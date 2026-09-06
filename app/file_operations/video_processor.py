import os
import subprocess
import shutil
import tempfile
import time
from pathlib import Path
from typing import Tuple, Optional, Dict, Any

# 支持的视频格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".webm", ".mov", ".avi", ".wmv", ".flv", ".mkv"}

# 支持的音频格式
SUPPORTED_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"}


def _find_ffmpeg() -> Optional[str]:
    """查找并返回 ffmpeg 可执行文件的完整路径，找不到返回 None"""
    # 优先从 PATH 中查找
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    
    # 在 Python 的 Scripts 目录中查找
    try:
        from sys import prefix
        candidate = Path(prefix) / "Scripts" / "ffmpeg.exe"
        if candidate.exists():
            return str(candidate)
    except Exception:
        pass
    
    return None


def get_video_streams(video_path: str) -> Dict[str, Any]:
    """
    检查视频文件的流信息
    
    Returns:
        包含 has_audio, has_video, duration, error 的字典
    """
    result = {
        "has_audio": False,
        "has_video": False,
        "duration": 0.0,
        "error": None
    }
    
    try:
        video_path = Path(video_path)
        if not video_path.exists():
            result["error"] = f"文件不存在: {video_path}"
            return result
        
        ffmpeg_exe = _find_ffmpeg()
        if not ffmpeg_exe:
            result["error"] = "系统未安装 FFmpeg"
            return result
        
        cmd = [ffmpeg_exe, "-i", str(video_path), "-hide_banner"]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
        output = proc.stderr or proc.stdout
        
        # 解析流信息
        for line in output.split("\n"):
            if "Stream" in line:
                if "Audio" in line:
                    result["has_audio"] = True
                if "Video" in line:
                    result["has_video"] = True
            elif "Duration:" in line:
                try:
                    duration_str = line.split("Duration: ")[1].split(",")[0].strip()
                    h, m, s = duration_str.split(":")
                    result["duration"] = float(h) * 3600 + float(m) * 60 + float(s)
                except Exception:
                    pass
        
        return result
        
    except Exception as e:
        result["error"] = str(e)
        return result


def _run_ffmpeg_cancellable(cmd, cancel_check=None, cleanup_path=None) -> Tuple[bool, int, str]:
    """
    运行 ffmpeg 命令，支持协作式取消。

    cancel_check 返回 True 时终止进程并删除未完成的输出文件（cleanup_path）。
    stderr 重定向到临时文件而非管道，避免轮询期间 ffmpeg 进度输出写满
    管道缓冲区导致进程阻塞死锁。

    Returns:
        (是否已取消, 进程返回码, stderr 输出内容)
    """
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="ignore") as err_file:
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err_file)
        while process.poll() is None:
            time.sleep(0.5)
            if cancel_check and cancel_check():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                if cleanup_path:
                    try:
                        os.remove(cleanup_path)
                    except OSError:
                        pass
                return True, 0, ""
        err_file.seek(0)
        return False, process.returncode, err_file.read()


def video_to_audio(video_path: str, output_audio_path: str = None, cancel_check=None) -> Tuple[bool, str]:
    """
    将视频转换为音频（支持音频旁路：mp3 直接返回，其他音频转 mp3）

    Args:
        video_path: 视频/音频文件路径
        output_audio_path: 输出音频路径，默认为同目录同名.mp3
        cancel_check: 可选的取消检查函数，返回 True 时终止转换（协作式取消）

    Returns:
        (是否成功, 错误信息) - 成功时错误信息为空字符串
    """
    try:
        video_path = Path(video_path)

        if not video_path.exists():
            return False, f"文件不存在: {video_path}"

        suffix_lower = video_path.suffix.lower()

        # 音频旁路处理
        if suffix_lower in SUPPORTED_AUDIO_EXTENSIONS:
            # 已经是 .mp3：直接返回成功
            if suffix_lower == ".mp3":
                return True, ""
            # 其他音频格式：转 mp3
            ffmpeg_exe = _find_ffmpeg()
            if not ffmpeg_exe:
                return False, "系统未安装 FFmpeg，请先安装后再试"
            if output_audio_path is None:
                output_audio_path = str(video_path.with_suffix(".mp3"))
            output_path = Path(output_audio_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            cmd = [
                ffmpeg_exe,
                "-i", str(video_path),
                "-vn",
                "-acodec", "libmp3lame",
                "-q:a", "2",
                "-y",
                str(output_audio_path)
            ]
            print(f"[Video Processor] 音频转 MP3: {' '.join(cmd)}")
            cancelled, returncode, stderr_output = _run_ffmpeg_cancellable(cmd, cancel_check, output_audio_path)
            if cancelled:
                return False, "已取消"
            if returncode != 0:
                error_lines = [l.strip() for l in (stderr_output or "").split("\n") if l.strip()]
                useful_error = "\n".join(error_lines[-5:]) if error_lines else "未知错误"
                return False, f"音频转换失败：{useful_error}"
            if not output_path.exists() or output_path.stat().st_size == 0:
                return False, "音频输出文件不存在或为空"
            return True, ""

        # 视频格式校验
        if suffix_lower not in SUPPORTED_VIDEO_EXTENSIONS:
            return False, f"不支持的视频格式: {video_path.suffix}"
        
        # 检查 ffmpeg 是否可用
        ffmpeg_exe = _find_ffmpeg()
        if not ffmpeg_exe:
            return False, "系统未安装 FFmpeg，请先安装后再试"
        
        if output_audio_path is None:
            output_audio_path = str(video_path.with_suffix(".mp3"))
        
        output_path = Path(output_audio_path)
        
        # 如果 mp3 已存在且新于视频文件，跳过转换
        if output_path.exists():
            video_mtime = video_path.stat().st_mtime
            audio_mtime = output_path.stat().st_mtime
            if audio_mtime >= video_mtime:
                print(f"[Video Processor] MP3 已存在且为最新，跳过转换: {output_audio_path}")
                return True, ""
        
        # 先检查视频是否有音频流，提前发现问题
        streams = get_video_streams(str(video_path))
        if not streams["has_audio"]:
            return False, f"视频文件没有音频流，无法提取音频（时长: {format_duration(streams['duration'])}）"
        
        # 确保输出目录存在
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 使用 ffmpeg 提取音频（使用更可靠的参数）
        cmd = [
            ffmpeg_exe,
            "-i", str(video_path),
            "-vn",
            "-acodec", "libmp3lame",
            "-q:a", "2",
            "-y",
            str(output_audio_path)
        ]
        
        print(f"[Video Processor] 执行: {' '.join(cmd)}")

        cancelled, returncode, stderr_output = _run_ffmpeg_cancellable(cmd, cancel_check, output_audio_path)
        if cancelled:
            return False, "已取消"

        if returncode != 0:
            # 提取有用的错误信息
            error_lines = [l.strip() for l in (stderr_output or "").split("\n") if l.strip()]
            useful_error = "\n".join(error_lines[-5:]) if error_lines else "未知错误"
            print(f"[Video Processor] FFmpeg 错误: {useful_error}")
            return False, f"音频提取失败：{useful_error}"
        
        # 验证输出文件
        if not output_path.exists() or output_path.stat().st_size == 0:
            return False, "音频输出文件不存在或为空"
        
        size_kb = output_path.stat().st_size / 1024
        print(f"[Video Processor] 音频提取成功: {output_audio_path} ({size_kb:.1f} KB)")
        return True, ""
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"处理异常: {e}"


def extract_thumbnail(video_path: str, output_path: str = None, time_offset: float = 1.0) -> Tuple[bool, str]:
    """
    提取视频缩略图（音频文件直接返回 False）

    Args:
        video_path: 视频文件路径
        output_path: 输出缩略图路径，默认为同目录同名.jpg
        time_offset: 提取帧的时间偏移（秒）

    Returns:
        (是否成功, 错误信息)
    """
    try:
        video_path = Path(video_path)

        if not video_path.exists():
            return False, f"视频文件不存在: {video_path}"

        # 音频文件无缩略图
        if video_path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS:
            return False, "音频文件无缩略图"

        ffmpeg_exe = _find_ffmpeg()
        if not ffmpeg_exe:
            return False, "系统未安装 FFmpeg"

        if video_path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS:
            return False, f"不支持的视频格式: {video_path.suffix}"
        
        if output_path is None:
            output_path = str(video_path.with_suffix(".jpg"))
        
        cmd = [
            ffmpeg_exe,
            "-i", str(video_path),
            "-ss", str(time_offset),
            "-vframes", "1",
            "-q:v", "2",
            "-y",
            str(output_path)
        ]
        
        print(f"[Video Processor] 执行: {' '.join(cmd)}")
        
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
        
        if result.returncode != 0:
            return False, f"缩略图提取失败"
        
        if not Path(output_path).exists():
            return False, "缩略图文件未生成"
        
        print(f"[Video Processor] 缩略图提取成功: {output_path}")
        return True, ""
        
    except Exception as e:
        print(f"[Video Processor] 提取缩略图失败: {e}")
        return False, str(e)


def get_video_duration(video_path: str) -> float:
    """
    获取视频时长
    
    Args:
        video_path: 视频文件路径
    
    Returns:
        视频时长（秒），失败返回 0
    """
    streams = get_video_streams(video_path)
    return streams["duration"]


def format_duration(seconds: float) -> str:
    """
    格式化时长显示
    
    Args:
        seconds: 秒数
    
    Returns:
        格式化的时长字符串（如 01:23:45）
    """
    if seconds <= 0:
        return "00:00"
    
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes:02d}:{secs:02d}"


def format_file_size(bytes_size: int) -> str:
    """
    格式化文件大小显示
    
    Args:
        bytes_size: 字节数
    
    Returns:
        格式化的文件大小字符串
    """
    if bytes_size < 1024:
        return f"{bytes_size} B"
    elif bytes_size < 1024 * 1024:
        return f"{bytes_size / 1024:.1f} KB"
    elif bytes_size < 1024 * 1024 * 1024:
        return f"{bytes_size / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_size / (1024 * 1024 * 1024):.1f} GB"
