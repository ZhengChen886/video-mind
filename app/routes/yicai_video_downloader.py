#!/usr/bin/env python3
"""
第一财经视频下载链接获取脚本
用法: python3 yicai_video_downloader.py <日期> [栏目...]
日期格式: MMDD (如 0720, 0716)
可选栏目: jinrigushi(今日股市), tangulunjin(谈股论金), gongsiyuhangye(公司与行业), cjyxx(财经夜行线), diuliuriqi(第六交易日)
默认获取全部可用栏目

示例:
  python3 yicai_video_downloader.py 0720                    # 获取0720日全部栏目
  python3 yicai_video_downloader.py 0716 jinrigushi tangulunjin  # 获取指定栏目
"""

import sys
import re
import subprocess
from datetime import datetime

# 强制 stdout/stderr 使用 UTF-8（Windows 默认 GBK 无法编码 emoji）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    # sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# 栏目配置：名称 -> (列表页URL, 详情页URL模板前缀, 显示名称)
COLUMNS = {
    "jinrigushi":     ("https://www.yicai.com/video/jinrigushi/",     "今日股市"),
    "tangulunjin":    ("https://www.yicai.com/video/tangulunjin/",    "谈股论金"),
    "gongsiyuhangye": ("https://www.yicai.com/video/gongsiyuhangye/", "公司与行业"),
    "cjyxx":          ("https://www.yicai.com/video/cjyxx/",          "财经夜行线"),
    "diuliuriqi":     ("https://www.yicai.com/video/diuliuriqi/",     "第六交易日"),
}

# 默认获取的栏目顺序（排除第六交易日，除非显式指定）
DEFAULT_COLUMNS = ["jinrigushi", "tangulunjin", "gongsiyuhangye", "cjyxx"]


def curl_get(url, timeout=15):
    """使用curl获取页面内容"""
    try:
        result = subprocess.run(
            ["curl", "-s", "-L", "--max-time", str(timeout), url],
            capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
        return result.stdout
    except Exception as e:
        print(f"  [错误] curl请求失败: {e}", file=sys.stderr)
        return ""


def extract_m3u8_url(html):
    """从HTML中提取m3u8视频链接"""
    match = re.search(r'(https://[^"\'<>\s]+\.m3u8[^"\'<>\s]*)', html)
    if match:
        # 解码HTML实体 &amp; -> &
        url = match.group(1).replace("&amp;", "&")
        return url
    return None


def check_http_status(url, timeout=10):
    """检查URL的HTTP状态码"""
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", str(timeout), url],
            capture_output=True, text=True, encoding="utf-8"
        )
        return result.stdout.strip()
    except Exception as e:
        return f"ERROR: {e}"


def find_video_url_for_date(list_page_url, date_str):
    """
    在列表页查找指定日期的视频详情页URL
    返回: (详情页URL, 视频标题) 或 (None, None)
    """
    html = curl_get(list_page_url)
    if not html:
        return None, None

    # 策略1: 先找<h2>标签中包含日期的，然后向前找最近的<a href="/video/XXX.html">
    # 实际HTML结构: <a href="/video/103283953.html"...><h2>今日股市0720丨双创指数探底回升...</h2></a>
    
    # 方法A: 匹配 <h2>栏目标题MMDD丨... </h2> 附近的链接
    h2_pattern = rf'<h2[^>]*>([^<]*?{date_str}[丨|][^<]*?)</h2>'
    h2_match = re.search(h2_pattern, html)
    if h2_match:
        title = h2_match.group(1).strip()
        # 从这个h2位置向前搜索最近的 <a href="/video/XXX.html">
        h2_pos = h2_match.start()
        search_region = html[max(0, h2_pos - 500):h2_pos]
        link_match = re.search(r'href="(/video/(\d+)\.html)"', search_region)
        if link_match:
            detail_url = f"https://www.yicai.com{link_match.group(1)}"
            return detail_url, title

    # 方法B: 直接在整页中用更宽泛的模式匹配
    # 匹配: href="/video/数字.html" 后面不远处有 MMDD丨
    pattern_b = rf'href="(/video/(\d+)\.html)"[^>]*>(?:.*?<h2[^>]*>)?([^<]*?{date_str}[丨|][^<]*?)(?:</h2>)?'
    matches_b = re.findall(pattern_b, html, re.DOTALL)
    if matches_b:
        path, vid, title_text = matches_b[0]
        # 清理title
        title_clean = re.sub(r'\s+', ' ', title_text).strip()
        return f"https://www.yicai.com{path}", title_clean

    # 方法C: 最宽泛 - 找所有 /video/数字.html 链接和对应的h2
    all_links = re.findall(r'href="(/video/(\d+)\.html)"', html)
    for path, vid in all_links:
        # 检查该链接后面是否有目标日期
        after_pos = html.find(path) + len(path)
        chunk = html[after_pos:after_pos + 600]
        if date_str in chunk and ('丨' in chunk or '|' in chunk):
            title_m = re.search(rf'<h2[^>]*>([^<]*?{date_str}[丨|][^<]*?)</h2>', chunk)
            if title_m:
                return f"https://www.yicai.com{path}", title_m.group(1).strip()
            # fallback: 用chunk中包含日期的文本片段
            fallback_m = re.search(rf'([^<>]*?{date_str}[丨|][^<>]*?)', chunk)
            if fallback_m:
                return f"https://www.yicai.com{path}", fallback_m.group(1).strip()

    return None, None


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

    # 步骤1: 在列表页查找该日期的视频
    detail_url, title = find_video_url_for_date(list_url, date_str)
    if not detail_url:
        print(f"  ⚠️ 未找到 {display_name}{date_str} 的视频（可能尚未发布）", file=sys.stderr)
        return None

    print(f"  📄 详情页: {detail_url}", file=sys.stderr)
    print(f"  📝 标题: {title}", file=sys.stderr)

    # 步骤2: 从详情页提取m3u8链接
    detail_html = curl_get(detail_url)
    m3u8_url = extract_m3u8_url(detail_html)
    if not m3u8_url:
        print(f"  ❌ 无法从详情页提取视频链接", file=sys.stderr)
        return None

    # 步骤3: 验证HTTP状态码
    status = check_http_status(m3u8_url)

    result = {
        "name": f"{date_str}{display_name}.mp4",
        "url": m3u8_url,
        "status": status,
        "detail_url": detail_url,
        "title": title,
        "column": display_name,
        "date": date_str,
    }

    status_icon = "✅" if status == "200" else f"⚠️ HTTP {status}"
    print(f"  {status_icon} 链接有效 (HTTP {status})", file=sys.stderr)

    return result


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    date_str = sys.argv[1]

    # 验证日期格式
    if not re.match(r'^\d{4}$', date_str):
        print(f"[错误] 日期格式应为MMDD，如 0720、0610", file=sys.stderr)
        sys.exit(1)

    # 确定要获取的栏目
    if len(sys.argv) > 2:
        requested_columns = [c.lower() for c in sys.argv[2:]]
        # 验证栏目名称
        invalid = [c for c in requested_columns if c not in COLUMNS]
        if invalid:
            print(f"[错误] 未知栏目: {invalid}", file=sys.stderr)
            print(f"可用栏目: {', '.join(COLUMNS.keys())}", file=sys.stderr)
            sys.exit(1)
        columns = requested_columns
    else:
        columns = DEFAULT_COLUMNS

    print(f"{'='*60}", file=sys.stderr)
    print(f"📅 正在获取 {date_str} 日视频链接 ({len(columns)}个栏目)", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    results = []
    success_count = 0
    fail_count = 0

    for col_key in columns:
        result = get_video_link(col_key, date_str)
        if result:
            results.append(result)
            if result["status"] == "200":
                success_count += 1
            else:
                fail_count += 1
        else:
            fail_count += 1

    # 输出结果（纯文本格式到stdout）
    print(f"\n{'='*60}")
    print(f"📺 {date_str}日 视频下载链接汇总")
    print(f"{'='*60}")

    if not results:
        print("\n⚠️ 未找到任何视频链接")
        sys.exit(0)

    # 按日期分组输出（当前只有一天）
    print(f"\n### 2026年{date_str[:2]}月{date_str[2:]}日\n")

    for r in results:
        status_tag = "" if r["status"] == "200" else f" [HTTP {r['status']}]"
        print(f"**{r['name']}**{status_tag}")
        print(f"{r['url']}")
        print()

    # 统计信息
    print(f"---")
    print(f"统计: 成功 {success_count}/{len(results)}, 失败 {fail_count}")

    # 同时输出name+url格式的纯文本结果到stderr（方便程序化调用）
    print(f"\n[name+url文本输出]", file=sys.stderr)
    for r in results:
        print(f"{r['name']}", file=sys.stderr)
        print(f"{r['url']}", file=sys.stderr)
        print(file=sys.stderr)  # 空行分隔


if __name__ == "__main__":
    main()
