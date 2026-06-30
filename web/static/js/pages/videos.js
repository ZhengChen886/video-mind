// ============================
// pages/videos.js
// 职责：文件列表加载、侧边栏、路径导航、视图切换、缩略图
// 文档加载、文件/目录点击事件
// ============================
import { API_BASE_URL } from '../core/config.js';
import { loadFileList } from '../core/api.js';
import { state } from '../core/state.js';
import { formatFileSize, escapeHtml } from '../core/utils.js';

// 文档文件扩展名
const DOCUMENT_EXTENSIONS = ['.md', '.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt'];

export async function loadFiles() {
    state.isShowingDocuments = false;
    state.isShowingAudio = false;
    updateTopBarMode();
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';
    try {
        const data = await loadFileList(state.currentPath, 'video');
        if (data && data.success) {
            const videoItems = (data.items || []).filter(item => item.type === 'directory' || item.media_type === 'video');
            renderFiles(videoItems, searchQuery, { mode: 'video' });
            updatePathNav('视频库');
        }
    } catch (error) {
        console.error('加载文件失败:', error);
        renderFiles([], '', { mode: 'video' });
    }
}

export async function loadAudioFiles() {
    state.isShowingDocuments = false;
    state.isShowingAudio = true;
    updateTopBarMode();
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';
    try {
        const data = await loadFileList(state.currentAudioPath, 'audio');
        if (data && data.success) {
            const audioItems = (data.items || []).filter(item => {
                if (item.type === 'directory') return true;
                return item.media_type === 'audio';
            });
            renderFiles(audioItems, searchQuery, { mode: 'audio' });
            updatePathNav('音频库');
        }
    } catch (error) {
        console.error('加载音频失败:', error);
        renderFiles([], '', { mode: 'audio' });
    }
}

export function updateTopBarMode() {
    const btnUpload = document.getElementById('btnUpload');
    const btnUrlUpload = document.getElementById('btnUrlUpload');
    const modalUploadTitle = document.getElementById('modalUploadTitle');
    const uploadFileInput = document.getElementById('uploadFileInput');
    const uploadFormatHint = document.getElementById('uploadFormatHint');
    const modalUrlUploadTitle = document.querySelector('#modalUrlUpload .modal-header span');

    if (state.isShowingAudio) {
        if (btnUpload) {
            const iconVideo = btnUpload.querySelector('.btn-icon-video');
            const iconAudio = btnUpload.querySelector('.btn-icon-audio');
            const text = btnUpload.querySelector('.btn-label');
            if (iconVideo) iconVideo.style.display = 'none';
            if (iconAudio) iconAudio.style.display = 'inline-block';
            if (text) text.textContent = '上传音频';
        }
        if (btnUrlUpload) {
            const text = btnUrlUpload.querySelector('.btn-label');
            if (text) text.textContent = '音频链接';
        }
        if (modalUploadTitle) modalUploadTitle.textContent = '上传音频';
        if (uploadFileInput) uploadFileInput.setAttribute('accept', 'audio/*');
        if (uploadFormatHint) uploadFormatHint.textContent = '支持格式: MP3, M4A, WAV, FLAC, OGG, AAC 等';
        if (modalUrlUploadTitle) modalUrlUploadTitle.textContent = '音频链接下载';
    } else {
        if (btnUpload) {
            const iconVideo = btnUpload.querySelector('.btn-icon-video');
            const iconAudio = btnUpload.querySelector('.btn-icon-audio');
            const text = btnUpload.querySelector('.btn-label');
            if (iconVideo) iconVideo.style.display = 'inline-block';
            if (iconAudio) iconAudio.style.display = 'none';
            if (text) text.textContent = '上传视频';
        }
        if (btnUrlUpload) {
            const text = btnUrlUpload.querySelector('.btn-label');
            if (text) text.textContent = '链接上传';
        }
        if (modalUploadTitle) modalUploadTitle.textContent = '上传视频';
        if (uploadFileInput) uploadFileInput.setAttribute('accept', 'video/*');
        if (uploadFormatHint) uploadFormatHint.textContent = '支持格式: MP4, WebM, MOV, AVI, MKV 等';
        if (modalUrlUploadTitle) modalUrlUploadTitle.textContent = '链接下载';
    }
}

export function updatePathNav(rootLabel) {
    const pathNav = document.querySelector('.path-nav');
    if (!pathNav) return;
    let html = '';
    const rootName = rootLabel || (state.isShowingAudio ? '音频库' : '视频库');
    html += `<span class="path-segment" data-path="" style="cursor:pointer;color:var(--primary);">${rootName}</span>`;
    if (state.currentPath) {
        const pathParts = state.currentPath.split(/[\\/]/).filter(p => p);
        let accumulatedPath = '';
        pathParts.forEach((part, index) => {
            html += `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin:0 8px;" fill="currentColor">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>`;
            accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
            const isLast = index === pathParts.length - 1;
            html += `<span class="path-segment" data-path="${escapeHtml(accumulatedPath)}" style="cursor:pointer;${isLast ? 'color:var(--text-primary);font-weight:500;' : 'color:var(--primary);'}">${escapeHtml(part)}</span>`;
        });
    } else {
        html += `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin:0 8px;" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
        </svg>`;
        html += `<span class="path-segment" data-path="" style="cursor:pointer;color:var(--text-primary);font-weight:500;">${state.isShowingAudio ? '全部音频' : '全部视频'}</span>`;
    }
    pathNav.innerHTML = html;
    pathNav.querySelectorAll('.path-segment').forEach(segment => {
        segment.addEventListener('click', () => {
            const path = segment.dataset.path;
            if (path !== undefined) navigateToPath(path);
        });
    });
}

export function navigateToPath(path) {
    state.currentPath = path;
    if (state.isShowingAudio) {
        state.currentAudioPath = path;
        loadAudioFiles();
    } else {
        loadFiles();
    }
    updateSidebarActiveState();
}

export function updateSidebarActiveState() {
    document.querySelectorAll('#videos-submenu .menu-item:not(.menu-item-parent)').forEach(item => {
        item.classList.remove('active');
        if (!state.isShowingAudio && item.dataset.path === state.currentPath) {
            item.classList.add('active');
        }
    });
    document.querySelectorAll('#audios-submenu .menu-item:not(.menu-item-parent)').forEach(item => {
        item.classList.remove('active');
        if (state.isShowingAudio && item.dataset.path === state.currentAudioPath) {
            item.classList.add('active');
        }
    });
}

export async function loadSidebarVideoFolders() {
    const submenu = document.getElementById('videos-submenu');
    if (!submenu) return;
    try {
        const data = await loadFileList('', 'video');
        if (data && data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');
            let html = '';
            html += `<div class="menu-item" data-path="">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                    <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                <span>全部视频</span>
            </div>`;
            dirs.forEach(dir => {
                html += `<div class="menu-item" data-path="${escapeHtml(dir.path)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span>${escapeHtml(dir.name)}</span>
                </div>`;
            });
            submenu.innerHTML = html;
            bindSidebarEvents();
            updateSidebarActiveState();
            await loadSidebarAudioFolders();
        }
    } catch (error) {
        console.error('加载侧边栏文件夹失败:', error);
    }
}

export async function loadSidebarAudioFolders() {
    const submenu = document.getElementById('audios-submenu');
    if (!submenu) return;
    try {
        const data = await loadFileList('', 'audio');
        if (data && data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');
            let html = '';
            html += `<div class="menu-item" data-path="">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"/>
                    <circle cx="6" cy="18" r="3"/>
                    <circle cx="18" cy="16" r="3"/>
                </svg>
                <span>全部音频</span>
            </div>`;
            dirs.forEach(dir => {
                html += `<div class="menu-item" data-path="${escapeHtml(dir.path)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span>${escapeHtml(dir.name)}</span>
                </div>`;
            });
            submenu.innerHTML = html;
            bindSidebarEvents();
            updateSidebarActiveState();
        }
    } catch (error) {
        console.error('加载侧边栏音频文件夹失败:', error);
    }
}

export function bindSidebarEvents() {
    document.querySelectorAll('#videos-submenu .menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            state.isShowingDocuments = false;
            state.isShowingAudio = false;
            state.currentPath = item.dataset.path || '';
            loadFiles();
        });
    });
    document.querySelectorAll('#audios-submenu .menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            state.isShowingDocuments = false;
            state.isShowingAudio = true;
            const audioPath = item.dataset.path || '';
            state.currentPath = audioPath;
            state.currentAudioPath = audioPath;
            loadAudioFiles();
        });
    });
}

export function toggleSubmenu(action) {
    const submenuId = {
        'toggle-videos':    'videos-submenu',
        'toggle-audios':    'audios-submenu',
        'toggle-documents': 'documents-submenu'
    }[action];
    if (!submenuId) return;
    const submenu = document.getElementById(submenuId);
    if (!submenu) return;
    submenu.classList.toggle('submenu-open');
    const parentItem = document.querySelector(`[data-action="${action}"]`);
    if (parentItem) {
        const toggleIcon = parentItem.querySelector('.menu-toggle-icon');
        if (toggleIcon) {
            toggleIcon.style.transform = submenu.classList.contains('submenu-open')
                ? 'rotate(0deg)'
                : 'rotate(-90deg)';
        }
    }
}

export function bindParentMenuToggles() {
    const sidebar = document.querySelector('.sidebar-menu');
    if (!sidebar) return;
    sidebar.addEventListener('click', (e) => {
        const parent = e.target.closest('.menu-item-parent');
        if (!parent) return;
        const action = parent.dataset.action;
        if (!action || !action.startsWith('toggle-')) return;
        e.stopPropagation();
        e.preventDefault();
        toggleSubmenu(action);
    });
}

export async function loadDocuments(docType = 'all') {
    state.isShowingDocuments = true;
    state.currentDocType = docType;
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.toLowerCase() : '';
    try {
        const apiUrl = docType === 'all'
            ? `${API_BASE_URL}/api/documents`
            : `${API_BASE_URL}/api/documents?type=${docType}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.success) {
            renderDocuments(data.items, searchQuery);
        }
    } catch (error) {
        console.error('加载文档失败:', error);
        renderDocuments([], '');
    }
}

export function renderDocuments(items, searchQuery) {
    const contentArea = document.getElementById('contentArea');
    if (!items || items.length === 0) {
        contentArea.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <div>暂无文档</div>
        </div>`;
        return;
    }
    let filteredItems = items;
    if (searchQuery) {
        filteredItems = items.filter(item => item.name.toLowerCase().includes(searchQuery));
    }
    if (filteredItems.length === 0) {
        contentArea.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 110-15 7.5 7.5 0 010 15z"/>
            </svg>
            <div>未找到匹配的文档</div>
        </div>`;
        return;
    }
    if (state.currentView === 'cards') {
        contentArea.innerHTML = renderDocumentCardsView(filteredItems);
    } else {
        contentArea.innerHTML = renderDocumentListView(filteredItems);
    }
    bindFileEvents();
}

export function renderDocumentCardsView(items) {
    let html = '<div class="cards-view">';
    items.forEach(item => {
        const ext = item.name.toLowerCase().substring(item.name.lastIndexOf('.'));
        let iconColor = '#64748b';
        if (ext === '.md') iconColor = '#0891b2';
        else if (ext === '.pdf') iconColor = '#ef4444';
        else if (['.doc', '.docx'].includes(ext)) iconColor = '#3b82f6';
        else if (['.xls', '.xlsx'].includes(ext)) iconColor = '#10b981';
        else if (['.ppt', '.pptx'].includes(ext)) iconColor = '#f59e0b';
        html += `
            <div class="file-card" data-path="${escapeHtml(item.path)}" data-type="document">
                <div class="card-thumbnail" style="background: ${iconColor}15;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" style="width: 48px; height: 48px;">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                </div>
                <div class="card-info">
                    <div class="card-name">${escapeHtml(item.name)}</div>
                    <div class="card-meta">${formatFileSize(item.size)}</div>
                </div>
            </div>`;
    });
    html += '</div>';
    return html;
}

export function renderDocumentListView(items) {
    let html = `<div class="list-view">
        <div class="list-header">
            <div></div>
            <div>名称</div>
            <div>大小</div>
            <div></div>
            <div></div>
        </div>`;
    items.forEach(item => {
        html += `<div class="list-item" data-path="${escapeHtml(item.path)}" data-type="document">
            <div class="list-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
            </div>
            <div class="list-name">${escapeHtml(item.name)}</div>
            <div class="list-meta">${formatFileSize(item.size)}</div>
            <div class="list-meta"></div>
            <div></div>
        </div>`;
    });
    html += '</div>';
    return html;
}

export function renderFiles(items, searchQuery, options) {
    const contentArea = document.getElementById('contentArea');
    const mode = (options && options.mode) || 'video';
    if (!items || items.length === 0) {
        contentArea.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7h18M3 12h18M3 17h18"/>
            </svg>
            <div>暂无文件</div>
        </div>`;
        return;
    }
    let filteredItems = items;
    if (searchQuery) {
        filteredItems = items.filter(item => item.name.toLowerCase().includes(searchQuery));
    }
    if (filteredItems.length === 0) {
        contentArea.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 110-15 7.5 7.5 0 010 15z"/>
            </svg>
            <div>未找到匹配的文件</div>
        </div>`;
        return;
    }
    if (state.currentView === 'cards') {
        contentArea.innerHTML = renderCardsView(filteredItems, { mode });
        if (mode === 'video') {
            setTimeout(loadThumbnails, 100);
        }
    } else {
        contentArea.innerHTML = renderListView(filteredItems, { mode });
    }
    bindFileEvents();
}

export function renderCardsView(items, options) {
    const mode = (options && options.mode) || 'video';
    let html = '<div class="cards-view">';
    items.forEach(item => {
        if (item.type === 'directory') {
            html += `<div class="file-card" data-path="${escapeHtml(item.path)}" data-type="directory" data-item-name="${escapeHtml(item.name)}">
                <div class="card-thumbnail-wrapper">
                    <div class="card-thumbnail">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
                        </svg>
                        <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                            <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="1"/>
                                <circle cx="19" cy="12" r="1"/>
                                <circle cx="5" cy="12" r="1"/>
                            </svg>
                        </button>
                        <div class="card-actions-menu" style="top: 44px; right: 8px; z-index: 100;">
                            <button class="action-item" data-action="rename">重命名</button>
                            <button class="action-item" data-action="move">移动</button>
                            <button class="action-item danger" data-action="delete">删除</button>
                        </div>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-name">${escapeHtml(item.name)}</div>
                </div>
            </div>`;
        } else {
            const pathForUrl = item.path.replace(/\\/g, '/');
            const isAudioItem = (item.media_type === 'audio') || /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(item.name);
            const thumbnailUrl = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?thumbnail=true`;
            const isSelected = state.selectedVideoPaths.includes(item.path);
            const mediaBadge = isAudioItem
                ? '<div style="position:absolute;top:8px;right:8px;z-index:10;background:rgba(99,102,241,0.9);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">音频</div>'
                : '';
            const placeholderIcon = isAudioItem
                ? '<svg viewBox="0 0 24 24" style="width:48px;height:48px;color:#6366f1" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
                : '<svg viewBox="0 0 24 24" style="width:48px;height:48px;color:#94a3b8" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/></svg>';
            html += `<div class="file-card ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(item.path)}" data-type="file" data-media-type="${isAudioItem ? 'audio' : 'video'}">
                <div style="position: absolute; top: 8px; left: 8px; z-index: 10;">
                    <input type="checkbox" data-select-path="${escapeHtml(item.path)}" ${isSelected ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;">
                </div>
                ${mediaBadge}
                <div class="card-thumbnail-wrapper">
                    <div class="card-thumbnail ${isAudioItem ? 'audio' : 'video'}" ${isAudioItem ? '' : `data-thumbnail="${thumbnailUrl}"`}>
                        <div class="thumbnail-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
                            ${placeholderIcon}
                        </div>
                        <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                            <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="1"/>
                                <circle cx="19" cy="12" r="1"/>
                                <circle cx="5" cy="12" r="1"/>
                            </svg>
                        </button>
                        <div class="card-actions-menu" style="top: 44px; right: 8px; z-index: 100;">
                            <button class="action-item" data-action="rename">重命名</button>
                            <button class="action-item" data-action="move">移动</button>
                            <button class="action-item danger" data-action="delete">删除</button>
                        </div>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-name">${escapeHtml(item.name)}</div>
                    <div class="card-meta">${formatFileSize(item.size)}</div>
                </div>
            </div>`;
        }
    });
    html += '</div>';
    return html;
}

export function renderListView(items, options) {
    const mode = (options && options.mode) || 'video';
    let html = `<div class="list-view">
        <div class="list-header">
            <div></div>
            <div>名称</div>
            <div>大小</div>
            <div>修改时间</div>
            <div></div>
        </div>`;
    items.forEach(item => {
        const isAudioItem = (item.media_type === 'audio') || /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(item.name);
        const iconPath = item.type === 'directory'
            ? '<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>'
            : (isAudioItem
                ? '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'
                : '<rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/>');
        const isSelected = state.selectedVideoPaths.includes(item.path);
        const isVideoFile = item.type === 'file';
        html += `<div class="list-item" data-path="${escapeHtml(item.path)}" data-type="${item.type}" data-item-name="${escapeHtml(item.name)}" data-media-type="${isAudioItem ? 'audio' : 'video'}">
            <div class="list-icon">
                ${isVideoFile ? `<input type="checkbox" data-select-path="${escapeHtml(item.path)}" ${isSelected ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;margin-right:8px">` : ''}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${iconPath}
                </svg>
            </div>
            <div class="list-name">${escapeHtml(item.name)}</div>
            <div class="list-meta">${item.type === 'directory' ? '-' : formatFileSize(item.size)}</div>
            <div class="list-meta">-</div>
            <div style="position: relative;">
                <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                    <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="1"/>
                        <circle cx="19" cy="12" r="1"/>
                        <circle cx="5" cy="12" r="1"/>
                    </svg>
                </button>
                <div class="card-actions-menu" style="top: 100%; right: 0; margin-top: 4px; z-index: 100;">
                    <button class="action-item" data-action="rename">重命名</button>
                    <button class="action-item" data-action="move">移动</button>
                    <button class="action-item danger" data-action="delete">删除</button>
                </div>
            </div>
        </div>`;
    });
    html += '</div>';
    return html;
}

export function loadThumbnails() {
    document.querySelectorAll('.card-thumbnail.video').forEach(thumbnail => {
        const thumbnailUrl = thumbnail.dataset.thumbnail;
        if (!thumbnailUrl) return;
        const placeholder = thumbnail.querySelector('.thumbnail-placeholder');
        thumbnail.querySelectorAll('img.card-thumbnail-img').forEach(old => old.remove());
        const img = document.createElement('img');
        img.className = 'card-thumbnail-img';
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;z-index:1;';
        let finished = false;
        const finish = (ok) => {
            if (finished) return;
            finished = true;
            if (ok && placeholder) placeholder.style.display = 'none';
        };
        img.onload = () => finish(true);
        img.onerror = () => { img.remove(); finish(false); };
        img.src = thumbnailUrl;
        thumbnail.appendChild(img);
    });
}

export function bindFileEvents() {
    const contentArea = document.getElementById('contentArea');
    if (!contentArea) return;
    // 文件/目录点击
    contentArea.querySelectorAll('.file-card, .list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.card-actions-btn') || e.target.closest('input')) return;
            const path = el.dataset.path;
            const type = el.dataset.type;
            if (type === 'directory') {
                navigateToPath(path);
            } else if (type === 'document') {
                console.log('文档点击:', path);
            } else {
                import('./video_detail.js').then(m => m.openVideoDetail(path));
            }
        });
    });
    // 批量选择 checkbox
    contentArea.querySelectorAll('input[data-select-path]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const p = cb.getAttribute('data-select-path');
            import('./selection.js').then(m => m.toggleVideoSelection(p));
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
    });
    // 操作按钮
    contentArea.querySelectorAll('.card-actions-btn').forEach(btn => {
        btn.addEventListener('click', showCardActions);
    });
    // 操作菜单项
    contentArea.querySelectorAll('.action-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = item.closest('.card-actions-menu').previousElementSibling;
            const itemPath = btn ? btn.dataset.itemPath : null;
            if (!itemPath) return;
            const action = item.dataset.action;
            import('./file_ops.js').then(m => {
                if (action === 'rename') m.renameFileFromCard(itemPath);
                else if (action === 'move') m.moveFileFromCard(itemPath);
                else if (action === 'delete') m.deleteFileFromCard(itemPath);
            });
            const menu = item.closest('.card-actions-menu');
            if (menu) menu.style.display = 'none';
        });
    });
}

function showCardActions(event) {
    event.stopPropagation();
    const btn = event.currentTarget;
    const menu = btn.nextElementSibling;
    document.querySelectorAll('.card-actions-menu').forEach(m => {
        if (m !== menu) m.style.display = 'none';
    });
    if (menu.style.display === 'block') {
        menu.style.display = 'none';
    } else {
        menu.style.display = 'block';
    }
}

// 文件/目录枚举：视频页需要的加载目录（移动、URL 上传）
export async function loadDirectories() {
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    try {
        const data = await loadFileList('', media_type);
        if (data && data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');
            const urlUploadDir = document.getElementById('urlUploadDir');
            const moveTargetDir = document.getElementById('moveTargetDir');
            if (urlUploadDir) {
                while (urlUploadDir.options.length > 1) urlUploadDir.remove(1);
            }
            if (moveTargetDir) {
                while (moveTargetDir.options.length > 1) moveTargetDir.remove(1);
            }
            dirs.forEach(dir => {
                if (urlUploadDir) {
                    const o1 = document.createElement('option');
                    o1.value = dir.path;
                    o1.textContent = dir.name;
                    urlUploadDir.appendChild(o1);
                }
                if (moveTargetDir) {
                    const o2 = document.createElement('option');
                    o2.value = dir.path;
                    o2.textContent = dir.name;
                    moveTargetDir.appendChild(o2);
                }
            });
        }
    } catch (error) {
        console.error('加载目录列表失败:', error);
    }
}
