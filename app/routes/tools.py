"""
工具类路由：多平台视频链接获取（统一 /api/tools/fetch）
"""
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.cookie_manager import cookie_manager

router = APIRouter(prefix="/api/tools", tags=["tools"])

# 脚本所在目录（app/routes/）
SCRIPT_DIR = Path(__file__).resolve().parent

# 支持 Cookie 配置的平台白名单
COOKIE_SUPPORTED_PLATFORMS = {"bilibili", "douyin"}


# ============================
# 平台注册表
# ============================
@dataclass
class PlatformSpec:
    id: str                       # 平台 id（小写英文，URL 友好）
    display_name: str             # 前端下拉显示名
    script: str                   # 脚本文件名（相对 SCRIPT_DIR）
    input_pattern: str            # 输入校验正则
    input_placeholder: str        # 输入框 placeholder
    input_maxlength: int          # 输入框 maxlength
    extra_args: List[str] = field(default_factory=list)  # 透传给脚本的固定参数
    timeout: int = 60              # 超时（秒）
    needs_cookie: bool = False    # 是否需要 Cookie（前端据此显示配置按钮）


PLATFORMS: Dict[str, PlatformSpec] = {
    "yicai": PlatformSpec(
        id="yicai",
        display_name="第一财经",
        script="yicai_video_downloader.py",
        input_pattern=r"^\d{4}$|^\d{8}$",
        input_placeholder="第一财经日期 YYYYMMDD，如 20260724（仅输入 MMDD 时默认本年）",
        input_maxlength=8,
    ),
    "bilibili": PlatformSpec(
        id="bilibili",
        display_name="B 站",
        script="bilibili_link_fetcher.py",
        input_pattern=r"^(BV[0-9A-Za-z]+|https?://[^\s]+)$",
        input_placeholder="BV 号（如 BV1a6K36TEyW）或视频页 URL",
        input_maxlength=300,
        timeout=90,
        needs_cookie=True,
    ),
    "douyin": PlatformSpec(
        id="douyin",
        display_name="抖音",
        script="douyin_link_fetcher.py",
        input_pattern=r"^https?://[^\s]+$",
        input_placeholder="抖音分享链接（如 https://v.douyin.com/xxx）",
        input_maxlength=500,
        timeout=90,
        needs_cookie=True,
    ),
}

PLATFORMS_LIST = list(PLATFORMS.values())


# ============================
# 请求模型
# ============================
class PlatformFetchRequest(BaseModel):
    platform: str
    params: Dict[str, Any] = {}


class YicaiFetchRequest(BaseModel):
    """DEPRECATED: 旧版 yicai 端点，保留过渡期用"""
    date: str
    columns: Optional[List[str]] = None


# ============================
# 解析脚本 stdout JSON
# ============================
def _parse_stdout_json(stdout_text: str) -> List[dict]:
    """
    解析脚本 stdout JSON: {"items":[{name,url}, ...]}
    """
    try:
        data = json.loads(stdout_text)
    except json.JSONDecodeError as e:
        raise ValueError(f"脚本输出非合法 JSON: {e}")
    if not isinstance(data, dict) or "items" not in data:
        raise ValueError("脚本输出格式错误：缺少 items 字段")
    items = data["items"]
    if not isinstance(items, list):
        raise ValueError("脚本输出格式错误：items 非数组")
    return items


def _run_platform_script(spec: PlatformSpec, input_value: str) -> List[dict]:
    """调子进程执行平台脚本，解析 stdout JSON"""
    script_path = SCRIPT_DIR / spec.script
    if not script_path.exists():
        raise FileNotFoundError(f"脚本不存在: {script_path}")

    cmd = [sys.executable, str(script_path), input_value, *spec.extra_args]

    # 把项目根目录加到 PYTHONPATH，让脚本能 `from app.xxx import ...`
    project_root = str(SCRIPT_DIR.parent.parent)
    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONPATH": project_root + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    try:
        result = subprocess.run(
            cmd,
            cwd=project_root,  # 项目根
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=spec.timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"脚本执行超时（{spec.timeout}s）")

    if result.returncode != 0:
        raise RuntimeError(
            f"脚本退出码 {result.returncode}: {result.stderr[-2000:]}"
        )

    return _parse_stdout_json(result.stdout)


# ============================
# 端点：GET /api/tools/platforms
# ============================
@router.get("/platforms")
async def list_platforms():
    """返回前端下拉数据源"""
    return {
        "success": True,
        "platforms": [
            {
                "id": p.id,
                "display_name": p.display_name,
                "input_pattern": p.input_pattern,
                "input_placeholder": p.input_placeholder,
                "input_maxlength": p.input_maxlength,
                "needs_cookie": p.needs_cookie,
            }
            for p in PLATFORMS_LIST
        ],
    }


# ============================
# 端点：POST /api/tools/fetch
# ============================
@router.post("/fetch")
async def fetch_platform(req: PlatformFetchRequest):
    """统一获取入口：按 platform 字段派发到对应脚本"""
    spec = PLATFORMS.get(req.platform)
    if not spec:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": f"未知平台: {req.platform}"},
        )

    input_value = (req.params.get("input") or "").strip()
    if not re.match(spec.input_pattern, input_value):
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": f"输入格式错误，应匹配 {spec.input_pattern}（{spec.input_placeholder}）",
            },
        )

    try:
        items = _run_platform_script(spec, input_value)
    except FileNotFoundError as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})
    except TimeoutError as e:
        return JSONResponse(status_code=504, content={"success": False, "error": str(e)})
    except (ValueError, RuntimeError) as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"脚本调用失败: {e}"},
        )

    return JSONResponse(
        content={
            "success": True,
            "platform": req.platform,
            "items": items,
            "count": len(items),
        }
    )


# ============================
# 端点：Cookie 管理（GET/POST/DELETE /api/tools/cookie/{platform}）
# ============================
class CookieUpsertRequest(BaseModel):
    cookie: str


def _check_cookie_platform(platform: str) -> Optional[JSONResponse]:
    """白名单校验：不在白名单返回 400 错误响应，否则返回 None"""
    if platform not in COOKIE_SUPPORTED_PLATFORMS:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": f"平台 {platform!r} 不支持 Cookie 配置（白名单：{sorted(COOKIE_SUPPORTED_PLATFORMS)}）",
            },
        )
    return None


@router.get("/cookie/{platform}")
async def get_cookie(platform: str):
    """获取 Cookie 状态（不返回完整 Cookie，仅返回长度 + 前 20 字符预览）"""
    err = _check_cookie_platform(platform)
    if err:
        return err
    raw = cookie_manager.get(platform)
    if not raw:
        return {"success": True, "configured": False, "platform": platform}
    return {
        "success": True,
        "configured": True,
        "platform": platform,
        "length": len(raw),
        "preview": raw[:20],
    }


@router.post("/cookie/{platform}")
async def set_cookie(platform: str, req: CookieUpsertRequest):
    """保存 Cookie（写到 config/downloader.json）"""
    err = _check_cookie_platform(platform)
    if err:
        return err
    value = (req.cookie or "").strip()
    if not value:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Cookie 不能为空"},
        )
    try:
        cookie_manager.set(platform, value)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"保存失败: {e}"},
        )
    return {"success": True, "platform": platform, "length": len(value)}


@router.delete("/cookie/{platform}")
async def delete_cookie(platform: str):
    """清空 Cookie"""
    err = _check_cookie_platform(platform)
    if err:
        return err
    try:
        cookie_manager.delete(platform)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"清空失败: {e}"},
        )
    return {"success": True, "platform": platform}


# ============================
# 端点：POST /api/tools/yicai/fetch  (DEPRECATED)
# ============================
def _parse_name_url_output(stderr_text: str) -> List[dict]:
    """解析旧 yicai 脚本 stderr 的 [name+url文本输出] 段（兼容老代码）"""
    marker = "[name+url文本输出]"
    if marker not in stderr_text:
        return []
    chunk = stderr_text.split(marker, 1)[1]
    lines = [ln.strip() for ln in chunk.splitlines()]
    non_empty = [ln for ln in lines if ln]
    items = []
    for i in range(0, len(non_empty) - 1, 2):
        name = non_empty[i]
        url = non_empty[i + 1]
        if not url.startswith("http"):
            continue
        items.append({"name": name, "url": url})
    return items


@router.post("/yicai/fetch", deprecated=True)
async def yicai_fetch(req: YicaiFetchRequest):
    """DEPRECATED: 旧版 yicai 端点，请改用 POST /api/tools/fetch"""
    date = (req.date or "").strip()
    if not re.match(r"^\d{4}$|^\d{8}$", date):
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "日期格式错误，应为 MMDD（如 0723）或 YYYYMMDD（如 20250723）",
            },
        )

    script_path = SCRIPT_DIR / "yicai_video_downloader.py"
    if not script_path.exists():
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"脚本不存在: {script_path}"},
        )

    cmd = [sys.executable, str(script_path), date]
    if req.columns:
        safe_cols = [c for c in req.columns if re.match(r"^[a-z]+$", c)]
        cmd.extend(safe_cols)

    try:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        result = subprocess.run(
            cmd,
            cwd=str(SCRIPT_DIR.parent.parent),
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
                "stderr": result.stderr[-2000:],
            },
        )

    items = _parse_name_url_output(result.stderr)
    return JSONResponse(
        content={"success": True, "date": date, "items": items, "count": len(items)}
    )
