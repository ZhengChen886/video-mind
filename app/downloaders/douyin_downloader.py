"""
抖音视频下载器
基于 yt-dlp 实现（自研 aweme/detail API 路径已废弃：mssdk.bytedance.com 风控升级，
gen_real_msToken 失效，ABogus 签名算法过时）

约定：当调用 download(..., skip_download=True) 时，不写文件，
      返回的 AudioDownloadResult.file_path 字段复用存直链 URL，
      title 字段复用存带扩展名的文件名（供 link fetcher 脚本使用）。
"""
import os
import re as _re
import tempfile
from typing import Union, Optional

import requests
import yt_dlp
from yt_dlp.utils import DownloadError

from app.downloaders.base import Downloader
from app.models.audio_model import AudioDownloadResult
from app.services.cookie_manager import cookie_manager

DOUYIN_HEADERS = {
    "Accept-Language": "zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Referer": "https://www.douyin.com/",
}

DOUYIN_PROXIES = {"http": None, "https": None}


class DouyinDownloader(Downloader):
    """抖音视频下载器（仅 yt-dlp 路径）"""

    def __init__(self, cookie: Optional[str] = None):
        super().__init__()
        self._cookie = cookie or cookie_manager.get("douyin")

    def _save_temp_cookie(self, cookie: str) -> str:
        """将Cookie写入临时Netscape文件给yt-dlp"""
        lines = ["# Netscape HTTP Cookie File\n"]
        for pair in cookie.split("; "):
            if "=" in pair:
                key, value = pair.split("=", 1)
                lines.append(f".douyin.com\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")
        tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', delete=False, encoding='utf-8'
        )
        tmp.writelines(lines)
        tmp.close()
        return tmp.name

    def _build_opts(self, output_dir: str, need_video: bool,
                    cookie_str: Optional[str], skip_download: bool = False) -> dict:
        """构造 yt-dlp 选项

        skip_download=True:  仅解析 → 单流（保证 info['url'] 有直链）
        skip_download=False: 下载 → DASH 合并获取最佳画质+音轨
        """
        if skip_download:
            # 解析模式：单流策略
            fmt = "best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/bestvideo[height<=720]/best"
        elif need_video:
            # DASH 视频/音频分流的平台必须用 + 合并
            fmt = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[ext=mp4]/best"
        else:
            fmt = "bestaudio[ext=m4a]/bestaudio/best"

        opts = {
            'format': fmt,
            'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
            'noplaylist': True,
            'quiet': True,
            'no_warnings': True,
            'merge_output_format': 'mp4',
            'http_headers': {
                'User-Agent': DOUYIN_HEADERS["User-Agent"],
                'Referer': DOUYIN_HEADERS["Referer"],
            },
        }
        if cookie_str:
            opts['cookiefile'] = self._save_temp_cookie(cookie_str)
        return opts

    def _resolve_short_url(self, video_url: str) -> str:
        if 'v.douyin.com' in video_url:
            try:
                resp = requests.head(video_url, allow_redirects=True, timeout=10)
                return resp.url
            except Exception as e:
                raise ValueError(f"短链解析失败: {e}")
        return video_url

    def _parse_only(self, video_url: str, label: str, attempt_cookie: Optional[str]) -> AudioDownloadResult:
        """仅解析不下载：返回直链 URL。约定 file_path 字段存直链。"""
        tmp_dir = self.cache_data
        os.makedirs(tmp_dir, exist_ok=True)
        opts = self._build_opts(tmp_dir, need_video=True, cookie_str=attempt_cookie, skip_download=True)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
        direct_url = info.get("url")
        if not direct_url:
            raise ValueError("yt-dlp 未返回 url 字段")
        ext = info.get("ext", "mp4")
        title = info.get("title", "douyin_video")
        safe_title = _re.sub(r'[\\/:*?"<>|]', '_', title)[:80]
        return AudioDownloadResult(
            file_path=direct_url,
            title=f"{safe_title}.{ext}",
            duration=float(info.get("duration", 0) or 0),
            cover_url=info.get("thumbnail"),
            platform="douyin",
            video_id=str(info.get("id", "")),
            raw_info={"source": f"ytdlp_{label}"},
            video_path=None,
            transcript=None,
        )

    def download(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        quality: str = "fast",
        need_video: Optional[bool] = False,
        skip_download: bool = False
    ) -> AudioDownloadResult:
        """抖音下载入口（仅 yt-dlp）
        策略：带Cookie -> 无Cookie（两次尝试）
        skip_download=True：仅解析不下载，file_path 存直链 URL
        """
        video_url = self._resolve_short_url(video_url)

        # ---------- skip_download=True：仅解析 ----------
        if skip_download:
            attempts = []
            if self._cookie:
                attempts.append(("with_cookie", self._cookie))
            attempts.append(("no_cookie", None))

            last_error = None
            for label, attempt_cookie in attempts:
                try:
                    return self._parse_only(video_url, label, attempt_cookie)
                except DownloadError as e:
                    last_error = e
                    err_msg = str(e).lower()
                    if 'cookies' in err_msg or 'login' in err_msg or 'sign in' in err_msg or 'fresh' in err_msg:
                        print(f"[DouyinDownloader] {label}解析失败（需Cookie/登录）: {e}")
                        continue
                    raise
            # 所有尝试都失败
            raise ValueError(
                f"抖音解析失败：{last_error}。"
                "可能原因：1)Cookie已过期请重新获取；2)视频需登录账号才能访问；"
                "3)请在浏览器中打开该链接确认可正常播放。"
            )

        # ---------- 原下载逻辑 ----------
        if output_dir is None:
            output_dir = self.cache_data
        os.makedirs(output_dir, exist_ok=True)

        attempts = []
        if self._cookie:
            attempts.append(("with_cookie", self._cookie))
        attempts.append(("no_cookie", None))

        last_error = None
        for label, attempt_cookie in attempts:
            try:
                ydl_opts = self._build_opts(output_dir, need_video, attempt_cookie)
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    video_id = str(info.get('id', ''))
                    title = info.get('title', '')
                    duration = info.get('duration', 0) or 0
                    cover_url = info.get('thumbnail')
                    ext = info.get('ext', 'mp4')
                    file_path = os.path.join(output_dir, f"{video_id}.{ext}")

                return AudioDownloadResult(
                    file_path=file_path,
                    title=title,
                    duration=float(duration),
                    cover_url=cover_url,
                    platform="douyin",
                    video_id=video_id,
                    raw_info={'source': f'ytdlp_{label}'},
                    video_path=file_path if need_video else None
                )
            except DownloadError as e:
                last_error = e
                err_msg = str(e).lower()
                if 'cookies' in err_msg or 'login' in err_msg or 'sign in' in err_msg or 'fresh' in err_msg:
                    logger.warning("[DouyinDownloader] %s 下载失败（需 Cookie/登录）: %s", label, e)
                    continue
                # 其他错误直接抛出
                raise

        # 所有尝试都失败
        raise ValueError(
            f"抖音下载失败：{last_error}。"
            "可能原因：1)Cookie已过期请重新获取；2)视频需登录账号才能访问；"
            "3)请在浏览器中打开该链接确认可正常播放。"
        )
