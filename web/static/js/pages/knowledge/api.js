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
            return await response.json();
        } catch (error) {
            console.error('API 请求失败:', error);
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
    }
};

window.KnowledgeAPI = KnowledgeAPI;
