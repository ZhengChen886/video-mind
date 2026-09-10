// ============================
// pages/knowledge/chat_steps.js
// 职责：在用户消息正下方展示多步骤进度条（索引/检索/重排序/思考）
// 设计：DOM-only，不写入 _state.messages；挂到 chat-messages 容器自身，
//      renderChatMessages 在重写 innerHTML 时会把 .chat-steps 保留并 append 回来。
// ============================

const STEP_DEFS = [
    { key: 'index',    label: '索引中' },
    { key: 'retrieve', label: '检索中' },
    { key: 'rerank',   label: '重排序中' },
    { key: 'think',    label: '思考中' }
];

const STATE_LABELS = {
    pending: '等待中',
    running: '进行中',
    done: '完成',
    failed: '失败'
};

let _state = null;

function setCtx({ state }) {
    _state = state;
}

function _container() {
    return document.getElementById('chat-messages');
}

function _messageNode(messageId) {
    const c = _container();
    if (!c) return null;
    return c.querySelector(`.chat-message[data-message-id="${messageId}"]`);
}

/**
 * 在 chat-messages 容器中、紧跟 user 消息节点之后插入步骤条。
 * 注意：append 到容器自身（不是 user 消息节点的子节点），否则会
 * 被 renderChatMessages 重写 innerHTML 时丢掉。
 */
function ensureStepContainer(messageId, opts = {}) {
    const c = _container();
    if (!c) return null;
    const msgNode = _messageNode(messageId);
    if (!msgNode) return null;

    // 已有则先移除（避免重复）
    const existing = c.querySelector(`.chat-steps[data-message-id="${messageId}"]`);
    if (existing) existing.remove();

    const showRerank = opts.showRerank !== false;
    const defs = STEP_DEFS.filter(d => showRerank || d.key !== 'rerank');

    const steps = document.createElement('div');
    steps.className = 'chat-steps';
    steps.dataset.messageId = String(messageId);
    steps.innerHTML = defs.map(d => `
        <div class="chat-step pending" data-step="${d.key}">
            <span class="chat-step-icon"></span>
            <span class="chat-step-label">${d.label}</span>
            <span class="chat-step-sub">${STATE_LABELS.pending}</span>
        </div>
    `).join('');

    // 紧跟 user 消息节点之后插入
    if (msgNode.nextSibling) {
        c.insertBefore(steps, msgNode.nextSibling);
    } else {
        c.appendChild(steps);
    }
    return steps;
}

function setStepState(messageId, stepKey, state, subText) {
    const c = _container();
    if (!c) return;
    const stepsRoot = c.querySelector(`.chat-steps[data-message-id="${messageId}"]`);
    if (!stepsRoot) return;
    const stepEl = stepsRoot.querySelector(`.chat-step[data-step="${stepKey}"]`);
    if (!stepEl) return;
    stepEl.classList.remove('pending', 'running', 'done', 'failed');
    stepEl.classList.add(state);
    const sub = stepEl.querySelector('.chat-step-sub');
    if (sub) {
        sub.textContent = subText || STATE_LABELS[state] || '';
    }
}

function removeStepContainer(messageId) {
    const c = _container();
    if (!c) return;
    const steps = c.querySelector(`.chat-steps[data-message-id="${messageId}"]`);
    if (steps) steps.remove();
}

export { setCtx as setChatStepsCtx, ensureStepContainer, setStepState, removeStepContainer };
