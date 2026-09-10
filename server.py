import uuid
import re
import hashlib
import json
import sys
import os
import subprocess
import asyncio
import requests
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List, Dict, Any
import uvicorn
import logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s  %(message)s')
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, BackgroundTasks
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse, StreamingResponse
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
from app.downloaders.subtitle_service import try_fetch_platform_subtitles

from app.file_operations.file_manager import (
    get_directory_list,
    list_all_subfolders,
    scan_folder_extensions,
    cleanup_folder_keep_extensions,
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
from app.routes.tools import router as tools_router
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
TASK_STATUS_CANCELLED = "cancelled"


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
            "cancel_requested": False,
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


def cancel_task(task_id: str) -> Dict[str, Any]:
    """请求取消任务。返回更新后的任务字典；任务不存在/已终结时返回带 error 的字典"""
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            return {"success": False, "error": "任务不存在"}
        if task["status"] in [TASK_STATUS_COMPLETED, TASK_STATUS_FAILED, TASK_STATUS_CANCELLED]:
            return {"success": False, "error": f"任务已结束（{task['status']}），无法取消"}
        task["cancel_requested"] = True
        task["updated_at"] = time.time()
        return {"success": True, "task": task}


def is_cancel_requested(task_id: str) -> bool:
    with tasks_lock:
        task = tasks.get(task_id)
        return bool(task and task.get("cancel_requested"))


def process_batch_transcribe_task(task_id: str, video_paths: List[str]):
    """处理批量转录任务"""
    update_task(task_id, status=TASK_STATUS_RUNNING, message="开始处理...")
    
    results = []
    total = len(video_paths)
    
    for i, video_path in enumerate(video_paths):
        if is_cancel_requested(task_id):
            update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消", result=results)
            return
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


def process_batch_url_download_task(task_id: str, url_or_items, target_dir: str = "", source_url: str = ""):
    """处理批量URL下载任务，支持items格式或urls列表"""
    update_task(task_id, status=TASK_STATUS_RUNNING, message="开始下载...")
    
    results = []
    # 判断是items格式还是urls列表
    if url_or_items and len(url_or_items) > 0 and isinstance(url_or_items[0], dict):
        # items格式，包含url和filename
        items = url_or_items
        total = len(items)
        
        for i, item in enumerate(items):
            if is_cancel_requested(task_id):
                update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消", result=results)
                return
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

                    # 视频条目尝试获取平台字幕（音频条目跳过）
                    subtitle_fetched = False
                    if source_url and Path(video_path).suffix.lower() in (".mp4", ".webm", ".mkv", ".mov", ".avi"):
                        sub_result = try_fetch_platform_subtitles(source_url, video_path)
                        subtitle_fetched = bool(sub_result.get("fetched"))
                        if subtitle_fetched:
                            update_task(task_id, message=f"正在下载 {i + 1}/{total}（字幕获取成功）")

                    results.append({
                        "url": url,
                        "success": True,
                        "filename": result["filename"],
                        "saved_path": result["saved_path"],
                        "subtitle_fetched": subtitle_fetched
                    })
                else:
                    results.append({
                        "url": url,
                        "success": False,
                        "error": result.get("error", "下载失败"),
                        "subtitle_fetched": False
                    })
                    
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e),
                    "subtitle_fetched": False
                })
    else:
        # 传统的urls列表格式
        urls = url_or_items
        total = len(urls)
        
        for i, url in enumerate(urls):
            if is_cancel_requested(task_id):
                update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消", result=results)
                return
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

                    # 视频条目尝试获取平台字幕（音频条目跳过）
                    subtitle_fetched = False
                    if source_url and Path(video_path).suffix.lower() in (".mp4", ".webm", ".mkv", ".mov", ".avi"):
                        sub_result = try_fetch_platform_subtitles(source_url, video_path)
                        subtitle_fetched = bool(sub_result.get("fetched"))
                        if subtitle_fetched:
                            update_task(task_id, message=f"正在下载 {i + 1}/{total}（字幕获取成功）")

                    results.append({
                        "url": url,
                        "success": True,
                        "filename": result["filename"],
                        "saved_path": result["saved_path"],
                        "subtitle_fetched": subtitle_fetched
                    })
                else:
                    results.append({
                        "url": url,
                        "success": False,
                        "error": result.get("error", "下载失败"),
                        "subtitle_fetched": False
                    })
                    
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e),
                    "subtitle_fetched": False
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
import app.config.config_manager as config_manager

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

# ============================================================
# CORS 中间件
# LAN 内网工具：通配 origin 即可；为合法化配置必须 allow_credentials=False
# （按 CORS 规范，allow_credentials=True 时 origin 不能是通配符 *）
# ============================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # 关键：false（通配 origin 不能配 true，否则部分浏览器会静默拒绝）
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Range",        # Range 媒体响应需要暴露给 JS
        "Accept-Ranges",
        "Content-Length",
        "Content-Disposition",
    ],
    max_age=3600,              # 预检结果缓存 1 小时，减少 OPTIONS 请求
)

# 静态文件服务（带强缓存头，减少首页 ~25 个资源 304 校验的往返开销）
app.mount("/static", CachedStaticFiles(directory="web/static"), name="static")

# ============================================================
# 方案 F'：BUILD_ID（启动时基于静态资源 mtime 算 hash）
# 用途：自动注入到入口 HTML 的 ?v=<BUILD_ID>，避免手动维护版本号
# 原理：内容不变 → mtime 不变 → hash 不变 → 浏览器缓存命中
#       内容变化 → 重启服务 → mtime 重算 → hash 变化 → 浏览器拉新
# ============================================================
def _calc_build_id() -> str:
    """遍历 web/static 下所有文件，按 (相对路径 + mtime_ns) 算 MD5，截断 8 位"""
    h = hashlib.md5()
    base = Path("web/static")
    if not base.exists():
        return "00000000"
    for f in sorted(base.rglob("*")):
        if f.is_file():
            try:
                rel = str(f.relative_to(base)).encode("utf-8")
                mtime = str(f.stat().st_mtime_ns).encode("utf-8")
                h.update(rel)
                h.update(b"\x00")
                h.update(mtime)
                h.update(b"\x00")
            except OSError:
                # 文件可能在遍历过程中被修改/删除，跳过即可
                continue
    return h.hexdigest()[:8]


BUILD_ID = _calc_build_id()
print(f"[BUILD] BUILD_ID = {BUILD_ID}  (web/static 内容指纹)")


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

# 注册工具路由（第一财经视频链接获取等）
app.include_router(tools_router)

# ============================================================
# 主页路由
# ============================================================

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """静默处理 favicon 请求，避免 404 噪声日志。
    浏览器默认每个页面都会请求 favicon.ico，返回 204 让浏览器停止重试。"""
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """主页（方案 F'：注入 BUILD_ID，HTML 入口永远走协商缓存）"""
    response = templates.TemplateResponse(
        request,
        "index.html",
        {"build_id": BUILD_ID},
    )
    # 入口 HTML 必须每次回服务器校验，确保 ?v=BUILD_ID 拿到最新值
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

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
# 一键清理：路径解析（支持任意绝对路径，含 base_dir 外目录）
# ============================================================
def _is_dangerous_path(target_dir: Path) -> bool:
    """
    检查路径是否属于禁止清理的「危险目录」：
    - 磁盘根目录（如 C:\）
    - Windows / Program Files / ProgramData 等系统目录
    - Linux / macOS 的系统目录
    """
    try:
        target_str = str(target_dir.resolve()).replace('/', '\\').lower().rstrip('\\')
    except Exception:
        return True
    if sys.platform.startswith('win'):
        # 磁盘根目录
        try:
            if target_dir.drive and (target_dir == Path(target_dir.drive + '\\') or len(target_dir.parts) == 1):
                return True
        except Exception:
            pass
        # 系统目录（按环境变量动态取）
        dangerous_env_keys = [
            'SystemRoot', 'windir',
            'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
            'ProgramData', 'ALLUSERSPROFILE',
            'ComSpec',
        ]
        for key in dangerous_env_keys:
            val = (os.environ.get(key) or '').strip()
            if not val:
                continue
            val_norm = val.replace('/', '\\').lower().rstrip('\\')
            # 跳过只到盘符级别的环境变量（如 SystemDrive=C:），避免误伤整盘
            if len(val_norm) <= 3 and val_norm.endswith(':'):
                continue
            if target_str == val_norm or target_str.startswith(val_norm + '\\'):
                return True
        # 兜底：常见系统目录
        for hardcoded in [r'c:\windows', r'c:\program files', r'c:\program files (x86)', r'c:\programdata']:
            if target_str == hardcoded or target_str.startswith(hardcoded + '\\'):
                return True
    else:
        # Linux / macOS
        target_unix = str(target_dir.resolve()).replace('\\', '/').rstrip('/')
        if target_unix == '' or target_unix == '/':
            return True
        for prefix in ['/etc', '/usr', '/var', '/boot', '/bin', '/sbin',
                       '/lib', '/lib64', '/opt', '/proc', '/sys', '/dev',
                       '/System', '/Library', '/Applications', '/private',
                       '/snap', '/run']:
            if target_unix == prefix or target_unix.startswith(prefix + '/'):
                return True
    return False


def _resolve_target_path(path: str, media_type: str) -> dict:
    """
    解析目标路径，支持：
    - 相对路径：拼接到 base_dir（与 tree 选择一致）
    - 绝对路径：直接使用（全盘任意位置均可）
    返回 dict：
      {
        base_dir, target_dir, is_outside_base_dir, is_dangerous, error
      }
    """
    if media_type not in ("video", "audio"):
        media_type = "video"
    base_dir = get_base_dir(media_type).resolve()
    raw = (path or "").strip()
    if raw and os.path.isabs(raw):
        target_dir = Path(raw).resolve()
    else:
        target_dir = (base_dir / raw).resolve() if raw else base_dir
    is_outside_base_dir = (target_dir != base_dir and base_dir not in target_dir.parents)
    is_dangerous = _is_dangerous_path(target_dir)
    if is_dangerous:
        return {
            "base_dir": str(base_dir),
            "target_dir": str(target_dir),
            "is_outside_base_dir": is_outside_base_dir,
            "is_dangerous": True,
            "error": JSONResponse(
                status_code=400,
                content={"success": False, "error": f"目标文件夹 {target_dir} 属于系统目录或磁盘根目录，禁止清理"},
            ),
        }
    return {
        "base_dir": str(base_dir),
        "target_dir": str(target_dir),
        "is_outside_base_dir": is_outside_base_dir,
        "is_dangerous": False,
        "error": None,
    }


# 兼容旧调用：返回 (base_dir, target_dir, err) 三元组
def _resolve_safe_path(path: str, media_type: str):
    info = _resolve_target_path(path, media_type)
    if info["error"]:
        return info["base_dir"], None, info["error"]
    return info["base_dir"], Path(info["target_dir"]), None


@app.get("/api/files/types", response_class=JSONResponse)
async def list_folder_file_types(path: str = "", media_type: str = "video"):
    """
    扫描指定文件夹中所有文件的扩展名（仅本层，不递归），并返回每个扩展名的文件数。
    用于「一键清理」弹窗动态生成文件类型下拉选项。
    """
    if media_type not in ("video", "audio"):
        media_type = "video"
    info = _resolve_target_path(path, media_type)
    if info["error"]:
        return info["error"]
    target_dir = Path(info["target_dir"])
    if not target_dir.exists() or not target_dir.is_dir():
        return JSONResponse(
            status_code=404,
            content={"success": False, "error": "文件夹不存在"},
        )

    scan = scan_folder_extensions(path, media_type=media_type)
    return {
        "success": True,
        "path": path,
        "media_type": media_type,
        "base_dir": info["base_dir"],
        "target_dir": info["target_dir"],
        "is_outside_base_dir": info["is_outside_base_dir"],
        "is_dangerous": info["is_dangerous"],
        "total_files": scan["total_files"],
        "extensions": scan["extensions"],
    }


# ============================================================
# 一键清理：列出所有子目录（用于下拉选择）
# ============================================================
@app.get("/api/files/all-folders", response_class=JSONResponse)
async def list_all_folders(path: str = "", media_type: str = "video"):
    """递归列出指定目录下的所有子目录（不含自身），供一键清理弹窗下拉使用"""
    if media_type not in ("video", "audio"):
        media_type = "video"
    info = _resolve_target_path(path, media_type)
    if info["error"]:
        return info["error"]
    target_dir = Path(info["target_dir"])
    if not target_dir.exists() or not target_dir.is_dir():
        return JSONResponse(
            status_code=404,
            content={"success": False, "error": "文件夹不存在"},
        )
    folders = list_all_subfolders(path, media_type=media_type)
    return {
        "success": True,
        "path": path,
        "media_type": media_type,
        "base_dir": info["base_dir"],
        "is_outside_base_dir": info["is_outside_base_dir"],
        "folders": folders,
    }


# ============================================================
# 一键清理：按保留后缀删除文件夹内其他文件
# ============================================================
class CleanupRequest(BaseModel):
    path: str = ""
    media_type: str = "video"
    keep_extensions: List[str] = []


@app.post("/api/files/cleanup", response_class=JSONResponse)
async def cleanup_folder_files(req: CleanupRequest):
    """
    仅处理当前文件夹（非递归），删除扩展名不在 keep_extensions 列表中的文件。
    keep_extensions 示例：['.md'] 表示只保留 .md 文件。
    """
    if req.media_type not in ("video", "audio"):
        req.media_type = "video"
    _, target_dir, err = _resolve_safe_path(req.path, req.media_type)
    if err:
        return err
    if not target_dir.exists() or not target_dir.is_dir():
        return JSONResponse(
            status_code=404,
            content={"success": False, "error": "文件夹不存在"},
        )

    result = cleanup_folder_keep_extensions(
        req.path, req.keep_extensions or [], media_type=req.media_type
    )
    keep_set = set()
    for e in req.keep_extensions or []:
        if not e:
            continue
        v = e.strip().lower()
        if not v:
            continue
        if not v.startswith("."):
            v = "." + v
        keep_set.add(v)

    return {
        "success": True,
        "path": req.path,
        "media_type": req.media_type,
        "kept_extensions": sorted(keep_set),
        "deleted_count": len(result["deleted"]),
        "kept_count": len(result["kept"]),
        "deleted": result["deleted"],
        "kept": result["kept"],
        "errors": result["errors"],
    }


# ============================================================
# 一键清理：弹出本地资源管理器选目录
# ============================================================
def _pick_folder_windows() -> str:
    """Windows 下调用 PowerShell + FolderBrowserDialog 弹出本地选目录对话框，返回用户选择的绝对路径，未选择则返回空串"""
    # 显式设置 PowerShell 输出编码为 UTF-8，避免中文路径在 Python 端被错误解码
    ps_script = (
        "$OutputEncoding = [System.Text.Encoding]::UTF8; "
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null; "
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$f.Description = '请选择要清理的文件夹（系统目录、磁盘根目录除外）'; "
        "$f.ShowNewFolderButton = $false; "
        "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
        "Write-Output $f.SelectedPath; "
        "}"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    return (result.stdout or "").strip()


def _pick_folder_linux() -> str:
    """Linux 下用 zenity/kdialog 弹目录选择对话框，失败则返回空串"""
    for cmd in (["zenity", "--file-selection", "--directory"],
                ["kdialog", "--getexistingdirectory"]):
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
            )
            if result.returncode == 0:
                return (result.stdout or "").strip()
        except FileNotFoundError:
            continue
        except Exception:
            continue
    return ""


@app.post("/api/files/pick-folder", response_class=JSONResponse)
async def pick_folder():
    """
    弹出本地操作系统的资源管理器选目录对话框，返回用户选择的绝对路径。
    - Windows: PowerShell + FolderBrowserDialog
    - Linux: zenity / kdialog
    - macOS: 暂未实现，返回明确错误
    """
    if sys.platform.startswith("win"):
        try:
            path = await asyncio.get_event_loop().run_in_executor(
                None, _pick_folder_windows
            )
            if not path:
                return {"success": False, "cancelled": True, "path": ""}
            return {"success": True, "cancelled": False, "path": path}
        except subprocess.TimeoutExpired:
            return JSONResponse(
                status_code=408,
                content={"success": False, "error": "选目录超时"},
            )
        except Exception as e:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": f"弹窗失败: {e}"},
            )
    elif sys.platform.startswith("linux"):
        try:
            path = await asyncio.get_event_loop().run_in_executor(
                None, _pick_folder_linux
            )
            if not path:
                return {"success": False, "cancelled": True, "path": ""}
            return {"success": True, "cancelled": False, "path": path}
        except Exception as e:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": f"弹窗失败: {e}"},
            )
    else:
        return JSONResponse(
            status_code=501,
            content={"success": False, "error": f"当前平台 {sys.platform} 暂不支持弹窗选目录"},
        )


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
async def upload_video_by_url(request: Request):
    try:
        body = await request.json()
        url = body.get("url", "")
        target_dir = body.get("target_dir", "")
        filename = body.get("filename", "")
        media_type = body.get("media_type", "video")
        source_url = body.get("source_url", "")
    except Exception:
        raise HTTPException(status_code=400, detail="请求参数解析失败")

    if not url:
        raise HTTPException(status_code=400, detail="URL不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"

    result = save_url_file(url, target_dir, filename, media_type=media_type)

    if result["success"]:
        full_path = str(result["file_path"])
        subtitle_fetched = False
        if media_type == "video":
            thumbnail_path = full_path.replace(".mp4", ".jpg")
            extract_thumbnail(full_path, thumbnail_path)
            # 尝试获取平台字幕（如B站）
            sub_result = try_fetch_platform_subtitles(source_url, full_path)
            subtitle_fetched = bool(sub_result.get("fetched"))

        return {
            "success": True,
            "filename": result["filename"],
            "saved_path": result["saved_path"],
            "media_type": media_type,
            "duration": result.get("duration", 0),
            "size": result.get("size", 0),
            "subtitle_fetched": subtitle_fetched,
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


# 媒体流分块大小（1MB），控制单次 read 的 IO 开销与内存占用
_MEDIA_CHUNK_SIZE = 1024 * 1024


async def _range_stream(file_path: Path, start: int, end: int):
    """按字节范围流式发送文件，避免一次性读入内存"""
    with open(file_path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(_MEDIA_CHUNK_SIZE, remaining))
            if not chunk:
                break
            yield chunk
            remaining -= len(chunk)


# ============================================================
# 健康检查端点（用于非本地设备快速验证服务可达性）
# ============================================================
@app.get("/api/health", response_class=JSONResponse)
async def health_check():
    """服务健康检查 + 数据目录自检"""
    try:
        video_files = sum(1 for _ in VIDEO_DIR.rglob("*") if _.is_file())
    except Exception as e:
        video_files = -1
    try:
        audio_files = sum(1 for _ in AUDIO_DIR.rglob("*") if _.is_file())
    except Exception as e:
        audio_files = -1
    return {
        "success": True,
        "data": {
            "status": "ok",
            "build_id": BUILD_ID,
            "video_dir": str(VIDEO_DIR),
            "video_dir_exists": VIDEO_DIR.exists(),
            "video_file_count": video_files,
            "audio_dir": str(AUDIO_DIR),
            "audio_dir_exists": AUDIO_DIR.exists(),
            "audio_file_count": audio_files,
        },
        "message": "服务正常"
    }


# ============================================================
# 媒体端点显式 OPTIONS 预检（兜底）
# 部分浏览器对 Range 请求会先发 OPTIONS 预检；CORSMiddleware 通常会自动处理，
# 但显式声明可避免边界情况被拦截
# ============================================================
@app.options("/api/video/{path:path}")
async def video_options(path: str):
    """媒体端点 OPTIONS 预检兜底"""
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type, Accept",
            "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
            "Access-Control-Max-Age": "3600",
        },
    )


@app.get("/api/video/{path:path}")
async def get_video(request: Request, path: str, thumbnail: bool = False, media_type: str = "video"):
    """
    媒体文件下载/播放端点（支持 HTTP Range 请求）。

    非本地设备/移动网络下必须支持 Range 才能：
      - 流畅拖动 <video>/<audio> 进度条（避免重新下载整个文件）
      - 渐进式播放（边下边播）
      - 大文件不被一次性加载撑爆内存

    响应头必须包含 Accept-Ranges: bytes，浏览器才知道支持。
    """
    print(f"[Server] 请求媒体文件: path={path}, thumbnail={thumbnail}, media_type={media_type}")
    if media_type not in ("video", "audio"):
        media_type = "video"
    file_path = get_file_path(path, media_type=media_type)
    print(f"[Server] 完整文件路径: {file_path}")
    print(f"[Server] 文件是否存在: {file_path.exists()}")

    # 缩略图直接走 FileResponse（小文件，无须 Range）
    if thumbnail:
        thumbnail_path = file_path.parent / f"{file_path.stem}.jpg"
        if thumbnail_path.exists():
            return FileResponse(thumbnail_path, media_type="image/jpeg")
        raise HTTPException(status_code=404, detail="缩略图不存在")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    suffix = file_path.suffix.lower()
    media_types = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
    }
    content_type = media_types.get(suffix, "application/octet-stream")

    file_size = file_path.stat().st_size

    # 解析 Range: bytes=start-end
    range_header = request.headers.get("range", "").strip()
    range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)

    common_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=3600",
    }

    if range_match:
        start = int(range_match.group(1))
        end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
        # 边界保护
        end = min(end, file_size - 1)
        if start > end or start >= file_size:
            raise HTTPException(
                status_code=416,
                detail="Requested range not satisfiable",
                headers={"Content-Range": f"bytes */{file_size}"},
            )
        length = end - start + 1
        return StreamingResponse(
            _range_stream(file_path, start, end),
            status_code=206,  # Partial Content
            headers={
                **common_headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(length),
            },
        )

    # 无 Range 头：返回完整文件（200 OK）
    return StreamingResponse(
        _range_stream(file_path, 0, file_size - 1),
        status_code=200,
        headers={**common_headers, "Content-Length": str(file_size)},
    )


@app.post("/api/video/analyze", response_class=JSONResponse)
async def analyze_video(path: str = "", background_tasks: BackgroundTasks = None, media_type: str = "video", force: bool = False):
    if not path:
        raise HTTPException(status_code=400, detail="路径不能为空")

    if media_type not in ("video", "audio"):
        media_type = "video"

    base_dir = get_base_dir(media_type)
    file_path = base_dir / path

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    # 创建异步任务
    task_id = create_task("video_transcribe", {"path": path, "media_type": media_type, "force": force})

    # 后台执行任务
    if background_tasks:
        background_tasks.add_task(process_video_transcribe_task, task_id, str(file_path), media_type, force)

    return {
        "success": True,
        "task_id": task_id,
        "media_type": media_type,
        "message": "转录任务已启动"
    }


def process_video_transcribe_task(task_id: str, video_path: str, media_type: str = "video", force: bool = False):
    """处理视频/音频转录任务"""
    cancel_check = lambda: is_cancel_requested(task_id)
    try:
        video_file = Path(video_path)

        # 如果调用方传了 media_type，以 media_type 为准；否则用扩展名判断
        if media_type not in ("video", "audio"):
            media_type = "audio" if is_audio_file(video_file) else "video"

        base_dir = get_base_dir(media_type)

        # 0. 短路：已存在字幕文件且未强制重跑时，跳过语音识别
        subtitle_path = Path(video_path).parent / f"{Path(video_path).stem}_subtitle.md"
        if not force and subtitle_path.exists():
            try:
                content = subtitle_path.read_text(encoding="utf-8")
            except Exception:
                content = ""
            update_task(task_id, status=TASK_STATUS_COMPLETED, progress=100,
                        message="已有字幕，跳过语音识别", result={
                            "path": str(Path(video_path).relative_to(base_dir)) if str(Path(video_path)).startswith(str(base_dir)) else Path(video_path).name,
                            "transcript": content,
                            "source": "subtitle",
                            "media_type": media_type,
                        })
            return

        # 1. 视频转 MP3 - 音频文件走旁路
        if media_type == "audio":
            update_task(task_id, status=TASK_STATUS_RUNNING, progress=5, message="检测到音频文件，跳过转码...")
            # 已经是 mp3 则直接使用；其他音频通过 video_to_audio 转 mp3
            if video_file.suffix.lower() == ".mp3":
                audio_path = str(video_file)
            else:
                audio_path = str(video_file.with_suffix(".mp3"))
                convert_success, error_msg = video_to_audio(str(video_file), audio_path, cancel_check=cancel_check)
                if not convert_success:
                    if error_msg == "已取消":
                        update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消")
                        return
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
            convert_success, error_msg = video_to_audio(str(video_file), audio_path, cancel_check=cancel_check)
            if not convert_success:
                if error_msg == "已取消":
                    update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消")
                    return
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

        result = transcribe_audio(audio_path, language="auto", progress_callback=progress_callback, cancel_check=cancel_check)

        if result.get("cancelled"):
            update_task(task_id, status=TASK_STATUS_CANCELLED, message="任务已取消")
            return

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
        source_url = body.get("source_url", "")
        
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
        background_tasks.add_task(process_batch_url_download_task, task_id, items if items else urls, target_dir, source_url)
        
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


@app.post("/api/tasks/{task_id}/cancel", response_class=JSONResponse)
async def cancel_task_endpoint(task_id: str):
    """请求取消任务"""
    result = cancel_task(task_id)
    if not result.get("success"):
        status_code = 404 if "不存在" in result.get("error", "") else 409
        return JSONResponse(status_code=status_code, content={"success": False, "error": result.get("error")})
    return {"success": True, "task": result["task"]}


@app.get("/api/tasks/{task_id}/stream")
async def stream_task_progress(task_id: str, request: Request):
    """SSE 实时推送任务状态"""
    import asyncio

    async def event_generator():
        last_snapshot = None
        while True:
            if await request.is_disconnected():
                return
            task = get_task(task_id)
            if task is None:
                yield f"event: end\ndata: {json.dumps({'error': '任务不存在'}, ensure_ascii=False)}\n\n"
                return
            snapshot = {
                "id": task.get("id"),
                "type": task.get("type"),
                "status": task.get("status"),
                "progress": task.get("progress", 0),
                "message": task.get("message", ""),
                "result": task.get("result"),
            }
            if snapshot != last_snapshot:
                yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
                last_snapshot = snapshot
            if task.get("status") in [TASK_STATUS_COMPLETED, TASK_STATUS_FAILED, TASK_STATUS_CANCELLED]:
                yield "event: end\ndata: {}\n\n"
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


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

@app.get("/api/knowledge/models", response_class=JSONResponse)
async def get_models_api(provider_id: str = None, source: str = "saved"):
    """获取模型列表

    source:
        - "saved"  : 返回 config_manager 中已保存的模型列表（默认）
        - "remote" : 从远程 API 实时获取模型列表（/api/models 别名调用）
    """
    try:
        if provider_id is None:
            config = GLOBAL_CONFIG
            provider_id = config.get("active_provider")

        if source == "remote":
            # 从远程 API 实时拉取模型列表
            config = GLOBAL_CONFIG
            provider_config = config.get("providers", {}).get(provider_id, {})
            api_url = provider_config.get("api_url", "")
            api_key = provider_config.get("api_key", "")

            if not api_url or not api_key:
                return {
                    "success": False,
                    "error": f"提供商 {provider_id} 未配置"
                }

            try:
                response = requests.get(
                    f"{api_url}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10
                )
                if response.status_code == 200:
                    data = response.json()
                    models = data.get("data", [])
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
                        "provider_id": provider_id
                    }
                else:
                    return {
                        "success": False,
                        "error": f"获取模型列表失败: HTTP {response.status_code}"
                    }
            except Exception as e:
                print(f"[Models] 远程获取模型列表异常: {e}")
                return {
                    "success": False,
                    "error": f"获取模型列表失败: {str(e)}"
                }
        else:
            # source == "saved"：从 config_manager 取已保存的模型
            models = config_manager.get_provider_models(provider_id)
            return {"success": True, "models": models, "provider_id": provider_id}
    except Exception as e:
        print(f"[Server] 获取模型列表异常: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# /api/models 改为 /api/knowledge/models?source=remote 的别名（统一收敛）
@app.get("/api/models", response_class=JSONResponse)
async def get_models(provider: str = None):
    """实时获取远程模型列表（统一收敛到 /api/knowledge/models?source=remote）"""
    return await get_models_api(provider_id=provider, source="remote")


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


# /api/knowledge/models 路由已在上方 get_models_api(...) 统一定义（合并 remote + saved 两种 source）
# 此处不再重复定义 handler，避免路由冲突


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