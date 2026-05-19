import os
import subprocess
from pathlib import Path

# 支持的视频格式
SUPPORTED_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".webm", ".mov", ".avi", ".wmv", ".flv", ".mkv"}


def video_to_audio(video_path: str, output_audio_path: str = None) -> bool:
    """
    将视频转换为音频
    
    Args:
        video_path: 视频文件路径
        output_audio_path: 输出音频路径，默认为同目录同名.mp3
    
    Returns:
        是否转换成功
    """
    try:
        video_path = Path(video_path)
        
        if not video_path.exists():
            print(f"[Video Processor] 视频文件不存在: {video_path}")
            return False
        
        if video_path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS:
            print(f"[Video Processor] 不支持的视频格式: {video_path.suffix}")
            return False
        
        if output_audio_path is None:
            output_audio_path = str(video_path.with_suffix(".mp3"))
        
        # 使用 ffmpeg 提取音频
        cmd = [
            "ffmpeg",
            "-i", str(video_path),
            "-q:a", "0",
            "-map", "a",
            "-y",
            str(output_audio_path)
        ]
        
        print(f"[Video Processor] 执行命令: {' '.join(cmd)}")
        
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode != 0:
            print(f"[Video Processor] 音频提取失败: {result.stderr}")
            return False
        
        print(f"[Video Processor] 音频提取成功: {output_audio_path}")
        return True
        
    except Exception as e:
        print(f"[Video Processor] 视频转音频失败: {e}")
        return False


def extract_thumbnail(video_path: str, output_path: str = None, time_offset: float = 1.0) -> bool:
    """
    提取视频缩略图
    
    Args:
        video_path: 视频文件路径
        output_path: 输出缩略图路径，默认为同目录同名.jpg
        time_offset: 提取帧的时间偏移（秒）
    
    Returns:
        是否提取成功
    """
    try:
        video_path = Path(video_path)
        
        if not video_path.exists():
            print(f"[Video Processor] 视频文件不存在: {video_path}")
            return False
        
        if video_path.suffix.lower() not in SUPPORTED_VIDEO_EXTENSIONS:
            print(f"[Video Processor] 不支持的视频格式: {video_path.suffix}")
            return False
        
        if output_path is None:
            output_path = str(video_path.with_suffix(".jpg"))
        
        # 使用 ffmpeg 提取缩略图
        cmd = [
            "ffmpeg",
            "-i", str(video_path),
            "-ss", str(time_offset),
            "-vframes", "1",
            "-q:v", "2",
            "-y",
            str(output_path)
        ]
        
        print(f"[Video Processor] 执行命令: {' '.join(cmd)}")
        
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode != 0:
            print(f"[Video Processor] 缩略图提取失败: {result.stderr}")
            return False
        
        print(f"[Video Processor] 缩略图提取成功: {output_path}")
        return True
        
    except Exception as e:
        print(f"[Video Processor] 提取缩略图失败: {e}")
        return False


def get_video_duration(video_path: str) -> float:
    """
    获取视频时长
    
    Args:
        video_path: 视频文件路径
    
    Returns:
        视频时长（秒），失败返回 0
    """
    try:
        video_path = Path(video_path)
        
        if not video_path.exists():
            return 0.0
        
        cmd = [
            "ffmpeg",
            "-i", str(video_path),
            "-f", "null",
            "-"
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', stderr=subprocess.STDOUT)
        
        # 从输出中提取时长信息
        for line in result.stdout.split('\n'):
            if "Duration:" in line:
                duration_str = line.split("Duration: ")[1].split(",")[0].strip()
                h, m, s = duration_str.split(":")
                return float(h) * 3600 + float(m) * 60 + float(s)
        
        return 0.0
        
    except Exception as e:
        print(f"[Video Processor] 获取视频时长失败: {e}")
        return 0.0


def format_duration(seconds: float) -> str:
    """
    格式化时长显示
    
    Args:
        seconds: 秒数
    
    Returns:
        格式化的时长字符串（如 01:23:45）
    """
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