import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import List, Dict, Any


def get_video_duration(video_path: str) -> float:
    """
    获取视频文件的时长
    
    Args:
        video_path: 视频文件路径
        
    Returns:
        视频时长（秒）
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True,
            text=True,
            encoding='utf-8'
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception as e:
        print(f"[File Manager] 获取视频时长失败: {e}")
    return 0.0

# 默认视频存储目录
VIDEO_DIR = Path(__file__).parent / "mp4"

# 支持的视频格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".webm", ".mov", ".avi", ".wmv", ".flv", ".mkv"}

# 支持的文档格式
SUPPORTED_DOCUMENT_EXTENSIONS = {".md", ".pdf", ".doc", ".docx", ".txt", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".odt"}


def init_video_dir():
    """初始化视频存储目录，创建默认子目录"""
    default_dirs = ["未分类", "学习资料", "会议记录", "个人收藏"]
    
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    
    for dir_name in default_dirs:
        (VIDEO_DIR / dir_name).mkdir(exist_ok=True)


def get_directory_list(path: str = "") -> List[Dict[str, Any]]:
    """
    获取指定目录下的文件和子目录列表
    
    Args:
        path: 相对路径，默认为根目录（mp4/）
    
    Returns:
        目录和文件列表
    """
    full_path = VIDEO_DIR / path
    items = []
    
    if not full_path.exists() or not full_path.is_dir():
        return items
    
    for item in sorted(full_path.iterdir()):
        if item.is_dir():
            items.append({
                "name": item.name,
                "path": str(item.relative_to(VIDEO_DIR)),
                "type": "directory",
                "size": 0,
                "modified": item.stat().st_mtime
            })
        elif item.is_file() and item.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
            items.append({
                "name": item.name,
                "path": str(item.relative_to(VIDEO_DIR)),
                "type": "file",
                "size": item.stat().st_size,
                "modified": item.stat().st_mtime,
                "extension": item.suffix.lower()
            })
    
    return items


def create_directory(path: str, name: str) -> bool:
    """
    在指定路径下创建新目录
    
    Args:
        path: 父目录相对路径
        name: 新目录名称
    
    Returns:
        是否创建成功
    """
    try:
        new_dir = VIDEO_DIR / path / name
        if new_dir.exists():
            return False
        new_dir.mkdir(parents=True)
        return True
    except Exception:
        return False


def delete_item(path: str) -> bool:
    """
    删除文件或目录

    Args:
        path: 要删除的文件或目录的相对路径

    Returns:
        是否删除成功
    """
    try:
        full_path = VIDEO_DIR / path
        if full_path.is_dir():
            shutil.rmtree(full_path)
        elif full_path.is_file():
            os.remove(full_path)
        else:
            return False
        return True
    except Exception:
        return False


def find_related_files(video_path: Path) -> List[Path]:
    """
    查找与视频相关的所有文件

    Args:
        video_path: 视频文件的完整路径

    Returns:
        相关文件的完整路径列表
    """
    related_files = []
    parent_dir = video_path.parent
    base_name = video_path.stem

    # 相关文件后缀模式
    related_suffixes = [
        ".mp3",
        ".jpg",
        "_subtitle.md",
        "_summary.md",
        "_notes.md",
        "_outline.md"
    ]

    # 查找所有相关文件
    for suffix in related_suffixes:
        related_file = parent_dir / (base_name + suffix)
        if related_file.exists():
            related_files.append(related_file)

    return related_files


def move_item(source_path: str, target_dir: str) -> Dict[str, Any]:
    """
    移动文件或目录到目标目录，同时处理视频相关文件

    Args:
        source_path: 源文件或目录的相对路径
        target_dir: 目标目录的相对路径

    Returns:
        包含成功状态和错误信息的字典
    """
    try:
        source_full = VIDEO_DIR / source_path
        target_full = VIDEO_DIR / target_dir

        if not source_full.exists():
            return {"success": False, "error": "源文件或目录不存在"}

        target_full.mkdir(parents=True, exist_ok=True)
        
        # 如果是文件且是视频文件，查找相关文件
        files_to_move = [source_full]
        if source_full.is_file() and source_full.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
            related_files = find_related_files(source_full)
            files_to_move.extend(related_files)

        # 移动所有文件
        moved_files = []
        for file_path in files_to_move:
            target_path = target_full / file_path.name
            
            # 处理重名情况
            if target_path.exists():
                counter = 1
                base = file_path.stem
                ext = file_path.suffix
                while target_path.exists():
                    new_name = f"{base}_{counter}{ext}"
                    target_path = target_full / new_name
                    counter += 1

            shutil.move(str(file_path), str(target_path))
            moved_files.append(file_path.name)

        return {"success": True, "message": f"移动成功，共移动 {len(moved_files)} 个文件"}
    except Exception as e:
        return {"success": False, "error": f"移动失败: {str(e)}"}


def rename_item(path: str, new_name: str) -> Dict[str, Any]:
    """
    重命名文件或目录，同时处理视频相关文件

    Args:
        path: 要重命名的文件或目录的相对路径
        new_name: 新名称

    Returns:
        包含成功状态和错误信息的字典
    """
    try:
        full_path = VIDEO_DIR / path
        if not full_path.exists():
            return {"success": False, "error": "文件或目录不存在"}

        new_name = new_name.strip()
        if not new_name:
            return {"success": False, "error": "新名称不能为空"}

        parent_dir = full_path.parent
        new_base = Path(new_name).stem  # 去除扩展名的新名称
        
        # 如果是目录，直接重命名
        if full_path.is_dir():
            new_path = parent_dir / new_name
            if new_path.exists():
                return {"success": False, "error": "已存在同名文件或目录"}
            full_path.rename(new_path)
            return {"success": True, "message": "重命名成功"}

        # 如果是视频文件，查找相关文件并一起重命名
        files_to_rename = [full_path]
        if full_path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS:
            related_files = find_related_files(full_path)
            files_to_rename.extend(related_files)

        old_base = full_path.stem
        renamed_files = []

        for file_path in files_to_rename:
            # 构建新文件名：保留原后缀，只修改基础名
            if file_path == full_path:
                # 原视频文件：使用用户指定的新名称（保留原扩展名）
                new_filename = new_base + file_path.suffix
            else:
                # 相关文件：替换基础名，保留特定后缀
                # 找出当前文件相对于原视频的后缀模式
                filename = file_path.name
                if filename.startswith(old_base):
                    suffix_part = filename[len(old_base):]
                    new_filename = new_base + suffix_part
                else:
                    continue  # 不匹配的文件跳过

            new_file_path = parent_dir / new_filename
            
            if new_file_path.exists():
                return {"success": False, "error": f"已存在同名文件: {new_filename}"}

            file_path.rename(new_file_path)
            renamed_files.append(new_filename)

        return {"success": True, "message": f"重命名成功，共重命名 {len(renamed_files)} 个文件"}
    except Exception as e:
        return {"success": False, "error": f"重命名失败: {str(e)}"}


def save_uploaded_file(file, target_dir: str = "") -> Path:
    """
    保存上传的文件到指定目录
    
    Args:
        file: 上传的文件对象
        target_dir: 目标目录相对路径
    
    Returns:
        保存后的文件路径
    """
    target_path = VIDEO_DIR / target_dir
    target_path.mkdir(parents=True, exist_ok=True)
    
    file_path = target_path / file.filename
    with open(file_path, "wb") as f:
        f.write(file.file.read())
    
    return file_path


def get_file_path(relative_path: str) -> Path:
    """
    获取文件的完整路径
    
    Args:
        relative_path: 文件相对路径
    
    Returns:
        文件完整路径
    """
    return VIDEO_DIR / relative_path


def get_files_by_extensions(extensions: set) -> List[Dict[str, Any]]:
    """
    通用函数：递归获取指定扩展名的所有文件
    
    Args:
        extensions: 文件扩展名集合（小写，如 {".md", ".pdf"}）
    
    Returns:
        符合条件的文件列表
    """
    result = []
    
    for root, dirs, files in os.walk(VIDEO_DIR):
        for file in files:
            ext = Path(file).suffix.lower()
            if ext in extensions:
                full_path = Path(root) / file
                result.append({
                    "name": file,
                    "path": str(full_path.relative_to(VIDEO_DIR)),
                    "directory": str(Path(root).relative_to(VIDEO_DIR)),
                    "size": full_path.stat().st_size,
                    "modified": full_path.stat().st_mtime,
                    "extension": ext
                })
    
    return result


def get_video_files() -> List[Dict[str, Any]]:
    """获取所有视频文件"""
    return get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS)


def get_document_files(type: str = None) -> List[Dict[str, Any]]:
    """
    获取文档文件，支持类型过滤
    
    Args:
        type: 文档类型过滤，可选值：
            - None 或 'all': 返回全部 .md 文件
            - 'subtitle': 返回原文 (_subtitle.md)
            - 'summary': 返回总结 (_summary.md)
            - 'outline': 返回大纲 (_outline.md)
            - 'notes': 返回笔记 (_notes.md)
    
    Returns:
        符合条件的文件列表
    """
    # 只返回 .md 格式文件
    md_extensions = {".md"}
    all_docs = get_files_by_extensions(md_extensions)
    
    if not type or type == 'all':
        return all_docs
    
    # 根据类型过滤
    type_suffixes = {
        'subtitle': ['_subtitle.md'],
        'summary': ['_summary.md'],
        'outline': ['_outline.md'],
        'notes': ['_notes.md']
    }
    
    if type not in type_suffixes:
        return all_docs
    
    suffixes = type_suffixes[type]
    return [doc for doc in all_docs if any(doc['name'].endswith(suffix) for suffix in suffixes)]


# 初始化默认目录
init_video_dir()


def save_url_file(url: str, target_dir: str = "", filename: str = "") -> Dict[str, Any]:
    """
    从URL下载视频文件

    Args:
        url: 视频文件URL
        target_dir: 目标目录相对路径
        filename: 自定义文件名（可选，不填则从URL自动提取）

    Returns:
        包含下载结果的字典，包含 success, file_path, filename, error 等字段
    """
    target_path = VIDEO_DIR / target_dir
    target_path.mkdir(parents=True, exist_ok=True)

    if filename:
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in ["mp4", "m4s", "webm", "mov", "avi", "mkv"]:
            ext = "mp4"
        name_part = filename.rsplit(".", 1)[0] if "." in filename else filename
        name_part = "".join(c if c.isalnum() or c in "._-" else "_" for c in name_part)
        filename = f"{name_part}.{ext}"
    else:
        for part in url.split("/"):
            if "." in part:
                filename = part.split("?")[0]
                break

        if not filename:
            filename = f"{uuid.uuid4().hex}.mp4"
        else:
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in ["mp4", "m4s", "webm", "mov", "avi", "mkv"]:
                ext = "mp4"
            name_part = filename.rsplit(".", 1)[0] if "." in filename else filename
            name_part = "".join(c if c.isalnum() or c in "._-" else "_" for c in name_part)
            filename = f"{name_part}.{ext}"

    output_path = target_path / filename

    try:
        cmd = [
            "ffmpeg",
            "-i", url,
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",
            "-y",
            str(output_path)
        ]

        print(f"[File Manager] 下载视频: {' '.join(cmd[:6])}...")

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

        if result.returncode != 0:
            print(f"[File Manager] 下载失败: {result.stderr}")
            return {
                "success": False,
                "error": f"下载失败: {result.stderr[-500:] if len(result.stderr) > 500 else result.stderr}"
            }

        if not output_path.exists():
            return {
                "success": False,
                "error": "下载后文件不存在"
            }

        # 获取视频时长
        try:
            duration = get_video_duration(str(output_path))
        except Exception as e:
            print(f"[File Manager] 获取视频时长失败: {e}")
            duration = 0

        return {
            "success": True,
            "file_path": output_path,
            "saved_path": str(output_path.relative_to(VIDEO_DIR)),
            "filename": filename,
            "size": output_path.stat().st_size,
            "duration": duration
        }

    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "下载超时（超过10分钟）"
        }
    except Exception as e:
        print(f"[File Manager] 下载异常: {e}")
        return {
            "success": False,
            "error": str(e)
        }