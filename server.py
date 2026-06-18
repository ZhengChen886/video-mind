import uuid
import requests
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List, Dict, Any
import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles as _BaseStaticFiles
from fastapi.templating import Jinja2Templates
from starlette.responses import Response


# 静态文件服务（带强缓存头，减少首页 ~25 个资源 304 校验的往返开销）
class CachedStaticFiles(_BaseStaticFiles):
    """
    带强缓存头的静态文件服务：
    - 路径中带 ?v=xxx（版本号查询串）时，返回 Cache-Control: public, max-age=31536000, immutable
      浏览器不再发 If-Modified-Since / If-None-Match，304 校验彻底省掉
    - 普通请求走默认行为（短期缓存）
    注意：max-age=31536000 配合版本号强制刷新（?v=20260618b）使用，不会出现缓存更新问题
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if isinstance(response, Response):
            query_string = scope.get("query_string", b"").decode("latin-1", errors="ignore")
            if "v=" in query_string:
                # 带版本号的资源：1 年强缓存 + immutable，浏览器不再发条件请求
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                # 普通资源：1 小时缓存，减少重复请求
                response.headers.setdefault("Cache-Control", "public, max-age=3600")
        return response


# 导入外部模块
from app.file_operations.audio_converter import convert_audio_to_mp3
from app.speech_text.asr_onnx import transcribe_audio

from app.file_operations.file_manager import (
    get_directory_list,
    create_directory,
    delete_item,
    move_item,
    rename_item,
    save_uploaded_file as save_video_file,
    get_file_path,
    get_video_files,
    get_document_files,
    save_url_file,
    is_audio_file,
    VIDEO_DIR,
    AUDIO_DIR,
    get_base_dir,
)
from app.file_operations.video_processor import (
    video_to_audio,
    extract_thumbnail,
    get_video_duration,
    format_duration,
    format_file_size
)
from app.text_summary.content_analyzer import (
    analyze_content,
    generate_summary_ai,
    generate_notes_ai,
    generate_outline_ai,
    analyze_and_save,
    read_md_file,
    write_md_file
)

from app.routes.knowledge import router as knowledge_router
from app.routes.dashboard import router as dashboard_router
import os
import time

# ============================================================
# 任务管理系统
# ============================================================

tasks: Dict[str, Dict[str, Any]] = {}
tasks_lock = threading.Lock()

TASK_STATUS_PENDING = "pending"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_COMPLETED = "completed"
TASK_STATUS_FAILED = "failed"


def create_task(task_type: str, data: Dict[str, Any]) -> str:
    """创建新任务"""
    task_id = str(uuid.uuid4())
    with tasks_lock:
        tasks[task_id] = {
            "id": task_id,
            "type": task_type,
            "status": TASK_STATUS_PENDING,
            "data": data,
            "progress": 0,
            "message": "",
            "created_at": time.time(),
            "updated_at": time.time(),
            "result": None
        }
    return task_id


def update_task(task_id: str, **kwargs):
    """更新任务状态"""
    with tasks_lock:
        if task_id in tasks:
            # 确保 progress 是整数
            if "progress" in kwargs:
                kwargs["progress"] = int(kwargs["progress"])
            tasks[task_id].update(kwargs)
            tasks[task_id]["updated_at"] = time.time()


def get_task(task_id: str) -> Dict[str, Any]:
    """获取任务信息"""
    with tasks_lock:
        return tasks.get(task_id)


def get_all_tasks() -> List[Dict[str, Any]]:
    """获取所有任务"""
    with tasks_lock:
        return list(tasks.values())


def clear_completed_tasks():
    """清除已完成的任务"""
    with tasks_lock:
        to_delete = [tid for tid, t in tasks.items() 
                     if t["status"] in [TASK_STATUS_COMPLETED, TASK_STATUS_FAILED]]
        for tid in to_delete:
            del tasks[tid]


def process_batch_transcribe_task(task_id: str, video_paths: List[str]):
    """处理批量转录任务"""
    update_task(task_id, status=TASK_STATUS_RUNNING, message="开始处理...")
    
    results = []
    total = len(video_paths)
    
    for i, video_path in enumerate(video_paths):
        try:
            update_task(task_id, 
                       progress=int((i / total) * 100),
                       message=f"正在处理 {i+1}/{total}: {video_path}")
            
            full_path = VIDEO_DIR / video_path
            if not full_path.exists():
                results.append({
                    "path": video_path,
                    "success": False,
                    "error": "文件不存在"
                })
                continue
            
            # 1. 视频转音频
            audio_path = str(full_path.with_suffix(".mp3"))
            convert_success, error_msg = video_to_audio(str(full_path), audio_path)
            
            if not convert_success:
                results.append({
                    "path": video_path,
                    "success": False,
                    "error": error_msg or "视频转音频失败"
                })
                continue
            
            # 2. 语音转文字
            result = transcribe_audio(audio_path, language="auto")
            
            if result["success"]:
                # 保存字幕
                subtitle_path = full_path.parent / f"{full_path.stem}_subtitle.md"
                write_md_file(str(subtitle_path), result["text"])
                
                results.append({
                    "path": video_path,
                    "success": True,
                    "transcript": result["text"],
                    "language": result.get("language", "unknown")
                })
            else:
                results.append({
                    "path": video_path,
                    "success": False,
                    "error": result.get("error", "转录失败")
                })
                
        except Exception as e:
            results.append({
                "path": video_path,
                "success": False,
                "error": str(e)
            })
    
    update_task(task_id, 
               status=TASK_STATUS_COMPLETED, 
               progress=100,
               message="处理完成",
               result=results)


def process_batch_url_download_task(task_id: str, url_or_items, target_dir: str = ""):
    """处理批量URL下载任务，支持items格式或urls列表"""
    update_task(task_id, status=TASK_STATUS_RUNNING, message="开始下载...")
    
    results = []
    # 判断是items格式还是urls列表
    if url_or_items and len(url_or_items) > 0 and isinstance(url_or_items[0], dict):
        # items格式，包含url和filename
        items = url_or_items
        total = len(items)
        
        for i, item in enumerate(items):
            try:
                url = item.get("url", "").strip()
                filename = item.get("filename", "")
                if not url:
                    continue
                    
                update_task(task_id, 
                           progress=int((i / total) * 100),
                           message=f"正在下载 {i + 1}/{total}")
                
                # 传递filename给save_url_file
                result = save_url_file(url, target_dir, filename)
                
                if result["success"]:
                    # 提取缩略图
                    video_path = str(result["file_path"])
                    thumbnail_path = video_path.replace(".mp4", ".jpg")
                    extract_thumbnail(video_path, thumbnail_path)
                    
                    results.append({
                        "url": url,
                        "success": True,
                        "filename": result["filename"],
                        "saved_path": result["saved_path"]
                    })
                else:
                    results.append({
                        "url": url,
                        "success": False,
                        "error": result.get("error", "下载失败")
                    })
                    
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e)
                })
    else:
        # 传统的urls列表格式
        urls = url_or_items
        total = len(urls)
        
        for i, url in enumerate(urls):
            try:
                url = url.strip()
                if not url:
                    continue
                    
                update_task(task_id, 
                           progress=int((i / total) * 100),
                           message=f"正在下载 {i + 1}/{total}")
                
                result = save_url_file(url, target_dir)
                
                if result["success"]:
                    # 提取缩略图
                    video_path = str(result["file_path"])
                    thumbnail_path = video_path.replace(".mp4", ".jpg")
                    extract_thumbnail(video_path, thumbnail_path)
                    
                    results.append({
                        "url": url,
                        "success": True,
                        "filename": result["filename"],
                        "saved_path": result["saved_path"]
                    })
                else:
                    results.append({
                        "url": url,
                        "success": False,
                        "error": result.get("error", "下载失败")
                    })
                    
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e)
                })
    
    update_task(task_id, 
               status=TASK_STATUS_COMPLETED, 
               progress=100,
               message="下载完成",
               result=results)

# ============================================================
# 全局路径配置
# ============================================================

PROJECT_ROOT = Path(__file__).parent.absolute()

# ============================================================
# 配置管理
# ============================================================
import config.config_manager as config_manager

def load_config():
    return config_manager.load_config()

def save_config(config):
    return config_manager.save_config(config)

# 全局配置
GLOBAL_CONFIG = load_config()

# ============================================================
# FastAPI 应用
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("AudioForge Server started")
    yield
    print("AudioForge Server stopped")

app = FastAPI(
    title="AudioForge API",
    description="音视频转 MP3 + 语音识别 API 服务",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态文件服务（带强缓存头，减少首页 ~25 个资源 304 校验的往返开销）
app.mount("/static", CachedStaticFiles(directory="web/static"), name="static")

# 模板配置
templates = Jinja2Templates(directory="web/templates")

# ============================================================
# 浏览器扩展兼容性：快速响应 Vite HMR 类扩展注入的请求
# 部分浏览器扩展（Vite DevTools 等）会向页面注入 /@vite/client、/@id/* 等请求
# 这些请求在 FastAPI 里没有对应路由，会得到 404；扩展会同时发起多个此类请求
# 占用浏览器同源并发连接（HTTP/1.1 默认 6 个），挤压首页数据 fetch 排队
# 这里直接返回 204 No Content，让扩展迅速完成请求，不影响正常业务
# ============================================================
@app.get("/@vite/{path:path}", status_code=204)
async def _vite_no_content(path: str):
    return None

@app.get("/@id/{path:path}", status_code=204)
async def _vite_id_no_content(path: str):
    return None

@app.get("/@fs/{path:path}", status_code=204)
async def _vite_fs_no_content(path: str):
    return None

@app.get("/__vite_ping", status_code=204)
async def _vite_ping_no_content():
    return None

@app.get("/@vite/client", status_code=204)
async def _vite_client_no_content():
    return None

# 注册知识库路由
app.include_router(knowledge_router)

# 注册仪表盘路由
app.include_router(dashboard_router)

# ============================================================
# 主页路由
# ============================================================

@app.get("/")
async def home(request: Request):
    """主页"""
    return templates.TemplateResponse("index.html", {"request": request})

# ============================================================
# 全部视频/音频列表
@app.get("/api/files", response_class=JSONResponse)
async def list_files(path: str = "", media_type: str = "video"):
    """
    获取文件列表
    Query Parameters:
        - path: 相对路径
        - media_type: 'video' (data/mp4，仅视频) 或 'audio' (data/mp3，仅音频)
    """
    if media_type not in ("video", "audio"):
        media_type = "video"
    items = get_directory_list(path, media_type=media_type)
    return {
        "success": True,
        "path": path,
        "media_type": media_type,
        "items": items
    }


# ============================================================
# 全部文档列表
@app.get("/api/documents", response_class=JSONResponse)
async def list_documents(type: str = None):
    """
    获取文档列表
    
    Query Parameters:
        - type: 文档类型 (可选)
            - all 或不传：全部文档
            - subtitle：原文
            - summary：总结
            - outline：大纲
            - notes：笔记
    """
    items = get_document_files(type=type)
    return {
        "success": True,
        "items": items
    }


@app.post("/api/folders", response_class=JSONResponse)
@app.post("/api/directory", response_class=JSONResponse)
async def create_new_directory(request: Request = None, path: str = "", name: str = "", media_type: str = "video"):
    # 兼容两种调用方式
    if request:
        try:
            body = await request.json()
            if "path" in body:
                path = body.get("path", "")
            if "name" in body:
                name = body.get("name", "")
            if "media_type" in body:
                media_type = body.get("media_type", "video")
        except Exception:
            pass
    if not name.strip():
        raise HTTPException(status_code=400, detail="目录名称不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    success = create_directory(path, name, media_type=media_type)
    if success:
        return {
            "success": True,
            "message": f"目录 '{name}' 创建成功"
        }
    else:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "目录创建失败，可能已存在"
            }
        )


@app.post("/api/item/delete", response_class=JSONResponse)
async def delete_item_api(request: Request):
    try:
        body = await request.json()
        path = body.get("path", "") or body.get("source_path", "")
        media_type = body.get("media_type", "video")
    except Exception:
        path = ""
        media_type = "video"

    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    result = delete_item(path, media_type=media_type)
    if result.get("success"):
        return {
            "success": True,
            "message": "删除成功",
            "deleted_files": result.get("deleted_files", 0),
            "deleted_type": result.get("deleted_type", "file")
        }
    else:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": result.get("error", "删除失败")
            }
        )


@app.get("/api/item/count", response_class=JSONResponse)
async def count_item_contents(path: str = "", media_type: str = "video"):
    """
    统计指定路径下递归的文件数量与类型（用于删除前预览）。
    path 为空或指向文件时，返回 type=file、count=1。
    path 指向目录时，返回 type=directory 与递归文件总数。
    """
    if media_type not in ("video", "audio"):
        media_type = "video"

    base_dir = get_base_dir(media_type)
    full_path = base_dir / path if path else base_dir

    if not full_path.exists():
        return JSONResponse(
            status_code=404,
            content={"success": False, "error": "路径不存在", "count": 0, "type": "unknown", "name": ""}
        )

    if full_path.is_file():
        return {
            "success": True,
            "type": "file",
            "count": 1,
            "name": full_path.name
        }

    # 目录：递归统计文件数
    file_count = sum(1 for p in full_path.rglob("*") if p.is_file())
    return {
        "success": True,
        "type": "directory",
        "count": file_count,
        "name": full_path.name
    }


@app.post("/api/item/move", response_class=JSONResponse)
async def move_item_api(request: Request):
    try:
        body = await request.json()
        source_path = body.get("source_path", "")
        target_dir = body.get("target_dir", "")
        media_type = body.get("media_type", "video")
    except Exception:
        source_path = ""
        target_dir = ""
        media_type = "video"

    if not source_path:
        raise HTTPException(status_code=400, detail="源路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    result = move_item(source_path, target_dir, media_type=media_type)
    if result["success"]:
        return {
            "success": True,
            "message": result["message"]
        }
    else:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": result["error"]
            }
        )


@app.post("/api/item/rename", response_class=JSONResponse)
async def rename_item_api(request: Request):
    try:
        body = await request.json()
        path = body.get("path", "") or body.get("source_path", "")
        new_name = body.get("new_name", "")
        media_type = body.get("media_type", "video")
    except Exception:
        path = ""
        new_name = ""
        media_type = "video"

    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if not new_name:
        raise HTTPException(status_code=400, detail="新名称不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    result = rename_item(path, new_name, media_type=media_type)
    if result["success"]:
        return {
            "success": True,
            "message": result["message"]
        }
    else:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": result["error"]
            }
        )


@app.post("/api/upload", response_class=JSONResponse)
@app.post("/api/video/upload", response_class=JSONResponse)
async def upload_video(file: UploadFile = File(...), path: str = "", media_type: str = "video"):
    if not file.filename:
        raise HTTPException(status_code=400, detail="未提供文件名")

    if media_type not in ("video", "audio"):
        media_type = "video"

    try:
        filename = await save_video_file(file, target_dir=path, media_type=media_type)

        base_dir = get_base_dir(media_type)
        full_path = str(base_dir / filename)
        if media_type == "video":
            # 视频提取缩略图
            thumbnail_path = full_path.replace(".mp4", ".jpg")
            extract_thumbnail(full_path, thumbnail_path)

        return {
            "success": True,
            "filename": filename,
            "media_type": media_type,
            "message": "上传成功"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"上传失败: {str(e)}")


@app.post("/api/upload/url", response_class=JSONResponse)
@app.post("/api/video/upload-by-url", response_class=JSONResponse)
async def upload_video_by_url(request: Request):
    try:
        body = await request.json()
        url = body.get("url", "")
        target_dir = body.get("target_dir", "")
        filename = body.get("filename", "")
        media_type = body.get("media_type", "video")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not url:
        raise HTTPException(status_code=400, detail="URL不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"

    result = save_url_file(url, target_dir, filename, media_type=media_type)

    if result["success"]:
        full_path = str(result["file_path"])
        if media_type == "video":
            thumbnail_path = full_path.replace(".mp4", ".jpg")
            extract_thumbnail(full_path, thumbnail_path)

        return {
            "success": True,
            "filename": result["filename"],
            "saved_path": result["saved_path"],
            "media_type": media_type,
            "duration": result.get("duration", 0),
            "size": result.get("size", 0),
            "message": "下载成功"
        }
    else:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": result.get("error", "下载失败")
            }
        )


@app.get("/api/video/{path:path}", response_class=FileResponse)
async def get_video(path: str, thumbnail: bool = False, media_type: str = "video"):
    print(f"[Server] 请求媒体文件: path={path}, thumbnail={thumbnail}, media_type={media_type}")
    if media_type not in ("video", "audio"):
        media_type = "video"
    file_path = get_file_path(path, media_type=media_type)
    print(f"[Server] 完整文件路径: {file_path}")
    print(f"[Server] 文件是否存在: {file_path.exists()}")

    # 如果请求缩略图，返回对应的jpg文件
    if thumbnail:
        thumbnail_path = file_path.parent / f"{file_path.stem}.jpg"
        print(f"[Server] 缩略图路径: {thumbnail_path}, 是否存在: {thumbnail_path.exists()}")
        if thumbnail_path.exists():
            return FileResponse(thumbnail_path, media_type="image/jpeg")
        else:
            raise HTTPException(status_code=404, detail="缩略图不存在")

    if file_path.exists():
        suffix = file_path.suffix.lower()
        if suffix == ".mp4":
            print(f"[Server] 返回MP4文件")
            return FileResponse(file_path, media_type="video/mp4")
        elif suffix == ".webm":
            return FileResponse(file_path, media_type="video/webm")
        elif suffix == ".mov":
            return FileResponse(file_path, media_type="video/quicktime")
        elif suffix == ".mp3":
            print(f"[Server] 返回MP3音频文件")
            return FileResponse(file_path, media_type="audio/mpeg")
        elif suffix == ".m4a":
            return FileResponse(file_path, media_type="audio/mp4")
        elif suffix == ".wav":
            return FileResponse(file_path, media_type="audio/wav")
        elif suffix == ".ogg":
            return FileResponse(file_path, media_type="audio/ogg")
        elif suffix == ".flac":
            return FileResponse(file_path, media_type="audio/flac")
        elif suffix == ".aac":
            return FileResponse(file_path, media_type="audio/aac")
        elif suffix == ".jpg":
            print(f"[Server] 返回JPG文件")
            return FileResponse(file_path, media_type="image/jpeg")
        else:
            print(f"[Server] 不支持的文件类型: {file_path.suffix}")
            raise HTTPException(status_code=404, detail="文件不存在")
    else:
        print(f"[Server] 文件不存在: {file_path}")
        # 列出父目录下的文件用于调试
        if file_path.parent.exists():
            print(f"[Server] 父目录内容: {list(file_path.parent.iterdir())}")
        raise HTTPException(status_code=404, detail="文件不存在")


@app.post("/api/video/analyze", response_class=JSONResponse)
async def analyze_video(path: str = "", background_tasks: BackgroundTasks = None, media_type: str = "video"):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"

    base_dir = get_base_dir(media_type)
    file_path = base_dir / path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    # 创建异步任务
    task_id = create_task("video_transcribe", {"path": path, "media_type": media_type})

    # 后台执行任务
    if background_tasks:
        background_tasks.add_task(process_video_transcribe_task, task_id, str(file_path), media_type)

    return {
        "success": True,
        "task_id": task_id,
        "media_type": media_type,
        "message": "转录任务已启动"
    }


def process_video_transcribe_task(task_id: str, video_path: str, media_type: str = "video"):
    """处理视频/音频转录任务"""
    try:
        video_file = Path(video_path)

        # 如果调用方传了 media_type，以 media_type 为准；否则用扩展名判断
        if media_type not in ("video", "audio"):
            media_type = "audio" if is_audio_file(video_file) else "video"

        base_dir = get_base_dir(media_type)

        # 1. 视频转 MP3 - 音频文件走旁路
        if media_type == "audio":
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=5, message="检测到音频文件，跳过转码...")
            # 已经是 mp3 则直接使用；其他音频通过 video_to_audio 转 mp3
            if video_file.suffix.lower() == ".mp3":
                audio_path = str(video_file)
            else:
                audio_path = str(video_file.with_suffix(".mp3"))
                convert_success, error_msg = video_to_audio(str(video_file), audio_path)
                if not convert_success:
                    update_task(
                        task_id,
                        status=TASK_STATUS_FAILED,
                        progress=0,
                        message=error_msg or "音频转码失败"
                    )
                    return
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=20, message="音频准备完成，开始语音识别...")
        else:
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=5, message="正在转换视频到音频...")
            audio_path = str(video_file.with_suffix(".mp3"))
            convert_success, error_msg = video_to_audio(str(video_file), audio_path)
            if not convert_success:
                update_task(
                    task_id,
                    status=TASK_STATUS_FAILED,
                    progress=0,
                    message=error_msg or "视频转音频失败"
                )
                return
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=20, message="音频转换完成，开始语音识别...")

        # 2. 语音识别 - 带进度回调
        def progress_callback(phase, progress, message):
            phase_ranges = {
                "loading": (20, 25),
                "segmenting": (25, 30),
                "transcribing": (30, 95),
                "saving": (95, 100)
            }
            start_p, end_p = phase_ranges.get(phase, (20, 100))
            overall_progress = start_p + (progress / 100) * (end_p - start_p)
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=int(overall_progress), message=message)

        result = transcribe_audio(audio_path, language="auto", progress_callback=progress_callback)

        if result["success"]:
            update_task(task_id, status=TASK_STATUS_COMPLETED, progress=100, message="处理完成", result={
                "path": str(Path(video_path).relative_to(base_dir)),
                "transcript": result["text"],
                "duration": get_video_duration(audio_path),
                "language": result.get("language", "unknown"),
                "media_type": media_type
            })
        else:
            update_task(task_id, status=TASK_STATUS_FAILED, progress=0, message=result.get("error", "识别失败"))

    except Exception as e:
        import traceback
        error_msg = f"处理失败: {str(e)}"
        print(f"[Task Error] {error_msg}")
        traceback.print_exc()
        update_task(task_id, status=TASK_STATUS_FAILED, progress=0, message=error_msg)


# ============================================================
# 批量上传API
# ============================================================

@app.post("/api/upload/batch", response_class=JSONResponse)
async def upload_batch(files: List[UploadFile] = File(...), path: str = "", media_type: str = "video"):
    """批量上传文件"""
    if media_type not in ("video", "audio"):
        media_type = "video"
    results = []

    for file in files:
        try:
            filename = await save_video_file(file, target_dir=path, media_type=media_type)

            full_path = str(filename)
            if media_type == "video":
                thumbnail_path = full_path.replace(".mp4", ".jpg")
                extract_thumbnail(full_path, thumbnail_path)

            results.append({
                "filename": file.filename,
                "success": True,
                "saved_path": str(filename.relative_to(get_base_dir(media_type)))
            })
        except Exception as e:
            results.append({
                "filename": file.filename,
                "success": False,
                "error": str(e)
            })
    
    return {
        "success": True,
        "results": results
    }


# ============================================================
# 批量URL下载API
# ============================================================

@app.post("/api/upload/url/batch", response_class=JSONResponse)
async def upload_batch_url(request: Request, background_tasks: BackgroundTasks):
    """批量从URL下载（异步任务）"""
    try:
        body = await request.json()
        # 支持两种数据格式：items（包含url和filename）或urls（仅url列表）
        items = body.get("items", [])
        urls = body.get("urls", [])
        target_dir = body.get("target_dir", "")
        
        # 优先使用items格式
        if items and len(items) > 0:
            # 提取urls，并创建后台任务时传递items信息
            urls = [item.get("url", "") for item in items if item.get("url", "")]
            task_data = {"items": items, "target_dir": target_dir}
        elif urls and len(urls) > 0:
            task_data = {"urls": urls, "target_dir": target_dir}
        else:
            raise HTTPException(status_code=400, detail="URL列表不能为空")
        
        # 创建后台任务
        task_id = create_task("batch_url_download", task_data)
        background_tasks.add_task(process_batch_url_download_task, task_id, items if items else urls, target_dir)
        
        return {
            "success": True,
            "task_id": task_id,
            "message": "下载任务已创建"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================
# 批量转录API
# ============================================================

@app.post("/api/video/analyze/batch", response_class=JSONResponse)
async def analyze_batch(request: Request, background_tasks: BackgroundTasks):
    """批量转录视频（异步任务）"""
    try:
        body = await request.json()
        video_paths = body.get("paths", [])
        
        if not video_paths or len(video_paths) == 0:
            raise HTTPException(status_code=400, detail="视频路径列表不能为空")
        
        # 创建后台任务
        task_id = create_task("batch_transcribe", {"paths": video_paths})
        background_tasks.add_task(process_batch_transcribe_task, task_id, video_paths)
        
        return {
            "success": True,
            "task_id": task_id,
            "message": "转录任务已创建"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================
# 任务管理API
# ============================================================

@app.get("/api/tasks", response_class=JSONResponse)
async def list_tasks():
    """获取所有任务列表"""
    return {
        "success": True,
        "tasks": get_all_tasks()
    }


@app.get("/api/tasks/{task_id}", response_class=JSONResponse)
async def get_task_detail(task_id: str):
    """获取单个任务详情"""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {
        "success": True,
        "task": task
    }


@app.post("/api/tasks/clear-completed", response_class=JSONResponse)
async def clear_tasks():
    """清除已完成的任务"""
    clear_completed_tasks()
    return {
        "success": True,
        "message": "已清除完成的任务"
    }


def format_summary_md(video_name: str, summary: str, source_file: str) -> str:
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    return f"""# 视频总结：{video_name}

{summary}

---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""

def format_notes_md(video_name: str, notes: list, source_file: str) -> str:
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    notes_list = "\n".join([f"- {note}" for note in notes])
    return f"""# 视频笔记：{video_name}

## 关键要点

{notes_list}

---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""

def format_outline_md(video_name: str, outline: list, source_file: str) -> str:
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    outline_content = ""
    
    for item in outline:
        level = item["level"]
        title = item["title"]
        content = item.get("content", "")
        
        outline_content += f"{'#' * level} {title}\n\n"
        if content:
            outline_content += f"{content}\n\n"
    
    return f"""# 视频大纲：{video_name}

{outline_content}---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""

@app.post("/api/analysis/generate-summary", response_class=JSONResponse)
async def generate_summary_api(request: Request):
    try:
        body = await request.json()
        video_path = body.get("video_path", "")
        model = body.get("model", None)
        media_type = body.get("media_type", "video")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    print(f"[Debug Summary] 收到 video_path: {video_path}, media_type: {media_type}")

    video_full_path = base_dir / video_path
    subtitle_path = video_full_path.parent / f"{video_full_path.stem}_subtitle.md"

    print(f"[Debug Summary] 字幕文件路径: {subtitle_path}")
    print(f"[Debug Summary] 字幕文件存在: {subtitle_path.exists()}")

    if not subtitle_path.exists():
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": f"字幕文件不存在，请先识别语音。路径: {subtitle_path}"
            }
        )

    content = read_md_file(str(subtitle_path))
    if not content:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "字幕内容为空"
            }
        )

    # 获取当前激活的提供商配置
    config = GLOBAL_CONFIG
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_url = provider_config.get("api_url", "")
    api_key = provider_config.get("api_key", "")

    # 如果没有指定model，使用提供商的默认模型
    if not model:
        model = provider_config.get("default_model", None)

    summary = generate_summary_ai(content, api_url=api_url, api_key=api_key, model=model)

    summary_path = video_full_path.parent / f"{video_full_path.stem}_summary.md"
    summary_md = format_summary_md(video_full_path.stem, summary, str(video_full_path))
    write_md_file(str(summary_path), summary_md)

    return {
        "success": True,
        "content": summary,
        "path": str(summary_path)
    }


@app.post("/api/analysis/generate-notes", response_class=JSONResponse)
async def generate_notes_api(request: Request):
    try:
        body = await request.json()
        video_path = body.get("video_path", "")
        model = body.get("model", None)
        media_type = body.get("media_type", "video")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    print(f"[Debug Notes] 收到 video_path: {video_path}, media_type: {media_type}")

    video_full_path = base_dir / video_path
    subtitle_path = video_full_path.parent / f"{video_full_path.stem}_subtitle.md"

    print(f"[Debug Notes] 字幕文件路径: {subtitle_path}")
    print(f"[Debug Notes] 字幕文件存在: {subtitle_path.exists()}")

    if not subtitle_path.exists():
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": f"字幕文件不存在，请先识别语音。路径: {subtitle_path}"
            }
        )

    content = read_md_file(str(subtitle_path))
    if not content:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "字幕内容为空"
            }
        )

    # 获取当前激活的提供商配置
    config = GLOBAL_CONFIG
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_url = provider_config.get("api_url", "")
    api_key = provider_config.get("api_key", "")

    # 如果没有指定model，使用提供商的默认模型
    if not model:
        model = provider_config.get("default_model", None)

    notes = generate_notes_ai(content, api_url=api_url, api_key=api_key, model=model)

    notes_path = video_full_path.parent / f"{video_full_path.stem}_notes.md"
    notes_md = format_notes_md(video_full_path.stem, notes, str(video_full_path))
    write_md_file(str(notes_path), notes_md)

    return {
        "success": True,
        "content": notes,
        "path": str(notes_path)
    }


@app.post("/api/analysis/generate-outline", response_class=JSONResponse)
async def generate_outline_api(request: Request):
    try:
        body = await request.json()
        video_path = body.get("video_path", "")
        model = body.get("model", None)
        media_type = body.get("media_type", "video")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    print(f"[Debug Outline] 收到 video_path: {video_path}, media_type: {media_type}")

    video_full_path = base_dir / video_path
    subtitle_path = video_full_path.parent / f"{video_full_path.stem}_subtitle.md"
    
    print(f"[Debug Outline] 字幕文件路径: {subtitle_path}")
    print(f"[Debug Outline] 字幕文件存在: {subtitle_path.exists()}")
    
    if not subtitle_path.exists():
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": f"字幕文件不存在，请先识别语音。路径: {subtitle_path}"
            }
        )
    
    content = read_md_file(str(subtitle_path))
    if not content:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "字幕内容为空"
            }
        )
    
    # 获取当前激活的提供商配置
    config = GLOBAL_CONFIG
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_url = provider_config.get("api_url", "")
    api_key = provider_config.get("api_key", "")
    
    # 如果没有指定model，使用提供商的默认模型
    if not model:
        model = provider_config.get("default_model", None)
    
    outline = generate_outline_ai(content, api_url=api_url, api_key=api_key, model=model)
    
    outline_path = video_full_path.parent / f"{video_full_path.stem}_outline.md"
    outline_md = format_outline_md(video_full_path.stem, outline, str(video_full_path))
    write_md_file(str(outline_path), outline_md)
    
    return {
        "success": True,
        "content": outline,
        "path": str(outline_path)
    }


# ============================================================
# 文本分析 API（总结、笔记、大纲）
# ============================================================

@app.get("/api/analysis/subtitle", response_class=JSONResponse)
async def get_subtitle(path: str = "", media_type: str = "video"):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    file_path = base_dir / path
    subtitle_path = file_path.parent / f"{file_path.stem}_subtitle.md"
    
    if not subtitle_path.exists():
        return {
            "success": False,
            "error": "字幕文件不存在"
        }
    
    content = read_md_file(str(subtitle_path))
    return {
        "success": True,
        "content": content,
        "path": str(subtitle_path)
    }


@app.post("/api/analysis/generate", response_class=JSONResponse)
async def generate_analysis(request: Request):
    try:
        body = await request.json()
        video_path = body.get("video_path", "")
        content = body.get("content", "")
        use_ai = body.get("use_ai", True)
        media_type = body.get("media_type", "video")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)
    full_video_path = str(base_dir / video_path)

    result = analyze_and_save(full_video_path, content)

    if result["success"]:
        return {
            "success": True,
            "video_name": result["video_name"],
            "video_dir": result["video_dir"],
            "summary_path": result["summary_path"],
            "notes_path": result["notes_path"],
            "outline_path": result["outline_path"],
            "summary": result["summary"],
            "notes": result["notes"],
            "outline": result["outline"],
            "generated_at": result["generated_at"]
        }
    else:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": result.get("error", "分析失败")
            }
        )


@app.get("/api/analysis/result", response_class=JSONResponse)
@app.get("/api/analysis/get-result", response_class=JSONResponse)
async def get_analysis_result(path: str = "", video_path: str = "", type: str = "summary", media_type: str = "video"):
    # 兼容两种参数名
    video_path = path or video_path
    if not video_path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    video_full_path = base_dir / video_path

    if not video_full_path.exists():
        # 检查是否是带扩展名的路径
        found = False
        for ext in ['.mp4', '.mov', '.avi', '.webm', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac']:
            if (base_dir / (video_path + ext)).exists():
                video_full_path = base_dir / (video_path + ext)
                found = True
                break
        if not found:
            raise HTTPException(status_code=404, detail="文件不存在")
    
    type_map = {
        "summary": f"{video_full_path.stem}_summary.md",
        "notes": f"{video_full_path.stem}_notes.md",
        "outline": f"{video_full_path.stem}_outline.md",
        "subtitle": f"{video_full_path.stem}_subtitle.md"
    }
    
    if type not in type_map:
        raise HTTPException(status_code=400, detail="无效的类型参数")
    
    result_path = video_full_path.parent / type_map[type]
    
    if not result_path.exists():
        return {
            "success": False,
            "error": f"{type} 文件不存在"
        }
    
    content = read_md_file(str(result_path))
    return {
        "success": True,
        "content": content,
        "path": str(result_path),
        "type": type
    }


@app.get("/api/analysis/get-all", response_class=JSONResponse)
async def get_all_analysis(path: str = "", media_type: str = "video"):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type)

    video_path = base_dir / path

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    
    result = {
        "success": True,
        "video_path": str(video_path),
        "video_name": video_path.stem,
        "summary": None,
        "notes": None,
        "outline": None
    }
    
    summary_path = video_path.parent / f"{video_path.stem}_summary.md"
    notes_path = video_path.parent / f"{video_path.stem}_notes.md"
    outline_path = video_path.parent / f"{video_path.stem}_outline.md"
    
    if summary_path.exists():
        result["summary"] = {
            "content": read_md_file(str(summary_path)),
            "path": str(summary_path)
        }
    
    if notes_path.exists():
        result["notes"] = {
            "content": read_md_file(str(notes_path)),
            "path": str(notes_path)
        }
    
    if outline_path.exists():
        result["outline"] = {
            "content": read_md_file(str(outline_path)),
            "path": str(outline_path)
        }
    
    return result


# ============================================================
# 模型和配置管理 API
# ============================================================

@app.get("/api/models", response_class=JSONResponse)
async def get_models(provider: str = None):
    """获取模型列表"""
    try:
        config = GLOBAL_CONFIG
        
        if provider is None:
            provider = config.get("active_provider", "free-ai")
        
        provider_config = config.get("providers", {}).get(provider, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")
        
        if not api_url or not api_key:
            return {
                "success": False,
                "error": f"提供商 {provider} 未配置"
            }
        
        # 获取模型列表
        try:
            response = requests.get(
                f"{api_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                models = data.get("data", [])
                
                # 筛选 opc/* 和 or/* 的模型
                filtered_models = []
                for model in models:
                    model_id = model.get("id", "")
                    if model_id.startswith("opc/") or model_id.startswith("or/"):
                        filtered_models.append({
                            "id": model_id,
                            "name": model_id,
                            "created": model.get("created", 0),
                            "owned_by": model.get("owned_by", "")
                        })
                
                return {
                    "success": True,
                    "models": filtered_models,
                    "provider": provider
                }
            else:
                return {
                    "success": False,
                    "error": f"获取模型列表失败: HTTP {response.status_code}"
                }
        except Exception as e:
            print(f"[Models] 获取模型列表异常: {e}")
            return {
                "success": False,
                "error": f"获取模型列表失败: {str(e)}"
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


@app.get("/api/config/status", response_class=JSONResponse)
async def get_config_status():
    """获取配置状态"""
    config = GLOBAL_CONFIG
    initialized = config.get("initialized", False)
    
    # 检查是否已配置API
    active_provider = config.get("active_provider", "open-ai")
    provider_config = config.get("providers", {}).get(active_provider, {})
    api_configured = bool(
        provider_config.get("api_url", "") and 
        provider_config.get("api_key", "")
    )
    
    return {
        "success": True,
        "initialized": initialized,
        "api_configured": api_configured,
        "active_provider": active_provider
    }


@app.get("/api/config", response_class=JSONResponse)
async def get_config():
    """获取配置"""
    config = GLOBAL_CONFIG
    # 返回配置但隐藏API密钥
    safe_config = {
        "providers": {},
        "active_provider": config.get("active_provider", "open-ai"),
        "initialized": config.get("initialized", False)
    }

    for provider_id, provider in config.get("providers", {}).items():
        safe_config["providers"][provider_id] = {
            "name": provider.get("name", ""),
            "api_url": provider.get("api_url", ""),
            "api_key": "***" if provider.get("api_key", "") else "",
            "models_url": provider.get("models_url", ""),
            "default_model": provider.get("default_model", ""),
            "models": provider.get("models", [])
        }

    return {
        "success": True,
        "config": safe_config
    }


@app.post("/api/config/save", response_class=JSONResponse)
async def save_config_api(request: Request):
    """保存配置"""
    global GLOBAL_CONFIG

    try:
        body = await request.json()
        providers = body.get("providers", {})
        active_provider = body.get("active_provider", "open-ai")
        set_initialized = body.get("set_initialized", False)

        print("[Server] 收到保存配置请求")
        print(f"[Server] 收到的providers: {list(providers.keys())}")
        print(f"[Server] 收到的active_provider: {active_provider}")

        # 合并现有配置
        config = GLOBAL_CONFIG.copy()
        
        # 确保providers字段存在
        if "providers" not in config:
            config["providers"] = {}

        # 更新或添加每个provider
        for provider_id, provider_data in providers.items():
            print(f"[Server] 处理provider: {provider_id}")
            
            if provider_id in config["providers"]:
                # 如果新的API key是***，则保留原有值
                if provider_data.get("api_key", "") == "***":
                    provider_data["api_key"] = config["providers"][provider_id]["api_key"]
                
                # 保留现有models
                if "models" in config["providers"][provider_id] and "models" not in provider_data:
                    provider_data["models"] = config["providers"][provider_id]["models"]
                
                config["providers"][provider_id].update(provider_data)
            else:
                # 添加新的provider
                config["providers"][provider_id] = provider_data

        config["active_provider"] = active_provider
        
        # 设置初始化标记
        if set_initialized:
            config["initialized"] = True

        print(f"[Server] 准备保存配置，providers: {list(config['providers'].keys())}")

        # 保存配置
        if save_config(config):
            GLOBAL_CONFIG = config
            print("[Server] 配置保存成功")
            return {
                "success": True,
                "message": "配置保存成功"
            }
        else:
            print("[Server] 配置保存失败")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": "保存配置失败"
                }
            )
    except Exception as e:
        print(f"[Server] 保存配置异常: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e)
            }
        )


@app.post("/api/knowledge/models/fetch", response_class=JSONResponse)
async def fetch_models_api(request: Request):
    """从API获取模型列表"""
    try:
        body = await request.json()
        api_url = body.get("api_url", "")
        api_key = body.get("api_key", "")
        models_url = body.get("models_url", "")

        result = config_manager.fetch_models_from_api(api_url, api_key, models_url)
        return result
    except Exception as e:
        print(f"[Server] 获取模型列表异常: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/knowledge/models/save", response_class=JSONResponse)
async def save_models_api(request: Request):
    """保存模型列表到配置"""
    global GLOBAL_CONFIG
    try:
        body = await request.json()
        provider_id = body.get("provider_id", "")
        models = body.get("models", [])
        
        if config_manager.save_provider_models(provider_id, models):
            GLOBAL_CONFIG = config_manager.load_config()
            return {"success": True, "message": "模型列表保存成功"}
        else:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "保存模型列表失败"}
            )
    except Exception as e:
        print(f"[Server] 保存模型列表异常: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/knowledge/models", response_class=JSONResponse)
async def get_models_api(provider_id: str = None):
    """获取已保存的模型列表"""
    try:
        if provider_id is None:
            config = GLOBAL_CONFIG
            provider_id = config.get("active_provider")

        models = config_manager.get_provider_models(provider_id)
        return {"success": True, "models": models, "provider_id": provider_id}
    except Exception as e:
        print(f"[Server] 获取模型列表异常: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/model/test", response_class=JSONResponse)
async def test_model_connection(request: Request):
    """测试模型连通性：发送一条最小 chat.completions 请求"""
    import time
    try:
        body = await request.json()
        provider_id = body.get("provider_id")
        model = body.get("model")

        config = config_manager.load_config()
        if not provider_id:
            provider_id = config.get("active_provider", "open-ai")

        provider_config = config.get("providers", {}).get(provider_id, {})
        api_url = provider_config.get("api_url", "")
        api_key = provider_config.get("api_key", "")

        if not api_url or not api_key:
            return {
                "success": False,
                "error": f"提供商 {provider_id} 未配置 API 地址或 Key"
            }

        if not model:
            model = provider_config.get("default_model", "")

        if not model:
            return {
                "success": False,
                "error": f"提供商 {provider_id} 未设置默认模型"
            }

        start = time.time()
        try:
            from openai import OpenAI
            client = OpenAI(base_url=api_url, api_key=api_key, timeout=15.0)
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=10,
            )
            latency_ms = int((time.time() - start) * 1000)
            return {
                "success": True,
                "latency_ms": latency_ms,
                "model": model,
                "provider": provider_id
            }
        except Exception as e:
            return {"success": False, "error": str(e), "model": model, "provider": provider_id}
    except Exception as e:
        print(f"[Server] 测试模型连通性异常: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================
# 启动服务器
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("AI Video Analysis App")
    print("=" * 60)
    print()
    print("服务已启动！")
    print("请在浏览器中访问: http://localhost:8000")
    print()
    print("API 文档: http://localhost:8000/docs")
    print("=" * 60)
    print()
    
    try:
        import subprocess
        subprocess.run(["ffmpeg", "-version"],
                      capture_output=True,
                      text=True,
                      encoding='utf-8',
                      check=True)
    except:
        print("警告: FFmpeg 未安装或不在PATH中")
        print("部分功能可能受限，请安装 FFmpeg: https://ffmpeg.org/download.html")
        print()
    
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        access_log=True
    )