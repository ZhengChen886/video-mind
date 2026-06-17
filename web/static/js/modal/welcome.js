// ============================
// modal/welcome.js
// 职责：4 步初始化引导弹窗
// 从原 index.html 内联脚本中迁出
// 删除了原内联中重复定义的 updateModelDisplay（与 core/config.js 中的版本冲突）
// ============================
import { state } from '../core/state.js';
import { updateModelDisplay } from '../core/config.js';

let welcomeStep = 0;
const totalSteps = 4;

export async function checkInitialConfig() {
    try {
        const response = await fetch('/api/config/status');
        const data = await response.json();
        if (data.success && !data.initialized) {
            showWelcomeModal();
        }
    } catch (e) {
        console.error('Check initial config failed:', e);
    }
}

export function showWelcomeModal() {
    const modal = document.getElementById('modalWelcome');
    if (modal) modal.classList.add('show');
    welcomeStep = 1;
    renderWelcomeStep();
}

function setupFooterButtons() {
    const footer = document.getElementById('welcomeFooter');
    if (!footer) return;
    footer.querySelectorAll('button').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            if (action === 'next') nextWelcomeStep();
            else if (action === 'prev') prevWelcomeStep();
            else if (action === 'finish') finishWelcomeSetup();
            else if (action === 'skip') skipWelcomeSetup();
        };
    });
}

export function renderWelcomeStep() {
    const body = document.getElementById('welcomeBody');
    const footer = document.getElementById('welcomeFooter');
    if (!body || !footer) return;
    let bodyHtml = '';
    let footerHtml = '';

    let stepsHtml = '<div class="welcome-progress">';
    for (let i = 1; i <= totalSteps; i++) {
        let cls = '';
        if (i < welcomeStep) cls = 'completed';
        if (i === welcomeStep) cls = 'active';
        stepsHtml += `<div class="welcome-progress-dot ${cls}"></div>`;
    }
    stepsHtml += '</div>';

    switch (welcomeStep) {
        case 1:
            bodyHtml = `${stepsHtml}
                <div class="welcome-step">
                    <div class="welcome-step-icon">🎉</div>
                    <h2 class="welcome-step-title">欢迎使用 VideoMind</h2>
                    <p class="welcome-step-desc">这是一个强大的 AI 视频分析助手，让我们开始设置吧！</p>
                </div>`;
            footerHtml = `<button class="btn btn-secondary" data-action="skip">跳过</button>
                <button class="btn btn-primary" data-action="next">下一步</button>`;
            break;
        case 2:
            bodyHtml = `${stepsHtml}
                <div class="welcome-step">
                    <div class="welcome-step-icon">⚙️</div>
                    <h2 class="welcome-step-title">选择 API 提供商</h2>
                    <p class="welcome-step-desc">选择你想使用的 AI 服务提供商</p>
                    <div class="welcome-step-form">
                        <select id="welcomeProviderSelect" style="width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">
                            <option value="free-ai">Open AI (默认，已配置)</option>
                            <option value="openroute">OpenRoute</option>
                            <option value="nvidia">NVIDIA</option>
                        </select>
                    </div>
                </div>`;
            footerHtml = `<button class="btn btn-secondary" data-action="prev">上一步</button>
                <button class="btn btn-primary" data-action="next">下一步</button>`;
            break;
        case 3:
            bodyHtml = `${stepsHtml}
                <div class="welcome-step">
                    <div class="welcome-step-icon">🔑</div>
                    <h2 class="welcome-step-title">配置 API</h2>
                    <p class="welcome-step-desc">输入你的 API 地址和密钥</p>
                    <div class="welcome-step-form" style="text-align:left;">
                        <div style="margin-bottom:12px;">
                            <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">API 地址</label>
                            <input type="text" id="welcomeApiUrl" placeholder="https://api.example.com/v1" style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">
                        </div>
                        <div>
                            <label style="display:block;margin-bottom:6px;font-size:14px;font-weight:500;">API Key</label>
                            <input type="password" id="welcomeApiKey" placeholder="sk-..." style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">
                        </div>
                    </div>
                </div>`;
            footerHtml = `<button class="btn btn-secondary" data-action="prev">上一步</button>
                <button class="btn btn-primary" data-action="next">下一步</button>`;
            break;
        case 4:
            bodyHtml = `${stepsHtml}
                <div class="welcome-step">
                    <div class="welcome-step-icon">✨</div>
                    <h2 class="welcome-step-title">完成设置</h2>
                    <p class="welcome-step-desc">恭喜！你已完成基本设置，现在可以开始使用了。</p>
                </div>`;
            footerHtml = `<button class="btn btn-secondary" data-action="prev">上一步</button>
                <button class="btn btn-primary" data-action="finish">开始使用</button>`;
            break;
    }
    body.innerHTML = bodyHtml;
    footer.innerHTML = footerHtml;
    setupFooterButtons();

    if (welcomeStep === 3) {
        const providerSelect = document.getElementById('welcomeProviderSelect');
        const selectedProvider = providerSelect ? providerSelect.value : 'free-ai';
        const provider = state.currentConfig.providers[selectedProvider];
        if (provider) {
            const urlInput = document.getElementById('welcomeApiUrl');
            const keyInput = document.getElementById('welcomeApiKey');
            if (urlInput) urlInput.value = provider.api_url || '';
            if (keyInput) keyInput.value = provider.api_key || '';
        }
    }
}

export function nextWelcomeStep() {
    if (welcomeStep < totalSteps) {
        welcomeStep++;
        renderWelcomeStep();
    }
}

export function prevWelcomeStep() {
    if (welcomeStep > 1) {
        welcomeStep--;
        renderWelcomeStep();
    }
}

export async function finishWelcomeSetup() {
    const providerSelect = document.getElementById('welcomeProviderSelect');
    const selectedProvider = providerSelect ? providerSelect.value : 'free-ai';
    if (welcomeStep >= 3) {
        const urlInput = document.getElementById('welcomeApiUrl');
        const keyInput = document.getElementById('welcomeApiKey');
        if (urlInput && keyInput) {
            if (!state.currentConfig.providers[selectedProvider]) {
                state.currentConfig.providers[selectedProvider] = {};
            }
            state.currentConfig.providers[selectedProvider].api_url = urlInput.value;
            state.currentConfig.providers[selectedProvider].api_key = keyInput.value;
        }
    }
    state.currentConfig.active_provider = selectedProvider;
    try {
        await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providers: state.currentConfig.providers,
                active_provider: selectedProvider,
                set_initialized: true
            })
        });
    } catch (e) {
        console.error('Save config failed:', e);
    }
    state.currentConfig.initialized = true;
    const modal = document.getElementById('modalWelcome');
    if (modal) modal.classList.remove('show');
    updateModelDisplay();
}

export function skipWelcomeSetup() {
    const modal = document.getElementById('modalWelcome');
    if (modal) modal.classList.remove('show');
}
