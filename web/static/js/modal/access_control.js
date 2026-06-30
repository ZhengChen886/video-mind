// ============================
// modal/access_control.js
// 职责：访问控制：未配置 API 时拦截 videos/knowledge 页面跳转
// 从原 index.html 内联脚本中迁出
// ============================
import { state } from '../core/state.js';
import { getConfigStatus } from '../core/api.js';

export function initAccessControl() {
    document.querySelectorAll('[data-page]').forEach(btn => {
        const page = btn.dataset.page;
        if (page === 'videos' || page === 'knowledge') {
            btn.addEventListener('click', async function(e) {
                if (!await checkApiConfig()) {
                    e.preventDefault();
                    e.stopPropagation();
                    showAccessDeniedModal();
                    return false;
                }
            });
        }
    });
    const goToSettings = document.getElementById('goToSettings');
    if (goToSettings) {
        goToSettings.addEventListener('click', function() {
            const modal = document.getElementById('modalAccessDenied');
            if (modal) modal.classList.remove('show');
            import('../pages/settings.js').then(m => m.openSettingsModal());
        });
    }
    const cancelAccessDenied = document.getElementById('cancelAccessDenied');
    if (cancelAccessDenied) {
        cancelAccessDenied.addEventListener('click', function() {
            const modal = document.getElementById('modalAccessDenied');
            if (modal) modal.classList.remove('show');
        });
    }
}

export async function checkApiConfig() {
    try {
        const data = await getConfigStatus();
        if (data && data.success) {
            state.currentConfig.initialized = data.initialized;
            return data.api_configured;
        }
    } catch (e) {
        console.error('Check config failed:', e);
    }
    return false;
}

export function showAccessDeniedModal() {
    const modal = document.getElementById('modalAccessDenied');
    if (modal) modal.classList.add('show');
}
