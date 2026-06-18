// ============================
// app.js 入口
// 职责：仅作为 ES Modules 引导入口；DOMContentLoaded 内串行调用各 init*/bindEvents
// 实际逻辑分散在 core/、pages/、modal/ 各模块中
// ============================
import { bindEvents } from './core/events.js?v=20260618i';
import { loadAppConfig } from './core/config.js?v=20260618i';
import { initHome } from './pages/home.js?v=20260618i';
import { initUserMenu } from './modal/user_menu.js?v=20260618i';
import { initProfileModal } from './modal/profile.js?v=20260618i';
import { initAccessControl } from './modal/access_control.js?v=20260618i';
import { checkInitialConfig } from './modal/welcome.js?v=20260618i';
import { initKnowledgeApp } from './pages/knowledge/index.js?v=20260618n';
import { switchPage } from './pages/index-bridge.js?v=20260618i';
import {
    skipWelcomeSetup,
    nextWelcomeStep,
    prevWelcomeStep,
    finishWelcomeSetup
} from './modal/welcome.js?v=20260618i';
import { openSettingsModal } from './pages/settings.js?v=20260618i';
import { showBatchAnalyze } from './pages/home.js?v=20260618i';

// 暴露给 index.html 内联 onclick 使用
window.switchPage = switchPage;
window.openSettingsModal = openSettingsModal;
window.showBatchAnalyze = showBatchAnalyze;
window.skipWelcomeSetup = skipWelcomeSetup;
window.nextWelcomeStep = nextWelcomeStep;
window.prevWelcomeStep = prevWelcomeStep;
window.finishWelcomeSetup = finishWelcomeSetup;

document.addEventListener('DOMContentLoaded', () => {
    loadAppConfig();
    bindEvents();
    initHome();
    initUserMenu();
    initProfileModal();
    initAccessControl();
    checkInitialConfig();
    initKnowledgeApp();
});
