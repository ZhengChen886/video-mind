// ============================
// pages/selection.js
// 职责：批量选择、全选、清除选择、批量转录
// ============================
import { API_BASE_URL } from '../core/config.js';
import { state } from '../core/state.js';

export function toggleVideoSelection(path) {
    const index = state.selectedVideoPaths.indexOf(path);
    if (index > -1) {
        state.selectedVideoPaths.splice(index, 1);
    } else {
        state.selectedVideoPaths.push(path);
    }
    updateBatchToolbar();
    if (state.isShowingAudio) {
        import('./videos.js').then(m => m.loadAudioFiles());
    } else {
        renderFilesWithSelection();
    }
}

export function renderFilesWithSelection() {
    if (state.isShowingAudio) {
        import('./videos.js').then(m => m.loadAudioFiles());
    } else {
        import('./videos.js').then(m => m.loadFiles());
    }
}

export function updateBatchToolbar() {
    const toolbar = document.getElementById('batchToolbar');
    const countSpan = document.getElementById('selectedCount');
    const batchBtn = document.getElementById('batchAnalyzeBtn');
    if (state.selectedVideoPaths.length > 0) {
        if (toolbar) toolbar.style.display = 'flex';
        if (countSpan) countSpan.textContent = `已选择 ${state.selectedVideoPaths.length} 个文件`;
        if (batchBtn) batchBtn.disabled = false;
    } else {
        if (toolbar) toolbar.style.display = 'none';
    }
}

export function toggleSelectAll() {
    const contentArea = document.getElementById('contentArea');
    if (!contentArea) return;
    const items = contentArea.querySelectorAll('.file-card[data-type="file"], .list-item[data-type="file"]');
    const allVideoPaths = Array.from(items).map(el => el.dataset.path);
    if (state.selectedVideoPaths.length === allVideoPaths.length && allVideoPaths.length > 0) {
        state.selectedVideoPaths = [];
    } else {
        state.selectedVideoPaths = allVideoPaths;
    }
    updateBatchToolbar();
    renderFilesWithSelection();
}

export function clearSelection() {
    state.selectedVideoPaths = [];
    updateBatchToolbar();
    renderFilesWithSelection();
}

export async function startBatchTranscribe() {
    if (state.selectedVideoPaths.length === 0) return;
    try {
        const response = await fetch(`${API_BASE_URL}/api/video/analyze/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: state.selectedVideoPaths })
        });
        const data = await response.json();
        if (data.success) {
            state.currentTranscribeTaskId = data.task_id;
            document.getElementById('modalTasks').classList.add('show');
            import('./tasks.js').then(m => m.startTasksPolling());
            clearSelection();
        } else {
            alert('创建转录任务失败: ' + data.error);
        }
    } catch (error) {
        alert('创建转录任务失败: ' + error.message);
    }
}
