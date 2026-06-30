// ============================
// pages/knowledge/chat.js
// 职责：知识库聊天（发送/接收消息、对话加载、模型选择）
// 内部仍依赖 KnowledgeAPI（来自 api.js）
// ============================
import { showToast } from '../../core/utils.js';

let _api = null;
let _state = null;
let _ctx = {};

function setCtx({ api, state, ctx }) { _api = api; _state = state; _ctx = ctx || {}; }

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function markdownToHtml(text) {
    if (!text) return '';
    try {
        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(text);
        }
        return text
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    } catch (e) {
        console.error('Markdown parse error:', e);
        return text.replace(/\n/g, '<br>');
    }
}

export async function sendMessage() {
    const input = document.getElementById('chat-input');
    if (!input || !input.value.trim()) return;
    if (!_state.currentDoc) {
        showToast('请先选择文档', 'warning');
        return;
    }
    const question = input.value.trim();
    input.value = '';
    addMessage('user', question);
    try {
        showTypingIndicator();
        const historyBeforeAdd = _state.messages.slice(0, -1);
        const currentConvId = _state.currentConversation?.id;
        const modelToUse = _state.selectedModel;
        const response = await _api.chat(
            _state.currentDoc.path,
            question,
            historyBeforeAdd.slice(-20),
            modelToUse,
            currentConvId
        );
        hideTypingIndicator();
        if (response.success) {
            addMessage('assistant', response.data.answer);
            if (response.data.conv_id && (!_state.currentConversation || _state.currentConversation.id !== response.data.conv_id)) {
                const convResponse = await _api.getConversation(response.data.conv_id);
                if (convResponse.success && convResponse.data) {
                    _state.currentConversation = convResponse.data;
                }
            }
            const { loadConversations } = await import('./sidebar.js');
            await loadConversations();
        } else {
            addMessage('assistant', `错误: ${response.error}`);
        }
    } catch (error) {
        hideTypingIndicator();
        addMessage('assistant', `请求失败: ${error.message}`);
    }
}

export function addMessage(role, content) {
    if (!_state) return;
    if (!Array.isArray(_state.messages)) _state.messages = [];
    _state.messages.push({ role, content });
    renderChatMessages();
}

export function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    if (!_state) return;
    const messages = Array.isArray(_state.messages) ? _state.messages : [];
    if (messages.length === 0) {
        container.innerHTML = `<div class="empty-hint">${_state.currentDoc ? '开始提问吧！' : '请先在左侧选择一个文档'}</div>`;
        return;
    }
    let html = '';
    messages.forEach((msg, index) => {
        let contentHtml;
        let contentClass;
        if (msg.role === 'assistant') {
            contentHtml = markdownToHtml(msg.content);
            contentClass = 'message-content markdown-body';
        } else {
            contentHtml = escapeHtml(msg.content);
            contentClass = 'message-content';
        }
        html += `<div class="chat-message ${msg.role}" data-content="${escapeHtml(msg.content)}" data-index="${index}">`;
        if (msg.role === 'assistant') {
            html += `<div class="message-actions">
                    <button class="btn-favorite" title="收藏">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                        </svg>
                    </button>
                </div>`;
        }
        html += `<div class="${contentClass}">${contentHtml}</div>`;
        if (msg.role === 'assistant') {
            const isCurrentlyPlaying = _state.ttsIsPlaying && _state.ttsPlayingIndex === index;
            const isPaused = _state.ttsIsPaused && _state.ttsPlayingIndex === index;
            html += `<div class="message-tts-controls">
                        <button class="btn-icon btn-tts-message-play" data-message-index="${index}" title="播放" style="${isCurrentlyPlaying ? 'display:none' : 'inline-flex'}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                        </button>
                        <button class="btn-icon btn-tts-message-pause" data-message-index="${index}" title="暂停" style="${(isCurrentlyPlaying && !isPaused) ? 'inline-flex' : 'display:none'}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="6" y="4" width="4" height="16"/>
                                <rect x="14" y="4" width="4" height="16"/>
                            </svg>
                        </button>
                        <button class="btn-icon btn-tts-message-stop" data-message-index="${index}" title="停止">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18"/>
                            </svg>
                        </button>
                    </div>`;
        }
        html += '</div>';
    });
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

export function showTypingIndicator() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const indicator = document.createElement('div');
    indicator.className = 'chat-message assistant typing';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = '<div class="message-content"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
}

export function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
}

export async function loadModels() {
    try {
        const response = await _api.getModels();
        if (response.success) {
            _state.availableModels = response.models || [];
            renderModelSelect();
        }
    } catch (error) {
        console.error('加载模型列表失败:', error);
    }
}

export function renderModelSelect() {
    const menu = document.getElementById('chat-model-menu');
    if (!menu) return;
    const models = _state.availableModels || [];
    let html = `
        <div class="chat-model-menu-item ${!_state.selectedModel ? 'active' : ''}" data-model-id="">
            <div>
                <div class="chat-model-menu-title">使用默认模型</div>
                <div class="chat-model-menu-desc">使用当前激活提供商的默认模型</div>
            </div>
            ${!_state.selectedModel ? '<svg class="chat-model-menu-check" viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>`;
    if (models.length === 0) {
        html += `<div class="chat-model-menu-empty">暂无可用模型，请到设置中获取</div>`;
    } else {
        models.forEach(model => {
            const isActive = _state.selectedModel === model.id;
            const desc = model.owned_by ? `提供方：${model.owned_by}` : '点击切换至该模型';
            html += `
                <div class="chat-model-menu-item ${isActive ? 'active' : ''}" data-model-id="${escapeHtml(model.id)}">
                    <div>
                        <div class="chat-model-menu-title">${escapeHtml(model.name || model.id)}</div>
                        <div class="chat-model-menu-desc">${escapeHtml(desc)}</div>
                    </div>
                    ${isActive ? '<svg class="chat-model-menu-check" viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                </div>`;
        });
    }
    menu.innerHTML = html;
    updateModelButtonText();
}

export function updateModelButtonText() {
    const textEl = document.getElementById('chat-model-button-text');
    if (!textEl) return;
    if (!_state.selectedModel) {
        textEl.textContent = '使用默认模型';
        return;
    }
    const model = (_state.availableModels || []).find(m => m.id === _state.selectedModel);
    if (model && (model.name || model.id)) {
        textEl.textContent = model.name || model.id;
    } else {
        // 选中的模型在当前列表里找不到（被删除/切换提供商），回退到默认模型显示
        _state.selectedModel = null;
        textEl.textContent = '使用默认模型';
    }
}

export async function loadConversation(convId, autoLoadDoc = true) {
    console.log('[loadConversation] 开始加载对话:', convId);
    // 早退保护：若 _state 未注入（init() 未跑 / 模块未 setCtx），直接失败，
    // 避免后续 _state.currentConversation 抛 TypeError 后被栈定位到 catch 行
    if (!_state || !_api) {
        console.error('[loadConversation] _state / _api 未初始化，跳过');
        showToast('加载对话失败：知识库未初始化，请刷新页面', 'error');
        return;
    }
    try {
        const response = await _api.getConversation(convId);
        console.log('[loadConversation] API 响应:', response);
        if (response && response.success) {
            try {
                _state.currentConversation = response.data;
                _state.messages = (response.data && response.data.messages) || [];
            } catch (e) {
                console.error('[loadConversation] 写入 state 失败:', e);
            }
            try { renderChatMessages(); } catch (e) { console.error('[loadConversation] renderChatMessages 失败:', e); }
            try {
                // 动态 import 必须带版本号，否则浏览器复用旧版缓存
                const { renderConversationList } = await import('./sidebar.js');
                renderConversationList();
            } catch (e) {
                console.error('[loadConversation] renderConversationList 失败:', e);
            }
            if (autoLoadDoc && response.data && response.data.doc_id) {
                console.log('[loadConversation] 加载关联文档:', response.data.doc_id);
                try {
                    const { selectDocument } = await import('./doc_preview.js');
                    await selectDocument(response.data.doc_id);
                } catch (e) {
                    console.error('[loadConversation] selectDocument 失败:', e, e?.stack || '');
                    // selectDocument 自身有 try/catch 一般不会冒泡，这里兜底
                    showToast('加载关联文档失败：' + (e?.message || e), 'error');
                }
            }
        } else {
            console.error('[loadConversation] API 返回失败:', response);
            showToast('加载对话失败：' + ((response && response.error) || '未知错误'), 'error');
        }
    } catch (error) {
        // 兜底：捕获 try 块顶层异常，附完整 stack 便于定位
        console.error('[loadConversation] 异常:', error, error && error.stack ? error.stack : '(no stack)');
        showToast('加载对话失败：' + (error?.message || error), 'error');
    }
}

// 一键测试当前选中的模型连通性
export async function testCurrentModel() {
    const btn = document.getElementById('btn-test-current-model');
    if (!btn) return;
    const modelToTest = _state.selectedModel || null;
    if (!modelToTest) {
        // 默认模型场景：先检查当前激活 provider 是否配置了默认模型
        if (window.knowledgeApp && window.knowledgeApp.config) {
            const cfg = window.knowledgeApp.config;
            const provider = cfg.providers && cfg.providers[cfg.active_provider];
            if (!provider || !provider.default_model) {
                showToast('当前未选择模型，且未配置默认模型', 'warning');
                return;
            }
        }
    }

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '测试中...';

    try {
        const data = await _api.testModel(null, modelToTest);
        if (data && data.success) {
            showToast(`✅ 连通成功（${data.latency_ms}ms）`, 'success');
        } else {
            showToast('❌ 连通失败：' + (data?.error || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('❌ 连通失败：' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

export async function newConversation() {
    try {
        const response = await _api.newConversation(
            _state.currentDoc?.path,
            _state.currentDoc?.name
        );
        if (response.success) {
            _state.currentConversation = response.data;
            _state.messages = [];
            renderChatMessages();
            const { loadConversations } = await import('./sidebar.js');
            await loadConversations();
        }
    } catch (error) {
        showToast('创建对话失败', 'error');
    }
}

export { setCtx as setChatCtx };
