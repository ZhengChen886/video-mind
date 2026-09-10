from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from typing import List, Optional
import os
import uuid
import logging
from pydantic import BaseModel
from pathlib import Path

import app.config.config_manager as config_manager

logger = logging.getLogger(__name__)

from app.services.knowledge_service import KnowledgeService
from app.rag.chat_service import RAGChatService
from app.rag.sse_stream import chat_sse_stream, sse_format
from app.models.knowledge import (
    ChatRequest, ChatResponse, IndexRequest, IndexResponse,
    FileSaveRequest, FavoriteRequest, RenameConversationRequest,
    MultiChatRequest, CollectionChatRequest, IndexItem, BatchIndexRequest
)
# 导入工具系统（触发注册）
from app.tools import get_all_registered_tool_names
from app.tools.registry import registry
from app.speech_text.tts import (
    get_supported_voices, clean_markdown_text,
    text_to_audio_with_resume, CHUNK_SIZE
)
from app.speech_text.tts_cache import (
    ensure_dirs, compute_text_hash, find_cached_audio,
    add_to_cache, get_audio_path, get_temp_dir, cleanup_temp_cache
)


router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

knowledge_service = KnowledgeService()
rag_service = RAGChatService()

# SSE 流式响应通用头（与 server.py 任务流保持一致）
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
# 上下文截断提示（与 chat_service 保持一致）
TRUNCATED_HINT = "（内容已截断：上下文超过最大长度限制，请减少检索片段数量或增大上下文窗口）"


# 请求模型
class CreateFolderRequest(BaseModel):
    folder_name: str
    parent_path: Optional[str] = None


class RenameFolderRequest(BaseModel):
    old_path: str
    new_name: str


class DeleteFolderRequest(BaseModel):
    folder_path: str


class MoveFileRequest(BaseModel):
    file_path: str
    target_folder_path: str


def success_response(data=None, message="Success"):
    response = {"success": True, "message": message}
    if data is not None:
        response["data"] = data
    return JSONResponse(response)


def error_response(error: str, status_code: int = 400):
    return JSONResponse({
        "success": False,
        "error": error
    }, status_code=status_code)


def _persist_conversation(conv_id, doc_id, doc_name, history, question, answer, reuse_recent=True):
    """保存/更新对话，返回 conv_id（SSE 与 JSON 分支共用）

    Args:
        reuse_recent: 无 conv_id 时是否复用该文档的最近对话（仅单文档模式启用）
    """
    messages = history + [
        {"role": "user", "content": question},
        {"role": "assistant", "content": answer}
    ]

    if conv_id:
        existing = knowledge_service.get_conversation(conv_id)
        if existing:
            existing["messages"] = messages
            knowledge_service.save_conversation(existing)
            return conv_id
        # conv_id 无效，走新建

    if reuse_recent:
        conversations = knowledge_service.list_conversations()
        doc_conversations = [c for c in conversations if c.get("doc_id") == doc_id]
        if doc_conversations:
            latest = knowledge_service.get_conversation(doc_conversations[0]["id"])
            latest["messages"] = messages
            knowledge_service.save_conversation(latest)
            return latest.get("id")

    conversation_data = {
        "doc_id": doc_id,
        "doc_name": doc_name,
        "messages": messages,
    }
    saved = knowledge_service.save_conversation(conversation_data)
    return saved.get("id") if saved else None


def _wrap_sse(inner, finalize=None, meta=None):
    """包装 chat_sse_stream：推送 meta -> 聚合完整回答 -> 保存对话 -> 推送 done/end 事件

    Args:
        inner: chat_sse_stream 生成器
        finalize: 同步回调 full_answer -> (conv_id, extra_dict)，extra 会并入 done 事件
        meta: 流开始前先推送的事件（如检索结果），dict 类型
    """
    async def generator():
        if meta:
            yield sse_format(meta)
        full_answer = ""
        try:
            async for event in inner:
                if event.get("type") == "assistant":
                    full_answer += event.get("content", "")
                elif event.get("type") == "finish":
                    full_answer = event.get("answer", full_answer)
                yield sse_format(event)
        finally:
            conv_id = None
            extra = {}
            if full_answer and finalize:
                try:
                    conv_id, extra = finalize(full_answer)
                except Exception as e:
                    logger.error(f"SSE 对话保存失败: {e}")
            yield sse_format({"type": "done", "conv_id": conv_id, **extra})
            yield "event: end\ndata: {}\n\n"
    return generator()


@router.get("/files")
async def list_files():
    try:
        files = knowledge_service.list_documents()
        return success_response(files)
    except Exception as e:
        return error_response(str(e))


@router.post("/upload")
async def upload_file(file: UploadFile = File(...), target_folder: Optional[str] = None):
    try:
        content = await file.read()
        result = knowledge_service.upload_document(file.filename, content, target_folder)
        if result:
            return success_response(result, "文件上传成功")
        return error_response("文件上传失败")
    except Exception as e:
        return error_response(str(e))


# 文件夹操作 API
@router.post("/folders")
async def create_folder(request: CreateFolderRequest):
    try:
        result = knowledge_service.create_folder(request.folder_name, request.parent_path)
        if result:
            return success_response(result, "文件夹创建成功")
        return error_response("文件夹创建失败")
    except Exception as e:
        return error_response(str(e))


@router.put("/folders")
async def rename_folder(request: RenameFolderRequest):
    try:
        result = knowledge_service.rename_folder(request.old_path, request.new_name)
        if result:
            return success_response(result, "文件夹重命名成功")
        return error_response("文件夹重命名失败")
    except Exception as e:
        return error_response(str(e))


@router.delete("/folders")
async def delete_folder(request: DeleteFolderRequest):
    try:
        success = knowledge_service.delete_folder(request.folder_path)
        if success:
            return success_response(message="文件夹删除成功")
        return error_response("文件夹删除失败")
    except Exception as e:
        return error_response(str(e))


@router.post("/files/move")
async def move_file(request: MoveFileRequest):
    try:
        result = knowledge_service.move_file(request.file_path, request.target_folder_path)
        if result:
            return success_response(result, "文件移动成功")
        return error_response("文件移动失败")
    except Exception as e:
        return error_response(str(e))


@router.get("/file/{path:path}")
async def get_file(path: str):
    try:
        doc = knowledge_service.get_document(path)
        if doc:
            return success_response(doc)
        return error_response("文件不存在", 404)
    except Exception as e:
        return error_response(str(e))


@router.post("/file/save")
async def save_file(request: FileSaveRequest):
    try:
        success = knowledge_service.save_document(request.path, request.content)
        if success:
            return success_response(message="文件保存成功")
        return error_response("文件保存失败")
    except Exception as e:
        return error_response(str(e))


@router.delete("/file")
async def delete_file(path: str):
    try:
        success = knowledge_service.delete_document(path)
        if success:
            rag_service.delete_document_index(path)
            return success_response(message="文件删除成功")
        return error_response("文件删除失败")
    except Exception as e:
        return error_response(str(e))


@router.get("/tools")
async def list_available_tools():
    """获取当前可用的工具列表（供前端展示）"""
    try:
        from app.tools.registry import registry
        tools = []
        for tool in registry.get_all():
            tools.append({
                "name": tool.name,
                "description": tool.description,
                "parameters": [
                    {
                        "name": p.name,
                        "type": p.type,
                        "description": p.description,
                        "required": p.required,
                    }
                    for p in tool.parameters
                ]
            })
        return success_response({"tools": tools, "count": len(tools)})
    except Exception as e:
        return error_response(str(e))


@router.post("/index")
async def index_document(request: IndexRequest):
    try:
        content = knowledge_service.get_document(request.doc_path)
        if not content:
            return error_response("文件不存在", 404)

        doc_type = content.get("type", "md")
        result = rag_service.index_document(request.doc_id, content["content"], doc_type)

        if result.get("success"):
            return success_response(result, "文档索引成功")
        return error_response(result.get("error", "索引失败"))
    except Exception as e:
        return error_response(str(e))


@router.get("/index/status")
async def get_index_status(doc_id: str):
    try:
        status = rag_service.check_index_status(doc_id)
        return success_response(status)
    except Exception as e:
        return error_response(str(e))


# ========== RAG 多文件/文件夹知识库改造：新增端点 ==========

@router.post("/index/batch")
async def index_batch(request: BatchIndexRequest):
    """批量索引文件或文件夹（支持混合）"""
    try:
        if not request.items:
            return error_response("索引列表为空")

        progress_log = []

        def on_progress(current, total, name):
            progress_log.append(f"[{current}/{total}] {name}")

        result = knowledge_service.batch_index(
            items=[item.dict() for item in request.items],
            force=request.force,
            progress_callback=on_progress,
        )

        if result.get("scan_errors"):
            logger.warning(f"批量索引扫描错误: {result['scan_errors']}")

        return success_response(result, (
            f"批量索引完成：成功 {result['indexed_count']}，"
            f"跳过 {result['skipped_count']}，失败 {result['failed_count']}"
        ))
    except Exception as e:
        return error_response(str(e))


@router.get("/scan-folder")
async def scan_folder(path: str):
    """扫描文件夹（先预览再索引）"""
    try:
        if not path or not path.strip():
            return error_response("路径不能为空")

        result = knowledge_service.scan_folder(path.strip())
        if not result.get("success"):
            return error_response(result.get("error", "扫描失败"))

        return success_response(result, f"扫描完成，找到 {result['total_found']} 个支持的文件")
    except Exception as e:
        return error_response(str(e))


@router.post("/chat/multi")
async def chat_multi(request: MultiChatRequest, stream: bool = False):
    """多文档问答（$in 一次检索 + Reranker 二次排序），支持 SSE 流式返回"""
    try:
        import json as _json
        if not request.doc_ids:
            return error_response("doc_ids 不能为空")
        if len(request.doc_ids) > 50:
            return error_response("单次问答最多支持 50 个文档")

        prep_result = rag_service.prepare_messages_multi(
            question=request.question,
            doc_ids=request.doc_ids,
            history=request.history,
            use_reranker=request.use_reranker,
        )

        config = config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai")
        provider_config = config.get("providers", {}).get(active_provider, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")
        model = request.model or provider_config.get("default_model", "")

        from openai import OpenAI
        client = OpenAI(base_url=api_url, api_key=api_key)

        # ---------- SSE 流式分支 ----------
        if stream:
            def finalize(answer):
                conv_id = _persist_conversation(
                    request.conv_id,
                    _json.dumps(request.doc_ids, ensure_ascii=False),
                    f"多文档问答（{len(request.doc_ids)} 个文件）",
                    request.history, request.question, answer,
                    reuse_recent=False,
                )
                extra = {
                    "sources": prep_result.get("chunks", [])[:6],
                    "doc_ids": request.doc_ids,
                    "doc_names": prep_result.get("doc_names", []),
                    "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
                }
                return conv_id, extra

            meta = {
                "type": "retrieve",
                "sources": prep_result.get("chunks", [])[:6],
                "doc_ids": request.doc_ids,
                "doc_names": prep_result.get("doc_names", []),
                "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            }

            return StreamingResponse(
                _wrap_sse(
                    chat_sse_stream(client, model, prep_result["messages"], tools=[]),
                    finalize=finalize,
                    meta=meta,
                ),
                media_type="text/event-stream",
                headers=SSE_HEADERS,
            )

        # ---------- 原 JSON 分支 ----------
        answer = None
        try:
            response = client.chat.completions.create(
                model=model,
                messages=prep_result["messages"],
                temperature=0.7,
                max_tokens=2000
            )
            answer = response.choices[0].message.content
        except Exception as e:
            logger.error(f"多文档问答 AI 调用失败: {e}")
            answer = f"AI 调用失败: {str(e)}"

        # 保存对话（doc_id 存 JSON 数组字符串以支持多文档恢复）
        conversation_id = _persist_conversation(
            request.conv_id,
            _json.dumps(request.doc_ids, ensure_ascii=False),
            f"多文档问答（{len(request.doc_ids)} 个文件）",
            request.history, request.question, answer or "",
            reuse_recent=False,
        )

        return success_response({
            "answer": answer,
            "sources": prep_result.get("chunks", [])[:6],
            "doc_ids": request.doc_ids,
            "doc_names": prep_result.get("doc_names", []),
            "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            "conv_id": conversation_id
        })
    except Exception as e:
        return error_response(str(e))


@router.post("/chat/collection")
async def chat_collection(request: CollectionChatRequest, stream: bool = False):
    """按集合问答（整个知识库的所有已索引文件），支持 SSE 流式返回"""
    try:
        prep_result = rag_service.prepare_messages_collection(
            question=request.question,
            history=request.history,
            use_reranker=request.use_reranker,
        )

        config = config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai")
        provider_config = config.get("providers", {}).get(active_provider, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")
        model = request.model or provider_config.get("default_model", "")

        from openai import OpenAI
        client = OpenAI(base_url=api_url, api_key=api_key)

        # ---------- SSE 流式分支 ----------
        if stream:
            def finalize(answer):
                conv_id = _persist_conversation(
                    request.conv_id,
                    "__collection__",
                    "全库问答",
                    request.history, request.question, answer,
                    reuse_recent=False,
                )
                extra = {
                    "sources": prep_result.get("chunks", [])[:6],
                    "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
                }
                return conv_id, extra

            meta = {
                "type": "retrieve",
                "sources": prep_result.get("chunks", [])[:6],
                "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            }

            return StreamingResponse(
                _wrap_sse(
                    chat_sse_stream(client, model, prep_result["messages"], tools=[]),
                    finalize=finalize,
                    meta=meta,
                ),
                media_type="text/event-stream",
                headers=SSE_HEADERS,
            )

        # ---------- 原 JSON 分支 ----------
        answer = None
        try:
            response = client.chat.completions.create(
                model=model,
                messages=prep_result["messages"],
                temperature=0.7,
                max_tokens=2000
            )
            answer = response.choices[0].message.content
        except Exception as e:
            logger.error(f"集合问答 AI 调用失败: {e}")
            answer = f"AI 调用失败: {str(e)}"

        conversation_id = _persist_conversation(
            request.conv_id,
            "__collection__",
            "全库问答",
            request.history, request.question, answer or "",
            reuse_recent=False,
        )

        return success_response({
            "answer": answer,
            "sources": prep_result.get("chunks", [])[:6],
            "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            "conv_id": conversation_id
        })
    except Exception as e:
        return error_response(str(e))


@router.post("/chat")
async def chat(request: ChatRequest, stream: bool = False):
    try:
        doc = knowledge_service.get_document(request.doc_id)
        if not doc:
            return error_response("文档不存在", 404)

        prep_result = rag_service.prepare_messages(
            question=request.question,
            history=request.history,
            doc_id=request.doc_id,
            doc_content=doc.get("content", ""),
            doc_name=doc.get("name", ""),
            enable_tools=True,  # 启用 Tool Calling
        )

        config = config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai")
        provider_config = config.get("providers", {}).get(active_provider, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")
        model = request.model or provider_config.get("default_model", "")

        messages = prep_result["messages"]
        doc_content = doc.get("content", "")

        from openai import OpenAI
        client = OpenAI(base_url=api_url, api_key=api_key)

        # ---------- SSE 流式分支（含流式 Tool Calling） ----------
        if stream:
            # 与 chat_with_tools 一致的文档内容注入（消息级指令）
            if doc_content:
                messages.insert(-1, {
                    "role": "system",
                    "content": f"[工具参数预填充] 当前文档内容已加载，字数约 {len(doc_content)} 字符。"
                               f"在调用 lookup_text、get_doc_info、get_section_content 时，"
                               f"doc_content 参数值为上述完整文档内容，无需重新获取。"
                               f"doc_name 参数值为当前打开的文档名。"
                })

            def finalize(answer):
                conv_id = _persist_conversation(
                    request.conv_id,
                    request.doc_id,
                    doc.get("name", ""),
                    request.history, request.question, answer,
                    reuse_recent=True,
                )
                extra = {
                    "sources": prep_result.get("chunks", [])[:3],
                    "doc_overview": prep_result.get("doc_overview", ""),
                    "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
                }
                return conv_id, extra

            meta = {
                "type": "retrieve",
                "sources": prep_result.get("chunks", [])[:3],
                "doc_overview": prep_result.get("doc_overview", ""),
                "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            }

            return StreamingResponse(
                _wrap_sse(
                    chat_sse_stream(
                        client, model, messages,
                        tools=registry.to_openai_tools(),
                    ),
                    finalize=finalize,
                    meta=meta,
                ),
                media_type="text/event-stream",
                headers=SSE_HEADERS,
            )

        # ---------- 原 JSON 分支 ----------
        try:
            # 使用 Tool Calling 对话（如果模型支持）
            answer = await rag_service.chat_with_tools(
                client=client,
                model=model,
                messages=messages,
                doc_content=doc_content,
                temperature=0.7,
                max_tokens=2000,
            )
        except Exception as e:
            # Tool Calling 失败时 fallback 到普通调用
            logger.error(f"Tool Calling 失败，回退到普通模式: {e}")
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=2000
                )
                answer = response.choices[0].message.content or f"AI 调用失败: {str(e)}"
            except Exception as e2:
                answer = f"AI 调用失败: {str(e2)}"

        conversation_id = _persist_conversation(
            request.conv_id,
            request.doc_id,
            doc.get("name", ""),
            request.history, request.question, answer,
            reuse_recent=True,
        )

        return success_response({
            "answer": answer,
            "sources": prep_result.get("chunks", [])[:3],
            "doc_overview": prep_result.get("doc_overview", ""),
            "truncated": prep_result.get("context", "").endswith(TRUNCATED_HINT),
            "conv_id": conversation_id
        })
    except Exception as e:
        return error_response(str(e))


@router.get("/conversations")
async def list_conversations():
    try:
        conversations = knowledge_service.list_conversations()
        return success_response(conversations)
    except Exception as e:
        return error_response(str(e))


@router.get("/conversation/{conv_id}")
async def get_conversation(conv_id: str):
    try:
        conversation = knowledge_service.get_conversation(conv_id)
        if conversation:
            return success_response(conversation)
        return error_response("对话不存在", 404)
    except Exception as e:
        return error_response(str(e))


@router.post("/conversation/save")
async def save_conversation(request: Request):
    try:
        data = await request.json()
        success = knowledge_service.save_conversation(data)
        if success:
            return success_response(message="对话保存成功")
        return error_response("对话保存失败")
    except Exception as e:
        return error_response(str(e))


@router.delete("/conversation/{conv_id}")
async def delete_conversation(conv_id: str):
    try:
        success = knowledge_service.delete_conversation(conv_id)
        if success:
            return success_response(message="对话删除成功")
        return error_response("对话删除失败")
    except Exception as e:
        return error_response(str(e))


@router.post("/conversation/rename")
async def rename_conversation(request: RenameConversationRequest):
    try:
        success = knowledge_service.rename_conversation(request.conv_id, request.title)
        if success:
            return success_response(message="对话重命名成功")
        return error_response("对话重命名失败")
    except Exception as e:
        return error_response(str(e))


@router.post("/conversation/new")
async def new_conversation(doc_id: str = None, doc_name: str = None):
    try:
        conversation = knowledge_service.create_new_conversation(doc_id, doc_name)
        return success_response(conversation, "对话创建成功")
    except Exception as e:
        return error_response(str(e))


@router.get("/favorites")
async def list_favorites():
    try:
        favorites = knowledge_service.get_favorites()
        return success_response(favorites)
    except Exception as e:
        return error_response(str(e))


@router.post("/favorites")
async def add_favorite(request: FavoriteRequest):
    try:
        favorite = knowledge_service.add_favorite(
            content=request.content,
            question=request.question,
            document=request.document
        )
        if favorite:
            return success_response(favorite, "收藏添加成功")
        return error_response("收藏添加失败")
    except Exception as e:
        return error_response(str(e))


@router.delete("/favorites/{fav_id}")
async def delete_favorite(fav_id: str):
    try:
        success = knowledge_service.delete_favorite(fav_id)
        if success:
            return success_response(message="收藏删除成功")
        return error_response("收藏删除失败")
    except Exception as e:
        return error_response(str(e))


@router.post("/favorites/export")
async def export_favorites():
    try:
        output_path = knowledge_service.export_favorites()
        if output_path:
            return success_response({"path": output_path}, "收藏导出成功")
        return error_response("收藏导出失败")
    except Exception as e:
        return error_response(str(e))


# TTS 相关 API
@router.get("/tts/voices")
async def get_tts_voices():
    """获取支持的音色列表"""
    try:
        voices = get_supported_voices()
        return success_response(voices)
    except Exception as e:
        return error_response(str(e))


class TTSConvertRequest(BaseModel):
    text: str
    voice: str = "zh-CN-XiaoxiaoNeural"
    source_type: Optional[str] = None
    source_id: Optional[str] = None
    source_info: Optional[dict] = None


@router.post("/tts/convert")
async def convert_tts(request: TTSConvertRequest):
    """
    文本转语音"""
    try:
        ensure_dirs()
        
        # 清理文本
        cleaned_text = clean_markdown_text(request.text)
        
        if not cleaned_text.strip():
            return error_response("文本内容为空")
        
        # 计算哈希并检查缓存
        text_hash = compute_text_hash(cleaned_text)
        cached = find_cached_audio(text_hash, request.voice)
        
        if cached:
            # 命中缓存
            audio_url = f"/api/knowledge/tts/audio/{cached['audio_file']}"
            return success_response({
                "audio_url": audio_url,
                "cached": True,
                "audio_file": cached['audio_file']
            })
        
        # 生成输出文件名
        audio_filename = f"tts_{text_hash[:16]}.mp3"
        output_path = get_audio_path(audio_filename)
        
        # 使用文本哈希作为临时目录名称，实现断点续传
        voice_suffix = request.voice.replace("-", "_").lower()
        temp_dir = get_temp_dir() / f"{text_hash}_{voice_suffix}"
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        result = text_to_audio_with_resume(
            text=cleaned_text,
            output_path=str(output_path),
            temp_dir=temp_dir,
            voice=request.voice,
            chunk_size=CHUNK_SIZE
        )
        
        # 只有成功时才清理临时缓存
        if result['success']:
            cleanup_temp_cache(temp_dir)
        
        if not result['success']:
            return error_response(result.get('error', 'TTS 转换失败'))
        
        # 添加到缓存
        file_size = output_path.stat().st_size
        add_to_cache(
            text_hash=text_hash,
            voice=request.voice,
            audio_file=audio_filename,
            file_size=file_size,
            source_type=request.source_type,
            source_id=request.source_id,
            source_info=request.source_info
        )
        
        audio_url = f"/api/knowledge/tts/audio/{audio_filename}"
        return success_response({
            "audio_url": audio_url,
            "cached": False,
            "audio_file": audio_filename
        })
        
    except Exception as e:
        return error_response(str(e))


@router.get("/tts/audio/{filename}")
async def get_tts_audio(filename: str):
    """获取 TTS 音频文件"""
    try:
        audio_path = get_audio_path(filename)
        if not audio_path.exists():
            raise HTTPException(status_code=404, detail="音频文件不存在")
        return FileResponse(
            path=str(audio_path),
            media_type="audio/mpeg",
            filename=filename
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
