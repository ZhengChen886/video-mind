import uuid
import shutil
import json
import requests
import asyncio
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List, Dict, Any
import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


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
    VIDEO_DIR
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
            
            # 视频转音频
            audio_path = str(full_path).replace(".mp4", ".mp3")
            video_to_audio(str(full_path), audio_path)
            
            # 语音转文字
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

# 静态文件服务
app.mount("/static", StaticFiles(directory="web/static"), name="static")

# 模板配置
templates = Jinja2Templates(directory="web/templates")

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
# 全部视频列表
@app.get("/api/files", response_class=JSONResponse)
async def list_files(path: str = ""):
    items = get_directory_list(path)
    return {
        "success": True,
        "path": path,
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
async def create_new_directory(request: Request = None, path: str = "", name: str = ""):
    # 兼容两种调用方式
    if request:
        try:
            body = await request.json()
            if "path" in body:
                path = body.get("path", "")
            if "name" in body:
                name = body.get("name", "")
        except Exception:
            pass
    if not name.strip():
        raise HTTPException(status_code=400, detail="目录名称不能为空")
    
    success = create_directory(path, name)
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
    except Exception:
        path = ""
    
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    success = delete_item(path)
    if success:
        return {
            "success": True,
            "message": "删除成功"
        }
    else:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "删除失败"
            }
        )


@app.post("/api/item/move", response_class=JSONResponse)
async def move_item_api(request: Request):
    try:
        body = await request.json()
        source_path = body.get("source_path", "")
        target_dir = body.get("target_dir", "")
    except Exception:
        source_path = ""
        target_dir = ""

    if not source_path:
        raise HTTPException(status_code=400, detail="源路径不能为空")

    result = move_item(source_path, target_dir)
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
    except Exception:
        path = ""
        new_name = ""

    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    if not new_name:
        raise HTTPException(status_code=400, detail="新名称不能为空")

    result = rename_item(path, new_name)
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
async def upload_video(file: UploadFile = File(...), path: str = ""):
    if not file.filename:
        raise HTTPException(status_code=400, detail="未提供文件名")
    
    try:
        filename = await save_video_file(file, target_dir=path)
        
        video_path = str(VIDEO_DIR / filename)
        thumbnail_path = video_path.replace(".mp4", ".jpg")
        extract_thumbnail(video_path, thumbnail_path)
        
        return {
            "success": True,
            "filename": filename,
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
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")
    
    if not url:
        raise HTTPException(status_code=400, detail="URL不能为空")
    
    result = save_url_file(url, target_dir, filename)
    
    if result["success"]:
        video_path = str(result["file_path"])
        thumbnail_path = video_path.replace(".mp4", ".jpg")
        extract_thumbnail(video_path, thumbnail_path)
        
        return {
            "success": True,
            "filename": result["filename"],
            "saved_path": result["saved_path"],
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
async def get_video(path: str, thumbnail: bool = False):
    file_path = get_file_path(path)
    
    # 如果请求缩略图，返回对应的jpg文件
    if thumbnail:
        thumbnail_path = file_path.parent / f"{file_path.stem}.jpg"
        if thumbnail_path.exists():
            return FileResponse(thumbnail_path, media_type="image/jpeg")
        else:
            raise HTTPException(status_code=404, detail="缩略图不存在")
    
    if file_path.suffix.lower() == ".mp4":
        return FileResponse(file_path, media_type="video/mp4")
    elif file_path.suffix.lower() == ".jpg":
        return FileResponse(file_path, media_type="image/jpeg")
    else:
        raise HTTPException(status_code=404, detail="文件不存在")


@app.post("/api/video/analyze", response_class=JSONResponse)
async def analyze_video(path: str = "", background_tasks: BackgroundTasks = None):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    video_path = VIDEO_DIR / path

    if not video_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    
    # 创建异步任务
    task_id = create_task("video_transcribe", {"path": path})
    
    # 后台执行任务
    if background_tasks:
        background_tasks.add_task(process_video_transcribe_task, task_id, str(video_path))
    
    return {
        "success": True,
        "task_id": task_id,
        "message": "转录任务已启动"
    }


def process_video_transcribe_task(task_id: str, video_path: str):
    """处理视频转录任务"""
    try:
        update_task(task_id, status=TASK_STATUS_RUNNING, progress=5, message="正在转换视频到音频...")
        
        audio_path = video_path.replace(".mp4", ".mp3")
        video_to_audio(video_path, audio_path)
        
        update_task(task_id, status=TASK_STATUS_RUNNING, progress=20, message="音频转换完成，开始语音识别...")
        
        # 进度回调函数
        def progress_callback(phase, progress, message):
            # 阶段映射到进度范围
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
                "path": str(Path(video_path).relative_to(VIDEO_DIR)),
                "transcript": result["text"],
                "duration": get_video_duration(video_path),
                "language": result.get("language", "unknown")
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
async def upload_batch(files: List[UploadFile] = File(...), path: str = ""):
    """批量上传文件"""
    results = []
    
    for file in files:
        try:
            filename = await save_video_file(file, target_dir=path)
            
            video_path = str(filename)
            thumbnail_path = video_path.replace(".mp4", ".jpg")
            extract_thumbnail(video_path, thumbnail_path)
            
            results.append({
                "filename": file.filename,
                "success": True,
                "saved_path": str(filename.relative_to(VIDEO_DIR))
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
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")
    
    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")
    
    print(f"[Debug Summary] 收到 video_path: {video_path}")
    
    video_full_path = VIDEO_DIR / video_path
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
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")
    
    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")
    
    print(f"[Debug Notes] 收到 video_path: {video_path}")
    
    video_full_path = VIDEO_DIR / video_path
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
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")
    
    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")
    
    print(f"[Debug Outline] 收到 video_path: {video_path}")
    
    video_full_path = VIDEO_DIR / video_path
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
async def get_subtitle(path: str = ""):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    video_path = VIDEO_DIR / path
    subtitle_path = video_path.parent / f"{video_path.stem}_subtitle.md"
    
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
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")
    
    if not video_path:
        raise HTTPException(status_code=400, detail="视频路径不能为空")
    
    result = analyze_and_save(video_path, content)
    
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
async def get_analysis_result(path: str = "", video_path: str = "", type: str = "summary"):
    # 兼容两种参数名
    video_path = path or video_path
    if not video_path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    video_full_path = VIDEO_DIR / video_path
    
    if not video_full_path.exists():
        # 检查是否是带扩展名的路径
        found = False
        for ext in ['.mp4', '.mov', '.avi', '.webm']:
            if (VIDEO_DIR / (video_path + ext)).exists():
                video_full_path = VIDEO_DIR / (video_path + ext)
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
async def get_all_analysis(path: str = ""):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")
    
    video_path = VIDEO_DIR / path
    
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
            "default_model": provider.get("default_model", "")
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

        # 合并现有配置
        config = GLOBAL_CONFIG.copy()

        for provider_id, provider_data in providers.items():
            if provider_id in config["providers"]:
                # 如果新的API key是***，则保留原有值
                if provider_data.get("api_key", "") == "***":
                    provider_data["api_key"] = config["providers"][provider_id]["api_key"]
                config["providers"][provider_id].update(provider_data)

        config["active_provider"] = active_provider
        
        # 设置初始化标记
        if set_initialized:
            config["initialized"] = True

        # 保存配置
        if save_config(config):
            GLOBAL_CONFIG = config
            return {
                "success": True,
                "message": "配置保存成功"
            }
        else:
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": "保存配置失败"
                }
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(e)
            }
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