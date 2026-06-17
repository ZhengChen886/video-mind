// ============================
// pages/model_select.js
// 职责：模型选择弹窗，加载/渲染/确认
// ============================
import { API_BASE_URL, appConfig, saveAppConfig, updateModelDisplay } from '../core/config.js';
import { state } from '../core/state.js';

export function openModelSelectModal() {
    state.selectedModel = null;
    const confirmBtn = document.getElementById('confirmModelSelect');
    if (confirmBtn) confirmBtn.disabled = true;
    const searchInput = document.getElementById('modelSearchInput');
    if (searchInput) searchInput.value = '';
    const modal = document.getElementById('modalModelSelect');
    if (modal) modal.classList.add('show');
    loadModels();
}

export async function loadModels() {
    const modelListEl = document.getElementById('modelList');
    if (!modelListEl) return;
    modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">加载中...</div>';
    try {
        const response = await fetch(`${API_BASE_URL}/api/models?provider=${appConfig.activeProvider}`);
        const data = await response.json();
        if (data.success) {
            state.allModels = data.models;
            renderModelList(state.allModels);
        } else {
            modelListEl.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">${data.error || '加载失败'}</div>`;
        }
    } catch (error) {
        console.error('加载模型失败:', error);
        modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444">加载失败</div>';
    }
}

export function renderModelList(models, searchQuery = '') {
    const modelListEl = document.getElementById('modelList');
    if (!modelListEl) return;
    const filteredModels = models.filter(m =>
        m.id.toLowerCase().includes((searchQuery || '').toLowerCase())
    );
    if (filteredModels.length === 0) {
        modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">暂无模型</div>';
        return;
    }
    modelListEl.innerHTML = filteredModels.map(model => `
        <div class="model-item ${state.selectedModel === model.id ? 'selected' : ''}" data-id="${model.id}">
            <div class="model-item-name">${model.id}</div>
            <div class="model-item-meta">${model.owned_by || ''}</div>
        </div>
    `).join('');
    modelListEl.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
            state.selectedModel = item.dataset.id;
            modelListEl.querySelectorAll('.model-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            const confirmBtn = document.getElementById('confirmModelSelect');
            if (confirmBtn) confirmBtn.disabled = false;
        });
    });
}

export function confirmModelSelect() {
    if (!state.selectedModel) return;
    appConfig.currentModel = state.selectedModel;
    saveAppConfig();
    updateModelDisplay();
    const modal = document.getElementById('modalModelSelect');
    if (modal) modal.classList.remove('show');
}
