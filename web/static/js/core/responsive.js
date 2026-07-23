// ============================
// core/responsive.js
// 职责：移动端导航/抽屉/详情面板断点切换
//   - 顶部汉堡按钮 → 抽屉
//   - 详情面板在 ≤1023px 改 Bottom Sheet
//   - 知识库左侧栏在 ≤1023px 抽屉化
// ============================

const MOBILE_QUERY = '(max-width: 1023px)';
const PHONE_QUERY = '(max-width: 768px)';

/**
 * 顶部汉堡按钮：点击切换 body.nav-drawer-open
 * 抽屉内的 nav-link 跳转后自动关闭
 */
function setupHamburger() {
    const btn = document.getElementById('navHamburger');
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('navDrawer');
    if (!btn) return;

    const open = () => document.body.classList.add('nav-drawer-open');
    const close = () => document.body.classList.remove('nav-drawer-open');
    const toggle = () => {
        if (document.body.classList.contains('nav-drawer-open')) {
            close();
        } else {
            open();
        }
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    if (overlay) {
        overlay.addEventListener('click', close);
    }

    // 抽屉内 nav-link 点击后自动关闭（不影响全局 nav-link 行为）
    if (drawer) {
        drawer.querySelectorAll('[data-nav-drawer]').forEach((el) => {
            el.addEventListener('click', () => {
                // 等待 switchPage 完成再关
                setTimeout(close, 0);
            });
        });
    }

    // 路由切换时（pages 切换）也关掉
    document.addEventListener('click', (e) => {
        const link = e.target.closest('.nav-link');
        if (link && document.body.classList.contains('nav-drawer-open')) {
            setTimeout(close, 0);
        }
    });
}

/**
 * 详情面板断点适配：≤1023px 时挂 is-mobile-sheet 修饰类
 * CSS 据此把 fixed 右侧抽屉改为底部 Bottom Sheet
 */
function setupDetailPanelResponsive() {
    const panel = document.getElementById('detailPanel');
    if (!panel) return;

    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => {
        panel.classList.toggle('is-mobile-sheet', mq.matches);
    };
    apply();
    if (mq.addEventListener) {
        mq.addEventListener('change', apply);
    } else if (mq.addListener) {
        // 旧浏览器兼容
        mq.addListener(apply);
    }
}

/**
 * 知识库页：kbSidebarToggle 切换 .left-panels.is-mobile-open
 * 同步在文档预览面板上加 .is-mobile-open 控制右侧抽屉
 */
function setupKnowledgeDrawer() {
    const btn = document.getElementById('kbSidebarToggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const panel = document.querySelector('.left-panels');
        if (panel) panel.classList.toggle('is-mobile-open');
    });

    // 知识库内点击空白区域时自动收起（点击聊天区也算）
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 1023) return;
        const panel = document.querySelector('.left-panels');
        if (!panel || !panel.classList.contains('is-mobile-open')) return;
        if (e.target.closest('.left-panels')) return;
        if (e.target.closest('#kbSidebarToggle')) return;
        panel.classList.remove('is-mobile-open');
    });
}

/**
 * 视频页 sidebar 抽屉：仅在 phone 尺寸生效（≤768px）
 * 视频页 sidebar 与知识库侧栏共用 .is-mobile-open 修饰类
 */
function setupVideoSidebarDrawer() {
    const btn = document.getElementById('videoSidebarToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const sidebar = document.querySelector('.video-page-layout .sidebar');
        if (sidebar) sidebar.classList.toggle('is-mobile-open');
    });
    // 点击其他区域关闭
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 768) return;
        const sidebar = document.querySelector('.video-page-layout .sidebar');
        if (!sidebar || !sidebar.classList.contains('is-mobile-open')) return;
        if (e.target.closest('.video-page-layout .sidebar')) return;
        if (e.target.closest('#videoSidebarToggle')) return;
        sidebar.classList.remove('is-mobile-open');
    });
}

/**
 * 视频/音频详情面板：点遮罩外区域关闭（移动端 Bottom Sheet 用）
 */
function setupDetailPanelDismiss() {
    const panel = document.getElementById('detailPanel');
    if (!panel) return;
    // 已有 #closeDetail 关闭按钮；这里只处理点击面板外区域
    panel.addEventListener('click', (e) => {
        if (e.target === panel && window.matchMedia(MOBILE_QUERY).matches) {
            panel.classList.remove('show');
        }
    });
}

export function initResponsive() {
    setupHamburger();
    setupDetailPanelResponsive();
    setupDetailPanelDismiss();
    setupKnowledgeDrawer();
    setupVideoSidebarDrawer();
}
