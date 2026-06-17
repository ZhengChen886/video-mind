// ============================
// pages/upload.js
// 职责：文件上传、URL 上传、轮询、URL 列表管理
// ============================
import { API_BASE_URL } from '../core/config.js';
import { state } from '../core/state.js';
import { escapeHtml } from '../core/utils.js';

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
            body: JSON.stringify({ items: state.urlDownloadItems, target_dir: targetDir, media_type })
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
    const progressList = document.getElementById('batchUrlProgressList');
    const progressSummary = document.getElementById('downloadProgressSummary');
    if (progressContainer) progressContainer.style.display = 'block';
    state.urlPollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/tasks/${state.currentUrlDownloadTaskId}`);
            const data = await response.json();
            if (data.success) {
                const task = data.task;
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
                if (progressSummary) progressSummary.textContent = `${statusText} · ${task.progress}%`;
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
                                    <div class="download-item-status ${itemStatus}">${statusLabel}</div>
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
                            <div class="download-item-status ${task.status === 'failed' ? 'failed' : 'downloading'}">${statusText}</div>
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
                if (task.status === 'completed' || task.status === 'failed') {
                    clearInterval(state.urlPollingInterval);
                    state.urlPollingInterval = null;
                    setTimeout(() => {
                        document.getElementById('modalUrlUpload').classList.remove('show');
                        const inp = document.getElementById('urlUploadInput');
                        if (inp) inp.value = '';
                        state.urlDownloadItems = [];
                        const listContainer = document.getElementById('urlListContainer');
                        if (listContainer) listContainer.style.display = 'none';
                        if (progressContainer) progressContainer.style.display = 'none';
                        const confirmBtn = document.getElementById('confirmUrlUpload');
                        if (confirmBtn) {
                            confirmBtn.disabled = false;
                            confirmBtn.textContent = '批量下载';
                        }
                        import('./videos.js').then(m => m.loadFiles());
                    }, 3000);
                }
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 1000);
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
