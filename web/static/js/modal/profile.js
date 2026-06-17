// ============================
// modal/profile.js
// 职责：个人中心弹窗（init/open/close/update）
// 从原 index.html 内联脚本中迁出
// ============================
import { state } from '../core/state.js';

export function initProfileModal() {
    const closeProfileBtn = document.getElementById('closeProfile');
    if (closeProfileBtn) {
        closeProfileBtn.addEventListener('click', function() {
            const modal = document.getElementById('modalProfile');
            if (modal) modal.classList.remove('show');
        });
    }
}

export function openProfileModal() {
    const modal = document.getElementById('modalProfile');
    if (modal) modal.classList.add('show');
    updateProfileDisplay();
}

// 优先使用 appConfig.providers（用户偏好），缺省回退到 state.currentConfig
export function updateProfileDisplay() {
    const cfg = state.currentConfig;
    let provider = null;
    let providerName = '';
    let modelName = '';
    if (cfg && cfg.providers && cfg.active_provider) {
        provider = cfg.providers[cfg.active_provider];
        providerName = provider?.name || '未设置';
        modelName = provider?.default_model || '未设置';
    }
    const profileProvider = document.getElementById('profileProvider');
    const profileModel = document.getElementById('profileModel');
    const profileStatus = document.getElementById('profileStatus');
    if (profileProvider) profileProvider.textContent = providerName;
    if (profileModel) profileModel.textContent = modelName;
    if (profileStatus) profileStatus.textContent = (cfg && cfg.initialized) ? '已配置' : '未配置';
}
