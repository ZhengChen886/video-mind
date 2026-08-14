import os
import shutil
import subprocess
import uuid
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from .video_processor import get_video_duration
from config.paths import VIDEO_DIR, AUDIO_DIR

# 支持的视频格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".webm", ".mov", ".avi", ".wmv", ".flv", ".mkv"}

# 支持的音频格式
SUPPORTED_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"}

# 媒体文件（视频+音频）
MEDIA_EXTENSIONS = SUPPORTED_VIDEO_EXTENSIONS | SUPPORTED_AUDIO_EXTENSIONS

# 支持的文档格式
SUPPORTED_DOCUMENT_EXTENSIONS = {".md", ".pdf", ".doc", ".docx", ".txt", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".odt"}


# ============================================================
# FFmpeg 路径解析
# 优先级：config/app_paths.json (ffmpeg.bin_dir) > 系统 PATH > 兜底目录
# 解析为绝对路径，subprocess.run 调 ffmpeg 时不再依赖 PATH
# ============================================================
_FALLBACK_FFMPEG_DIRS = [
    r"F:\work-tool\ffmpeg\bin",
]


def _build_ffmpeg_headers(url: str) -> str:
    """
    根据 URL 域名构造 ffmpeg -headers 字符串。
    - bilivideo.com / bilibili.com → 必须带 Referer: https://www.bilibili.com
    - 其它源 → User-Agent 兜底
    """
    headers = []
    lower = (url or "").lower()
    if "bilivideo.com" in lower or "bilibili.com" in lower:
        headers.append("Referer: https://www.bilibili.com")
        headers.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    else:
        headers.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    # ffmpeg -headers 要求每行以 \r\n 结尾
    return "\r\n".join(headers) + "\r\n"


def get_ffmpeg_path() -> Optional[str]:
    """
    解析 ffmpeg.exe 的绝对路径。

    查找顺序：
      1. config/app_paths.json 中的 ffmpeg.bin_dir
      2. PATH 环境变量（shutil.which）
      3. _FALLBACK_FFMPEG_DIRS 兜底目录

    找不到返回 None。
    """
    # 1) JSON 配置
    try:
        cfg = Path(__file__).resolve().parent.parent / "config" / "app_paths.json"
        if cfg.is_file():
            data = json.loads(cfg.read_text(encoding="utf-8"))
            saved = (data.get("ffmpeg") or {}).get("bin_dir", "").strip()
            if saved and (Path(saved) / "ffmpeg.exe").is_file():
                return str(Path(saved) / "ffmpeg.exe")
    except (OSError, ValueError):
        pass

    # 2) PATH
    found = shutil.which("ffmpeg")
    if found:
        return found

    # 3) 兜底目录
    for d in _FALLBACK_FFMPEG_DIRS:
        candidate = Path(d) / "ffmpeg.exe"
        if candidate.is_file():
            return str(candidate)

    return None


def is_audio_file(path) -> bool:
    """判断是否为音频文件"""
    if path is None:
        return False
    if hasattr(path, "suffix"):
        return path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS
    return Path(str(path)).suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS


def is_video_file(path) -> bool:
    """判断是否为视频文件"""
    if path is None:
        return False
    if hasattr(path, "suffix"):
        return path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
    return Path(str(path)).suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS


def get_base_dir(media_type: str = "video") -> Path:
    """
    根据 media_type 返回对应的根目录
    Args:
        media_type: 'video' -> VIDEO_DIR (data/mp4)
                    'audio' -> AUDIO_DIR (data/mp3)
    """
    if media_type == "audio":
        return AUDIO_DIR
    return VIDEO_DIR


def init_video_dir():
    """初始化视频存储目录，创建默认子目录"""
    default_dirs = ["未分类", "学习资料", "会议记录", "个人收藏"]

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)

    for dir_name in default_dirs:
        (VIDEO_DIR / dir_name).mkdir(exist_ok=True)


def init_audio_dir():
    """初始化音频存储目录，创建默认子目录（不存在则新建）"""
    default_dirs = ["未分类", "学习资料", "会议记录", "个人收藏"]

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    for dir_name in default_dirs:
        (AUDIO_DIR / dir_name).mkdir(exist_ok=True)


def init_media_dirs():
    """初始化视频和音频存储目录"""
    init_video_dir()
    init_audio_dir()


def get_directory_list(path: str = "", media_type: str = "video") -> List[Dict[str, Any]]:
    """
    获取指定目录下的文件和子目录列表

    Args:
        path: 相对路径，默认为根目录
        media_type: 媒体类型 'video' (data/mp4) 或 'audio' (data/mp3)
                    不同 media_type 走不同的根目录，且只返回对应类型的文件
    """
    base_dir = get_base_dir(media_type)
    target_exts = SUPPORTED_AUDIO_EXTENSIONS if media_type == "audio" else SUPPORTED_VIDEO_EXTENSIONS
    media_label = "audio" if media_type == "audio" else "video"

    full_path = base_dir / path
    items = []

    if not full_path.exists() or not full_path.is_dir():
        return items

    for item in sorted(full_path.iterdir()):
        if item.is_dir():
            items.append({
                "name": item.name,
                "path": str(item.relative_to(base_dir)),
                "type": "directory",
                "size": 0,
                "modified": item.stat().st_mtime
            })
        elif item.is_file() and item.suffix.lower() in target_exts:
            ext = item.suffix.lower()
            items.append({
                "name": item.name,
                "path": str(item.relative_to(base_dir)),
                "type": "file",
                "size": item.stat().st_size,
                "modified": item.stat().st_mtime,
                "extension": ext,
                "media_type": media_label
            })

    return items


def _is_dangerous_path(target_dir: Path) -> bool:
    """
    检查路径是否属于禁止清理的「危险目录」：
    - 磁盘根目录（如 C:\\）
    - Windows / Program Files / ProgramData 等系统目录
    - Linux / macOS 的系统目录
    """
    import sys as _sys
    try:
        target_str = str(target_dir.resolve()).replace('/', '\\').lower().rstrip('\\')
    except Exception:
        return True
    if _sys.platform.startswith('win'):
        try:
            if target_dir.drive and (target_dir == Path(target_dir.drive + '\\') or len(target_dir.parts) == 1):
                return True
        except Exception:
            pass
        # 系统目录（按环境变量动态取；排除 SystemDrive 等只是盘符的变量）
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
        for hardcoded in [r'c:\windows', r'c:\program files', r'c:\program files (x86)', r'c:\programdata']:
            if target_str == hardcoded or target_str.startswith(hardcoded + '\\'):
                return True
    else:
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


def _resolve_target_dir(path: str, media_type: str) -> Optional[Path]:
    """
    解析目标目录：
    - 相对路径：拼接到 base_dir
    - 绝对路径：直接使用（全盘任意位置均可，危险目录除外）
    - 失败 / 路径为系统目录或磁盘根：返回 None
    """
    base_dir = get_base_dir(media_type).resolve()
    raw = (path or "").strip()
    if raw and os.path.isabs(raw):
        target_dir = Path(raw).resolve()
    else:
        target_dir = (base_dir / raw).resolve() if raw else base_dir
    if _is_dangerous_path(target_dir):
        return None
    return target_dir


def list_all_subfolders(path: str = "", media_type: str = "video") -> List[Dict[str, str]]:
    """
    递归列出指定目录下的所有子目录（不含自身）。
    返回 [{path, name}]，name 是 path 末级目录名。
    path 接受相对路径（相对 base_dir）或绝对路径（全盘任意位置，系统目录、磁盘根目录除外）。
    """
    base_dir = get_base_dir(media_type)
    start_dir = _resolve_target_dir(path, media_type)
    if start_dir is None or not start_dir.exists() or not start_dir.is_dir():
        return []

    result: List[Dict[str, str]] = []
    for root, dirs, _files in os.walk(start_dir):
        for d in sorted(dirs):
            full = Path(root) / d
            try:
                rel = str(full.relative_to(base_dir))
            except ValueError:
                continue
            result.append({"path": rel, "name": d})
    result.sort(key=lambda x: x["path"])
    return result


def scan_folder_extensions(path: str = "", media_type: str = "video") -> Dict[str, Any]:
    """
    扫描指定文件夹（仅本层，不递归）中的文件扩展名，返回:
      {
        total_files: 文件总数（不含子目录）,
        extensions: [{ext, count}, ...]   # ext 已统一小写；无后缀文件 ext 为 ''
      }
    path 接受相对路径（相对 base_dir）或绝对路径（全盘任意位置，系统目录、磁盘根目录除外）。
    """
    base_dir = get_base_dir(media_type)
    target_dir = _resolve_target_dir(path, media_type)
    if target_dir is None or not target_dir.exists() or not target_dir.is_dir():
        return {"total_files": 0, "extensions": []}

    ext_counter: Dict[str, int] = {}
    total_files = 0
    for item in target_dir.iterdir():
        if item.is_file():
            total_files += 1
            ext = item.suffix.lower()
            ext_counter[ext] = ext_counter.get(ext, 0) + 1

    sorted_exts = sorted(
        ext_counter.items(),
        key=lambda kv: (0 if kv[0] == "" else 1, kv[0]),
    )
    return {
        "total_files": total_files,
        "extensions": [{"ext": k, "count": v} for k, v in sorted_exts],
    }


def cleanup_folder_keep_extensions(path: str, keep_extensions: List[str], media_type: str = "video") -> Dict[str, Any]:
    """
    仅处理当前文件夹（非递归），删除扩展名不在 keep_extensions 列表中的文件。
    keep_extensions 允许传入带或不带前导点的后缀（如 '.md' / 'md'）。
    path 接受相对路径（相对 base_dir）或绝对路径（全盘任意位置，系统目录、磁盘根目录除外）。
    返回:
      {
        deleted: [filename, ...],
        kept: [filename, ...],
        errors: [msg, ...]
      }
    """
    base_dir = get_base_dir(media_type)
    target_dir = _resolve_target_dir(path, media_type)
    if target_dir is None or not target_dir.exists() or not target_dir.is_dir():
        return {"deleted": [], "kept": [], "errors": ["文件夹不存在或路径非法"]}

    keep_set = set()
    for ext in keep_extensions or []:
        if not ext:
            continue
        e = ext.strip().lower()
        if not e:
            continue
        if not e.startswith("."):
            e = "." + e
        keep_set.add(e)

    deleted: List[str] = []
    kept: List[str] = []
    errors: List[str] = []
    for item in list(target_dir.iterdir()):
        if item.is_dir():
            continue
        ext = item.suffix.lower()
        if ext in keep_set:
            kept.append(item.name)
            continue
        try:
            os.remove(item)
            deleted.append(item.name)
        except Exception as exc:
            errors.append(f"{item.name}: {exc}")

    return {"deleted": deleted, "kept": kept, "errors": errors}


def create_directory(path: str, name: str, media_type: str = "video") -> bool:
    """
    在指定路径下创建新目录

    Args:
        path: 父目录相对路径
        name: 新目录名称
        media_type: 媒体类型，决定根目录
    """
    try:
        base_dir = get_base_dir(media_type)
        new_dir = base_dir / path / name
        if new_dir.exists():
            return False
        new_dir.mkdir(parents=True)
        return True
    except Exception:
        return False


def delete_item(path: str, media_type: str = "video") -> Dict[str, Any]:
    """
    删除文件或目录（目录会递归删除其中所有内容）

    Args:
        path: 要删除的文件或目录的相对路径
        media_type: 媒体类型，决定根目录

    Returns:
        包含 success / error / deleted_files / deleted_type 的字典
    """
    try:
        base_dir = get_base_dir(media_type)
        full_path = base_dir / path
        if full_path.is_dir():
            # 先递归统计目录内文件数（不含目录本身），用于前端展示
            file_count = sum(1 for p in full_path.rglob("*") if p.is_file())
            shutil.rmtree(full_path)
            return {"success": True, "deleted_files": file_count, "deleted_type": "directory"}
        elif full_path.is_file():
            os.remove(full_path)
            return {"success": True, "deleted_files": 1, "deleted_type": "file"}
        else:
            return {"success": False, "error": "路径不存在", "deleted_files": 0}
    except Exception as e:
        return {"success": False, "error": str(e), "deleted_files": 0}


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


def move_item(source_path: str, target_dir: str, media_type: str = "video") -> Dict[str, Any]:
    """
    移动文件或目录到目标目录，同时处理视频相关文件

    Args:
        source_path: 源文件或目录的相对路径
        target_dir: 目标目录的相对路径
        media_type: 媒体类型，决定根目录

    Returns:
        包含成功状态和错误信息的字典
    """
    try:
        base_dir = get_base_dir(media_type)
        source_full = base_dir / source_path
        target_full = base_dir / target_dir

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


def rename_item(path: str, new_name: str, media_type: str = "video") -> Dict[str, Any]:
    """
    重命名文件或目录，同时处理视频相关文件

    Args:
        path: 要重命名的文件或目录的相对路径
        new_name: 新名称
        media_type: 媒体类型，决定根目录

    Returns:
        包含成功状态和错误信息的字典
    """
    try:
        base_dir = get_base_dir(media_type)
        full_path = base_dir / path
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


def save_uploaded_file(file, target_dir: str = "", media_type: str = "video") -> Path:
    """
    保存上传的文件到指定目录

    Args:
        file: 上传的文件对象
        target_dir: 目标目录相对路径
        media_type: 媒体类型，决定根目录（'video' -> data/mp4, 'audio' -> data/mp3）

    Returns:
        保存后的文件路径
    """
    base_dir = get_base_dir(media_type)
    target_path = base_dir / target_dir
    target_path.mkdir(parents=True, exist_ok=True)

    file_path = target_path / file.filename
    with open(file_path, "wb") as f:
        f.write(file.file.read())

    return file_path


def get_file_path(relative_path: str, media_type: str = "video") -> Path:
    """
    获取文件的完整路径

    Args:
        relative_path: 文件相对路径
        media_type: 媒体类型，决定根目录

    Returns:
        文件完整路径
    """
    return get_base_dir(media_type) / relative_path


def get_files_by_extensions(extensions: set, media_type: str = "video") -> List[Dict[str, Any]]:
    """
    通用函数：递归获取指定扩展名的所有文件

    Args:
        extensions: 文件扩展名集合（小写，如 {".md", ".pdf"}）
        media_type: 媒体类型，决定根目录

    Returns:
        符合条件的文件列表
    """
    result = []
    base_dir = get_base_dir(media_type)

    for root, dirs, files in os.walk(base_dir):
        for file in files:
            ext = Path(file).suffix.lower()
            if ext in extensions:
                full_path = Path(root) / file
                stat_result = full_path.stat()
                result.append({
                    "name": file,
                    "path": str(full_path.relative_to(base_dir)),
                    "directory": str(Path(root).relative_to(base_dir)),
                    "size": stat_result.st_size,
                    "modified": stat_result.st_mtime,
                    "extension": ext
                })

    return result


def get_video_files() -> List[Dict[str, Any]]:
    """获取所有视频文件"""
    return get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS, media_type="video")


def get_audio_files() -> List[Dict[str, Any]]:
    """获取所有音频文件"""
    return get_files_by_extensions(SUPPORTED_AUDIO_EXTENSIONS, media_type="audio")


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
    all_docs = get_files_by_extensions(md_extensions, media_type="video")

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
init_audio_dir()


def save_url_file(url: str, target_dir: str = "", filename: str = "", media_type: str = "video") -> Dict[str, Any]:
    """
    从URL下载媒体文件

    Args:
        url: 媒体文件URL
        target_dir: 目标目录相对路径
        filename: 自定义文件名（可选，不填则从URL自动提取）
        media_type: 媒体类型，决定根目录（'video' → data/mp4，'audio' → data/mp3）

    Returns:
        包含下载结果的字典，包含 success, file_path, filename, error 等字段
    """
    base_dir = get_base_dir(media_type)
    target_path = base_dir / target_dir
    target_path.mkdir(parents=True, exist_ok=True)

    # 根据 media_type 决定允许的扩展名
    if media_type == "audio":
        allowed_exts = ["mp3", "m4a", "wav", "flac", "ogg", "aac"]
        default_ext = "mp3"
    else:
        # video 模式也接受音频后缀（保持 .mp3 不被改名），所有文件统一存到 data/mp4
        allowed_exts = ["mp4", "m4s", "webm", "mov", "avi", "mkv", "mp3", "m4a", "wav", "flac", "ogg", "aac"]
        default_ext = "mp4"

    if filename:
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in allowed_exts:
            ext = default_ext
        name_part = filename.rsplit(".", 1)[0] if "." in filename else filename
        name_part = "".join(c if c.isalnum() or c in "._-" else "_" for c in name_part)
        filename = f"{name_part}.{ext}"
    else:
        for part in url.split("/"):
            if "." in part:
                filename = part.split("?")[0]
                break

        if not filename:
            filename = f"{uuid.uuid4().hex}.{default_ext}"
        else:
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in allowed_exts:
                ext = default_ext
            name_part = filename.rsplit(".", 1)[0] if "." in filename else filename
            name_part = "".join(c if c.isalnum() or c in "._-" else "_" for c in name_part)
            filename = f"{name_part}.{ext}"

    output_path = target_path / filename

    try:
        ffmpeg_exe = get_ffmpeg_path()
        if not ffmpeg_exe:
            return {
                "success": False,
                "error": "找不到 ffmpeg.exe，请确认 FFmpeg 已安装，或通过 start_with.bat 配置路径",
            }
        # 根据输出后缀决定编码策略：
        #   mp3  → 需要转码（aac→mp3）
        #   其它 → copy 原始流（m4a/m4s 已是 aac/mp4 容器，aac_adtstoasc 处理裸 aac 头）
        out_ext = (output_path.suffix or "").lstrip(".").lower()
        if out_ext == "mp3":
            cmd = [
                ffmpeg_exe,
                "-headers", _build_ffmpeg_headers(url),
                "-i", url,
                "-vn",
                "-c:a", "libmp3lame",
                "-b:a", "192k",
                "-y",
                str(output_path)
            ]
        else:
            cmd = [
                ffmpeg_exe,
                "-headers", _build_ffmpeg_headers(url),
                "-i", url,
                "-c", "copy",
                "-bsf:a", "aac_adtstoasc",
                "-y",
                str(output_path)
            ]

        print(f"[File Manager] 下载媒体({media_type}): {' '.join(cmd[:8])}...")

        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)

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

        # 获取时长
        try:
            duration = get_video_duration(str(output_path))
        except Exception as e:
            print(f"[File Manager] 获取时长失败: {e}")
            duration = 0

        return {
            "success": True,
            "file_path": output_path,
            "saved_path": str(output_path.relative_to(base_dir)),
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