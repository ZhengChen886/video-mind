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

    const date = (input.value || '').trim();
    if (!/^\d{4}$/.test(date)) {
        alert('日期格式错误，请输入 4 位数字 MMDD，如 0723');
        return;
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

        // 1) 写入 state（保持 url + filename 结构）
        state.urlDownloadItems = items.map(it => ({
            url: it.url,
            filename: it.name || (it.url.split('/').pop() || 'video.mp4'),
        }));

        // 2) 同步 textarea（让现有 input 监听也能识别）
        const textarea = document.getElementById('urlUploadInput');
        if (textarea) {
            textarea.value = state.urlDownloadItems.map(i => i.url).join('\n');
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
