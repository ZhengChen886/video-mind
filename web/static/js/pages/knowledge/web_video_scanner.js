(function() {
  if (window.__CONTENT_DOWNLOADER_LOADED__) return;
  window.__CONTENT_DOWNLOADER_LOADED__ = true;

  const PANEL_ID = '__content_downloader_panel__';
  const BTN_ID = '__content_downloader_btn__';

  function createStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #${BTN_ID} {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        width: 48px; height: 48px; border-radius: 50%; border: none;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: #fff; font-size: 20px; cursor: pointer;
        box-shadow: 0 4px 15px rgba(102,126,234,0.4);
        transition: transform 0.2s, box-shadow 0.2s;
        display: flex; align-items: center; justify-content: center;
      }
      #${BTN_ID}:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(102,126,234,0.6);
      }
      #${PANEL_ID} {
        position: fixed; bottom: 84px; right: 24px; z-index: 2147483647;
        width: 400px; max-height: 520px; border-radius: 16px;
        background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); overflow: hidden;
        display: none; flex-direction: column;
        border: 1px solid rgba(255,255,255,0.1);
      }
      #${PANEL_ID}.open { display: flex; }
      .cd-header {
        padding: 16px 20px; font-size: 16px; font-weight: 600;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: #fff; display: flex; justify-content: space-between; align-items: center;
      }
      .cd-close { cursor: pointer; font-size: 20px; opacity: 0.8; }
      .cd-close:hover { opacity: 1; }
      .cd-tabs {
        display: flex; border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .cd-tab {
        flex: 1; padding: 10px; text-align: center; cursor: pointer;
        font-size: 13px; color: #aaa; transition: all 0.2s;
        border-bottom: 2px solid transparent;
      }
      .cd-tab.active { color: #667eea; border-bottom-color: #667eea; }
      .cd-tab:hover { color: #ddd; }
      .cd-body {
        flex: 1; overflow-y: auto; padding: 12px;
        max-height: 400px;
      }
      .cd-body::-webkit-scrollbar { width: 4px; }
      .cd-body::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
      .cd-video-item {
        background: rgba(255,255,255,0.05); border-radius: 10px;
        padding: 12px; margin-bottom: 10px; transition: background 0.2s;
      }
      .cd-video-item:hover { background: rgba(255,255,255,0.1); }
      .cd-video-label {
        font-size: 12px; color: #888; margin-bottom: 6px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .cd-video-url {
        font-size: 11px; color: #667eea; margin-bottom: 8px;
        word-break: break-all; max-height: 40px; overflow: hidden;
      }
      .cd-dl-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 14px; border-radius: 6px; border: none;
        background: #667eea; color: #fff; font-size: 12px;
        cursor: pointer; transition: background 0.2s;
      }
      .cd-dl-btn:hover { background: #5a6fd6; }
      .cd-dl-btn.copy { background: #48bb78; }
      .cd-dl-btn.copy:hover { background: #38a169; }
      .cd-text-preview {
        background: rgba(255,255,255,0.05); border-radius: 10px;
        padding: 14px; font-size: 13px; line-height: 1.7;
        max-height: 280px; overflow-y: auto; white-space: pre-wrap;
        word-break: break-all; color: #ccc;
      }
      .cd-text-actions { margin-top: 12px; display: flex; gap: 8px; }
      .cd-empty {
        text-align: center; padding: 40px 20px; color: #666; font-size: 14px;
      }
      .cd-empty-icon { font-size: 40px; margin-bottom: 10px; }
      .cd-scan-btn {
        margin: 10px 0; padding: 8px 16px; border-radius: 8px; border: none;
        background: rgba(102,126,234,0.2); color: #667eea; font-size: 13px;
        cursor: pointer; width: 100%; transition: background 0.2s;
      }
      .cd-scan-btn:hover { background: rgba(102,126,234,0.35); }
    `;
    document.head.appendChild(style);
  }

  function scanVideos() {
    const videos = [];
    const seen = new Set();

    document.querySelectorAll('video').forEach(v => {
      const src = v.currentSrc || v.src;
      if (src && !seen.has(src)) {
        seen.add(src);
        videos.push({ type: 'video', src, label: 'HTML5 Video' });
      }
      v.querySelectorAll('source').forEach(s => {
        const src2 = s.src;
        if (src2 && !seen.has(src2)) {
          seen.add(src2);
          const label = s.getAttribute('label') || s.type || 'Source';
          videos.push({ type: 'video', src: src2, label });
        }
      });
    });

    document.querySelectorAll('iframe').forEach(iframe => {
      const src = iframe.src || '';
      if (src && /video|player|embed|bilibili|youtube|v\.qq|ixigua|douyin/.test(src) && !seen.has(src)) {
        seen.add(src);
        videos.push({ type: 'iframe', src, label: 'Embedded Player' });
      }
    });

    const performanceEntries = performance.getEntriesByType('resource');
    performanceEntries.forEach(entry => {
      const url = entry.name;
      if (/\.(mp4|webm|ogg|m3u8|flv|mov)(\?|$)/i.test(url) && !seen.has(url)) {
        seen.add(url);
        videos.push({ type: 'media', src: url, label: 'Network Media' });
      }
    });

    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (/\.(mp4|webm|ogg|m3u8|flv|mov)(\?|$)/i.test(href) && !seen.has(href)) {
        seen.add(href);
        videos.push({ type: 'link', src: href, label: 'Video Link' });
      }
    });

    return videos;
  }

  function extractText() {
    const selectors = ['article', 'main', '.post-content', '.article-content', '.content', '.entry-content'];
    let container = null;
    for (const sel of selectors) {
      container = document.querySelector(sel);
      if (container) break;
    }
    if (!container) container = document.body;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'nav', 'footer', 'header'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.textContent.trim();
        return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const lines = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (text) lines.push(text);
    }
    return lines.join('\n');
  }

  function downloadFile(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制到剪贴板');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('已复制到剪贴板');
    });
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    downloadFile(url, filename || 'page-text.txt');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; padding: 10px 24px; border-radius: 8px;
      background: #48bb78; color: #fff; font-size: 14px;
      font-family: -apple-system, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: cdFadeIn 0.3s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function renderVideoList() {
    const body = document.querySelector(`#${PANEL_ID} .cd-body`);
    const videos = scanVideos();
    if (videos.length === 0) {
      body.innerHTML = `
        <div class="cd-empty">
          <div class="cd-empty-icon">🎬</div>
          <div>未检测到视频资源</div>
          <div style="font-size:12px;margin-top:6px;color:#555">尝试播放视频后再次扫描</div>
        </div>
        <button class="cd-scan-btn" id="__cd_rescan__">🔄 重新扫描</button>
      `;
      document.getElementById('__cd_rescan__')?.addEventListener('click', renderVideoList);
      return;
    }
    body.innerHTML = `
      <div style="font-size:12px;color:#888;margin-bottom:8px">检测到 ${videos.length} 个视频资源</div>
      ${videos.map((v, i) => `
        <div class="cd-video-item">
          <div class="cd-video-label">${escHtml(v.label)} #${i + 1}</div>
          <div class="cd-video-url">${escHtml(v.src)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${v.type !== 'iframe' ? `<button class="cd-dl-btn" data-action="download" data-url="${escAttr(v.src)}" data-index="${i}">⬇ 下载</button>` : ''}
            <button class="cd-dl-btn copy" data-action="copy" data-url="${escAttr(v.src)}">📋 复制链接</button>
            <button class="cd-dl-btn" data-action="open" data-url="${escAttr(v.src)}" style="background:#4a5568">🔗 新标签打开</button>
          </div>
        </div>
      `).join('')}
      <button class="cd-scan-btn" id="__cd_rescan__">🔄 重新扫描</button>
    `;
    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const url = btn.dataset.url;
        const idx = btn.dataset.index;
        if (action === 'download') downloadFile(url, `video-${parseInt(idx) + 1}.mp4`);
        else if (action === 'copy') copyText(url);
        else if (action === 'open') window.open(url, '_blank');
      });
    });
    document.getElementById('__cd_rescan__')?.addEventListener('click', renderVideoList);
  }

  function renderTextContent() {
    const body = document.querySelector(`#${PANEL_ID} .cd-body`);
    const text = extractText();
    if (!text.trim()) {
      body.innerHTML = `
        <div class="cd-empty">
          <div class="cd-empty-icon">📝</div>
          <div>未提取到文本内容</div>
        </div>
      `;
      return;
    }
    const charCount = text.length;
    const preview = text.substring(0, 3000);
    body.innerHTML = `
      <div style="font-size:12px;color:#888;margin-bottom:10px">提取到 ${charCount} 个字符</div>
      <div class="cd-text-preview">${escHtml(preview)}${charCount > 3000 ? '\n\n... (内容过长，下载查看完整文本)' : ''}</div>
      <div class="cd-text-actions">
        <button class="cd-dl-btn" id="__cd_text_dl__">⬇ 下载文本</button>
        <button class="cd-dl-btn copy" id="__cd_text_copy__">📋 复制全文</button>
      </div>
    `;
    document.getElementById('__cd_text_dl__')?.addEventListener('click', () => {
      const title = document.title.replace(/[\\/:*?"<>|]/g, '_') || 'page';
      downloadTextFile(text, `${title}.txt`);
    });
    document.getElementById('__cd_text_copy__')?.addEventListener('click', () => copyText(text));
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function createUI() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerHTML = '⬇';
    btn.title = '网页内容下载器';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="cd-header">
        <span>📥 网页内容下载器</span>
        <span class="cd-close" id="__cd_close__">✕</span>
      </div>
      <div class="cd-tabs">
        <div class="cd-tab active" data-tab="video">🎬 视频</div>
        <div class="cd-tab" data-tab="text">📝 文本</div>
      </div>
      <div class="cd-body"></div>
    `;
    document.body.appendChild(panel);

    btn.addEventListener('click', () => {
      const isOpen = panel.classList.toggle('open');
      if (isOpen) renderVideoList();
    });

    document.getElementById('__cd_close__')?.addEventListener('click', () => {
      panel.classList.remove('open');
    });

    panel.querySelectorAll('.cd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.cd-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.tab === 'video') renderVideoList();
        else renderTextContent();
      });
    });
  }

  function init() {
    if (document.getElementById(BTN_ID)) return;
    createStyles();
    createUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();