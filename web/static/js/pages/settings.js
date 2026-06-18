// ============================
// pages/settings.js
// 职责：设置弹窗（提供商切换、API Key 显隐、获取模型、保存设置）
// ============================
import { API_BASE_URL, appConfig, saveAppConfig, updateModelDisplay } from '../core/config.js';
import { state } from '../core/state.js';
import { escapeAttr } from '../core/utils.js';

export async function openSettingsModal() {
    const modal = document.getElementById('modalSettings');
    if (modal) modal.classList.add('show');
    await loadConfigFromServer();
}

export async function loadConfigFromServer() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        if (data.success) {
            state.currentConfig = data.config;
            const activeProvider = state.currentConfig.active_provider || 'open-ai';
            state.editingProvider = activeProvider;
            document.querySelectorAll('.provider-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.provider === activeProvider);
            });
            loadProviderConfig(activeProvider);
        }
    } catch (e) {
        console.error('Load config failed:', e);
    }
}

export function loadProviderConfig(providerId) {
    const provider = state.currentConfig.providers[providerId];
    if (!provider) return;
    const urlInput = document.getElementById('configApiUrl');
    const keyInput = document.getElementById('configApiKey');
    const modelsUrlInput = document.getElementById('configModelsUrl');
    const modelSelect = document.getElementById('configDefaultModel');
    if (urlInput) urlInput.value = provider.api_url || '';
    if (keyInput) keyInput.value = provider.api_key ? '***' : '';
    if (modelsUrlInput) modelsUrlInput.value = provider.models_url || '';
    loadModelSelectModels(providerId);
    renderModelsTable(providerId);
    if (modelSelect) modelSelect.value = provider.default_model || '';
}

export function loadModelSelectModels(providerId) {
    const modelSelect = document.getElementById('configDefaultModel');
    if (!modelSelect) return;
    modelSelect.innerHTML = '<option value="">请选择默认模型</option>';
    const provider = state.currentConfig.providers[providerId];
    if (provider && Array.isArray(provider.models) && provider.models.length > 0) {
        provider.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name || model.id;
            modelSelect.appendChild(option);
        });
        if (provider.default_model) modelSelect.value = provider.default_model;
    }
}

export function renderModelsTable(providerId) {
    const tbody = document.getElementById('configModelsTbody');
    const emptyEl = document.getElementById('configModelsEmpty');
    if (!tbody || !emptyEl) return;
    const provider = state.currentConfig.providers[providerId] || { models: [] };
    const models = provider.models || [];
    tbody.innerHTML = '';
    if (models.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';
    models.forEach((model, idx) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #f1f5f9';
        tr.innerHTML = `
            <td style="padding:6px 10px;">
                <input type="text" data-field="id" data-index="${idx}" value="${escapeAttr(model.id || '')}" placeholder="模型 ID（必填）" style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
            </td>
            <td style="padding:6px 10px;">
                <input type="text" data-field="name" data-index="${idx}" value="${escapeAttr(model.name || '')}" placeholder="显示名称（可空）" style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
            </td>
            <td style="padding:6px 10px;text-align:center;">
                <button type="button" class="config-model-delete-btn" data-index="${idx}" title="删除" style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:13px;padding:4px 8px;">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.config-model-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.dataset.index, 10);
            removeModelRow(idx);
        });
    });
}

export function switchProviderTab(providerId) {
    state.editingProvider = providerId;
    document.querySelectorAll('.provider-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.provider === providerId);
    });
    loadProviderConfig(providerId);
}

export function getCurrentEditingProviderId() {
    const activeTab = document.querySelector('.provider-tab.active');
    return activeTab ? activeTab.dataset.provider : (state.currentConfig.active_provider || 'open-ai');
}

export function addModelRow() {
    const providerId = getCurrentEditingProviderId();
    if (!state.currentConfig.providers[providerId]) state.currentConfig.providers[providerId] = {};
    if (!state.currentConfig.providers[providerId].models) state.currentConfig.providers[providerId].models = [];
    state.currentConfig.providers[providerId].models.push({ id: '', name: '', created: 0, owned_by: '' });
    renderModelsTable(providerId);
    loadModelSelectModels(providerId);
}

export function removeModelRow(idx) {
    const providerId = getCurrentEditingProviderId();
    const provider = state.currentConfig.providers[providerId];
    if (!provider || !Array.isArray(provider.models)) return;
    provider.models.splice(idx, 1);
    renderModelsTable(providerId);
    loadModelSelectModels(providerId);
}

export async function fetchModels() {
    const activeTab = document.querySelector('.provider-tab.active');
    const providerId = activeTab ? activeTab.dataset.provider : null;
    const apiUrl = document.getElementById('configApiUrl')?.value;
    const apiKey = document.getElementById('configApiKey')?.value;
    const modelsUrl = document.getElementById('configModelsUrl')?.value;
    if (!apiKey) { alert('请先填写 API 密钥'); return; }
    if (!apiUrl && !modelsUrl) { alert('请先填写 API 地址或模型列表 URL'); return; }
    const btn = document.getElementById('fetchModelsBtn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '获取中...'; btn.disabled = true; }
    try {
        const response = await fetch('/api/knowledge/models/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_url: apiUrl || '', api_key: apiKey, models_url: modelsUrl || '' })
        });
        const data = await response.json();
        if (data.success) {
            await saveModelsToProvider(providerId, data.models);
            loadModelSelectModels(providerId);
            renderModelsTable(providerId);
            if (window.knowledgePage && typeof window.knowledgePage.loadModels === 'function') {
                await window.knowledgePage.loadModels();
            }
            alert('成功获取并保存 ' + data.models.length + ' 个模型！');
        } else {
            alert('获取模型失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('获取模型失败：' + e.message);
    } finally {
        if (btn) { btn.textContent = originalText; btn.disabled = false; }
    }
}

export async function saveModelsToProvider(providerId, models) {
    if (!state.currentConfig.providers[providerId]) state.currentConfig.providers[providerId] = {};
    state.currentConfig.providers[providerId].models = models;
    try {
        await fetch('/api/knowledge/models/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider_id: providerId, models })
        });
    } catch (e) {
        console.error('保存模型失败', e);
    }
}

export async function saveModelsFromTable() {
    const providerId = getCurrentEditingProviderId();
    const tbody = document.getElementById('configModelsTbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    const newModels = [];
    const seenIds = new Set();
    rows.forEach(tr => {
        const idInput = tr.querySelector('input[data-field="id"]');
        const nameInput = tr.querySelector('input[data-field="name"]');
        const id = (idInput?.value || '').trim();
        const name = (nameInput?.value || '').trim();
        if (!id) return;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        newModels.push({ id, name: name || id, created: 0, owned_by: '' });
    });
    const btn = document.getElementById('saveModelsBtn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '保存中...'; btn.disabled = true; }
    try {
        const resp = await fetch('/api/knowledge/models/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider_id: providerId, models: newModels })
        });
        const data = await resp.json();
        if (data.success) {
            if (!state.currentConfig.providers[providerId]) state.currentConfig.providers[providerId] = {};
            state.currentConfig.providers[providerId].models = newModels;
            renderModelsTable(providerId);
            loadModelSelectModels(providerId);
            if (window.knowledgePage && typeof window.knowledgePage.loadModels === 'function') {
                await window.knowledgePage.loadModels();
            }
            alert('模型列表已保存（' + newModels.length + ' 个）');
        } else {
            alert('保存失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    } finally {
        if (btn) { btn.textContent = originalText || '保存模型列表'; btn.disabled = false; }
    }
}

export async function saveSettings() {
    const activeTab = document.querySelector('.provider-tab.active');
    const currentEditingProvider = activeTab ? activeTab.dataset.provider : (state.currentConfig.active_provider || 'open-ai');
    const providers = JSON.parse(JSON.stringify(state.currentConfig.providers || {}));
    const finalModel = document.getElementById('configDefaultModel')?.value || '';
    const modelsUrl = document.getElementById('configModelsUrl')?.value || '';
    if (!providers[currentEditingProvider]) providers[currentEditingProvider] = {};
    providers[currentEditingProvider] = {
        ...providers[currentEditingProvider],
        api_url: document.getElementById('configApiUrl')?.value || '',
        api_key: document.getElementById('configApiKey')?.value || '',
        models_url: modelsUrl,
        default_model: finalModel
    };
    try {
        const response = await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providers,
                active_provider: currentEditingProvider,
                set_initialized: true
            })
        });
        const data = await response.json();
        if (data.success) {
            state.currentConfig.active_provider = currentEditingProvider;
            state.currentConfig.providers = providers;
            state.currentConfig.initialized = true;
            appConfig.activeProvider = currentEditingProvider;
            if (providers[currentEditingProvider]) {
                const p = providers[currentEditingProvider];
                if (!appConfig.providers[currentEditingProvider]) appConfig.providers[currentEditingProvider] = {};
                Object.assign(appConfig.providers[currentEditingProvider], {
                    name: p.name || appConfig.providers[currentEditingProvider].name || '',
                    apiUrl: p.api_url || '',
                    apiKey: p.api_key || '',
                    defaultModel: p.default_model || ''
                });
                if (p.default_model) appConfig.currentModel = p.default_model;
            }
            saveAppConfig();
            updateModelDisplay();
            // 同步刷新 chat 页的模型列表与按钮文本（避免切换提供商/修改模型后聊天页仍显示旧模型）
            if (window.knowledgePage && typeof window.knowledgePage.loadModels === 'function') {
                try { await window.knowledgePage.loadModels(); } catch (e) { console.error('刷新知识库模型列表失败:', e); }
            }
            const modal = document.getElementById('modalSettings');
            if (modal) modal.classList.remove('show');
            alert('保存成功！');
        } else {
            alert('保存失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    }
}

// 测试当前编辑 provider 的模型连通性
export async function testConnection() {
    const btn = document.getElementById('testConnectionBtn');
    if (!btn) return;
    const activeTab = document.querySelector('.provider-tab.active');
    const providerId = activeTab ? activeTab.dataset.provider : (state.currentConfig.active_provider || 'open-ai');
    const model = document.getElementById('configDefaultModel')?.value || '';

    if (!model) {
        alert('请先选择默认模型再测试');
        return;
    }

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '测试中...';

    try {
        // 优先使用 KnowledgeAPI，缺少时回退到原生 fetch
        const api = window.KnowledgeAPI;
        const data = api && typeof api.testModel === 'function'
            ? await api.testModel(providerId, model)
            : await (await fetch('/api/model/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider_id: providerId, model })
            })).json();

        if (data && data.success) {
            alert(`✅ 连通成功！\n模型：${data.model || model}\n耗时：${data.latency_ms}ms`);
        } else {
            alert('❌ 连通失败：' + (data?.error || '未知错误'));
        }
    } catch (e) {
        alert('❌ 连通失败：' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}
