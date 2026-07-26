#!/usr/bin/env python3
"""
第一财经视频下载链接获取脚本
用法: python3 yicai_video_downloader.py <日期> [栏目...]
日期格式: MMDD (如 0720) 或 YYYYMMDD (如 20250720，精确匹配年份)
可选栏目: jinrigushi(今日股市), tangulunjin(谈股论金), gongsiyuhangye(公司与行业), cjyxx(财经夜行线), diuliuriqi(第六交易日)
默认获取全部可用栏目

示例:
  python3 yicai_video_downloader.py 0720                    # 获取0720日视频（任意年份）
  python3 yicai_video_downloader.py 20250720               # 获取2025-07-20视频（精确匹配年份）
  python3 yicai_video_downloader.py 0716 jinrigushi tangulunjin  # 获取指定栏目
"""

import sys
import re
import json
import subprocess

# 强制 stdout/stderr 使用 UTF-8（Windows 默认 GBK 无法编码 emoji）
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 栏目配置：名称 -> (列表页URL, 显示名称)
# 注：display_name 即 NewsTitle 的前缀（"今日股市"、"第六交易日" 等）
# 第一财经已将 diuliuriqi 路径改名为 6thtradingday
COLUMNS = {
    "jinrigushi":     ("https://www.yicai.com/video/jinrigushi/",    "今日股市"),
    "tangulunjin":    ("https://www.yicai.com/video/tangulunjin/",   "谈股论金"),
    "gongsiyuhangye": ("https://www.yicai.com/video/gongsiyuhangye/","公司与行业"),
    "cjyxx":          ("https://www.yicai.com/video/cjyxx/",         "财经夜行线"),
    "diuliuriqi":     ("https://www.yicai.com/video/6thtradingday/", "第六交易日"),
}

# 默认获取的栏目顺序
DEFAULT_COLUMNS = ["jinrigushi", "tangulunjin", "gongsiyuhangye", "cjyxx", "diuliuriqi"]

def curl_get(url, timeout=15):
    """使用curl获取页面内容"""
    try:
        result = subprocess.run(
            ["curl", "-s", "-L", "--max-time", str(timeout), url],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        return result.stdout
    except Exception as e:
        print(f"  [错误] curl请求失败: {e}", file=sys.stderr)
        return ""


def extract_m3u8_url(html):
    """从HTML中提取m3u8视频链接（兜底方案）"""
    m = re.search(r'(https://[^"\'<>\s]+\.m3u8[^"\'<>\s]*)', html)
    return m.group(1).replace("&amp;", "&") if m else None


def _extract_embedded_json(html):
    """
    从第一财经列表页HTML中提取嵌入的 JSON 视频数据。
    当前页面结构: <script>var ... = [{...}, {...}];</script>
    """
    items = []
    i, n = 0, len(html)
    while i < n:
        idx = html.find('"ChannelName"', i)
        if idx == -1:
            break
        # 向前找最近的 '{'
        start = html.rfind('{', 0, idx)
        if start == -1 or start < i - 200:
            i = idx + 1
            continue
        # 向后匹配平衡的 '}'，处理字符串内的大括号
        depth, j, in_str, esc = 0, start, False, False
        while j < n:
            ch = html[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == '\\':
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        break
            j += 1
        if j >= n or depth != 0:
            i = idx + 1
            continue
        i = j + 1
        candidate = html[start:j + 1]
        if '"NewsTitle"' not in candidate:
            continue
        if '"VideoUrl"' not in candidate and '"url"' not in candidate:
            continue
        try:
            obj = json.loads(candidate)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("NewsTitle") and (obj.get("VideoUrl") or obj.get("url")):
            items.append(obj)
    return items


def _date_in_pubdate(pub_date, mm, dd, yyyy=None):
    """
    检查 pubDate 是否匹配 MMDD（可选 YYYY）。
    pubDate 形如 '2025-12-15 19:16' 或 '2025-12-15T19:16:00'
    """
    if not pub_date:
        return False
    if yyyy and not pub_date.startswith(f"{yyyy}-"):
        return False
    return (f"-{mm}-{dd} " in pub_date) or (f"-{mm}-{dd}T" in pub_date) or (f"{int(mm)}月{int(dd)}日" in pub_date)


def find_video_in_json(items, date_str, title_prefix):
    """
    在 JSON 视频列表中按 NewsTitle 前缀 + pubDate 双重匹配查找指定日期。
    date_str 长度 8 时按 YYYYMMDD 解析（精确匹配年份），长度 4 时按 MMDD 解析。
    """
    if len(date_str) == 8:
        yyyy, mm, dd = date_str[:4], date_str[4:6], date_str[6:]
    else:
        yyyy, mm, dd = None, date_str[:2], date_str[2:]

    prefix = title_prefix + date_str[-4:]  # 标题里的日期永远是 MMDD（如 "今日股市0720丨..."）
    for item in items:
        title = item.get("NewsTitle") or ""
        if title.startswith(prefix) and _date_in_pubdate(
            item.get("pubDate") or item.get("CreateDate") or "", mm, dd, yyyy
        ):
            return item
    return None


def find_video_url_for_date(html, date_str, title_prefix):
    """
    在已抓取的列表页 HTML 中查找指定日期的视频。
    date_str 长度 8 时按 YYYYMMDD 解析（精确匹配年份），长度 4 时按 MMDD 解析。
    返回: (detail_url, title, m3u_url) 或 (None, None, None)
    """
    if not html:
        return None, None, None

    # 标题里日期格式统一是 MMDD
    date_short = date_str[-4:]
    mm, dd = date_short[:2], date_short[2:]

    # 策略A：嵌入 JSON（新页面结构）
    item = find_video_in_json(_extract_embedded_json(html), date_str, title_prefix)
    if item:
        url = item.get("url") or ""
        if url.startswith("/video/"):
            detail_url = f"https://www.yicai.com{url}"
        elif url.startswith("http"):
            detail_url = url
        else:
            detail_url = None
        if detail_url:
            return detail_url, (item.get("NewsTitle") or "").strip(), item.get("VideoUrl") or None

    # 策略B：旧版 HTML <h2>链接 解析（兜底）
    # 结构: <a href="/video/XXX.html"...><h2>栏目标题MMDD丨...</h2></a>

    # B1: 直接定位 <h2>...</h2>
    h2_match = re.search(rf'<h2[^>]*>([^<]*?{date_short}[丨|][^<]*?)</h2>', html)
    if h2_match:
        title = h2_match.group(1).strip()
        search_region = html[max(0, h2_match.start() - 500):h2_match.start()]
        link_match = re.search(r'href="(/video/(\d+)\.html)"', search_region)
        if link_match:
            return f"https://www.yicai.com{link_match.group(1)}", title, None

    # B2: 找所有 /video/XXX.html 链接附近包含 MMDD丨 的文本
    for path in re.findall(r'href="(/video/\d+\.html)"', html):
        chunk = html[html.find(path) + len(path):][:600]
        if date_short in chunk and ('丨' in chunk or '|' in chunk):
            m = re.search(rf'<h2[^>]*>([^<]*?{date_short}[丨|][^<]*?)</h2>', chunk) \
                or re.search(rf'([^<>]*?{date_short}[丨|][^<>]*?)', chunk)
            if m:
                title = re.sub(r'\s+', ' ', m.group(1)).strip()
                return f"https://www.yicai.com{path}", title, None

    return None, None, None


def check_http_status(url, timeout=10):
    """检查URL的HTTP状态码"""
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", str(timeout), url],
            capture_output=True, text=True, encoding="utf-8",
        )
        return result.stdout.strip()
    except Exception as e:
        return f"ERROR: {e}"


def get_video_link(column_key, date_str):
    """
    获取指定栏目和日期的视频下载链接
    返回: dict with keys: name, url, status, detail_url, title 或 None(未找到)
    """
    if column_key not in COLUMNS:
        print(f"  [错误] 未知栏目: {column_key}", file=sys.stderr)
        return None

    list_url, display_name = COLUMNS[column_key]
    print(f"\n📺 查找 {display_name}{date_str}...", file=sys.stderr)

    # 步骤1: 抓取列表页（仅一次）+ 解析
    list_html = curl_get(list_url)
    detail_url, title, m3u8_url = find_video_url_for_date(list_html, date_str, display_name)
    if not detail_url:
        print(f"  ⚠️ 未找到 {display_name}{date_str} 的视频（可能尚未发布）", file=sys.stderr)
        return None

    print(f"  📄 详情页: {detail_url}", file=sys.stderr)
    print(f"  📝 标题: {title}", file=sys.stderr)

    # 步骤2: 优先 JSON.VideoUrl（已在步骤1拿到），否则从详情页兜底
    if m3u8_url:
        print(f"  🎯 JSON.VideoUrl 直接命中，跳过详情页", file=sys.stderr)
    else:
        m3u8_url = extract_m3u8_url(curl_get(detail_url))

    if not m3u8_url:
        print(f"  ❌ 无法获取视频链接", file=sys.stderr)
        return None

    status = check_http_status(m3u8_url)
    status_icon = "✅" if status == "200" else f"⚠️ HTTP {status}"
    print(f"  {status_icon} 链接有效 (HTTP {status})", file=sys.stderr)

    return {
        "name": f"{date_str[-4:]}{display_name}.mp4",
        "url": m3u8_url,
        "status": status,
        "detail_url": detail_url,
        "title": title,
        "column": display_name,
        "date": date_str,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    date_str = sys.argv[1]
    if not re.match(r'^\d{4}$|^\d{8}$', date_str):
        print(f"[错误] 日期格式应为 MMDD（如 0720）或 YYYYMMDD（如 20250720）", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) > 2:
        columns = [c.lower() for c in sys.argv[2:]]
        invalid = [c for c in columns if c not in COLUMNS]
        if invalid:
            print(f"[错误] 未知栏目: {invalid}", file=sys.stderr)
            print(f"可用栏目: {', '.join(COLUMNS.keys())}", file=sys.stderr)
            sys.exit(1)
    else:
        columns = DEFAULT_COLUMNS

    sep = "=" * 60
    print(sep, file=sys.stderr)
    print(f"📅 正在获取 {date_str} 日视频链接 ({len(columns)}个栏目)", file=sys.stderr)
    print(sep, file=sys.stderr)

    results = []
    for col_key in columns:
        r = get_video_link(col_key, date_str)
        if r:
            results.append(r)

    print(f"\n{sep}")
    print(f"📺 {date_str}日 视频下载链接汇总")
    print(sep)

    if not results:
        print("\n⚠️ 未找到任何视频链接")
        sys.exit(0)

    print(f"\n### {date_str[:4]}年{date_str[4:6] if len(date_str) == 8 else date_str[:2]}月{date_str[6:8] if len(date_str) == 8 else date_str[2:]}日\n")
    for r in results:
        status_tag = "" if r["status"] == "200" else f" [HTTP {r['status']}]"
        print(f"**{r['name']}**{status_tag}")
        print(f"{r['url']}")
        print()

    success = sum(1 for r in results if r["status"] == "200")
    print(f"---\n统计: 成功 {success}/{len(results)}, 失败 {len(results) - success}")

    # stderr 输出 name+url 段（供 tools.py 解析）
    print(f"\n[name+url文本输出]", file=sys.stderr)
    for r in results:
        print(f"{r['name']}", file=sys.stderr)
        print(f"{r['url']}", file=sys.stderr)
        print(file=sys.stderr)


if __name__ == "__main__":
    main()
