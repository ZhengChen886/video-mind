"""
仪表盘 API 路由
提供首页数据统计、分析等 API
"""
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.services.dashboard_service import dashboard_service


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def success_response(data=None, message="Success"):
    response = {"success": True, "message": message}
    if data is not None:
        response["data"] = data
    return JSONResponse(response)


def error_response(error: str, status_code: int = 400):
    return JSONResponse({
        "success": False,
        "error": error
    }, status_code=status_code)


@router.get("/stats")
async def get_stats():
    """
    获取首页统计数据
    """
    try:
        stats = dashboard_service.get_stats()
        return success_response(stats)
    except Exception as e:
        return error_response(str(e))


@router.get("/distribution")
async def get_distribution():
    """
    获取视频分类分布
    """
    try:
        distribution = dashboard_service.get_distribution()
        return success_response(distribution)
    except Exception as e:
        return error_response(str(e))


@router.get("/trends")
async def get_trends(days: int = Query(default=7, ge=1, le=90)):
    """
    获取趋势数据
    """
    try:
        trends = dashboard_service.get_trends(days)
        return success_response(trends)
    except Exception as e:
        return error_response(str(e))


@router.get("/recent")
async def get_recent(limit: int = Query(default=5, ge=1, le=20)):
    """
    获取最近活动
    """
    try:
        recent = dashboard_service.get_recent_activity(limit)
        return success_response(recent)
    except Exception as e:
        return error_response(str(e))


@router.get("/documents/stats")
async def get_document_stats():
    """
    获取各类文档统计
    """
    try:
        stats = dashboard_service.get_document_stats()
        return success_response(stats)
    except Exception as e:
        return error_response(str(e))
