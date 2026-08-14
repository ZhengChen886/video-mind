// ============================
// pages/file_cleanup.js
// 职责：一键清理弹窗 - 树形选文件夹 + 弹出本地资源管理器选目录 + 选保留后缀，删除非保留类型文件
// ============================
import { state } from '../core/state.js';
import { showToast } from '../core/utils.js';
import { listFolderFileTypes, listAllFolders, cleanupFolderFilesApi, pickFolderApi } from '../core/api.js';

console.log('[cleanup] module loaded');

let _allFoldersCache = { mediaType: null, folders: [], tree: null };
let _currentScanKey = ''; // `${mediaType}::${path}` 用于避免过期回调
let _selectedPath = '';   // 当前树中选中的文件夹相对路径
let _pickedPath = '';     // 通过本地资源管理器选中的绝对路径
let _expandedSet = new Set(); // 展开状态：path -> bool

function _getCurrentMediaType() {
    return state.isShowingAudio ? 'audio' : 'video';
}

function _getCurrentPath() {
    if (state.isShowingDocuments) return '';
    return state.isShowingAudio ? (state.currentAudioPath || '') : (state.currentPath || '');
}

function _rootLabel(mediaType) {
    return mediaType === 'audio' ? '音频库根目录' : '视频库根目录';
}

// 把后端返回的扁平路径列表 [{path, name}] 构造成树
function _buildTree(folders) {
    const root = { name: '', path: '', displayName: _rootLabel(_getCurrentMediaType()), children: new Map() };
    folders.forEach(({ path, name }) => {
        const parts = String(path).split(/[\\/]/).filter(Boolean);
        let current = root;
        let currentPath = '';
        parts.forEach((part) => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    path: currentPath,
                    displayName: part,
                    children: new Map(),
                });
            }
            current = current.children.get(part);
        });
    });
    return root;
}

async function _ensureAllFolders(mediaType) {
    if (_allFoldersCache.mediaType === mediaType && _allFoldersCache.tree) {
        return _allFoldersCache.tree;
    }
    const data = await listAllFolders('', mediaType);
    const folders = (data && data.success) ? (data.folders || []) : [];
    _allFoldersCache = {
        mediaType,
        folders,
        tree: _buildTree(folders),
    };
    return _allFoldersCache.tree;
}

function _renderTreeNode(node, depth = 0) {
    const hasChildren = node.children && node.children.size > 0;
    const expanded = _expandedSet.has(node.path) || depth === 0; // 根默认展开，第一层也默认展开
    const isSelected = _selectedPath === node.path;
    const rowClass = `tree-row${isSelected ? ' selected' : ''}`;
    const toggleClass = `tree-toggle${hasChildren ? (expanded ? ' expanded' : '') : ' empty'}`;
    const childrenClass = `tree-children${expanded ? '' : ' collapsed'}`;

    const childrenHtml = hasChildren
        ? Array.from(node.children.values())
            .map(child => _renderTreeNode(child, depth + 1))
            .join('')
        : '';

    return `
        <div class="tree-node" data-path="${escapeAttr(node.path)}">
            <div class="${rowClass}">
                <span class="${toggleClass}" data-action="toggle">${hasChildren ? '▶' : '·'}</span>
                <span class="tree-icon">📁</span>
                <span class="tree-name" data-action="select">${escapeHtml(node.displayName || node.name)}</span>
            </div>
            ${hasChildren ? `<div class="${childrenClass}">${childrenHtml}</div>` : ''}
        </div>
    `;
}

function _renderTree() {
    const container = document.getElementById('cleanupFolderTree');
    if (!container) return;
    const tree = _allFoldersCache.tree;
    if (!tree) {
        container.innerHTML = '<div class="tree-empty">暂无可选目录</div>';
        return;
    }
    container.innerHTML = _renderTreeNode(tree, 0);
    _updateSelectedLabel();
}

function _updateSelectedLabel() {
    const el = document.getElementById('cleanupSelectedName');
    if (!el) return;
    if (_pickedPath) {
        el.textContent = _pickedPath;
    } else {
        el.textContent = _selectedPath || _rootLabel(_getCurrentMediaType());
    }
}

function _setSelected(path) {
    _selectedPath = path || '';
    // 树中点击时清掉本地选目录（用树选中更直观）
    _setPickedPath('', { skipScan: true });
    // 找到节点的所有祖先，强制展开
    if (path) {
        const parts = path.split('/').filter(Boolean);
        let cur = '';
        _expandedSet.add(''); // 根始终展开
        parts.forEach((p) => {
            cur = cur ? `${cur}/${p}` : p;
            _expandedSet.add(cur);
        });
    }
    _renderTree();
    _scanCurrentFolder();
}

function _onTreeClick(event) {
    const target = event.target;
    if (!target) return;
    const action = target.dataset.action;
    if (!action) return;
    const nodeEl = target.closest('.tree-node');
    if (!nodeEl) return;
    const path = nodeEl.dataset.path || '';
    if (action === 'toggle') {
        if (_expandedSet.has(path)) {
            _expandedSet.delete(path);
        } else {
            _expandedSet.add(path);
        }
        _renderTree();
        return;
    }
    if (action === 'select') {
        _setSelected(path);
    }
}

async function _populateFolderTree() {
    const container = document.getElementById('cleanupFolderTree');
    if (container) {
        container.innerHTML = '<div class="tree-empty">正在加载目录…</div>';
    }
    const mediaType = _getCurrentMediaType();
    try {
        await _ensureAllFolders(mediaType);
    } catch (e) {
        if (container) container.innerHTML = `<div class="tree-error">加载目录失败: ${escapeHtml(e.message || String(e))}</div>`;
        throw e;
    }
    // 默认选中当前浏览路径
    const desired = _getCurrentPath();
    _selectedPath = desired || '';
    _renderTree();
}

function _setPickedPath(p, opts = {}) {
    _pickedPath = (p || '').trim();
    const input = document.getElementById('cleanupPickedPath');
    if (input) input.value = _pickedPath;
    const clearBtn = document.getElementById('cleanupPickedClearBtn');
    if (clearBtn) clearBtn.style.display = _pickedPath ? 'flex' : 'none';
    _updateSelectedLabel();
    if (!opts.skipScan) {
        _scanCurrentFolder();
    }
}

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function _getSelectedExts() {
    return Array.from(document.querySelectorAll('#cleanupExtList .cleanup-ext-cb:checked'))
        .map(cb => cb.value);
}

function _countSelectedFiles() {
    let keepCount = 0;
    let total = 0;
    document.querySelectorAll('#cleanupExtList .cleanup-ext-item').forEach(item => {
        const m = (item.querySelector('span:last-child').textContent || '').match(/(\d+)/);
        const c = m ? parseInt(m[1], 10) : 0;
        total += c;
        const cb = item.querySelector('.cleanup-ext-cb');
        if (cb && cb.checked) keepCount += c;
    });
    return { keepCount, deleteCount: total - keepCount, total };
}

function _resolveTargetPath() {
    // 优先使用本地选目录（绝对路径），否则用树选中
    return _pickedPath || _selectedPath || '';
}

function _resolveTargetLabel() {
    if (_pickedPath) return _pickedPath;
    return _selectedPath || _rootLabel(_getCurrentMediaType());
}

function _updatePreview() {
    const preview = document.getElementById('cleanupPreview');
    if (!preview) return;
    const selected = _resolveTargetLabel();
    const exts = _getSelectedExts();
    if (exts.length === 0) {
        preview.style.display = 'block';
        preview.innerHTML = `⚠ 当前未勾选任何文件类型，文件夹内<b>全部文件</b>将被删除。目标：${escapeHtml(selected)}`;
        return;
    }
    const { keepCount, deleteCount, total } = _countSelectedFiles();
    preview.style.display = 'block';
    const extLabel = exts.length === 1 ? exts[0] : `${exts.length} 种`;
    preview.innerHTML = `目标：${escapeHtml(selected)}<br>将保留 <b>${keepCount}</b> 个文件（${escapeHtml(extLabel)}），删除 <b>${deleteCount}</b> 个文件（合计 ${total} 个）。子目录不会被清理。`;
}

async function _scanCurrentFolder() {
    const list = document.getElementById('cleanupExtList');
    if (!list) return;
    const mediaType = _getCurrentMediaType();
    const path = _resolveTargetPath();
    const key = `${mediaType}::${path}`;
    _currentScanKey = key;
    if (!path) {
        list.innerHTML = '<div style="font-size:13px;color:#94a3b8;text-align:center;padding:16px">请先在树上选择文件夹或使用本地选目录</div>';
        _updatePreview();
        return;
    }
    list.innerHTML = '<div style="font-size:13px;color:#94a3b8;text-align:center;padding:16px">正在扫描文件类型…</div>';
    _updatePreview();
    try {
        const data = await listFolderFileTypes(path, mediaType);
        if (key !== _currentScanKey) return; // 用户已切换文件夹
        if (!data || !data.success) {
            list.innerHTML = `<div style="font-size:13px;color:#dc2626;text-align:center;padding:16px">扫描失败: ${escapeHtml((data && data.error) || '未知错误')}</div>`;
            _updatePreview();
            return;
        }
        _renderExtList(data.extensions || []);
        _updatePreview();
    } catch (error) {
        if (key !== _currentScanKey) return;
        list.innerHTML = `<div style="font-size:13px;color:#dc2626;text-align:center;padding:16px">扫描失败: ${escapeHtml(error.message)}</div>`;
    }
}

function _renderExtList(extensions) {
    const container = document.getElementById('cleanupExtList');
    if (!container) return;
    if (!extensions || extensions.length === 0) {
        container.innerHTML = '<div style="font-size:13px;color:#94a3b8;text-align:center;padding:16px">该文件夹内没有文件</div>';
        return;
    }
    const items = extensions.map(({ ext, count }) => {
        const safeExt = (ext || '').toLowerCase();
        const label = ext ? ext : '(无后缀)';
        const checked = safeExt === '.md' ? 'checked' : '';
        return `
            <label class="cleanup-ext-item" data-ext="${escapeAttr(ext)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px 6px 4px;cursor:pointer;border-radius:6px;font-size:13px;text-align:left;width:100%;box-sizing:border-box">
                <span class="cleanup-ext-cb-wrap" style="display:inline-flex;align-items:center;justify-content:flex-start;width:20px;flex-shrink:0">
                    <input type="checkbox" class="cleanup-ext-cb" value="${escapeAttr(ext)}" ${checked}>
                </span>
                <span style="font-family:ui-monospace,Consolas,monospace;min-width:64px;flex:0 0 auto">${escapeHtml(label)}</span>
                <span style="color:#94a3b8;font-size:12px;margin-left:auto">${count} 个文件</span>
            </label>`;
    }).join('');
    container.innerHTML = items;
}

// ============================================================
// 入口：打开清理弹窗
// ============================================================
export async function openCleanupModal() {
    console.log('[cleanup] openCleanupModal called');
    const modal = document.getElementById('modalCleanup');
    if (!modal) {
        console.error('[cleanup] #modalCleanup 元素不存在');
        return;
    }
    // 重置状态
    _allFoldersCache = { mediaType: null, folders: [], tree: null };
    _currentScanKey = '';
    _expandedSet = new Set();
    _setPickedPath('', { skipScan: true });
    modal.classList.add('show');
    try {
        await _populateFolderTree();
    } catch (e) {
        console.error('[cleanup] 加载目录树失败:', e);
    }
    try {
        await _scanCurrentFolder();
    } catch (e) {
        console.error('[cleanup] 扫描文件类型失败:', e);
    }
}

// ============================================================
// 入口：弹出本地资源管理器选目录
// ============================================================
export async function onCleanupPickFolder() {
    const pickBtn = document.getElementById('cleanupPickFolderBtn');
    const pickedInput = document.getElementById('cleanupPickedPath');
    if (pickBtn) pickBtn.style.pointerEvents = 'none';
    try {
        const data = await pickFolderApi();
        if (!data || !data.success) {
            if (data && data.cancelled) return;
            showToast((data && data.error) || '选目录失败', 'error');
            return;
        }
        const abs = (data.path || '').trim();
        if (!abs) return;
        _setPickedPath(abs);
        showToast('已选择本地目录', 'success');
    } catch (e) {
        showToast(`选目录失败: ${e.message}`, 'error');
    } finally {
        if (pickBtn) pickBtn.style.pointerEvents = '';
        if (pickedInput) pickedInput.blur();
    }
}

// ============================================================
// 入口：点击 picker 输入框 → 弹出选目录
// ============================================================
export function onCleanupPickedPathClick() {
    return onCleanupPickFolder();
}

// ============================================================
// 入口：清除已选本地目录
// ============================================================
export function onCleanupPickedClear(event) {
    if (event) {
        event.stopPropagation();
    }
    _setPickedPath('');
    showToast('已清除本地选目录', 'info');
}

// ============================================================
// 入口：确认清理
// ============================================================
export async function confirmCleanup() {
    const confirmBtn = document.getElementById('confirmCleanup');
    if (!confirmBtn) return;
    const mediaType = _getCurrentMediaType();
    const path = _resolveTargetPath();
    if (!path) {
        showToast('请先选择要清理的文件夹', 'info');
        return;
    }
    const keepExts = _getSelectedExts();
    const label = _resolveTargetLabel();

    if (keepExts.length === 0) {
        if (!confirm(`当前未勾选任何保留类型，将删除「${label}」中的所有文件（不含子目录），是否继续？`)) return;
    } else {
        const preview = _countSelectedFiles();
        const msg = `将删除「${label}」中的 ${preview.deleteCount} 个非保留类型文件（保留 ${preview.keepCount} 个），不可恢复，是否继续？`;
        if (!confirm(msg)) return;
    }

    confirmBtn.disabled = true;
    const originalText = confirmBtn.textContent;
    confirmBtn.textContent = '清理中...';
    try {
        const data = await cleanupFolderFilesApi(path, keepExts, mediaType);
        if (!data || !data.success) {
            showToast((data && data.error) || '清理失败', 'error');
            return;
        }
        const modal = document.getElementById('modalCleanup');
        if (modal) modal.classList.remove('show');
        const errCount = (data.errors || []).length;
        const tip = errCount > 0
            ? `已删除 ${data.deleted_count} 个文件，保留 ${data.kept_count} 个，${errCount} 个失败`
            : `已删除 ${data.deleted_count} 个文件，保留 ${data.kept_count} 个`;
        showToast(tip, errCount > 0 ? 'info' : 'success');
        // 刷新当前列表
        const { loadFiles, loadAudioFiles, loadSidebarVideoFolders, loadSidebarAudioFolders } = await import('./videos.js');
        if (state.isShowingAudio) {
            await loadAudioFiles();
            await loadSidebarAudioFolders();
        } else {
            await loadFiles();
            await loadSidebarVideoFolders();
        }
    } catch (error) {
        showToast(`清理失败: ${error.message}`, 'error');
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
    }
}

// ============================================================
// 入口：全选 / 全不选
// ============================================================
export function onCleanupSelectAll() {
    document.querySelectorAll('#cleanupExtList .cleanup-ext-cb').forEach(cb => { cb.checked = true; });
    _updatePreview();
}
export function onCleanupSelectNone() {
    document.querySelectorAll('#cleanupExtList .cleanup-ext-cb').forEach(cb => { cb.checked = false; });
    _updatePreview();
}

// ============================================================
// 入口：复选框变化时刷新预览
// ============================================================
export function onCleanupExtChange() {
    _updatePreview();
}

// ============================================================
// 入口：树形区域点击（事件委托）
// ============================================================
export function onCleanupTreeClick(event) {
    _onTreeClick(event);
}

// ============================================================
// 入口：关闭弹窗
// ============================================================
export function closeCleanupModal() {
    const modal = document.getElementById('modalCleanup');
    if (modal) modal.classList.remove('show');
}
