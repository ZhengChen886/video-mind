"""
SRT 字幕解析工具
将 SRT 字幕解析为分段结构，并按每 5 个字幕块合并为一段，
产出可直接写入 _subtitle.md 的纯文本。
"""
import logging
import re

logger = logging.getLogger(__name__)

# 时间码行：00:00:01,000 --> 00:00:03,500（毫秒分隔符兼容 , 和 .，可省略）
_TIMECODE_RE = re.compile(
    r'^\s*(\d{1,3}:\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)\s*-->\s*'
    r'(\d{1,3}:\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)'
)

# 每多少个字幕块合并为一段
_BLOCKS_PER_PARAGRAPH = 5

_CANNOT_PARSE = "无法解析SRT内容"


def parse_srt(srt_text: str) -> dict:
    """解析 SRT 文本，返回 {"success", "text", "segments", "error"}"""
    fail = {"success": False, "text": "", "segments": [], "error": _CANNOT_PARSE}
    try:
        if not srt_text or not srt_text.strip():
            return dict(fail)

        segments = []
        # 统一换行符后按空行分块
        normalized = srt_text.replace("\r\n", "\n").replace("\r", "\n")
        for block in re.split(r"\n\s*\n", normalized):
            lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
            if not lines:
                continue

            # 定位时间码行（必须包含 " --> " 才算有效块）
            tc_idx = None
            for i, ln in enumerate(lines):
                if " --> " in ln:
                    tc_idx = i
                    break
            if tc_idx is None:
                continue
            m = _TIMECODE_RE.match(lines[tc_idx])
            if not m:
                continue

            # 序号行：时间码行之前若为纯数字则作为 index，否则按顺序编号
            index = len(segments) + 1
            if tc_idx > 0 and lines[0].isdigit():
                index = int(lines[0])

            # 块内多行文本直接拼接，不加分隔符
            text = "".join(lines[tc_idx + 1:])
            segments.append({
                "index": index,
                "start": m.group(1),
                "end": m.group(2),
                "text": text,
            })

        if not segments:
            logger.debug("SRT内容中未找到有效字幕块")
            return dict(fail)

        # 每 5 个字幕块合并为一段，段间以空行分隔
        paragraphs = [
            "".join(seg["text"] for seg in segments[i:i + _BLOCKS_PER_PARAGRAPH])
            for i in range(0, len(segments), _BLOCKS_PER_PARAGRAPH)
        ]
        return {
            "success": True,
            "text": "\n\n".join(paragraphs),
            "segments": segments,
            "error": None,
        }
    except Exception as e:
        logger.warning(f"解析SRT内容时发生意外异常: {e}")
        return dict(fail)


def srt_to_subtitle_md(srt_text: str, lang: str = "") -> dict:
    """组合 parse_srt，输出可直接写入 _subtitle.md 的纯文本，返回 {"success", "text", "error"}"""
    result = parse_srt(srt_text)
    if not result.get("success"):
        return {
            "success": False,
            "text": "",
            "error": result.get("error") or _CANNOT_PARSE,
        }
    if lang:
        logger.debug(f"字幕语言: {lang}")
    return {
        "success": True,
        "text": result.get("text", ""),
        "error": None,
    }
