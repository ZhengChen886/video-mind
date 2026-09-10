// ============================
// pages/knowledge/multi_doc.js
// 职责：多文档问答（多选模式 / 添加本地文件夹批量索引 / 全库问答）
// RAG 多文件/文件夹知识库改造
// ============================
import { showToast } from '../../core/utils.js';

let _api = null;
let _state = null;

function setCtx({ api, state }) { _api = api; _state = state; }

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------- 多选文档模式 ----------

export function toggleMultiSelectMode() {
    _state.multiSelectMode = !_state.multiSelectMode;
    if (!_state.multiSelectMode) {
        // 退出多选模式时清空选择并回到单文档模式
        _state.selectedDocs = [];
        _state.chatMode = 'single';
    } else {
        _state.chatMode = 'multi';
    }
    updateMultiDocBar();
    // 重新渲染文件树（显示/隐藏复选框）
    import('./sidebar.js').then(({ renderFileList }) => renderFileList());
    showToast(_state.multiSelectMode
        ? '多选模式已开启：在左侧文件树勾选文档后提问'
        : '已退出多选模式', 'info');
}

export function toggleDocSelected(path, name) {
    if (!_state.selectedDocs) _state.selectedDocs = [];
    const idx = _state.selectedDocs.findIndex(d => d.path === path);
    if (idx >= 0) {
        _state.selectedDocs.splice(idx, 1);
    } else {
        if (_state.selectedDocs.length >= 50) {
            showToast('单次问答最多支持 50 个文档', 'warning');
            return;
        }
        _state.selectedDocs.push({ path, name });
    }
    updateMultiDocBar();
}

export function clearSelectedDocs() {
    _state.selectedDocs = [];
    updateMultiDocBar();
    import('./sidebar.js').then(({ renderFileList }) => renderFileList());
}

export function updateMultiDocBar() {
    const btn = document.getElementById('btn-multiselect-toggle');
    const collBtn = document.getElementById('btn-collection-chat');
    const selectedWrap = document.getElementById('multi-doc-selected');
    const listEl = document.getElementById('multi-doc-selected-list');

    if (btn) btn.classList.toggle('active', !!_state.multiSelectMode);
    if (collBtn) collBtn.classList.toggle('active', _state.chatMode === 'collection');

    const docs = _state.selectedDocs || [];
    if (selectedWrap && listEl) {
        selectedWrap.style.display = docs.length > 0 ? 'flex' : 'none';
        listEl.innerHTML = docs.map(d => `
            <span class="doc-chip" title="${escapeHtml(d.path)}">
                ${escapeHtml(d.name)}
                <button class="doc-chip-remove" data-path="${escapeHtml(d.path)}">&times;</button>
            </span>
        `).join('');
    }
}

// ---------- 全库问答模式 ----------

export function toggleCollectionMode() {
    if (_state.chatMode === 'collection') {
        _state.chatMode = 'single';
        showToast('已退出全库问答模式', 'info');
    } else {
        _state.chatMode = 'collection';
        _state.multiSelectMode = false;
        _state.selectedDocs = [];
        showToast('全库问答模式：将检索知识库中所有已索引文档', 'info');
    }
    updateMultiDocBar();
    import('./sidebar.js').then(({ renderFileList }) => renderFileList());
}

// ---------- 添加本地文件夹（扫描 -> 预览 -> 批量索引） ----------

export function showScanFolderDialog() {
    const dialog = document.getElementById('modalScanFolder');
    const input = document.getElementById('scanFolderInput');
    const preview = document.getElementById('scan-folder-preview');
    const doScanBtn = document.getElementById('btn-do-scan');
    const confirmBtn = document.getElementById('confirmScanFolder');
    if (dialog && input) {
        input.value = '';
        if (preview) preview.style.display = 'none';
        if (doScanBtn) doScanBtn.style.display = 'none';
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '扫描';
        }
        dialog.classList.add('open');
        setTimeout(() => input.focus(), 100);
    }
}

export function closeScanFolderDialog() {
    const dialog = document.getElementById('modalScanFolder');
    if (dialog) dialog.classList.remove('open');
}

// 已扫描的文件夹结果（供确认索引用）
let _scannedResult = null;

export async function doScanFolder() {
    const input = document.getElementById('scanFolderInput');
    const path = input ? input.value.trim() : '';
    if (!path) {
        showToast('请输入文件夹路径', 'warning');
        return;
    }

    const confirmBtn = document.getElementById('confirmScanFolder');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '扫描中...';
    }

    try {
        const response = await _api.scanFolder(path);
        if (!response.success) {
            showToast(response.error || '扫描失败', 'error');
            return;
        }

        _scannedResult = response.data;
        const preview = document.getElementById('scan-folder-preview');
        const summary = document.getElementById('scan-folder-summary');
        const filesEl = document.getElementById('scan-folder-files');
        const doScanBtn = document.getElementById('btn-do-scan');

        if (preview) preview.style.display = 'block';
        if (doScanBtn) doScanBtn.style.display = 'inline-block';

        const files = _scannedResult.files || [];
        const skipped = _scannedResult.skipped || [];
        if (summary) {
            summary.innerHTML = `
                找到 <strong>${files.length}</strong> 个支持的文件
                ${skipped.length > 0 ? `（跳过 ${skipped.length} 个超大/异常文件）` : ''}
            `;
        }
        if (filesEl) {
            // 最多展示前 100 条，避免 DOM 过大
            const shown = files.slice(0, 100);
            filesEl.innerHTML = shown.map(f => `
                <div class="scan-file-row">
                    <span class="scan-file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>
                    <span class="scan-file-meta">${escapeHtml(f.type)} · ${formatSize(f.size)}</span>
                </div>
            `).join('') + (files.length > 100
                ? `<div class="scan-file-more">... 其余 ${files.length - 100} 个文件</div>`
                : '');
        }

        if (confirmBtn) {
            confirmBtn.textContent = `批量索引 ${files.length} 个文件`;
            confirmBtn.disabled = files.length === 0;
        }
    } catch (error) {
        showToast('扫描失败: ' + error.message, 'error');
    } finally {
        if (confirmBtn && confirmBtn.textContent === '扫描中...') {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '扫描';
        }
    }
}

function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function confirmScanFolder() {
    // 若尚未扫描，先执行扫描
    if (!_scannedResult) {
        await doScanFolder();
        return;
    }

    const folderPath = _scannedResult.folder;
    const forceCheckbox = document.getElementById('scanFolderForce');
    const force = forceCheckbox ? forceCheckbox.checked : false;

    const confirmBtn = document.getElementById('confirmScanFolder');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '索引中...';
    }

    try {
        const response = await _api.batchIndex(
            [{ path: folderPath, type: 'folder' }],
            force
        );
        if (response.success) {
            const r = response.data;
            showToast(response.message || `批量索引完成：成功 ${r.indexed_count}，跳过 ${r.skipped_count}，失败 ${r.failed_count}`, 'success');
            closeScanFolderDialog();

            // 将成功索引的文件加入多文档已选列表
            const indexed = (r.indexed || []).map(f => ({ path: f.path, name: f.name }));
            const skipped = (r.skipped || []).map(f => ({ path: f.path, name: f.path.split(/[\\/]/).pop() }));
            const allDocs = indexed.concat(skipped);

            if (allDocs.length > 0) {
                _state.multiSelectMode = true;
                _state.chatMode = 'multi';
                if (!_state.selectedDocs) _state.selectedDocs = [];
                for (const doc of allDocs) {
                    if (_state.selectedDocs.length >= 50) break;
                    if (!_state.selectedDocs.some(d => d.path === doc.path)) {
                        _state.selectedDocs.push(doc);
                    }
                }
                updateMultiDocBar();
                showToast(`已选 ${_state.selectedDocs.length} 个文档，可以直接提问`, 'info');
            }
        } else {
            showToast(response.error || '批量索引失败', 'error');
        }
    } catch (error) {
        showToast('批量索引失败: ' + error.message, 'error');
    } finally {
        _scannedResult = null;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '扫描';
        }
    }
}

export { setCtx as setMultiDocCtx };
