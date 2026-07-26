"""
工具类路由：第一财经视频链接获取等
"""
import re
import sys
import subprocess
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/tools", tags=["tools"])

# 脚本所在目录（相对项目根）
SCRIPT_DIR = Path(__file__).resolve()
SCRIPT_PATH = SCRIPT_DIR.parent / "yicai_video_downloader.py"


class YicaiFetchRequest(BaseModel):
    date: str
    columns: Optional[List[str]] = None


def _parse_name_url_output(stderr_text: str) -> List[dict]:
    """
    解析 yicai_video_downloader.py 的 stderr 输出 [name+url文本输出] 段
    每对 name + url 用空行分隔
    """
    marker = "[name+url文本输出]"
    if marker not in stderr_text:
        return []

    chunk = stderr_text.split(marker, 1)[1]
    lines = [ln.strip() for ln in chunk.splitlines()]
    # 去除空行
    non_empty = [ln for ln in lines if ln]

    items = []
    # 两两成对：第 0 行为 name, 第 1 行为 url
    for i in range(0, len(non_empty) - 1, 2):
        name = non_empty[i]
        url = non_empty[i + 1]
        # 简单校验
        if not url.startswith("http"):
            continue
        items.append({"name": name, "url": url})
    return items


@router.post("/yicai/fetch")
async def yicai_fetch(req: YicaiFetchRequest):
    """
    调用 .trae/tool/yicai_video_downloader.py 获取指定日期的第一财经视频链接
    """
    date = (req.date or "").strip()
    if not re.match(r"^\d{4}$|^\d{8}$", date):
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "日期格式错误，应为 MMDD（如 0723）或 YYYYMMDD（如 20250723）",
            },
        )

    if not SCRIPT_PATH.exists():
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"脚本不存在: {SCRIPT_PATH}"},
        )

    cmd = [sys.executable, str(SCRIPT_PATH), date]
    if req.columns:
        # 过滤非法列名（防止命令注入）
        safe_cols = [c for c in req.columns if re.match(r"^[a-z]+$", c)]
        cmd.extend(safe_cols)

    try:
        # 强制子进程 UTF-8 输出，避免 Windows GBK 无法编码 emoji
        env = {**__import__("os").environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        result = subprocess.run(
            cmd,
            cwd=str(SCRIPT_DIR.parent.parent),  # 项目根
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(
            status_code=504,
            content={"success": False, "error": "脚本执行超时（60s）"},
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"脚本调用失败: {e}"},
        )

    if result.returncode != 0:
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": f"脚本退出码 {result.returncode}",
                "stderr": result.stderr[-2000:],  # 截断防止过大
            },
        )

    items = _parse_name_url_output(result.stderr)
    return JSONResponse(
        content={"success": True, "date": date, "items": items, "count": len(items)}
    )
