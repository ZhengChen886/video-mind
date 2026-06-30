// ============================
// pages/file_ops.js
// 职责：新建目录、重命名、移动、删除
// ============================
import {
    loadFileList,
    createFolderApi,
    renameItemApi,
    moveItemApi,
    countItem,
    deleteItemApi
} from '../core/api.js';
import { state } from '../core/state.js';

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

export async function createFolder() {
    const nameEl = document.getElementById('folderNameInput');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) return;
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    const basePath = state.isShowingAudio ? state.currentAudioPath : state.currentPath;
    try {
        const data = await createFolderApi(basePath, name, media_type);
        if (data && data.success) {
            const modal = document.getElementById('modalNewFolder');
            if (modal) modal.classList.remove('show');
            if (nameEl) nameEl.value = '';
            const { loadFiles, loadAudioFiles, loadSidebarVideoFolders, loadSidebarAudioFolders } = await import('./videos.js');
            if (state.isShowingAudio) await loadAudioFiles();
            else await loadFiles();
            await loadDirectories();
            if (state.isShowingAudio) await loadSidebarAudioFolders();
            else await loadSidebarVideoFolders();
        } else {
            alert('创建失败: ' + (data && data.error));
        }
    } catch (error) {
        alert('创建失败: ' + error.message);
    }
}

export function computePathAfterOperation(oldItemPath, newItemPath) {
    const isAudio = state.isShowingAudio;
    const current = isAudio ? state.currentAudioPath : state.currentPath;
    if (!current || !oldItemPath) return current;
    const oldPrefix = oldItemPath.endsWith('/') ? oldItemPath : oldItemPath + '/';
    if (current === oldItemPath) {
        return newItemPath || '';
    }
    if (current.startsWith(oldPrefix)) {
        const suffix = current.slice(oldPrefix.length);
        if (!newItemPath) return suffix;
        return suffix ? `${newItemPath}/${suffix}` : newItemPath;
    }
    return current;
}

export function refreshAfterStructureChange() {
    import('./videos.js').then(m => {
        if (state.isShowingAudio) m.loadSidebarAudioFolders();
        else m.loadSidebarVideoFolders();
        m.updateSidebarActiveState();
    });
}

export function renameFileFromCard(path) {
    const input = document.getElementById('renameInput');
    if (input) input.value = path.split('/').pop();
    const modal = document.getElementById('modalRename');
    if (modal) {
        modal.dataset.path = path;
        modal.classList.add('show');
    }
}

export async function renameFile() {
    const modal = document.getElementById('modalRename');
    const path = modal ? modal.dataset.path : '';
    const newNameEl = document.getElementById('renameInput');
    const newName = newNameEl ? newNameEl.value.trim() : '';
    if (!path || !newName) return;
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    try {
        const data = await renameItemApi(path, newName, media_type);
        if (data && data.success) {
            if (modal) modal.classList.remove('show');
            const segments = path.split('/').filter(Boolean);
            segments[segments.length - 1] = newName;
            const newItemPath = segments.join('/');
            const newCurrent = computePathAfterOperation(path, newItemPath);
            if (state.isShowingAudio) state.currentAudioPath = newCurrent;
            else state.currentPath = newCurrent;
            const { loadFiles, loadAudioFiles } = await import('./videos.js');
            if (state.isShowingAudio) await loadAudioFiles();
            else await loadFiles();
            refreshAfterStructureChange();
        } else {
            alert('重命名失败: ' + (data && data.error));
        }
    } catch (error) {
        alert('重命名失败: ' + error.message);
    }
}

export function moveFileFromCard(path) {
    const modal = document.getElementById('modalMove');
    if (modal) {
        modal.dataset.path = path;
        modal.classList.add('show');
    }
}

export async function moveFile() {
    const modal = document.getElementById('modalMove');
    const path = modal ? modal.dataset.path : '';
    const targetDirEl = document.getElementById('moveTargetDir');
    const targetDir = targetDirEl ? targetDirEl.value : '';
    if (!path) return;
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    try {
        const data = await moveItemApi(path, targetDir, media_type);
        if (data && data.success) {
            if (modal) modal.classList.remove('show');
            const oldName = path.split('/').filter(Boolean).pop() || '';
            const newItemPath = targetDir ? `${targetDir}/${oldName}` : oldName;
            const newCurrent = computePathAfterOperation(path, newItemPath);
            if (state.isShowingAudio) state.currentAudioPath = newCurrent;
            else state.currentPath = newCurrent;
            const { loadFiles, loadAudioFiles } = await import('./videos.js');
            if (state.isShowingAudio) await loadAudioFiles();
            else await loadFiles();
            refreshAfterStructureChange();
        } else {
            alert('移动失败: ' + (data && data.error));
        }
    } catch (error) {
        alert('移动失败: ' + error.message);
    }
}

export async function deleteFileFromCard(path) {
    state.selectedItems = [path];
    await renderDeleteModal(path);
    const modal = document.getElementById('modalDelete');
    if (modal) modal.classList.add('show');
}

export async function renderDeleteModal(path) {
    const modal = document.getElementById('modalDelete');
    const titleEl = document.getElementById('deleteModalTitle');
    const descEl = document.getElementById('deleteModalDesc');
    if (!modal || !titleEl || !descEl) return;
    let itemName = '';
    try {
        const card = document.querySelector(
            `.file-card[data-type][data-path="${CSS.escape(path)}"], .list-item[data-type][data-path="${CSS.escape(path)}"]`
        );
        if (card && card.dataset.itemName) itemName = card.dataset.itemName;
    } catch (e) {}
    if (!itemName) {
        itemName = (path || '').split('/').filter(Boolean).pop() || path || '该项';
    }
    titleEl.textContent = '确认删除';
    descEl.textContent = `确定要删除「${itemName}」吗？此操作不可撤销。`;
    modal.dataset.path = path;
    modal.dataset.itemName = itemName;
    modal.dataset.itemType = '';
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    try {
        const data = await countItem(path, media_type);
        if (!data || !data.success) return;
        const realName = data.name || itemName;
        modal.dataset.itemName = realName;
        modal.dataset.itemType = data.type;
        if (data.type === 'directory') {
            titleEl.textContent = '确认删除文件夹';
            const count = data.count || 0;
            descEl.textContent = `将永久删除文件夹「${realName}」及其内的 ${count} 个文件，此操作不可撤销。`;
        } else {
            titleEl.textContent = '确认删除文件';
            descEl.textContent = `将永久删除文件「${realName}」，此操作不可撤销。`;
        }
    } catch (error) {
        console.error('渲染删除弹窗失败:', error);
    }
}

export async function deleteSelected() {
    if (state.selectedItems.length === 0) return;
    const media_type = state.isShowingAudio ? 'audio' : 'video';
    const path = state.selectedItems[0];
    try {
        const data = await deleteItemApi(path, media_type);
        if (data && data.success) {
            const modal = document.getElementById('modalDelete');
            if (modal) modal.classList.remove('show');
            state.selectedItems = [];
            const { loadFiles, loadAudioFiles, loadSidebarVideoFolders, loadSidebarAudioFolders } = await import('./videos.js');
            if (state.isShowingAudio) await loadAudioFiles();
            else await loadFiles();
            if (data.deleted_type === 'directory') {
                if (state.isShowingAudio) await loadSidebarAudioFolders();
                else await loadSidebarVideoFolders();
            }
        } else {
            alert('删除失败: ' + (data && data.error));
        }
    } catch (error) {
        alert('删除失败: ' + error.message);
    }
}
