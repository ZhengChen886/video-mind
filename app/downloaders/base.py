"""
下载器抽象基类
所有平台下载器都应继承此类
"""
from abc import ABC, abstractmethod
from typing import Optional, Union

from app.models.audio_model import AudioDownloadResult

QUALITY_MAP = {
    "fast": "32",
    "medium": "64",
    "slow": "128"
}


class Downloader(ABC):
    def __init__(self):
        self.quality = QUALITY_MAP.get('fast')
        from config.paths import DATA_DIR
        self.cache_data = str(DATA_DIR)

    @abstractmethod
    def download(self, video_url: str, output_dir: str = None,
                 quality: str = "fast", need_video: Optional[bool] = False,
                 skip_download: bool = False) -> AudioDownloadResult:
        """
        :param need_video: 是否需要下载视频
        :param video_url: 资源链接
        :param output_dir: 输出路径
        :param quality: 音频质量 fast | medium | slow
        :param skip_download: True 时仅解析不下载，file_path 字段复用存直链 URL
        :return: AudioDownloadResult
        """
        pass

    def download_video(self, video_url: str,
                       output_dir: Union[str, None] = None) -> str:
        """下载视频文件，默认不实现"""
        return None

    def download_subtitles(self, video_url: str, output_dir: str = None,
                           langs: list = None) -> Optional[dict]:
        """
        尝试获取平台字幕（默认无字幕，子类可重写）
        返回字幕字典 {'srt': str, 'lang': str} 或 None
        """
        return None
