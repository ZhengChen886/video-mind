"""
音频下载结果数据模型
"""
from dataclasses import dataclass
from typing import Optional


@dataclass
class AudioDownloadResult:
    file_path: str               # 本地音频/视频路径；skip_download=True 时复用存直链 URL
    title: str                   # 视频标题；skip_download=True 时复用存带扩展名的文件名
    duration: float              # 视频时长（秒）
    cover_url: Optional[str]     # 视频封面图
    platform: str                # 平台，如 "bilibili"
    video_id: str                # 唯一视频ID
    raw_info: dict               # 平台原始信息字典
    video_path: Optional[str] = None  # 可选视频文件路径
    transcript: Optional[dict] = None  # 平台字幕（若有）
