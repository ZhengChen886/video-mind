#!/usr/bin/env python3
"""
抖音视频直链获取（仅解析，不下载）
用法: python3 douyin_link_fetcher.py <分享链接|视频页URL>
stdout: {"items":[{"name":"...","url":"...mp4"}], "title": "...", "duration": 123, "video_id": "..."}
"""
import json
import sys

from app.downloaders.douyin_downloader import DouyinDownloader


def main():
    if len(sys.argv) < 2:
        print("Usage: douyin_link_fetcher.py <分享链接|URL>", file=sys.stderr)
        sys.exit(1)
    video_url = sys.argv[1].strip()
    downloader = DouyinDownloader()
    # skip_download=True：仅解析，file_path 字段复用存直链 URL
    result = downloader.download(video_url, skip_download=True)
    direct_url = result.file_path
    if not direct_url or not direct_url.startswith(("http://", "https://")):
        raise ValueError(f"抖音解析失败：未拿到直链（file_path={direct_url!r}）")
    print(json.dumps({
        "items":    [{"name": result.title, "url": direct_url}],
        "title":    result.title,
        "duration": result.duration,
        "video_id": result.video_id,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
