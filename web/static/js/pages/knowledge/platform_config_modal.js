// ============================
// pages/knowledge/platform_config_modal.js
// 职责：平台 Cookie 配置 + 使用方法 弹窗
//   - 点击 #btnPlatformConfig 打开 #modalPlatformConfig
//   - 打开时按当前 select 选中的平台拉 Cookie 状态 + 写标题
//   - 切换 tab：Cookie 配置 / 使用方法
//   - 保存 / 清空 Cookie
//   - 顶部"← 返回"和"×"关闭按钮
//   - 使用方法文案作为前端常量（按平台分写）
// ============================

// 使用方法文案（分平台）。后端无对应端点，文案与代码同源便于维护。
const USAGE_DOCS = {
    bilibili: `
        <h4 style="margin:0 0 8px;color:#1a202c;">B 站 Cookie 获取步骤</h4>
        <ol style="padding-left:20px;margin:0 0 16px;">
            <li>浏览器登录 <a href="https://www.bilibili.com" target="_blank" rel="noopener">bilibili.com</a></li>
            <li>按 F12 打开开发者工具 → 切换到 <b>Network</b> 标签</li>
            <li>刷新页面，任意点开一个请求</li>
            <li>在 <b>Request Headers</b> 中找到 <code>cookie</code> 字段，复制完整值</li>
        </ol>
        <h4 style="margin:0 0 8px;color:#1a202c;">支持的视频类型</h4>
        <ul style="padding-left:20px;margin:0 0 16px;">
            <li>BV 号（如 <code>BV1a6K36TEyW</code>）</li>
            <li>视频页 URL（如 <code>https://www.bilibili.com/video/BV1xx/</code>）</li>
            <li>支持同时返回视频流和音频流两条直链</li>
        </ul>
        <h4 style="margin:0 0 8px;color:#1a202c;">注意事项</h4>
        <ul style="padding-left:20px;margin:0;">
            <li>会员视频 / 付费视频需要登录 Cookie</li>
            <li>Cookie 包含登录态，请勿泄露</li>
        </ul>
    `,
    douyin: `
        <h4 style="margin:0 0 8px;color:#1a202c;">抖音 Cookie 获取步骤</h4>
        <ol style="padding-left:20px;margin:0 0 16px;">
            <li>浏览器登录 <a href="https://www.douyin.com" target="_blank" rel="noopener">douyin.com</a></li>
            <li>按 F12 打开开发者工具 → 切换到 <b>Application</b> 标签</li>
            <li>左侧展开 <b>Cookies</b> → 选择 <code>https://www.douyin.com</code></li>
            <li>全选所有 Cookie 项，按 <code>name1=value1; name2=value2;</code> 格式拼接</li>
        </ol>
        <h4 style="margin:0 0 8px;color:#1a202c;">支持的链接类型</h4>
        <ul style="padding-left:20px;margin:0 0 16px;">
            <li>抖音分享短链（<code>https://v.douyin.com/xxx</code>）</li>
            <li>视频页完整 URL</li>
        </ul>
        <h4 style="margin:0 0 8px;color:#1a202c;">注意事项</h4>
        <ul style="padding-left:20px;margin:0;">
            <li>部分视频有地区限制，配置 Cookie 可提高成功率</li>
            <li>Cookie 失效后请重新获取</li>
        </ul>
    `,
};

let CURRENT_PLATFORM = null;     // 当前打开弹窗时的平台 id（bilibili/douyin）
let CURRENT_PLATFORMS = [];      // 缓存平台元数据，含 display_name

async function fetchPlatformsMeta() {
    if (CURRENT_PLATFORMS.length > 0) return CURRENT_PLATFORMS;
    try {
        const r = await fetch('/api/tools/platforms');
        const data = await r.json();
        if (data?.success) CURRENT_PLATFORMS = data.platforms || [];
    } catch (e) {
        console.error('[platform-config] 拉平台列表失败:', e);
    }
    return CURRENT_PLATFORMS;
}

function getCurrentPlatformId() {
    const sel = document.getElementById('platformSelect');
    return sel ? sel.value : null;
}

function getDisplayName(platformId) {
    const meta = CURRENT_PLATFORMS.find(p => p.id === platformId);
    return meta ? meta.display_name : platformId;
}

function showModal() {
    const modal = document.getElementById('modalPlatformConfig');
    if (modal) modal.classList.add('show');
}

function hideModal() {
    const modal = document.getElementById('modalPlatformConfig');
    if (modal) modal.classList.remove('show');
}

function setActiveTab(tabName) {
    document.querySelectorAll('.config-tab').forEach(btn => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle('btn-primary', isActive);
        btn.classList.toggle('btn-secondary', !isActive);
    });
    document.querySelectorAll('.config-panel').forEach(panel => {
        panel.style.display = (panel.dataset.panel === tabName) ? '' : 'none';
    });
}

function renderStatus(data) {
    const status = document.getElementById('cookieStatus');
    if (!status) return;
    if (!data?.configured) {
        status.innerHTML = '<b style="color:#a0aec0;">○ 未配置</b> &nbsp; <span style="color:#718096;">该平台将无法访问需要登录的视频</span>';
        status.style.background = '#f7fafc';
        return;
    }
    const preview = (data.preview || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    status.innerHTML = `<b style="color:#38a169;">● 已配置</b> &nbsp; 长度 <code>${data.length}</code> &nbsp; 预览 <code>${preview}…</code>`;
    status.style.background = '#f0fff4';
}

async function loadCookieStatus(platformId) {
    const status = document.getElementById('cookieStatus');
    const ta = document.getElementById('cookieInput');
    if (status) status.textContent = '加载中…';
    if (ta) ta.value = '';
    try {
        const r = await fetch(`/api/tools/cookie/${encodeURIComponent(platformId)}`);
        const data = await r.json();
        if (!data?.success) {
            if (status) status.textContent = '加载失败：' + (data?.error || `HTTP ${r.status}`);
            return;
        }
        renderStatus(data);
    } catch (e) {
        if (status) status.textContent = '加载异常：' + (e?.message || e);
    }
}

async function openConfigModal() {
    const platformId = getCurrentPlatformId();
    if (!platformId) {
        alert('请先选择平台');
        return;
    }
    await fetchPlatformsMeta();
    CURRENT_PLATFORM = platformId;

    // 标题
    const title = document.getElementById('platformConfigTitle');
    if (title) title.textContent = `${getDisplayName(platformId)} 配置`;

    // 渲染使用方法
    const usage = document.getElementById('usageContent');
    if (usage) usage.innerHTML = USAGE_DOCS[platformId] || '<p style="color:#a0aec0;">暂无该平台的使用说明</p>';

    // 默认切到 cookie tab
    setActiveTab('cookie');
    await loadCookieStatus(platformId);
    showModal();
}

async function saveCookie() {
    if (!CURRENT_PLATFORM) return;
    const ta = document.getElementById('cookieInput');
    const value = (ta?.value || '').trim();
    if (!value) { alert('Cookie 不能为空'); return; }
    try {
        const r = await fetch(`/api/tools/cookie/${encodeURIComponent(CURRENT_PLATFORM)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: value }),
        });
        const data = await r.json();
        if (!data?.success) {
            alert('保存失败：' + (data?.error || `HTTP ${r.status}`));
            return;
        }
        alert(`已保存（长度 ${data.length}）。\n提示：新配置将在下次启动服务时生效。`);
        // 派发 Cookie 状态变化事件，通知「获取链接」按钮解禁
        document.dispatchEvent(new CustomEvent('platform-cookie-changed', {
            detail: { platform: CURRENT_PLATFORM, configured: true, length: data.length }
        }));
        await loadCookieStatus(CURRENT_PLATFORM);
        // 清空 textarea（避免本地留明文）
        if (ta) ta.value = '';
    } catch (e) {
        alert('保存异常：' + (e?.message || e));
    }
}

async function clearCookie() {
    if (!CURRENT_PLATFORM) return;
    if (!confirm(`确定要清空「${getDisplayName(CURRENT_PLATFORM)}」的 Cookie 吗？`)) return;
    try {
        const r = await fetch(`/api/tools/cookie/${encodeURIComponent(CURRENT_PLATFORM)}`, {
            method: 'DELETE',
        });
        const data = await r.json();
        if (!data?.success) {
            alert('清空失败：' + (data?.error || `HTTP ${r.status}`));
            return;
        }
        // 派发 Cookie 状态变化事件，通知「获取链接」按钮禁用
        document.dispatchEvent(new CustomEvent('platform-cookie-changed', {
            detail: { platform: CURRENT_PLATFORM, configured: false }
        }));
        await loadCookieStatus(CURRENT_PLATFORM);
    } catch (e) {
        alert('清空异常：' + (e?.message || e));
    }
}

function init() {
    // 打开弹窗按钮
    const openBtn = document.getElementById('btnPlatformConfig');
    if (openBtn) openBtn.addEventListener('click', openConfigModal);

    // 返回按钮 + 关闭按钮
    const backBtn = document.getElementById('btnConfigBack');
    if (backBtn) backBtn.addEventListener('click', hideModal);
    const modal = document.getElementById('modalPlatformConfig');
    if (modal) {
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', hideModal);
        // 点击遮罩层关闭
        modal.addEventListener('click', e => {
            if (e.target === modal) hideModal();
        });
    }

    // tab 切换
    document.querySelectorAll('.config-tab').forEach(btn => {
        btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });

    // 保存/清空
    const saveBtn = document.getElementById('btnSaveCookie');
    if (saveBtn) saveBtn.addEventListener('click', saveCookie);
    const clearBtn = document.getElementById('btnClearCookie');
    if (clearBtn) clearBtn.addEventListener('click', clearCookie);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
