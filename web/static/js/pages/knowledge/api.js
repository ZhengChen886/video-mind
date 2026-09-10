const API_BASE = '/api';

const KnowledgeAPI = {
    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const errMsg = (data && (data.error || data.message)) || `HTTP ${response.status}`;
                const error = new Error(errMsg);
                error.status = response.status;
                error.payload = data;
                throw error;
            }
            return data;
        } catch (error) {
            console.error('[KnowledgeAPI] 请求失败:', endpoint, error);
            throw error;
        }
    },

    async listFiles() {
        return this.request('/knowledge/files');
    },

    async getFile(path) {
        return this.request(`/knowledge/file/${encodeURIComponent(path)}`);
    },

    async uploadFile(file, targetFolder = null) {
        const formData = new FormData();
        formData.append('file', file);
        if (targetFolder) {
            formData.append('target_folder', targetFolder);
        }

        try {
            const response = await fetch(`${API_BASE}/knowledge/upload`, {
                method: 'POST',
                body: formData
            });
            return await response.json();
        } catch (error) {
            console.error('上传失败:', error);
            throw error;
        }
    },

    async saveFile(path, content) {
        return this.request('/knowledge/file/save', {
            method: 'POST',
            body: JSON.stringify({ path, content })
        });
    },

    async deleteFile(path) {
        return this.request(`/knowledge/file?path=${encodeURIComponent(path)}`, {
            method: 'DELETE'
        });
    },

    async indexDocument(docId, docPath) {
        return this.request('/knowledge/index', {
            method: 'POST',
            body: JSON.stringify({ doc_id: docId, doc_path: docPath })
        });
    },

    async getIndexStatus(docId) {
        return this.request(`/knowledge/index/status?doc_id=${encodeURIComponent(docId)}`);
    },

    // ========== RAG 多文件/文件夹知识库改造 ==========

    async scanFolder(path) {
        return this.request(`/knowledge/scan-folder?path=${encodeURIComponent(path)}`);
    },

    async batchIndex(items, force = false) {
        return this.request('/knowledge/index/batch', {
            method: 'POST',
            body: JSON.stringify({ items, force })
        });
    },

    async chatMulti(docIds, question, history = [], model = null, convId = null, useReranker = true) {
        const payload = {
            doc_ids: docIds,
            question,
            history,
            use_reranker: useReranker
        };
        if (model) {
            payload.model = model;
        }
        if (convId) {
            payload.conv_id = convId;
        }
        return this.request('/knowledge/chat/multi', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    async chatCollection(question, history = [], model = null, convId = null, useReranker = true) {
        const payload = {
            question,
            history,
            use_reranker: useReranker
        };
        if (model) {
            payload.model = model;
        }
        if (convId) {
            payload.conv_id = convId;
        }
        return this.request('/knowledge/chat/collection', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    async chat(docId, question, history = [], model = null, convId = null) {
        const payload = {
            doc_id: docId,
            question,
            history
        };
        if (model) {
            payload.model = model;
        }
        if (convId) {
            payload.conv_id = convId;
        }
        return this.request('/knowledge/chat', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    // ========== SSE 流式聊天（fetch + ReadableStream 解析） ==========

    /**
     * 发起 SSE 流式聊天请求
     * @param {string} endpoint 聊天端点（如 /knowledge/chat）
     * @param {object} payload 请求体
     * @param {Function} onEvent 事件回调 (event) => void
     * @returns {Promise<object>} { answer, convId, extra } 聚合结果
     */
    async streamChat(endpoint, payload, onEvent) {
        const response = await fetch(`${API_BASE}${endpoint}?stream=1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok || !response.body) {
            let detail = `HTTP ${response.status}`;
            try { const d = await response.json(); detail = (d && (d.error || d.message)) || detail; } catch (e) { /* ignore */ }
            throw new Error(detail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullAnswer = '';
        let convId = null;
        let extra = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (!raw) continue;
                    let event;
                    try { event = JSON.parse(raw); } catch (e) { console.warn('[SSE] 解析失败:', raw); continue; }
                    const type = event.type;
                    if (type === 'assistant') {
                        fullAnswer += event.content || '';
                    } else if (type === 'finish') {
                        fullAnswer = event.answer || fullAnswer;
                    } else if (type === 'done') {
                        convId = event.conv_id || null;
                        extra = event;
                    } else if (type === 'error') {
                        throw new Error(event.error || '流式请求失败');
                    }
                    if (typeof onEvent === 'function') onEvent(event);
                }
            }
        }
        return { answer: fullAnswer, convId, extra };
    },

    async chatStream(docId, question, history = [], model = null, convId = null, onEvent = null) {
        const payload = { doc_id: docId, question, history };
        if (model) payload.model = model;
        if (convId) payload.conv_id = convId;
        return this.streamChat('/knowledge/chat', payload, onEvent);
    },

    async chatMultiStream(docIds, question, history = [], model = null, convId = null, useReranker = true, onEvent = null) {
        const payload = { doc_ids: docIds, question, history, use_reranker: useReranker };
        if (model) payload.model = model;
        if (convId) payload.conv_id = convId;
        return this.streamChat('/knowledge/chat/multi', payload, onEvent);
    },

    async chatCollectionStream(question, history = [], model = null, convId = null, useReranker = true, onEvent = null) {
        const payload = { question, history, use_reranker: useReranker };
        if (model) payload.model = model;
        if (convId) payload.conv_id = convId;
        return this.streamChat('/knowledge/chat/collection', payload, onEvent);
    },

    async listConversations() {
        return this.request('/knowledge/conversations');
    },

    async getConversation(convId) {
        return this.request(`/knowledge/conversation/${convId}`);
    },

    async saveConversation(conversation) {
        return this.request('/knowledge/conversation/save', {
            method: 'POST',
            body: JSON.stringify(conversation)
        });
    },

    async deleteConversation(convId) {
        return this.request(`/knowledge/conversation/${convId}`, {
            method: 'DELETE'
        });
    },

    async renameConversation(convId, title) {
        return this.request('/knowledge/conversation/rename', {
            method: 'POST',
            body: JSON.stringify({ conv_id: convId, title })
        });
    },

    async newConversation(docId = null, docName = null) {
        const params = new URLSearchParams();
        if (docId) params.append('doc_id', docId);
        if (docName) params.append('doc_name', docName);
        return this.request(`/knowledge/conversation/new?${params}`, {
            method: 'POST'
        });
    },

    async listFavorites() {
        return this.request('/knowledge/favorites');
    },

    async addFavorite(content, question = '', document = '') {
        return this.request('/knowledge/favorites', {
            method: 'POST',
            body: JSON.stringify({ content, question, document })
        });
    },

    async deleteFavorite(favId) {
        return this.request(`/knowledge/favorites/${favId}`, {
            method: 'DELETE'
        });
    },

    async exportFavorites() {
        return this.request('/knowledge/favorites/export', {
            method: 'POST'
        });
    },

    // 文件夹操作 API
    async createFolder(folderName, parentPath = null) {
        return this.request('/knowledge/folders', {
            method: 'POST',
            body: JSON.stringify({ folder_name: folderName, parent_path: parentPath })
        });
    },

    async renameFolder(oldPath, newName) {
        return this.request('/knowledge/folders', {
            method: 'PUT',
            body: JSON.stringify({ old_path: oldPath, new_name: newName })
        });
    },

    async deleteFolder(folderPath) {
        return this.request('/knowledge/folders', {
            method: 'DELETE',
            body: JSON.stringify({ folder_path: folderPath })
        });
    },

    async moveFile(filePath, targetFolderPath) {
        return this.request('/knowledge/files/move', {
            method: 'POST',
            body: JSON.stringify({ file_path: filePath, target_folder_path: targetFolderPath })
        });
    },

    // TTS 相关 API
    async getTTSVoices() {
        return this.request('/knowledge/tts/voices');
    },

    async convertTextToSpeech(text, voice = 'zh-CN-XiaoxiaoNeural') {
        return this.request('/knowledge/tts/convert', {
            method: 'POST',
            body: JSON.stringify({ text, voice })
        });
    },

    // Tool Calling 相关 API
    async listTools() {
        return this.request('/knowledge/tools');
    },

    // 模型相关 API
    async getModels(providerId = null) {
        const url = providerId 
            ? `/knowledge/models?provider_id=${encodeURIComponent(providerId)}`
            : '/knowledge/models';
        return this.request(url);
    },

    async fetchModelsFromAPI(apiUrl, apiKey) {
        return this.request('/knowledge/models/fetch', {
            method: 'POST',
            body: JSON.stringify({ api_url: apiUrl, api_key: apiKey })
        });
    },

    async saveModels(providerId, models) {
        return this.request('/knowledge/models/save', {
            method: 'POST',
            body: JSON.stringify({ provider_id: providerId, models: models })
        });
    },

    // 测试模型连通性
    async testModel(providerId = null, model = null) {
        const payload = {};
        if (providerId) payload.provider_id = providerId;
        if (model) payload.model = model;
        return this.request('/model/test', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }
};

window.KnowledgeAPI = KnowledgeAPI;
