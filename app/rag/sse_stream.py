"""
SSE 流式聊天生成器

支持三种模式：
1. 普通流式：assistant 逐 token 推送
2. 流式 + Tool Calling：tool_call / tool_response 事件实时推送，工具执行后再次流式生成
3. 多轮工具循环：最多 max_iterations 轮

每次 yield 一个事件字典：
- {"type": "thinking", "content": "..."}        # reasoning_content（默认丢弃，可开启）
- {"type": "tool_call", "id", "name", "arguments"}
- {"type": "tool_response", "tool_call_id", "name", "output"}
- {"type": "assistant", "content": "..."}       # 逐 token
- {"type": "finish", "answer": "完整回答"}
- {"type": "error", "error": "..."}

说明：
- 使用同步 OpenAI client + asyncio.to_thread 逐 chunk 拉取，
  避免阻塞事件循环（SSE 长连接期间其他请求仍可响应）
- reasoning_content 为模型思考过程（NVIDIA kimi-k3 会输出），
  默认丢弃，可通过 yield_thinking=True 开启并转成 thinking 事件
"""

import asyncio
import json
import logging
from typing import AsyncIterator, Dict, Any, List, Optional

from app.tools.registry import registry
from app.tools.base_tool import ToolResult

logger = logging.getLogger(__name__)

# 流结束哨兵（不能用 StopIteration，跨线程 raise 进 Future 会被 Python 拦截）
_STREAM_DONE = object()
_STREAM_ERROR = object()


def sse_format(data: dict) -> str:
    """把事件字典格式化为 SSE 帧（中文不转义，符合项目既有约定）"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _blocking_next(iterator):
    """在工作线程内拉取下一个 chunk，捕获 StopIteration 和其他异常，
    用哨兵对象返回，避免 asyncio.to_thread 在 Future 中 raise 异常。

    返回值约定：_STREAM_DONE | _STREAM_ERROR | 实际 chunk
    """
    try:
        return next(iterator)
    except StopIteration:
        return _STREAM_DONE
    except Exception as e:  # noqa: BLE001
        return (_STREAM_ERROR, e)


async def _next_chunk(iterator):
    """在线程池中拉取下一个流式 chunk"""
    return await asyncio.to_thread(_blocking_next, iterator)


async def chat_sse_stream(
    client,
    model: str,
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.7,
    max_tokens: int = 2000,
    max_iterations: int = 5,
    yield_thinking: bool = False,
) -> AsyncIterator[dict]:
    """
    流式聊天生成器（兼容 Tool Calling 多轮循环）

    Args:
        client: OpenAI client（同步）
        model: 模型名
        messages: 对话消息列表（会被原地追加 tool 相关消息）
        tools: 工具定义列表；None/空列表表示不启用工具调用（纯文本流式）
        temperature / max_tokens: 传给模型的参数
        max_iterations: 最大工具调用轮次
        yield_thinking: 是否把 reasoning_content 作为 thinking 事件推送
    """
    use_tools = bool(tools)

    def _create_stream():
        """同步创建 stream 对象（封装到 to_thread，避免阻塞事件循环）"""
        kwargs = dict(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        if use_tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        return client.chat.completions.create(**kwargs)

    iteration = 0
    while iteration < max_iterations:
        iteration += 1
        logger.info(f"[SSE] 发起流式请求 iter={iteration} model={model} tools={len(tools) if tools else 0}")

        # ---- 发起一轮流式请求（放到线程池，避免阻塞事件循环） ----
        try:
            stream = await asyncio.to_thread(_create_stream)
            logger.info(f"[SSE] 流式连接已建立 iter={iteration}")
        except Exception as e:
            logger.error(f"API 调用失败: {e}")
            yield {"type": "error", "error": f"AI 调用失败: {str(e)}"}
            return

        # ---- 解析流式 chunk ----
        content = ""
        collected_tools: Dict[int, Dict[str, str]] = {}
        tool_order: List[int] = []

        iterator = iter(stream)
        while True:
            chunk = await _next_chunk(iterator)
            if chunk is _STREAM_DONE:
                break
            if isinstance(chunk, tuple) and chunk and chunk[0] is _STREAM_ERROR:
                err = chunk[1]
                logger.error(f"流式读取中断: {err}")
                yield {"type": "error", "error": f"流式读取中断: {str(err)}"}
                return

            for c in chunk.choices or []:
                delta = getattr(c, "delta", None)
                if delta is None:
                    continue
                if yield_thinking and getattr(delta, "reasoning_content", None):
                    yield {"type": "thinking", "content": delta.reasoning_content}
                if delta.content:
                    content += delta.content
                    yield {"type": "assistant", "content": delta.content}
                for tc in delta.tool_calls or []:
                    idx = tc.index
                    if idx not in collected_tools:
                        collected_tools[idx] = {"id": "", "name": "", "arguments": ""}
                        tool_order.append(idx)
                    if tc.id:
                        collected_tools[idx]["id"] = tc.id
                    if tc.function and tc.function.name:
                        collected_tools[idx]["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        collected_tools[idx]["arguments"] += tc.function.arguments

        # ---- 无工具调用：本轮即为最终回答 ----
        if not tool_order:
            yield {"type": "finish", "answer": content}
            return

        # ---- 有工具调用：把 assistant 消息（含 tool_calls）追加到历史 ----
        tool_calls = [collected_tools[i] for i in tool_order]
        messages.append({
            "role": "assistant",
            "content": content or "",
            "tool_calls": [
                {
                    "id": t["id"],
                    "type": "function",
                    "function": {"name": t["name"], "arguments": t["arguments"]},
                }
                for t in tool_calls
            ],
        })

        # ---- 逐个执行工具并推送事件 ----
        for t in tool_calls:
            yield {
                "type": "tool_call",
                "id": t["id"],
                "name": t["name"],
                "arguments": t["arguments"],
            }
            result = await _execute_tool(t["name"], t["arguments"])
            output = json.dumps(
                result.data if result.success else {"error": result.error},
                ensure_ascii=False,
            )
            yield {
                "type": "tool_response",
                "tool_call_id": t["id"],
                "name": t["name"],
                "output": output,
            }
            messages.append({"role": "tool", "tool_call_id": t["id"], "content": output})

    # ---- 达到最大迭代次数：做一次无工具总结调用 ----
    def _create_summary_stream():
        return client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
    try:
        stream = await asyncio.to_thread(_create_summary_stream)
        content = ""
        iterator = iter(stream)
        while True:
            chunk = await _next_chunk(iterator)
            if chunk is _STREAM_DONE:
                break
            if isinstance(chunk, tuple) and chunk and chunk[0] is _STREAM_ERROR:
                err = chunk[1]
                logger.error(f"总结调用流式读取中断: {err}")
                yield {"type": "error", "error": f"流式读取中断: {str(err)}"}
                return
            for c in chunk.choices or []:
                delta = getattr(c, "delta", None)
                if delta and delta.content:
                    content += delta.content
                    yield {"type": "assistant", "content": delta.content}
        yield {"type": "finish", "answer": content}
    except Exception as e:
        logger.error(f"总结调用失败: {e}")
        yield {"type": "error", "error": f"AI 调用失败: {str(e)}"}


async def _execute_tool(name: str, arguments: str) -> ToolResult:
    """执行单个工具（与 orchestrator 行为一致）"""
    tool = registry.get(name)
    if not tool:
        return ToolResult(success=False, error=f"未知工具: {name}")
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError as e:
        return ToolResult(success=False, error=f"参数 JSON 解析失败: {str(e)}")
    try:
        return await tool.execute(**args)
    except Exception as e:
        logger.error(f"工具 [{name}] 执行异常: {e}", exc_info=True)
        return ToolResult(success=False, error=f"工具执行异常: {str(e)}")
