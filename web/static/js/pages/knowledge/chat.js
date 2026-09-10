// ============================
// pages/knowledge/chat.js
// 职责：知识库聊天（发送/接收消息、对话加载、模型选择）
// 内部仍依赖 KnowledgeAPI（来自 api.js）
// ============================
import { showToast } from '../../core/utils.js';
import * as ChatSteps from './chat_steps.js';

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

    const chatMode = _state.chatMode || 'single';
    const selectedDocs = _state.selectedDocs || [];

    // 模式校验
    if (chatMode === 'multi') {
        if (selectedDocs.length === 0) {
            showToast('多选模式下请先勾选至少一个文档', 'warning');
            return;
        }
    } else if (chatMode === 'collection') {
        // 全库问答无需选择文档
    } else if (!_state.currentDoc) {
        showToast('请先选择文档', 'warning');
        return;
    }

    const question = input.value.trim();
    input.value = '';
    const userMessageId = addMessage('user', question);

    // 在用户消息下方插入多步骤进度条（单文档路径不展示 rerank 步）
    ChatSteps.ensureStepContainer(userMessageId, { showRerank: chatMode !== 'single' });

    // assistant 占位消息 id（供 catch 分支更新错误信息）
    let assistantId = null;

    try {
        showTypingIndicator();
        const historyBeforeAdd = _state.messages.slice(0, -1);
        const currentConvId = _state.currentConversation?.id;
        const modelToUse = _state.selectedModel;

        // ---------- 索引中：多选模式自动 force 批量重索引 ----------
        if (chatMode === 'multi') {
            ChatSteps.setStepState(userMessageId, 'index', 'running');
            const items = selectedDocs.map(d => ({ path: d.path, type: 'file' }));
            try {
                const r = await _api.batchIndex(items, true); // force=true
                if (r && r.success) {
                    const d = r.data || {};
                    ChatSteps.setStepState(
                        userMessageId, 'index', 'done',
                        `成功 ${d.indexed_count ?? 0}，跳过 ${d.skipped_count ?? 0}，失败 ${d.failed_count ?? 0}`
                    );
                } else {
                    ChatSteps.setStepState(
                        userMessageId, 'index', 'failed',
                        (r && r.error) ? r.error : '批量索引返回失败'
                    );
                }
            } catch (e) {
                ChatSteps.setStepState(userMessageId, 'index', 'failed', e?.message || '索引异常');
            }
        } else {
            // 单文档 / 全库问答：跳过"索引中"步骤（单文档已有 reindex，全库不需要预索引）
            ChatSteps.setStepState(userMessageId, 'index', 'done', '无需索引');
        }

        // ---------- 检索中（SSE 流开始时由 retrieve 事件标记 done） ----------
        ChatSteps.setStepState(userMessageId, 'retrieve', 'running');

        // ---------- 思考中（流式生成开始） ----------
        ChatSteps.setStepState(userMessageId, 'think', 'running');
        hideTypingIndicator();

        // 创建 assistant 占位消息（流式渲染用）
        assistantId = addMessage('assistant', '');
        const chatContainer = document.getElementById('chat-messages');
        let msgEl = chatContainer
            ? chatContainer.querySelector(`[data-message-id="${assistantId}"]`)
            : null;
        let contentEl = msgEl ? msgEl.querySelector('.message-content') : null;
        let accumulated = '';
        let retrieveDone = false;

        // SSE 事件处理：流式渲染文本 + 工具调用卡片 + 步骤条状态
        const handleEvent = (event) => {
            const type = event.type;
            if (type === 'retrieve') {
                const srcCount = Array.isArray(event.sources) ? event.sources.length : 0;
                ChatSteps.setStepState(
                    userMessageId, 'retrieve', 'done',
                    srcCount > 0 ? `召回 ${srcCount} 段` : '未召回'
                );
                if (chatMode !== 'single') {
                    ChatSteps.setStepState(userMessageId, 'rerank', 'done', '精排完成');
                }
                retrieveDone = true;
            } else if (type === 'assistant') {
                accumulated += event.content || '';
                if (contentEl) {
                    contentEl.innerHTML = markdownToHtml(accumulated);
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            } else if (type === 'tool_call') {
                // 工具调用占位卡片
                if (msgEl) {
                    const card = document.createElement('div');
                    card.className = 'chat-tool-card';
                    card.dataset.toolId = event.id || '';
                    card.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0;padding:6px 10px;background:#f0f4ff;border:1px solid #d6e0f5;border-radius:6px;font-size:13px;color:#3a5a8c;';
                    card.innerHTML = `<span>🔧</span><span style="font-weight:600">${escapeHtml(event.name || '')}</span><span style="color:#888">执行中…</span>`;
                    msgEl.appendChild(card);
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            } else if (type === 'tool_response') {
                // 更新工具卡片结果
                if (msgEl) {
                    const cards = msgEl.querySelectorAll('.chat-tool-card');
                    for (const card of cards) {
                        if (card.dataset.toolId === (event.tool_call_id || '')) {
                            const statusEl = card.querySelector('span:last-child');
                            if (statusEl) {
                                let brief = event.output || '';
                                try {
                                    const parsed = JSON.parse(brief);
                                    brief = parsed.error || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
                                } catch (e) { /* 非 JSON，原样展示 */ }
                                statusEl.textContent = '✓ ' + String(brief).slice(0, 80);
                                statusEl.style.color = '#2e7d32';
                            }
                            break;
                        }
                    }
                }
            }
        };

        // ---------- SSE 流式请求（fetch + ReadableStream） ----------
        let result;
        if (chatMode === 'multi') {
            // 多文档问答（$in 一次检索 + Reranker 二次排序）
            result = await _api.chatMultiStream(
                selectedDocs.map(d => d.path),
                question,
                historyBeforeAdd.slice(-20),
                modelToUse,
                currentConvId,
                true,
                handleEvent
            );
        } else if (chatMode === 'collection') {
            // 全库问答
            result = await _api.chatCollectionStream(
                question,
                historyBeforeAdd.slice(-20),
                modelToUse,
                currentConvId,
                true,
                handleEvent
            );
        } else {
            // 单文档问答（原有逻辑）
            result = await _api.chatStream(
                _state.currentDoc.path,
                question,
                historyBeforeAdd.slice(-20),
                modelToUse,
                currentConvId,
                handleEvent
            );
        }

        // ---------- 流式完成：步骤条收尾 ----------
        ChatSteps.setStepState(userMessageId, 'think', 'done', '已生成回答');
        if (!retrieveDone) {
            const srcCount = Array.isArray(result.extra.sources) ? result.extra.sources.length : 0;
            ChatSteps.setStepState(
                userMessageId, 'retrieve', 'done',
                srcCount > 0 ? `召回 ${srcCount} 段` : '未召回'
            );
            if (chatMode !== 'single') {
                ChatSteps.setStepState(userMessageId, 'rerank', 'done', '精排完成');
            }
        }

        // 更新 state 中的 assistant 消息为完整回答，最终 markdown 渲染（保留工具卡片 DOM）
        const finalAnswer = result.answer || '';
        const lastMsg = (_state.messages || []).find(m => m._id === assistantId);
        if (lastMsg) lastMsg.content = finalAnswer;
        if (contentEl) contentEl.innerHTML = markdownToHtml(finalAnswer);

        const data = result.extra || {};
        // 提示用户上下文已被截断，数据可能不完整
        if (data.truncated) {
            showToast('知识库数据量过大，部分上下文已被截断，回答可能不完整', 'warning');
        }

        // 来源文档标注（多文档/全库问答时展示，不写入消息数组）
        const sources = data.sources;
        if (Array.isArray(sources) && sources.length > 0 && chatMode !== 'single') {
            const sourceNames = [...new Set(sources.map(s => {
                const docId = s?.metadata?.doc_id || '';
                return docId.split(/[\\/]/).pop() || docId;
            }).filter(Boolean))];
            if (sourceNames.length > 0) {
                appendSourceBar(sourceNames);
            }
        }
        if (result.convId && (!_state.currentConversation || _state.currentConversation.id !== result.convId)) {
            const convResponse = await _api.getConversation(result.convId);
            if (convResponse.success && convResponse.data) {
                _state.currentConversation = convResponse.data;
            }
        }
        const { loadConversations } = await import('./sidebar.js');
        await loadConversations();

        // 给用户 1.5 秒看清步骤条"全部 ✓"再淡出
        setTimeout(() => ChatSteps.removeStepContainer(userMessageId), 1500);
    } catch (error) {
        hideTypingIndicator();
        ChatSteps.setStepState(userMessageId, 'think', 'failed', error?.message || '请求失败');
        if (assistantId) {
            // 更新占位消息为错误信息（避免出现空消息）
            const lastMsg = (_state.messages || []).find(m => m._id === assistantId);
            if (lastMsg) lastMsg.content = `请求失败: ${error.message}`;
            renderChatMessages();
        } else {
            addMessage('assistant', `请求失败: ${error.message}`);
        }
        setTimeout(() => ChatSteps.removeStepContainer(userMessageId), 1500);
    }
}

export function addMessage(role, content) {
    if (!_state) return;
    if (!Array.isArray(_state.messages)) _state.messages = [];
    const messageId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _state.messages.push({ role, content, _id: messageId });
    renderChatMessages();
    return messageId;
}

export function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    if (!_state) return;
    // 保留外部步骤条（多步骤进度条）—— renderChatMessages 重写 innerHTML 时不能丢
    const preservedSteps = Array.from(container.querySelectorAll(':scope > .chat-steps'));
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
        html += `<div class="chat-message ${msg.role}" data-content="${escapeHtml(msg.content)}" data-index="${index}"${msg._id ? ` data-message-id="${escapeHtml(msg._id)}"` : ''}>`;
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
    // 把保留的步骤条 append 回去
    preservedSteps.forEach(s => container.appendChild(s));
    container.scrollTop = container.scrollHeight;
}

// 来源标注条：直接渲染到聊天区末尾（不写入 _state.messages）
function appendSourceBar(sourceNames) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const bar = document.createElement('div');
    bar.className = 'chat-source-bar';
    bar.innerHTML = `📄 参考来源：${sourceNames.map(escapeHtml).join('、')}`;
    container.appendChild(bar);
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
                const rawDocId = response.data.doc_id;
                // 全库问答对话：恢复 collection 模式，不加载单文档
                if (rawDocId === '__collection__') {
                    _state.chatMode = 'collection';
                    _state.multiSelectMode = false;
                    _state.selectedDocs = [];
                    const { updateMultiDocBar } = await import('./multi_doc.js');
                    updateMultiDocBar();
                } else if (typeof rawDocId === 'string' && rawDocId.trim().startsWith('[')) {
                    // 多文档对话（doc_id 为 JSON 数组字符串）：恢复 multi 模式与已选列表
                    try {
                        const docIds = JSON.parse(rawDocId);
                        if (Array.isArray(docIds) && docIds.length > 0) {
                            _state.chatMode = 'multi';
                            _state.multiSelectMode = true;
                            _state.selectedDocs = docIds.map(p => ({
                                path: p,
                                name: String(p).split(/[\\/]/).pop() || p
                            }));
                            const { updateMultiDocBar } = await import('./multi_doc.js');
                            updateMultiDocBar();
                            const { renderFileList } = await import('./sidebar.js');
                            renderFileList();
                        }
                    } catch (e) {
                        console.warn('[loadConversation] 多文档 doc_id 解析失败，忽略:', e);
                    }
                } else {
                    console.log('[loadConversation] 加载关联文档:', rawDocId);
                    try {
                        const { selectDocument } = await import('./doc_preview.js');
                        await selectDocument(rawDocId);
                    } catch (e) {
                        console.error('[loadConversation] selectDocument 失败:', e, e?.stack || '');
                        // selectDocument 自身有 try/catch 一般不会冒泡，这里兜底
                        showToast('加载关联文档失败：' + (e?.message || e), 'error');
                    }
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
