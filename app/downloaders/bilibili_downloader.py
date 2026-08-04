"""
B站视频下载器
基于 yt-dlp，支持可选Cookie

约定：当调用 download(..., skip_download=True) 时，不写文件，
      返回的 AudioDownloadResult.file_path 字段复用存直链 URL，
      title 字段复用存带扩展名的文件名（供 link fetcher 脚本使用）。
"""
import logging
import os
import re as _re
import tempfile
from typing import Union, Optional

import yt_dlp

from app.downloaders.base import Downloader
from app.models.audio_model import AudioDownloadResult
from app.services.cookie_manager import cookie_manager

logger = logging.getLogger(__name__)


class BilibiliDownloader(Downloader):
    def __init__(self):
        super().__init__()
        self._cookie = cookie_manager.get("bilibili")
        self._cookiefile = self._write_netscape_cookie_file()

    def _write_netscape_cookie_file(self) -> Optional[str]:
        """将Cookie转为yt-dlp可用的Netscape格式"""
        if not self._cookie:
            logger.info("B站Cookie未配置，部分视频可能下载失败")
            return None
        lines = ["# Netscape HTTP Cookie File\n"]
        for pair in self._cookie.split("; "):
            if "=" in pair:
                key, value = pair.split("=", 1)
                lines.append(f".bilibili.com\tTRUE\t/\tFALSE\t0\t{key}\t{value}\n")
        tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', delete=False, encoding='utf-8'
        )
        tmp.writelines(lines)
        tmp.close()
        return tmp.name

    def _build_ydl_opts(self, need_video: bool, output_dir: str,
                        skip_download: bool = False) -> dict:
        """构造 yt-dlp 选项

        skip_download=True:  仅解析，需保证 info['url'] 有直链 → 用单流策略
        skip_download=False: 实际下载，用 DASH 合并获取最佳画质+音轨
        """
        if skip_download:
            # 解析模式：单流，避免 DASH 合并导致 info['url'] 为空
            # need_video 决定是取视频流还是音频流
            if need_video:
                fmt = "best[height<=720][ext=mp4]/best[ext=mp4]/best[height<=720]/bestvideo[height<=720]/best"
                final_ext = "mp4"
            else:
                fmt = "bestaudio[ext=m4a]/bestaudio/best"
                final_ext = "mp3"  # 名称用 mp3（与下载后 FFmpeg 转码输出一致）
        elif need_video:
            # 下载模式：DASH 合并 720p → 单文件 720p mp4 → 任意最佳 mp4
            fmt = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[ext=mp4]/best"
            final_ext = "mp4"
        else:
            fmt = "bestaudio[ext=m4a]/bestaudio/best"
            final_ext = "mp3"

        ydl_opts = {
            'format': fmt,
            'outtmpl': os.path.join(output_dir, "%(id)s.%(ext)s"),
            'http_headers': {'Referer': 'https://www.bilibili.com'},
            'merge_output_format': 'mp4',
            'noplaylist': True,
            'quiet': True,
        }
        if self._cookiefile:
            ydl_opts['cookiefile'] = self._cookiefile
        return ydl_opts, final_ext

    def _postprocessors_for(self, need_video: bool) -> list:
        if need_video:
            return []
        return [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '64',
        }]

    def download(
        self,
        video_url: str,
        output_dir: Union[str, None] = None,
        quality: str = "fast",
        need_video: Optional[bool] = False,
        skip_download: bool = False
    ) -> AudioDownloadResult:
        # ---------- skip_download=True：仅解析，返回直链 ----------
        if skip_download:
            tmp_dir = self.cache_data
            os.makedirs(tmp_dir, exist_ok=True)
            # need_video 控制取视频流还是音频流
            ydl_opts, final_ext = self._build_ydl_opts(
                need_video=bool(need_video), output_dir=tmp_dir, skip_download=True
            )
            # 关键：不下载
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=False)
            direct_url = info.get("url")
            if not direct_url:
                raise ValueError("yt-dlp 未返回 url 字段")
            # need_video=False 时强制用 final_ext（避免 yt-dlp 返回 m4a 时污染为 m4a）
            if need_video:
                ext = info.get("ext") or final_ext
            else:
                ext = final_ext
            title = info.get("title", "video")
            safe_title = _re.sub(r'[\\/:*?"<>|]', '_', title)[:80]
            return AudioDownloadResult(
                file_path=direct_url,                    # 复用：存直链 URL
                title=f"{safe_title}.{ext}",             # 复用：存 filename
                duration=float(info.get("duration", 0) or 0),
                cover_url=info.get("thumbnail"),
                platform="bilibili",
                video_id=str(info.get("id", "")),
                raw_info=info,
                video_path=None,
                transcript=None,
            )

        # ---------- 原下载逻辑 ----------
        if output_dir is None:
            output_dir = self.cache_data
        os.makedirs(output_dir, exist_ok=True)

        ydl_opts, final_ext = self._build_ydl_opts(need_video, output_dir)
        ydl_opts['postprocessors'] = self._postprocessors_for(need_video)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
            video_id = info.get("id")
            title = info.get("title")
            duration = info.get("duration", 0) or 0
            cover_url = info.get("thumbnail")
            # 后处理可能改名（如 bestaudio -> .mp3），优先按 video_id 匹配最终文件
            audio_path = os.path.join(output_dir, f"{video_id}.{final_ext}")

        # 如未生成预期文件则找其他格式
        if not os.path.exists(audio_path):
            for f in os.listdir(output_dir):
                if f.startswith(str(video_id)) and f.endswith(('.m4a', '.mp3', '.mp4', '.webm')):
                    audio_path = os.path.join(output_dir, f)
                    break

        return AudioDownloadResult(
            file_path=audio_path,
            title=title or "",
            duration=float(duration),
            cover_url=cover_url,
            platform="bilibili",
            video_id=str(video_id) if video_id else "",
            raw_info=info,
            video_path=audio_path if need_video else None
        )

    def download_subtitles(self, video_url: str, output_dir: str = None,
                           langs: list = None) -> Optional[dict]:
        """
        尝试获取B站字幕（使用yt-dlp）
        返回 {'srt': str, 'lang': str, 'segments': list} 或 None
        """
        if output_dir is None:
            output_dir = self.cache_data
        os.makedirs(output_dir, exist_ok=True)

        if langs is None:
            langs = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh', 'en']

        video_id_match = None
        import re
        m = re.search(r'BV([0-9A-Za-z]+)', video_url)
        if m:
            video_id_match = f"BV{m.group(1)}"

        ydl_opts = {
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': langs,
            'subtitlesformat': 'srt',
            'skip_download': True,
            'outtmpl': os.path.join(output_dir, f'{video_id_match or "%(id)s"}.%(ext)s'),
            'quiet': True,
        }
        if self._cookiefile:
            ydl_opts['cookiefile'] = self._cookiefile
            ydl_opts['http_headers'] = {'Referer': 'https://www.bilibili.com'}

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                subtitles = info.get('requested_subtitles') or {}
                if not subtitles:
                    return None

                for lang in langs:
                    if lang in subtitles:
                        sub = subtitles[lang]
                        if 'data' in sub and sub['data']:
                            return {
                                'srt': sub['data'],
                                'lang': lang,
                                'source': 'bilibili',
                            }
                        ext = sub.get('ext', 'srt')
                        sub_file = os.path.join(
                            output_dir, f"{video_id_match or info.get('id')}.{lang}.{ext}"
                        )
                        if os.path.exists(sub_file):
                            with open(sub_file, 'r', encoding='utf-8') as f:
                                return {
                                    'srt': f.read(),
                                    'lang': lang,
                                    'source': 'bilibili',
                                }
        except Exception as e:
            logger.warning(f"获取B站字幕失败: {e}")
        return None
