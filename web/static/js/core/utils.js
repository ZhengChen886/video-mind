// ============================
// core/utils.js
// 职责：通用工具函数（防抖、Markdown 转换、文件大小、HTML 转义）
// ============================

// 防抖
export function debounce(func, wait) {
    let timeout;
    return function() {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// 简易 Markdown 转 HTML（兜底实现，主路径仍走 marked.parse）
export function simpleMarkdownToHtml(text) {
    if (!text) return '';
    let str = String(text);
    let html = str
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^- (.*$)/gim, '<li>$1</li>')
        .replace(/\n/g, '<br>');

    if (html.includes('<li>')) {
        html = html.replace(/(<li>.*?<\/li>)+/g, function(match) {
            return '<ul>' + match.replace(/<\/li><li>/g, '</li><li>') + '</ul>';
        });
    }
    return html;
}

// 字节数转可读字符串
export function formatFileSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// 文本转义为 HTML 实体
export function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// 属性值转义（用于 HTML 属性值）
export function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 全局 Toast 提示
export function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
