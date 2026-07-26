#!/usr/bin/env python3
"""
B站视频直链获取（仅解析，不下载）
同时输出视频流和音频流两条直链。
用法: python3 bilibili_link_fetcher.py <BV号|完整URL>
stdout: {
  "items": [
    {"name": "<title>.mp4", "url": "视频直链", "kind": "video"},
    {"name": "<title>.m4a", "url": "音频直链", "kind": "audio"},
  ],
  "title":    "...",
  "duration": 123,
  "video_id": "BV1xx",
  "cover":    "https://...",
  "platform": "bilibili",
}
"""
import json
import re
import sys

from app.downloaders.bilibili_downloader import BilibiliDownloader


def _fetch(downloader: BilibiliDownloader, video_url: str, need_video: bool):
    """调用一次 downloader 拿一条直链（视频或音频）。"""
    res = downloader.download(video_url, need_video=need_video, skip_download=True)
    if not res.file_path or not res.file_path.startswith(("http://", "https://")):
        kind = "视频" if need_video else "音频"
        raise ValueError(f"B 站{kind}解析失败：未拿到直链（file_path={res.file_path!r}）")
    return res


def main():
    if len(sys.argv) < 2:
        print("Usage: bilibili_link_fetcher.py <BV号|URL>", file=sys.stderr)
        sys.exit(1)
    raw = sys.argv[1].strip()
    # 接受 BV 号或完整 URL；BV 号自动补全 https://www.bilibili.com/video/<BV>/
    if re.match(r"^BV[0-9A-Za-z]+$", raw):
        video_url = f"https://www.bilibili.com/video/{raw}/"
    else:
        video_url = raw

    downloader = BilibiliDownloader()

    # 取视频直链；失败时回退到仅音频（部分老视频/版权视频无单独视频流）
    try:
        v_res = _fetch(downloader, video_url, need_video=True)
    except Exception:
        v_res = None

    # 取音频直链
    a_res = _fetch(downloader, video_url, need_video=False)

    # 任意一条拿到直链即可继续；取标题/时长/封面以音频结果为准（同一视频元数据一致）
    if v_res is None and a_res is None:
        raise ValueError("B 站解析失败：视频与音频直链均未拿到")

    title    = (v_res or a_res).title
    duration = (v_res or a_res).duration
    video_id = (v_res or a_res).video_id
    cover    = (v_res or a_res).cover_url

    items = []
    if v_res is not None:
        items.append({"name": v_res.title, "url": v_res.file_path, "kind": "video"})
    items.append({"name": a_res.title, "url": a_res.file_path, "kind": "audio"})

    print(json.dumps({
        "items":    items,
        "title":    title,
        "duration": duration,
        "video_id": video_id,
        "cover":    cover,
        "platform": "bilibili",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
