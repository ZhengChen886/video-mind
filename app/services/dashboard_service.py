"""
仪表盘数据统计服务
提供首页数据统计、分析等功能
"""
import os
import time
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime, timedelta

# 导入文件管理模块
from app.file_operations.file_manager import (
    VIDEO_DIR,
    SUPPORTED_VIDEO_EXTENSIONS,
    get_files_by_extensions,
    get_video_duration
)

# 文档类型后缀
DOCUMENT_SUFFIXES = {
    'subtitle': '_subtitle.md',
    'summary': '_summary.md',
    'outline': '_outline.md',
    'notes': '_notes.md'
}


class DashboardService:
    """仪表盘数据统计服务"""

    def __init__(self):
        self.video_dir = VIDEO_DIR

    def get_stats(self) -> Dict[str, Any]:
        """
        获取首页统计数据
        """
        videos = get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS)

        # 视频统计
        total_videos = len(videos)

        # 今日新增视频
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        today_videos = len([v for v in videos if v.get('modified', 0) >= today_start])

        # 本周处理视频（简化处理，使用今天的数据作为近似）
        week_videos = today_videos  # TODO: 需要任务历史记录来准确统计

        # 处理时长统计
        total_duration = 0
        for video in videos[:50]:  # 只统计前50个视频以提升性能
            try:
                full_path = self.video_dir / video['path']
                duration = get_video_duration(str(full_path))
                total_duration += duration
            except Exception:
                pass

        total_duration_hours = round(total_duration / 3600, 1) if total_duration > 0 else 0

        # 文档统计
        md_files = get_files_by_extensions({'.md'})
        total_documents = len(md_files)

        # 今日生成文档
        today_docs = len([d for d in md_files if d.get('modified', 0) >= today_start])

        # 任务状态统计（从全局任务系统获取）
        from server import tasks, tasks_lock, TASK_STATUS_PENDING, TASK_STATUS_RUNNING, TASK_STATUS_COMPLETED, TASK_STATUS_FAILED

        pending_tasks = 0
        completed_tasks = 0
        failed_tasks = 0

        with tasks_lock:
            for task in tasks.values():
                status = task.get('status', '')
                if status == TASK_STATUS_PENDING or status == TASK_STATUS_RUNNING:
                    pending_tasks += 1
                elif status == TASK_STATUS_COMPLETED:
                    completed_tasks += 1
                elif status == TASK_STATUS_FAILED:
                    failed_tasks += 1

        return {
            "videos": {
                "total": total_videos,
                "today": today_videos,
                "week": week_videos
            },
            "duration": {
                "total": f"{total_duration_hours}h",
                "transcribed": "0h"  # TODO: 需要根据实际转录状态统计
            },
            "documents": {
                "total": total_documents,
                "today": today_docs
            },
            "tasks": {
                "pending": pending_tasks,
                "completed": completed_tasks,
                "failed": failed_tasks
            }
        }

    def get_distribution(self) -> Dict[str, Any]:
        """
        获取视频分类分布
        """
        videos = get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS)

        # 按目录统计视频分布
        category_count = {}
        for video in videos:
            directory = video.get('directory', '未分类')
            if directory not in category_count:
                category_count[directory] = 0
            category_count[directory] += 1

        total = len(videos)
        categories = []
        for name, count in sorted(category_count.items(), key=lambda x: x[1], reverse=True):
            percentage = round((count / total * 100) if total > 0 else 0, 1)
            categories.append({
                "name": name if name else '未分类',
                "count": count,
                "percentage": percentage
            })

        return {
            "categories": categories
        }

    def get_trends(self, days: int = 7) -> Dict[str, Any]:
        """
        获取趋势数据
        """
        videos = get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS)

        # 生成日期列表
        dates = []
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

        for i in range(days - 1, -1, -1):
            date = today - timedelta(days=i)
            dates.append(date.strftime("%Y-%m-%d"))

        # 统计每日视频处理量
        videos_processed = []
        documents_generated = []

        for date_str in dates:
            # 解析日期
            date_obj = datetime.strptime(date_str, "%Y-%m-%d")
            day_start = date_obj.timestamp()
            day_end = (date_obj + timedelta(days=1)).timestamp()

            # 统计当日视频数
            day_videos = len([
                v for v in videos
                if day_start <= v.get('modified', 0) < day_end
            ])
            videos_processed.append(day_videos)

            # 统计当日文档数（简化处理）
            day_docs = len([
                v for v in videos
                if v.get('name', '').endswith('_summary.md') and
                day_start <= v.get('modified', 0) < day_end
            ])
            documents_generated.append(day_docs)

        return {
            "dates": dates,
            "videos_processed": videos_processed,
            "documents_generated": documents_generated
        }

    def get_recent_activity(self, limit: int = 5) -> Dict[str, Any]:
        """
        获取最近活动
        """
        videos = get_files_by_extensions(SUPPORTED_VIDEO_EXTENSIONS)

        # 按修改时间排序
        sorted_videos = sorted(videos, key=lambda x: x.get('modified', 0), reverse=True)

        # 最近处理的视频
        recent_videos = []
        for video in sorted_videos[:limit]:
            recent_videos.append({
                "name": video['name'],
                "path": video['path'],
                "directory": video.get('directory', ''),
                "modified": datetime.fromtimestamp(video.get('modified', 0)).strftime("%Y-%m-%d %H:%M")
            })

        # TODO: 获取最近对话和待处理任务
        recent_conversations = []
        pending_tasks = []

        return {
            "videos": recent_videos,
            "conversations": recent_conversations,
            "tasks": pending_tasks
        }

    def get_document_stats(self) -> Dict[str, Any]:
        """
        获取各类文档统计
        """
        md_files = get_files_by_extensions({'.md'})

        stats = {
            "subtitle": 0,
            "summary": 0,
            "outline": 0,
            "notes": 0,
            "other": 0
        }

        for doc in md_files:
            name = doc['name']
            if name.endswith('_subtitle.md'):
                stats['subtitle'] += 1
            elif name.endswith('_summary.md'):
                stats['summary'] += 1
            elif name.endswith('_outline.md'):
                stats['outline'] += 1
            elif name.endswith('_notes.md'):
                stats['notes'] += 1
            else:
                stats['other'] += 1

        return stats


# 全局实例
dashboard_service = DashboardService()
