"""
工具编排器 - 处理 OpenAI tool_calls 响应，执行工具，将结果回传给模型

核心流程：
1. 发送消息（含 tools 定义）→ 模型返回（可能含 tool_calls）
2. 解析 tool_calls → 逐个执行对应工具
3. 将工具结果追加到消息 → 再次调用模型
4. 模型基于工具结果生成最终回答
"""

import json
import logging
from typing import Dict, Any, List, Optional, AsyncIterator

from app.tools.registry import registry
from app.tools.base_tool import ToolResult

logger = logging.getLogger(__name__)


class ToolOrchestrator:
    """Tool Calling 编排器"""
    
    def __init__(self, max_iterations: int = 5):
        """
        Args:
            max_iterations: 最大工具调用轮次（防止无限循环）
        """
        self.max_iterations = max_iterations
    
    async def process_with_tools(
        self,
        client,                    # OpenAI client 实例
        model: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]] = None,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> str:
        """
        带 Tool Calling 的完整对话流程
        
        Args:
            client: OpenAI client
            model: 模型名
            messages: 对话消息列表
            tools: 工具定义列表（None 则从注册表获取全部）
            temperature: 温度
            max_tokens: 最大 token 数
            
        Returns:
            最终文本回答
        """
        if tools is None:
            tools = registry.to_openai_tools()
        
        # 如果没有注册任何工具，走普通调用
        if not tools:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return response.choices[0].message.content or ""
        
        iteration = 0
        while iteration < self.max_iterations:
            iteration += 1
            
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools if tools else None,
                    tool_choice="auto",
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except Exception as e:
                logger.error(f"API 调用失败: {e}")
                return f"AI 调用失败: {str(e)}"
            
            choice = response.choices[0]
            msg = choice.message
            
            # 没有工具调用 → 直接返回回答
            if not msg.tool_calls:
                return msg.content or ""
            
            # 将模型的 assistant 消息（含 tool_calls）加入历史
            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        }
                    }
                    for tc in msg.tool_calls
                ]
            })
            
            # 逐个执行工具调用
            for tool_call in msg.tool_calls:
                func_name = tool_call.function.name
                func_args_str = tool_call.function.arguments
                
                logger.info(f"[Tool Call] {func_name}({func_args_str})")
                
                # 解析参数
                try:
                    func_args = json.loads(func_args_str) if func_args_str else {}
                except json.JSONDecodeError as e:
                    logger.error(f"参数解析失败: {e}")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": f"错误：参数 JSON 解析失败 - {str(e)}"
                    })
                    continue
                
                # 执行工具
                result = await self._execute_tool(func_name, func_args)
                
                # 将工具结果加入消息
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result.data if result.success else {"error": result.error}, ensure_ascii=False)
                })
        
        # 达到最大迭代次数后，再做一次最终调用让模型总结
        try:
            final_response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return final_response.choices[0].message.content or "（达到最大工具调用次数限制）"
        except Exception as e:
            return f"AI 调用失败: {str(e)}"
    
    async def _execute_tool(self, name: str, args: Dict[str, Any]) -> ToolResult:
        """执行单个工具"""
        tool = registry.get(name)
        if not tool:
            return ToolResult(success=False, error=f"未知工具: {name}")
        
        try:
            return await tool.execute(**args)
        except Exception as e:
            logger.error(f"工具 [{name}] 执行异常: {e}", exc_info=True)
            return ToolResult(success=False, error=f"工具执行异常: {str(e)}")
