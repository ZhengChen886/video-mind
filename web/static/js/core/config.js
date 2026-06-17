// ============================
// core/config.js
// 职责：API_BASE_URL 常量、appConfig 配置对象、loadAppConfig/saveAppConfig/updateModelDisplay
// 所有跨模块共享的配置相关函数和变量集中在此
// ============================

// API 基础地址
export const API_BASE_URL = 'http://localhost:8000';

// 应用配置（active provider / providers / current model）
export const appConfig = {
    activeProvider: 'open-ai',
    providers: {
        'open-ai': { name: 'Open AI', apiUrl: '', defaultModel: '' },
        'openroute': { name: 'OpenRoute', apiUrl: '', apiKey: '', defaultModel: '' },
        'nvidia': { name: 'NVIDIA', apiUrl: '', apiKey: '', defaultModel: '' }
    },
    currentModel: ''
};

// 从 localStorage 加载配置
export function loadAppConfig() {
    const saved = localStorage.getItem('appConfig');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            Object.assign(appConfig, parsed);
            // 合并 providers（避免 localStorage 缺失某些 provider 时丢失默认值）
            if (parsed.providers) {
                Object.keys(parsed.providers).forEach(key => {
                    if (appConfig.providers[key]) {
                        Object.assign(appConfig.providers[key], parsed.providers[key]);
                    } else {
                        appConfig.providers[key] = parsed.providers[key];
                    }
                });
            }
        } catch (e) {
            console.error('加载配置失败:', e);
        }
    }
    updateModelDisplay();
}

// 保存配置到 localStorage
export function saveAppConfig() {
    localStorage.setItem('appConfig', JSON.stringify(appConfig));
}

// 更新顶部 / 侧栏显示的当前模型与提供商名称
export function updateModelDisplay() {
    const modelNameEl = document.getElementById('currentModelName');
    const providerNameEl = document.getElementById('currentProviderName');
    if (modelNameEl) modelNameEl.textContent = appConfig.currentModel;
    if (providerNameEl) {
        const active = appConfig.providers[appConfig.activeProvider];
        providerNameEl.textContent = active ? active.name : '';
    }
}
