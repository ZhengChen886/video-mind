"""
平台下载器集合
导出 B 站、抖音 yt-dlp 下载器
"""
from app.downloaders.base import Downloader
from app.downloaders.bilibili_downloader import BilibiliDownloader
from app.downloaders.douyin_downloader import DouyinDownloader

__all__ = ["Downloader", "BilibiliDownloader", "DouyinDownloader"]
