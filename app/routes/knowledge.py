from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import JSONResponse, FileResponse
from typing import List, Optional
import os
import uuid
from pydantic import BaseModel
from pathlib import Path

import config.config_manager as config_manager

from app.services.knowledge_service import KnowledgeService
from app.rag.chat_service import RAGChatService
from app.models.knowledge import (
    ChatRequest, ChatResponse, IndexRequest, IndexResponse,
    FileSaveRequest, FavoriteRequest, RenameConversationRequest
)
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


@router.post("/chat")
async def chat(request: ChatRequest):
    try:
        doc = knowledge_service.get_document(request.doc_id)
        if not doc:
            return error_response("文档不存在", 404)

        prep_result = rag_service.prepare_messages(
            question=request.question,
            history=request.history,
            doc_id=request.doc_id,
            doc_content=doc.get("content", ""),
            doc_name=doc.get("name", "")
        )

        config = config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai")
        provider_config = config.get("providers", {}).get(active_provider, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")
        model = request.model or provider_config.get("default_model", "")

        messages = prep_result["messages"]

        try:
            from openai import OpenAI
            client = OpenAI(base_url=api_url, api_key=api_key)
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.7,
                max_tokens=2000
            )
            answer = response.choices[0].message.content
        except Exception as e:
            answer = f"AI 调用失败: {str(e)}"

        # 如果有 conv_id，尝试加载现有对话并更新
        if request.conv_id:
            existing_conv = knowledge_service.get_conversation(request.conv_id)
            if existing_conv:
                # 更新现有对话
                existing_conv["messages"] = request.history + [
                    {"role": "user", "content": request.question},
                    {"role": "assistant", "content": answer}
                ]
                knowledge_service.save_conversation(existing_conv)
                conversation_id = request.conv_id
            else:
                # conv_id 无效，创建新对话
                conversation_data = {
                    "doc_id": request.doc_id,
                    "doc_name": doc.get("name", ""),
                    "messages": request.history + [
                        {"role": "user", "content": request.question},
                        {"role": "assistant", "content": answer}
                    ]
                }
                saved_conv = knowledge_service.save_conversation(conversation_data)
                conversation_id = saved_conv.get("id") if saved_conv else None
        else:
            # 没有 conv_id，尝试查找该文档是否有最近的对话
            conversations = knowledge_service.list_conversations()
            # 查找与当前文档相关的最近对话
            doc_conversations = [c for c in conversations if c.get("doc_id") == request.doc_id]
            if doc_conversations:
                # 使用最近的对话
                latest_conv = knowledge_service.get_conversation(doc_conversations[0]["id"])
                latest_conv["messages"] = request.history + [
                    {"role": "user", "content": request.question},
                    {"role": "assistant", "content": answer}
                ]
                knowledge_service.save_conversation(latest_conv)
                conversation_id = latest_conv.get("id")
            else:
                # 创建新对话
                conversation_data = {
                    "doc_id": request.doc_id,
                    "doc_name": doc.get("name", ""),
                    "messages": request.history + [
                        {"role": "user", "content": request.question},
                        {"role": "assistant", "content": answer}
                    ]
                }
                saved_conv = knowledge_service.save_conversation(conversation_data)
                conversation_id = saved_conv.get("id") if saved_conv else None

        return success_response({
            "answer": answer,
            "sources": prep_result.get("chunks", [])[:3],
            "doc_overview": prep_result.get("doc_overview", ""),
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
