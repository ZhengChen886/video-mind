// ============================
// pages/knowledge/platform_fetcher_ui.js
// 职责：modalUrlUpload 顶部多平台获取控件
//      启动时 GET /api/tools/platforms 拉下拉项
//      切换平台时同步 input 的 placeholder/pattern/maxlength
//      需要 Cookie 的平台，未配置时禁用「获取链接」并提示
//      点击「获取链接」POST /api/tools/fetch {platform, params:{input}}
//      回填到 urlDownloadItems + urlUploadInput（叠加去重）
//      同时把用户输入的原始平台页 URL 存入 state.urlSourceUrl，
//      提交下载时由 upload.js 作为 source_url 发送（B站链接触发后端抓字幕）
// ============================
import { state } from '../../core/state.js';
import { renderUrlList } from '../upload.js';

let PLATFORMS = [];   // [{id, display_name, input_pattern, input_placeholder, input_maxlength, needs_cookie}]

async function loadPlatforms() {
    const sel = document.getElementById('platformSelect');
    const inp = document.getElementById('platformInput');
    if (!sel || !inp) return;
    try {
        const r = await fetch('/api/tools/platforms');
        const data = await r.json();
        if (!data?.success) throw new Error(data?.error || '加载平台失败');
        PLATFORMS = data.platforms;
        sel.innerHTML = PLATFORMS.map(p =>
            `<option value="${p.id}">${p.display_name}</option>`
        ).join('');
        if (PLATFORMS.length > 0) applyPlatformSpec(PLATFORMS[0]);
    } catch (e) {
        console.error('[platform-fetcher] 加载平台列表失败:', e);
        if (inp) inp.placeholder = '平台列表加载失败';
    }
}

function applyPlatformSpec(spec) {
    const inp = document.getElementById('platformInput');
    if (!inp || !spec) return;
    inp.placeholder = spec.input_placeholder;
    inp.maxLength = spec.input_maxlength;
    inp.dataset.pattern = spec.input_pattern;
    inp.value = '';
    inp.focus();
    // 控制"⚙ 配置"按钮显隐：仅 needs_cookie=true 的平台（bilibili/douyin）显示
    const cfgBtn = document.getElementById('btnPlatformConfig');
    if (cfgBtn) {
        cfgBtn.style.display = spec.needs_cookie ? '' : 'none';
    }
    // 刷新"获取链接"按钮状态（异步，不阻塞）
    refreshFetchButtonState(spec.id);
}

async function refreshFetchButtonState(platformId) {
    const btn = document.getElementById('btnPlatformFetch');
    if (!btn) return;
    const spec = PLATFORMS.find(p => p.id === platformId);
    // 不需要 cookie 的平台：直接启用
    if (!spec || !spec.needs_cookie) {
        btn.disabled = false;
        btn.title = '获取视频直链';
        return;
    }
    // 需要 cookie：查后端状态
    try {
        const r = await fetch(`/api/tools/cookie/${encodeURIComponent(platformId)}`);
        const data = await r.json();
        if (data?.configured) {
            btn.disabled = false;
            btn.title = `已配置 Cookie（长度 ${data.length}）`;
        } else {
            btn.disabled = true;
            btn.title = `该平台需要先配置 Cookie，请点击「⚙ 配置」按钮`;
        }
    } catch (e) {
        // 网络异常时不禁用，避免误伤
        btn.disabled = false;
        btn.title = 'Cookie 状态查询失败，可重试';
        console.warn('[platform-fetcher] 查 Cookie 状态失败:', e);
    }
}

function validate(spec, value) {
    if (!spec) return '请先选择平台';
    const re = new RegExp(spec.input_pattern);
    if (!re.test(value)) return `输入格式错误：${spec.input_placeholder}`;
    return null;
}

async function fetchPlatform() {
    const sel = document.getElementById('platformSelect');
    const inp = document.getElementById('platformInput');
    const btn = document.getElementById('btnPlatformFetch');
    if (!sel || !inp || !btn) return;

    const spec = PLATFORMS.find(p => p.id === sel.value);
    let value = inp.value.trim();
    const err = validate(spec, value);
    if (err) { alert(err); return; }

    // yicai 特殊：4 位 MMDD → 自动补本年
    if (spec.id === 'yicai' && value.length === 4) {
        value = `${new Date().getFullYear()}${value}`;
        inp.value = value;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '获取中...';
    try {
        const resp = await fetch('/api/tools/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: spec.id, params: { input: value } }),
        });
        const data = await resp.json().catch(() => null);
        if (!data || !data.success) {
            const errMsg = (data && (data.error || data.stderr)) || `HTTP ${resp.status}`;
            alert('获取失败：' + errMsg);
            return;
        }
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) { alert(`${spec.display_name} ${value} 未获取到任何链接`); return; }

        // 叠加写入 state（去重）
        const existing = Array.isArray(state.urlDownloadItems) ? state.urlDownloadItems : [];
        const existingUrls = new Set(existing.map(i => i.url));
        const newItems = items
            .filter(it => it.url && !existingUrls.has(it.url))
            .map(it => ({ url: it.url, filename: it.name || (it.url.split('/').pop() || 'video.mp4') }));
        state.urlDownloadItems = existing.concat(newItems);
        // 记录用户输入的原始平台页 URL，提交下载时作为 source_url 发送（B站链接会触发后端抓字幕）
        state.urlSourceUrl = value;

        // 同步 textarea
        const textarea = document.getElementById('urlUploadInput');
        if (textarea) {
            const oldText = (textarea.value || '').trim();
            const newText = newItems.map(i => i.url).join('\n');
            textarea.value = oldText ? `${oldText}\n${newText}` : newText;
        }

        renderUrlList();
        const listContainer = document.getElementById('urlListContainer');
        if (listContainer) listContainer.style.display = 'block';
        const countSpan = document.getElementById('urlListCount');
        if (countSpan) countSpan.textContent = state.urlDownloadItems.length + '个';
        const confirmBtn = document.getElementById('confirmUrlUpload');
        if (confirmBtn) confirmBtn.disabled = false;

        console.log(`[${spec.id}] 已填充 ${newItems.length} 条链接（共 ${state.urlDownloadItems.length}）`);
    } catch (e) {
        console.error('[platform-fetcher] 请求异常:', e);
        alert('请求异常：' + (e?.message || e));
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function init() {
    loadPlatforms();
    const sel = document.getElementById('platformSelect');
    if (sel) sel.addEventListener('change', () => {
        const spec = PLATFORMS.find(p => p.id === sel.value);
        applyPlatformSpec(spec);
    });
    const btn = document.getElementById('btnPlatformFetch');
    if (btn) btn.addEventListener('click', fetchPlatform);
    const inp = document.getElementById('platformInput');
    if (inp) inp.addEventListener('keypress', e => { if (e.key === 'Enter') { e.preventDefault(); fetchPlatform(); } });

    // 监听 Cookie 状态变化事件（由 platform_config_modal.js 派发）
    document.addEventListener('platform-cookie-changed', (e) => {
        const selNow = document.getElementById('platformSelect');
        if (selNow && e.detail?.platform === selNow.value) {
            // 当前选中的平台 Cookie 状态变化，刷新按钮
            refreshFetchButtonState(selNow.value);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
