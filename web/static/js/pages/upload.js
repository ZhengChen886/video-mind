// ============================
// pages/upload.js
// 职责：文件上传、URL 上传、轮询、URL 列表管理
// ============================
import { API_BASE_URL } from '../core/config.js';
import { getTaskStatus, streamTaskProgress, cancelTask } from '../core/api.js';
import { state } from '../core/state.js';
import { escapeHtml } from '../core/utils.js';

// 当前 URL 下载任务的 SSE 流控制器
let urlDownloadStream = null;

export function handleFileSelect(e) {
    state.selectedUploadFiles = Array.from(e.target.files);
    updateSelectedFilesList();
}

export function updateSelectedFilesList() {
    const listContainer = document.getElementById('selectedFilesList');
    const container = document.getElementById('selectedFilesContainer');
    const confirmBtn = document.getElementById('confirmUpload');
    if (state.selectedUploadFiles.length === 0) {
        if (listContainer) listContainer.style.display = 'none';
        if (confirmBtn) confirmBtn.disabled = true;
        return;
    }
    if (listContainer) listContainer.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = false;
    if (!container) return;
    container.innerHTML = state.selectedUploadFiles.map((file, index) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee;">
            <span>${escapeHtml(file.name)} (${(file.size / 1024 / 1024).toFixed(2)} MB)</span>
            <button data-remove-index="${index}" style="color: #ef4444; border: none; background: none; cursor: pointer;">&times;</button>
        </div>
    `).join('');
    container.querySelectorAll('button[data-remove-index]').forEach(btn => {
        btn.addEventListener('click', () => {
            removeSelectedFile(parseInt(btn.dataset.removeIndex, 10));
        });
    });
}

export function removeSelectedFile(index) {
    state.selectedUploadFiles.splice(index, 1);
    updateSelectedFilesList();
}

export async function uploadFile() {
    if (state.selectedUploadFiles.length === 0) return;
    const formData = new FormData();
    state.selectedUploadFiles.forEach(file => formData.append('files', file));
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    const basePath = state.isShowingAudio ? state.currentAudioPath : state.currentPath;
    formData.append('path', basePath);
    formData.append('media_type', media_type);
    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressList = document.getElementById('uploadProgressList');
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressList) progressList.innerHTML = '<div>正在上传...</div>';
    try {
        const response = await fetch(`${API_BASE_URL}/api/upload/batch`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (data.success) {
            if (progressList) {
                progressList.innerHTML = data.results.map(r => `
                    <div style="padding: 4px 0;">
                        ${r.success ? '✅' : '❌'} ${escapeHtml(r.filename)}
                        ${!r.success ? ` - ${escapeHtml(r.error || '')}` : ''}
                    </div>`).join('');
            }
            setTimeout(() => {
                document.getElementById('modalUpload').classList.remove('show');
                const inp = document.getElementById('uploadFileInput');
                if (inp) inp.value = '';
                state.selectedUploadFiles = [];
                updateSelectedFilesList();
                if (progressContainer) progressContainer.style.display = 'none';
                if (state.isShowingAudio) {
                    import('./videos.js').then(m => m.loadAudioFiles());
                } else {
                    import('./videos.js').then(m => m.loadFiles());
                }
            }, 1500);
        } else {
            alert('上传失败');
        }
    } catch (error) {
        alert('上传失败: ' + error.message);
    }
}

export function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        let filename = pathname.split('/').pop();
        if (filename.includes('?')) filename = filename.split('?')[0];
        if (!filename.includes('.')) filename += '.mp4';
        filename = filename.replace(/[<>:"/\\|?*]/g, '_');
        return filename;
    } catch {
        return 'video_' + Date.now() + '.mp4';
    }
}

export async function uploadByUrl() {
    const targetDirEl = document.getElementById('urlUploadDir');
    const targetDir = targetDirEl ? targetDirEl.value : '';
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    if (state.urlDownloadItems.length === 0) return;
    const confirmBtn = document.getElementById('confirmUrlUpload');
    if (!confirmBtn) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '创建任务...';
    try {
        const response = await fetch(`${API_BASE_URL}/api/upload/url/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // source_url：平台获取时用户输入的原始平台页 URL（如B站链接，后端会尝试抓字幕）
            body: JSON.stringify({ items: state.urlDownloadItems, target_dir: targetDir, media_type, source_url: state.urlSourceUrl || '' })
        });
        const data = await response.json();
        if (data.success) {
            state.currentUrlDownloadTaskId = data.task_id;
            confirmBtn.textContent = '下载中...';
            const listContainer = document.getElementById('urlListContainer');
            if (listContainer) listContainer.style.display = 'none';
            startUrlDownloadPolling();
        } else {
            alert('创建下载任务失败: ' + data.error);
            confirmBtn.disabled = false;
            confirmBtn.textContent = '批量下载';
        }
    } catch (error) {
        alert('创建下载任务失败: ' + error.message);
        confirmBtn.disabled = false;
        confirmBtn.textContent = '批量下载';
    }
}

export function startUrlDownloadPolling() {
    const progressContainer = document.getElementById('batchUrlProgressContainer');
    if (progressContainer) progressContainer.style.display = 'block';
    let finished = false;
    const checkSnapshot = (task) => {
        if (handleUrlDownloadSnapshot(task)) finished = true;
    };
    // SSE 不可用（file:// 或代理不支持流式）时的降级路径：1s 轮询（原轮询逻辑）
    const fallbackToPolling = () => {
        if (state.urlPollingInterval) return;
        state.urlPollingInterval = setInterval(async () => {
            if (finished || !state.currentUrlDownloadTaskId) {
                clearInterval(state.urlPollingInterval);
                state.urlPollingInterval = null;
                return;
            }
            try {
                const data = await getTaskStatus(state.currentUrlDownloadTaskId);
                if (data && data.success) checkSnapshot(data.task);
            } catch (error) {
                console.error('Polling error:', error);
            }
        }, 1000);
    };
    // 优先 SSE 实时进度；终态处理与轮询一致
    urlDownloadStream = streamTaskProgress(
        state.currentUrlDownloadTaskId,
        checkSnapshot,
        (endData) => {
            // 流正常终止：终态已由 onUpdate 处理；未收到终态（如任务不存在）时兜底恢复 UI
            if (!finished) {
                finished = true;
                finishUrlDownloadUI({ status: 'cancelled' });
                if (endData && endData.error) alert('下载任务异常: ' + endData.error);
            }
        },
        () => {
            if (!finished) fallbackToPolling();
        }
    );
}

// 处理一次下载任务快照（SSE 与轮询共用）：更新进度 UI，返回是否到达终态
function handleUrlDownloadSnapshot(task) {
    const progressList = document.getElementById('batchUrlProgressList');
    const progressSummary = document.getElementById('downloadProgressSummary');
    let completedCount = 0;
    let totalCount = 0;
    if (task.result) {
        totalCount = task.result.length;
        completedCount = task.result.filter(r => r.success || r.status === 'completed').length;
    }
    let statusText = '';
    if (task.status === 'pending') statusText = '等待中';
    else if (task.status === 'running') statusText = '下载中';
    else if (task.status === 'completed') statusText = '已完成';
    else if (task.status === 'failed') statusText = '失败';
    else if (task.status === 'cancelled') statusText = '已取消';
    if (progressSummary) progressSummary.textContent = `${statusText} · ${task.progress}%`;
    // 任务进行中才渲染条目级取消按钮（放在「下载中」状态右侧）
    const taskActive = task.status === 'running' || task.status === 'pending';
    const cancelBtnHtml = `<button type="button" class="btn btn-secondary btn-sm btn-cancel-url-download" style="padding:2px 10px;font-size:12px;color:#ef4444;">取消下载</button>`;
    let html = '';
    if (task.result && task.result.length > 0) {
        task.result.forEach((r, index) => {
            const item = state.urlDownloadItems[index] || { filename: r.filename || r.url, url: r.url };
            const filename = item.filename || r.filename || `文件${index + 1}`;
            let itemStatus = 'pending';
            let progressWidth = 0;
            let statusLabel = '等待中';
            if (r.success) {
                itemStatus = 'completed';
                progressWidth = 100;
                statusLabel = '已完成';
            } else if (r.error) {
                itemStatus = 'failed';
                progressWidth = 0;
                statusLabel = '失败';
            } else {
                const itemsPerStep = Math.max(1, Math.floor(100 / task.result.length));
                const currentStep = Math.floor(task.progress / itemsPerStep);
                if (index < currentStep) {
                    itemStatus = 'completed';
                    progressWidth = 100;
                    statusLabel = '已完成';
                } else if (index === currentStep) {
                    itemStatus = 'downloading';
                    progressWidth = task.progress % itemsPerStep * (100 / itemsPerStep);
                    statusLabel = '下载中';
                } else {
                    itemStatus = 'pending';
                    progressWidth = 0;
                    statusLabel = '等待中';
                }
            }
            html += `
                <div class="download-item">
                    <div class="download-item-header">
                        <div class="download-item-name">${escapeHtml(filename)}</div>
                        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                            <div class="download-item-status ${itemStatus}">${statusLabel}</div>
                            ${itemStatus === 'downloading' && taskActive ? cancelBtnHtml : ''}
                        </div>
                    </div>
                    <div class="download-progress-bar-container">
                        <div class="download-progress-bar" style="width: ${progressWidth}%"></div>
                    </div>
                    <div class="download-item-meta">
                        <div class="download-item-speed">
                            <span>进度 ${Math.round(progressWidth)}%</span>
                        </div>
                        <div></div>
                    </div>
                    ${r.error ? `<div class="download-item-error">${escapeHtml(r.error)}</div>` : ''}
                </div>`;
        });
    } else {
        html += `<div class="download-item">
            <div class="download-item-header">
                <div class="download-item-name">准备下载...</div>
                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                    <div class="download-item-status ${task.status === 'failed' ? 'failed' : 'downloading'}">${statusText}</div>
                    ${taskActive ? cancelBtnHtml : ''}
                </div>
            </div>
            <div class="download-progress-bar-container">
                <div class="download-progress-bar" style="width: ${task.progress}%"></div>
            </div>
            <div class="download-item-meta">
                <div class="download-item-speed">
                    <span>进度 ${task.progress}%</span>
                </div>
                <div></div>
            </div>
        </div>`;
    }
    if (progressList) progressList.innerHTML = html;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        finishUrlDownloadUI(task);
        return true;
    }
    return false;
}

// 下载终态收尾：停止轮询/SSE 流并恢复 UI
function finishUrlDownloadUI(task) {
    stopUrlDownloadTracking();
    const progressContainer = document.getElementById('batchUrlProgressContainer');
    const listContainer = document.getElementById('urlListContainer');
    const confirmBtn = document.getElementById('confirmUrlUpload');
    if (task.status === 'cancelled') {
        // 用户主动取消：恢复列表与按钮，不自动关闭弹窗
        if (progressContainer) progressContainer.style.display = 'none';
        if (listContainer && state.urlDownloadItems.length > 0) listContainer.style.display = 'block';
        if (confirmBtn) {
            confirmBtn.disabled = state.urlDownloadItems.length === 0;
            confirmBtn.textContent = '批量下载';
        }
        return;
    }
    // completed / failed：3 秒后关闭弹窗并刷新文件列表（原逻辑）
    setTimeout(() => {
        document.getElementById('modalUrlUpload').classList.remove('show');
        const inp = document.getElementById('urlUploadInput');
        if (inp) inp.value = '';
        state.urlDownloadItems = [];
        state.urlSourceUrl = null;
        if (listContainer) listContainer.style.display = 'none';
        if (progressContainer) progressContainer.style.display = 'none';
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '批量下载';
        }
        import('./videos.js').then(m => m.loadFiles());
    }, 3000);
}

// 停止 URL 下载任务的轮询 / SSE 流
export function stopUrlDownloadTracking() {
    if (state.urlPollingInterval) {
        clearInterval(state.urlPollingInterval);
        state.urlPollingInterval = null;
    }
    if (urlDownloadStream) {
        urlDownloadStream.abort();
        urlDownloadStream = null;
    }
}

// 取消当前 URL 下载任务：取消后由 SSE/轮询推送 cancelled 终态恢复 UI
export async function cancelUrlDownload() {
    if (!state.currentUrlDownloadTaskId) return;
    try {
        const data = await cancelTask(state.currentUrlDownloadTaskId);
        if (data && data.task) handleUrlDownloadSnapshot(data.task);
    } catch (error) {
        // 任务已结束（404/409）等场景：忽略错误，终态由 SSE/轮询驱动 UI 恢复
        console.warn('取消下载任务失败:', error.message);
    }
}

export function initUrlUploadInput() {
    const input = document.getElementById('urlUploadInput');
    if (!input) return;
    input.addEventListener('input', () => {
        const urlText = input.value.trim();
        const urls = urlText.split('\n').map(u => u.trim()).filter(u => u.length > 0);
        const listContainer = document.getElementById('urlListContainer');
        const list = document.getElementById('urlList');
        const countSpan = document.getElementById('urlListCount');
        const confirmBtn = document.getElementById('confirmUrlUpload');
        if (urls.length === 0) {
            if (listContainer) listContainer.style.display = 'none';
            if (confirmBtn) confirmBtn.disabled = true;
            state.urlDownloadItems = [];
            state.urlSourceUrl = null;
        } else {
            state.urlDownloadItems = urls.map((url) => {
                const existing = state.urlDownloadItems.find(item => item.url === url);
                if (existing) return existing;
                return { url, filename: extractFilenameFromUrl(url) };
            });
            if (listContainer) listContainer.style.display = 'block';
            if (confirmBtn) confirmBtn.disabled = false;
            if (countSpan) countSpan.textContent = urls.length + '个';
            renderUrlList();
        }
    });
}

export function renderUrlList() {
    const list = document.getElementById('urlList');
    if (!list) return;
    list.innerHTML = state.urlDownloadItems.map((item, i) => `
        <div class="url-list-item" data-index="${i}">
            <div class="url-item-index">${i + 1}.</div>
            <div class="url-item-main">
                <div class="url-item-filename">
                    <input type="text" value="${escapeHtml(item.filename)}" data-index="${i}" placeholder="文件名" class="url-filename-input">
                </div>
                <div class="url-item-url">${escapeHtml(item.url.length > 60 ? item.url.substring(0, 60) + '...' : item.url)}</div>
            </div>
            <div class="url-item-actions">
                <button class="url-item-btn danger" data-remove-index="${i}">删除</button>
            </div>
        </div>
    `).join('');
    list.querySelectorAll('input.url-filename-input').forEach(inp => {
        inp.addEventListener('change', () => updateFilename(parseInt(inp.dataset.index, 10), inp.value));
        inp.addEventListener('blur', () => updateFilename(parseInt(inp.dataset.index, 10), inp.value));
    });
    list.querySelectorAll('button[data-remove-index]').forEach(btn => {
        btn.addEventListener('click', () => removeUrlItem(parseInt(btn.dataset.removeIndex, 10)));
    });
}

export function updateFilename(index, newFilename) {
    if (state.urlDownloadItems[index]) {
        state.urlDownloadItems[index].filename = newFilename;
    }
}

export function removeUrlItem(index) {
    state.urlDownloadItems.splice(index, 1);
    const input = document.getElementById('urlUploadInput');
    if (input) input.value = state.urlDownloadItems.map(item => item.url).join('\n');
    if (state.urlDownloadItems.length === 0) {
        const listContainer = document.getElementById('urlListContainer');
        if (listContainer) listContainer.style.display = 'none';
        const confirmBtn = document.getElementById('confirmUrlUpload');
        if (confirmBtn) confirmBtn.disabled = true;
    } else {
        const countSpan = document.getElementById('urlListCount');
        if (countSpan) countSpan.textContent = state.urlDownloadItems.length + '个';
        renderUrlList();
    }
}
