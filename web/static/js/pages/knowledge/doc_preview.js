// ============================
// pages/knowledge/doc_preview.js
// 职责：知识库文档预览（renderDocumentPreview / selectDocument / reindexDocument）
// ============================
import { showToast } from '../../core/utils.js';

let _api = null;
let _state = null;

function setCtx({ api, state }) { _api = api; _state = state; }

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function markdownToHtml(text) {
    if (!text) return '';
    try {
        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(text);
        }
        return text
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    } catch (e) {
        return text.replace(/\n/g, '<br>');
    }
}

export function renderDocumentPreview(doc) {
    const titleEl = document.getElementById('doc-title');
    const contentEl = document.getElementById('doc-content');
    if (titleEl) titleEl.textContent = doc.name || '文档预览';
    if (contentEl) contentEl.innerHTML = markdownToHtml(doc.content || '');
}

export async function selectDocument(filePath) {
    // 早退保护：_state / _api 未注入时直接拒绝
    if (!_state || !_api) {
        console.error('[selectDocument] _state / _api 未初始化，跳过');
        showToast('加载文档失败：知识库未初始化，请刷新页面', 'error');
        return;
    }
    try {
        if (_state.ttsIsPlaying || _state.ttsIsPaused) {
            const { stopTTS } = await import('./tts.js');
            stopTTS();
            showToast('已停止当前音频播放', 'info');
        }
        _state.isLoading = true;
        const response = await _api.getFile(filePath);
        if (response.success) {
            _state.currentDoc = response.data;
            renderDocumentPreview(response.data);
            await checkIndexStatus(filePath);
            const { loadFiles, renderFileList } = await import('./sidebar.js');
            await loadFiles();
            const docConversations = (_state.conversations || []).filter(
                conv => conv.doc_id === filePath
            );
            const { loadConversation, renderChatMessages } = await import('./chat.js');
            if (docConversations.length > 0) {
                const latestConv = docConversations[0];
                await loadConversation(latestConv.id, false);
            } else {
                _state.currentConversation = null;
                _state.messages = [];
                renderChatMessages();
            }
            const { renderConversationList } = await import('./sidebar.js');
            renderConversationList();
        }
    } catch (error) {
        showToast('加载文档失败', 'error');
    } finally {
        _state.isLoading = false;
    }
}

export async function checkIndexStatus(docId) {
    try {
        const response = await _api.getIndexStatus(docId);
        const statusEl = document.getElementById('index-status');
        if (response.success) {
            const { is_indexed, chunk_count } = response.data;
            _state.indexStatus = is_indexed ? 'indexed' : 'not_indexed';
            if (statusEl) {
                statusEl.textContent = is_indexed ? `已索引 (${chunk_count} 块)` : '未索引';
            }
        }
    } catch (error) {
        console.error('检查索引状态失败:', error);
    }
}

export async function reindexDocument() {
    if (!_state.currentDoc) return;
    try {
        _state.isLoading = true;
        const statusEl = document.getElementById('index-status');
        if (statusEl) statusEl.textContent = '索引中...';
        const response = await _api.indexDocument(
            _state.currentDoc.path,
            _state.currentDoc.path
        );
        if (response.success) {
            showToast('索引成功', 'success');
            await checkIndexStatus(_state.currentDoc.path);
        } else {
            showToast(response.error || '索引失败', 'error');
        }
    } catch (error) {
        showToast('索引失败', 'error');
    } finally {
        _state.isLoading = false;
    }
}

export { setCtx as setDocPreviewCtx };
