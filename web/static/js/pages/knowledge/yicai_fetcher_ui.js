// ============================
// pages/knowledge/yicai_fetcher_ui.js
// 职责：modalUrlUpload 顶部"第一财经日期获取"按钮
//      调用 POST /api/tools/yicai/fetch
//      将返回的 {name, url} 列表回填到 urlDownloadItems + urlUploadInput
// ============================
import { state } from '../../core/state.js';
import { renderUrlList } from '../upload.js';

async function fetchYicai() {
    const input = document.getElementById('yicaiDateInput');
    const btn = document.getElementById('btnYicaiFetch');
    if (!input || !btn) return;

    let date = (input.value || '').trim();
    if (!/^\d{4}$|^\d{8}$/.test(date)) {
        alert('日期格式错误，请输入 YYYYMMDD（如 20260724）或 MMDD（如 0723，将默认补本年）');
        return;
    }
    // 仅输入 MMDD 时，自动用当前年份补全为 YYYYMMDD
    if (date.length === 4) {
        const yyyy = new Date().getFullYear();
        date = `${yyyy}${date}`;
        input.value = date;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '获取中...';

    try {
        const resp = await fetch('/api/tools/yicai/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, columns: null }),
        });
        const data = await resp.json().catch(() => null);

        if (!data || !data.success) {
            const errMsg = (data && (data.error || data.stderr)) || `HTTP ${resp.status}`;
            alert('获取失败：' + errMsg);
            return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            alert(`${date} 未获取到任何视频链接（可能尚未发布）`);
            return;
        }

        // 1) 叠加写入 state（按 url 去重，保留已有项）
        const existing = Array.isArray(state.urlDownloadItems) ? state.urlDownloadItems : [];
        const existingUrls = new Set(existing.map(i => i.url));
        const newItems = items
            .filter(it => it.url && !existingUrls.has(it.url))
            .map(it => ({
                url: it.url,
                filename: it.name || (it.url.split('/').pop() || 'video.mp4'),
            }));
        state.urlDownloadItems = existing.concat(newItems);

        // 2) 同步 textarea（叠加，不覆盖）
        const textarea = document.getElementById('urlUploadInput');
        if (textarea) {
            const existingText = (textarea.value || '').trim();
            const newText = newItems.map(i => i.url).join('\n');
            textarea.value = existingText ? `${existingText}\n${newText}` : newText;
        }

        // 3) 显式渲染列表（避免依赖 input 事件触发时机）
        renderUrlList();

        // 4) 更新计数 / 启用确认按钮 / 显示容器
        const listContainer = document.getElementById('urlListContainer');
        if (listContainer) listContainer.style.display = 'block';
        const countSpan = document.getElementById('urlListCount');
        if (countSpan) countSpan.textContent = state.urlDownloadItems.length + '个';
        const confirmBtn = document.getElementById('confirmUrlUpload');
        if (confirmBtn) confirmBtn.disabled = false;

        console.log(`[yicai] 已填充 ${state.urlDownloadItems.length} 条链接`);
    } catch (err) {
        console.error('[yicai] 请求异常:', err);
        alert('请求异常：' + (err && err.message ? err.message : err));
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function init() {
    const btn = document.getElementById('btnYicaiFetch');
    if (btn) btn.addEventListener('click', fetchYicai);

    const input = document.getElementById('yicaiDateInput');
    if (input) {
        input.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                fetchYicai();
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
