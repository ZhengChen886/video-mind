// ============================
// pages/tasks.js
// 职责：任务中心加载、渲染、轮询、清除
// ============================
import { API_BASE_URL } from '../core/config.js';
import { state } from '../core/state.js';

export async function loadTasks() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tasks`);
        const data = await response.json();
        if (data.success) {
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
        const statusColors = {
            'pending': '#f59e0b',
            'running': '#3b82f6',
            'completed': '#10b981',
            'failed': '#ef4444'
        };
        const typeNames = {
            'batch_transcribe': '批量转录',
            'batch_url_download': '批量下载'
        };
        return `
            <div style="padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong>${typeNames[task.type] || task.type}</strong>
                    <span style="color: ${statusColors[task.status] || '#666'};"> ${task.status}</span>
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                        <div style="background: #3b82f6; height: 100%; width: ${task.progress}%; transition: width 0.3s;"></div>
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
        await fetch(`${API_BASE_URL}/api/tasks/clear-completed`, { method: 'POST' });
        loadTasks();
    } catch (error) {
        console.error('清除任务失败:', error);
    }
}
