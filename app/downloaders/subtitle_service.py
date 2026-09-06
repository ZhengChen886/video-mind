"""
平台字幕抓取服务
探测视频链接所属平台（当前支持B站），尝试抓取平台字幕并解析为纯文本，
写入视频同目录的 {video_stem}_subtitle.md 文件，供后续笔记流程使用。

约定：stdout 必须保持纯 JSON 输出，所有警告走 logging (stderr)，禁止 print。
"""
import logging
from pathlib import Path
from typing import Optional

from app.downloaders.subtitle_parser import srt_to_subtitle_md

logger = logging.getLogger(__name__)

# B站域名特征：bilibili.com / b23.tv（含子域名如 www.bilibili.com）
_BILIBILI_DOMAINS = ("bilibili.com", "b23.tv")


def _skipped() -> dict:
    """静默跳过（无字幕可抓）的标准返回"""
    return {"success": True, "fetched": False, "subtitle_path": None, "error": None}


def detect_platform(url: str) -> Optional[str]:
    """B站域名（bilibili.com / b23.tv，含子域名如 www.bilibili.com）返回 "bilibili"，其余/空返回 None"""
    if not url or not isinstance(url, str):
        return None
    lower = url.lower()
    for domain in _BILIBILI_DOMAINS:
        if domain in lower:
            return "bilibili"
    return None


def try_fetch_platform_subtitles(source_url: str, video_path: str) -> dict:
    """
    探测平台并抓取字幕，成功则写入 video_path 同目录的 {video_stem}_subtitle.md
    返回 {"success", "fetched", "subtitle_path", "error"}
    """
    try:
        # 1. 无来源链接或非支持平台：静默跳过
        platform = detect_platform(source_url or "")
        if platform is None:
            return _skipped()

        # 2. 视频文件必须存在（字幕写入其所在目录）
        if not video_path or not Path(video_path).exists():
            return {
                "success": False,
                "fetched": False,
                "subtitle_path": None,
                "error": "视频文件不存在",
            }

        # 3. 按平台抓取字幕
        sub = None
        if platform == "bilibili":
            try:
                from app.downloaders.bilibili_downloader import BilibiliDownloader
                downloader = BilibiliDownloader()
                sub = downloader.download_subtitles(source_url)
            except Exception as e:
                logger.warning(f"抓取B站字幕失败: {e}")
                sub = None

        if not sub:
            return _skipped()

        # 4. 解析为可写入 _subtitle.md 的纯文本
        md = srt_to_subtitle_md(sub.get("srt") or "", sub.get("lang") or "")
        if not md.get("success"):
            logger.warning(f"平台字幕解析失败: {md.get('error')}")
            return _skipped()

        # 5. 写入视频同目录
        subtitle_path = Path(video_path).parent / f"{Path(video_path).stem}_subtitle.md"
        subtitle_path.write_text(md.get("text", ""), encoding="utf-8")
        return {
            "success": True,
            "fetched": True,
            "subtitle_path": str(subtitle_path),
            "error": None,
        }
    except Exception as e:
        logger.warning(f"抓取平台字幕时发生意外异常: {e}")
        return _skipped()
