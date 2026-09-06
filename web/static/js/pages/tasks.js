// ============================
// pages/tasks.js
// 职责：任务中心加载、渲染、轮询、清除
// ============================
import { listTasks, clearCompletedTasksApi, cancelTask } from '../core/api.js';
import { state } from '../core/state.js';

// 任务状态 → 文案 / 颜色（cancelled 为中性灰）
const statusTexts = {
    'pending': '等待中',
    'running': '进行中',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
};
const statusColors = {
    'pending': '#f59e0b',
    'running': '#3b82f6',
    'completed': '#10b981',
    'failed': '#ef4444',
    'cancelled': '#94a3b8'
};

export async function loadTasks() {
    try {
        const data = await listTasks();
        if (data && data.success) {
            renderTasks(data.tasks);
        }
    } catch (error) {
        console.error('加载任务失败:', error);
    }
}

export function renderTasks(tasks) {
    const container = document.getElementById('tasksList');
    if (!container) return;
    if (tasks.length === 0) {
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: #94a3b8;">暂无任务</div>';
        return;
    }
    container.innerHTML = tasks.map(task => {
        const typeNames = {
            'batch_transcribe': '批量转录',
            'batch_url_download': '批量下载'
        };
        // 仅未终结（等待/进行中）的任务可取消
        const cancellable = task.status === 'pending' || task.status === 'running';
        return `
            <div style="padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong>${typeNames[task.type] || task.type}</strong>
                    <span style="display: flex; align-items: center; gap: 8px;">
                        <span style="color: ${statusColors[task.status] || '#666'};">${statusTexts[task.status] || task.status}</span>
                        ${cancellable ? `<button data-cancel-task="${task.id}" style="padding: 2px 10px; font-size: 12px; border: 1px solid #e2e8f0; background: #fff; color: #ef4444; border-radius: 4px; cursor: pointer;">取消</button>` : ''}
                    </span>
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                        <div style="background: ${statusColors[task.status] || '#3b82f6'}; height: 100%; width: ${task.progress}%; transition: width 0.3s;"></div>
                    </div>
                    <div style="margin-top: 4px; font-size: 12px; color: #666;">${task.progress}%</div>
                </div>
                <div style="font-size: 13px; color: #555; margin-bottom: 4px;">${task.message || ''}</div>
                <div style="font-size: 12px; color: #999;">
                    创建于: ${new Date(task.created_at * 1000).toLocaleString()}
                </div>
                ${task.result ? `
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">结果:</div>
                        <div style="max-height: 100px; overflow-y: auto; font-size: 12px;">
                            ${task.result.map(r => `
                                <div style="padding: 2px 0;">
                                    ${r.success ? '✅' : '❌'} ${r.filename || r.path || r.url}
                                    ${!r.success ? ` - ${r.error}` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>`;
    }).join('');
    // 进行中/等待中任务的「取消」按钮
    container.querySelectorAll('button[data-cancel-task]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const taskId = btn.dataset.cancelTask;
            try {
                await cancelTask(taskId);
                loadTasks();
            } catch (error) {
                // 已结束/不存在（404/409）：刷新列表以同步真实状态
                console.error('取消任务失败:', error.message);
                loadTasks();
            }
        });
    });
}

export function startTasksPolling() {
    if (!state.tasksPollingInterval) {
        state.tasksPollingInterval = setInterval(loadTasks, 2000);
    }
    loadTasks();
}

export function stopTasksPolling() {
    if (state.tasksPollingInterval) {
        clearInterval(state.tasksPollingInterval);
        state.tasksPollingInterval = null;
    }
}

export async function clearCompletedTasks() {
    try {
        await clearCompletedTasksApi();
        loadTasks();
    } catch (error) {
        console.error('清除任务失败:', error);
    }
}
