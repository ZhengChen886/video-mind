// ============================
// pages/knowledge/sidebar.js
// 职责：知识库左侧文件树 / 文件夹管理 / 收藏 / 对话列表 / 侧栏控制
// 内部仍依赖 KnowledgeAPI（来自 api.js）
// ============================
import { showToast } from '../../core/utils.js';

let _api = null;
let _state = null;

function setCtx({ api, state }) { _api = api; _state = state; }

// 通用 escape
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function loadFiles() {
    if (!_api) return;
    try {
        const response = await _api.listFiles();
        if (response.success) {
            _state.fileTree = response.data;
            renderFileList();
        }
    } catch (error) {
        console.error('加载文件列表失败:', error);
    }
}

function filterFileTree(items, query) {
    if (!query) return items;
    return items.filter(item => {
        if (item.type === 'folder') {
            const childrenMatch = item.children && filterFileTree(item.children, query).length > 0;
            const nameMatch = item.name.toLowerCase().includes(query);
            if (nameMatch || childrenMatch) {
                return {
                    ...item,
                    children: item.children ? filterFileTree(item.children, query) : []
                };
            }
            return false;
        } else {
            return item.name.toLowerCase().includes(query);
        }
    }).filter(Boolean);
}

export function renderFileList() {
    const container = document.getElementById('knowledge-file-list');
    if (!container) return;
    if (!_state.fileTree || _state.fileTree.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无文档，上传一个开始使用</div>';
        return;
    }
    const filteredTree = filterFileTree(_state.fileTree, _state.searchQuery);
    container.innerHTML = renderFileTreeItems(filteredTree, 0);
}

export function renderFileTreeItems(items, depth) {
    return items.map(item => {
        if (item.type === 'folder') {
            const isExpanded = _state.expandedFolders.has(item.path);
            const hasChildren = item.children && item.children.length > 0;
            const indentStyle = `padding-left: ${depth * 16}px`;
            return `
                <div class="folder-item" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
                    <div class="folder-header" style="${indentStyle}">
                        <span class="folder-toggle ${isExpanded ? 'expanded' : ''}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="9 18 15 12 9 6"/>
                            </svg>
                        </span>
                        <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span class="folder-name">${escapeHtml(item.name)}</span>
                        <div class="folder-actions">
                            <button class="folder-action-btn folder-rename-btn" title="重命名">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                            </button>
                            <button class="folder-action-btn folder-delete-btn" title="删除">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    ${isExpanded && hasChildren ? `
                        <div class="folder-children">
                            ${renderFileTreeItems(item.children, depth + 1)}
                        </div>
                    ` : ''}
                </div>`;
        } else {
            const indentStyle = `padding-left: ${depth * 16}px`;
            const isActive = _state.currentDoc?.path === item.path;
            return `
                <div class="file-item ${isActive ? 'active' : ''}"
                     data-path="${escapeHtml(item.path)}"
                     data-name="${escapeHtml(item.name)}"
                     style="${indentStyle}">
                    <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <span class="file-name">${escapeHtml(item.name)}</span>
                </div>`;
        }
    }).join('');
}

export function toggleFolder(folderPath) {
    if (_state.expandedFolders.has(folderPath)) {
        _state.expandedFolders.delete(folderPath);
    } else {
        _state.expandedFolders.add(folderPath);
    }
    renderFileList();
}

export function showCreateFolderDialog() {
    const dialog = document.getElementById('modalCreateFolder');
    const input = document.getElementById('folderNameInput');
    if (dialog && input) {
        input.value = '';
        dialog.classList.add('open');
        setTimeout(() => input.focus(), 100);
    }
}

export function closeCreateFolderDialog() {
    const dialog = document.getElementById('modalCreateFolder');
    if (dialog) dialog.classList.remove('open');
}

export async function confirmCreateFolder() {
    const input = document.getElementById('folderNameInput');
    const folderName = input ? input.value.trim() : '';
    if (!folderName) {
        showToast('请输入文件夹名称', 'warning');
        return;
    }
    try {
        const response = await _api.createFolder(folderName);
        if (response.success) {
            showToast('文件夹创建成功', 'success');
            closeCreateFolderDialog();
            _state.expandedFolders.add(response.data.path);
            await loadFiles();
        } else {
            showToast(response.error || '创建失败', 'error');
        }
    } catch (error) {
        showToast('创建失败: ' + error.message, 'error');
    }
}

export function showRenameFolderDialog(folderPath, folderName) {
    _state.renamingFolderPath = folderPath;
    const dialog = document.getElementById('modalRenameFolder');
    const input = document.getElementById('renameFolderInput');
    if (dialog && input) {
        input.value = folderName;
        dialog.classList.add('open');
        setTimeout(() => input.focus(), 100);
    }
}

export function closeRenameFolderDialog() {
    const dialog = document.getElementById('modalRenameFolder');
    if (dialog) dialog.classList.remove('open');
    _state.renamingFolderPath = null;
}

export async function confirmRenameFolder() {
    const input = document.getElementById('renameFolderInput');
    const newName = input ? input.value.trim() : '';
    if (!newName) {
        showToast('请输入名称', 'warning');
        return;
    }
    try {
        const response = await _api.renameFolder(_state.renamingFolderPath, newName);
        if (response.success) {
            await loadFiles();
            showToast('重命名成功', 'success');
            closeRenameFolderDialog();
        }
    } catch (error) {
        showToast('重命名失败', 'error');
    }
}

export async function confirmDeleteFolder(folderPath, folderName) {
    if (!confirm(`确定要删除文件夹"${folderName}"及其所有内容吗？此操作不可撤销。`)) {
        return;
    }
    try {
        const response = await _api.deleteFolder(folderPath);
        if (response.success) {
            _state.expandedFolders.delete(folderPath);
            await loadFiles();
            showToast('删除成功', 'success');
        }
    } catch (error) {
        showToast('删除失败', 'error');
    }
}

export async function loadFavorites() {
    try {
        const response = await _api.listFavorites();
        if (response.success) {
            _state.favorites = response.data;
            renderFavoritesList();
        }
    } catch (error) {
        console.error('加载收藏失败:', error);
    }
}

export function renderFavoritesList() {
    const container = document.getElementById('favorites-list');
    if (!container) return;
    if (!_state.favorites || _state.favorites.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无收藏</div>';
        return;
    }
    container.innerHTML = _state.favorites.map(fav => `
        <div class="favorite-item" data-id="${escapeHtml(fav.id)}">
            <div class="favorite-content">${escapeHtml(fav.content.substring(0, 100))}...</div>
            <div class="favorite-meta">
                <span>${escapeHtml(fav.document || '未知文档')}</span>
                <button class="btn-delete-favorite" data-id="${escapeHtml(fav.id)}" title="删除">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

export async function deleteFavorite(favId) {
    try {
        const response = await _api.deleteFavorite(favId);
        if (response.success) {
            await loadFavorites();
            showToast('已删除收藏', 'success');
        }
    } catch (error) {
        showToast('删除失败', 'error');
    }
}

export function showFavoriteDetail(favId) {
    const fav = _state.favorites.find(f => f.id === favId);
    if (!fav) return;
    alert(`问题: ${fav.question || '无'}\n\n回答: ${fav.content}`);
}

export async function loadConversations() {
    try {
        const response = await _api.listConversations();
        if (response && response.success) {
            // 兜底：后端 success_response 在 data 为 None 时省略 data 字段，
            // 避免后续 .filter / .find 在 null 上调用而抛 TypeError
            _state.conversations = Array.isArray(response.data) ? response.data : [];
            renderConversationList();
        } else {
            // 失败时也保持数组形态，避免破窗
            if (!Array.isArray(_state.conversations)) _state.conversations = [];
        }
    } catch (error) {
        console.error('加载对话列表失败:', error);
        if (!Array.isArray(_state.conversations)) _state.conversations = [];
    }
}

export function renderConversationList() {
    const container = document.getElementById('conversation-list');
    if (!container) return;
    // 兜底：防止 _state.conversations 异常为 null/undefined 时抛 TypeError
    const allConversations = Array.isArray(_state.conversations) ? _state.conversations : [];
    let filteredConversations = allConversations;
    if (_state.currentDoc) {
        filteredConversations = allConversations.filter(
            conv => conv.doc_id === _state.currentDoc.path
        );
    }
    if (!filteredConversations || filteredConversations.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无对话</div>';
        return;
    }
    container.innerHTML = filteredConversations.map(conv => `
        <div class="conversation-item ${_state.currentConversation?.id === conv.id ? 'active' : ''}"
             data-id="${escapeHtml(conv.id)}">
            <div class="conv-info">
                <span class="conv-title">${escapeHtml(conv.title || '未命名对话')}</span>
                <span class="conv-doc">${escapeHtml(conv.doc_name || '')}</span>
            </div>
            <div class="conv-actions">
                <button class="conv-action-btn conv-rename-btn" title="重命名" data-id="${escapeHtml(conv.id)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="conv-action-btn conv-delete-btn" title="删除" data-id="${escapeHtml(conv.id)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

export function showRenameDialog(convId) {
    _state.currentRenameConvId = convId;
    const conv = (_state.conversations || []).find(c => c.id === convId);
    const dialog = document.getElementById('modalRenameConversation');
    const input = document.getElementById('renameConvInput');
    if (conv) input.value = conv.title || '';
    dialog.classList.add('open');
    setTimeout(() => input.focus(), 100);
}

export function closeRenameDialog() {
    const dialog = document.getElementById('modalRenameConversation');
    const input = document.getElementById('renameConvInput');
    dialog.classList.remove('open');
    input.value = '';
    _state.currentRenameConvId = null;
}

export async function confirmRename() {
    const input = document.getElementById('renameConvInput');
    const newTitle = input ? input.value.trim() : '';
    if (!newTitle) {
        showToast('请输入名称', 'warning');
        return;
    }
    try {
        const response = await _api.renameConversation(_state.currentRenameConvId, newTitle);
        if (response.success) {
            await loadConversations();
            showToast('重命名成功', 'success');
            closeRenameDialog();
        }
    } catch (error) {
        showToast('重命名失败', 'error');
    }
}

export async function deleteConversation(convId) {
    if (!confirm('确定要删除这个对话吗？')) return;
    try {
        const response = await _api.deleteConversation(convId);
        if (response.success) {
            if (_state.currentConversation?.id === convId) {
                _state.currentConversation = null;
                _state.messages = [];
                const { renderChatMessages } = await import('./chat.js');
                renderChatMessages();
            }
            await loadConversations();
            showToast('删除成功', 'success');
        }
    } catch (error) {
        showToast('删除失败', 'error');
    }
}

export function toggleLeftSidebar(expand) {
    const leftPanels = document.querySelector('.left-panels');
    const expandBtn = document.getElementById('btn-expand-left');
    _state.sidebarCollapsed = !expand;
    if (expand) {
        leftPanels.classList.remove('collapsed');
        expandBtn.style.display = 'none';
    } else {
        leftPanels.classList.add('collapsed');
        expandBtn.style.display = 'flex';
    }
}

export function toggleDocPreview(expand) {
    const panel = document.getElementById('doc-preview');
    const expandBtn = document.getElementById('btn-expand-right');
    if (expand) {
        panel.classList.remove('collapsed');
        expandBtn.style.display = 'none';
    } else {
        panel.classList.add('collapsed');
        expandBtn.style.display = 'flex';
    }
}

export function toggleFavoritesSection() {
    const section = document.getElementById('sidebar-favorites-section');
    if (section) section.classList.toggle('collapsed');
}

export { setCtx as setSidebarCtx };
