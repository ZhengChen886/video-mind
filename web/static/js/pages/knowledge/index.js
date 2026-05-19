const KnowledgeApp = {
    state: {
        currentDoc: null,
        currentConversation: null,
        conversations: [],
        messages: [],
        favorites: [],
        indexStatus: 'idle',
        isLoading: false,
        expandedFolders: new Set(), // 展开的文件夹集合
        searchQuery: '', // 搜索关键词
        sidebarCollapsed: false // 侧边栏状态
    },

    api: null,

    init() {
        this.api = window.KnowledgeAPI;
        this.bindEvents();
        this.loadInitialData();
        
        // 默认展开左侧边栏
        this.toggleLeftSidebar(true);
        // 右侧文档预览默认收起
        this.toggleDocPreview(false);
        // 收藏区域默认收起
        const favSection = document.getElementById('sidebar-favorites-section');
        if (favSection) favSection.classList.add('collapsed');
    },

    bindEvents() {
        document.addEventListener('click', (e) => {
            if (e.target.closest('#btn-upload-doc')) {
                this.triggerFileUpload();
            }
            // 文件夹展开/收起
            if (e.target.closest('.folder-toggle')) {
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                this.toggleFolder(folderPath);
            }
            // 文件夹创建
            if (e.target.closest('.create-folder-btn')) {
                this.showCreateFolderDialog();
            }
            // 文件夹操作按钮 - 重命名/删除
            if (e.target.closest('.folder-rename-btn')) {
                e.stopPropagation();
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                const folderName = folderEl.dataset.name;
                this.showRenameFolderDialog(folderPath, folderName);
            }
            if (e.target.closest('.folder-delete-btn')) {
                e.stopPropagation();
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                const folderName = folderEl.dataset.name;
                this.confirmDeleteFolder(folderPath, folderName);
            }
            // 文件点击
            if (e.target.closest('.file-item')) {
                const filePath = e.target.closest('.file-item').dataset.path;
                this.selectDocument(filePath);
            }
            if (e.target.closest('#btn-new-chat')) {
                this.newConversation();
            }
            if (e.target.closest('#btn-send')) {
                this.sendMessage();
            }
            if (e.target.closest('#btn-reindex')) {
                this.reindexDocument();
            }
            // 点击对话项时排除操作按钮
            if (e.target.closest('.conversation-item') && !e.target.closest('.conv-actions')) {
                const convId = e.target.closest('.conversation-item').dataset.id;
                this.loadConversation(convId);
            }
            if (e.target.closest('.conv-rename-btn')) {
                e.stopPropagation();
                const convId = e.target.closest('.conv-rename-btn').dataset.id;
                this.showRenameDialog(convId);
            }
            if (e.target.closest('.conv-delete-btn')) {
                e.stopPropagation();
                const convId = e.target.closest('.conv-delete-btn').dataset.id;
                this.deleteConversation(convId);
            }
            if (e.target.closest('.btn-favorite')) {
                const content = e.target.closest('.chat-message').dataset.content;
                this.toggleFavorite(e.target.closest('.btn-favorite'), content);
            }
            if (e.target.closest('#btn-export-favorites')) {
                this.exportFavorites();
            }
            if (e.target.closest('#btn-toggle-favorites')) {
                this.toggleFavoritesSection();
            }
            if (e.target.closest('.favorite-item')) {
                const favId = e.target.closest('.favorite-item').dataset.id;
                this.showFavoriteDetail(favId);
            }
            if (e.target.closest('.btn-delete-favorite')) {
                const favId = e.target.closest('.btn-delete-favorite').dataset.id;
                this.deleteFavorite(favId);
            }
            if (e.target.closest('#btn-collapse-left')) {
                this.toggleLeftSidebar(false);
            }
            if (e.target.closest('#btn-expand-left')) {
                this.toggleLeftSidebar(true);
            }
            if (e.target.closest('#btn-collapse-right')) {
                this.toggleDocPreview(false);
            }
            if (e.target.closest('#btn-expand-right')) {
                this.toggleDocPreview(true);
            }
            // 重命名对话框按钮
            if (e.target.closest('#cancelRenameConv')) {
                this.closeRenameDialog();
            }
            if (e.target.closest('#confirmRenameConv')) {
                this.confirmRename();
            }
            // 文件夹对话框按钮
            if (e.target.closest('#cancelCreateFolder')) {
                this.closeCreateFolderDialog();
            }
            if (e.target.closest('#confirmCreateFolder')) {
                this.confirmCreateFolder();
            }
            if (e.target.closest('#cancelRenameFolder')) {
                this.closeRenameFolderDialog();
            }
            if (e.target.closest('#confirmRenameFolder')) {
                this.confirmRenameFolder();
            }
        });

        // 搜索框事件
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.state.searchQuery = e.target.value.toLowerCase();
                this.loadFiles();
            });
        }

        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
        }

        const fileInput = document.getElementById('file-upload-input');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.uploadFiles(e.target.files);
                }
            });
        }
    },

    async loadInitialData() {
        await Promise.all([
            this.loadFiles(),
            this.loadConversations(),
            this.loadFavorites()
        ]);
    },

    async loadFiles() {
        try {
            const response = await this.api.listFiles();
            if (response.success) {
                // 保存原始文件树
                this.state.fileTree = response.data;
                this.renderFileList();
            }
        } catch (error) {
            console.error('加载文件列表失败:', error);
        }
    },

    // 递归渲染文件树
    renderFileList() {
        const container = document.getElementById('knowledge-file-list');
        if (!container) return;

        if (!this.state.fileTree || this.state.fileTree.length === 0) {
            container.innerHTML = '<div class="empty-hint">暂无文档，上传一个开始使用</div>';
            return;
        }

        // 根据搜索关键词过滤
        const filteredTree = this.filterFileTree(this.state.fileTree, this.state.searchQuery);
        
        container.innerHTML = this.renderFileTreeItems(filteredTree, 0);
    },

    // 过滤文件树
    filterFileTree(items, query) {
        if (!query) return items;
        
        return items.filter(item => {
            if (item.type === 'folder') {
                // 文件夹：检查自身名称或子项是否匹配
                const childrenMatch = item.children && this.filterFileTree(item.children, query).length > 0;
                const nameMatch = item.name.toLowerCase().includes(query);
                if (nameMatch || childrenMatch) {
                    // 如果匹配或子项匹配，保留并递归过滤子项
                    return {
                        ...item,
                        children: item.children ? this.filterFileTree(item.children, query) : []
                    };
                }
                return false;
            } else {
                // 文件：检查名称
                return item.name.toLowerCase().includes(query);
            }
        }).filter(Boolean); // 移除false值
    },

    // 递归渲染文件树项
    renderFileTreeItems(items, depth) {
        return items.map(item => {
            if (item.type === 'folder') {
                const isExpanded = this.state.expandedFolders.has(item.path);
                const hasChildren = item.children && item.children.length > 0;
                const indentStyle = `padding-left: ${depth * 16}px`;
                
                return `
                    <div class="folder-item" data-path="${item.path}" data-name="${item.name}">
                        <div class="folder-header" style="${indentStyle}">
                            <span class="folder-toggle ${isExpanded ? 'expanded' : ''}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="9 18 15 12 9 6"/>
                                </svg>
                            </span>
                            <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                            <span class="folder-name">${item.name}</span>
                            <div class="folder-actions">
                                <button class="folder-action-btn folder-rename-btn" title="重命名">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                    </svg>
                                </button>
                                <button class="folder-action-btn folder-delete-btn" title="删除">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="3 6 5 6 21 6"/>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        ${isExpanded && hasChildren ? `
                            <div class="folder-children">
                                ${this.renderFileTreeItems(item.children, depth + 1)}
                            </div>
                        ` : ''}
                    </div>
                `;
            } else {
                const indentStyle = `padding-left: ${depth * 16}px`;
                const isActive = this.state.currentDoc?.path === item.path;
                
                return `
                    <div class="file-item ${isActive ? 'active' : ''}" 
                         data-path="${item.path}"
                         data-name="${item.name}"
                         style="${indentStyle}">
                        <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span class="file-name">${item.name}</span>
                    </div>
                `;
            }
        }).join('');
    },

    // 切换文件夹展开/收起
    toggleFolder(folderPath) {
        if (this.state.expandedFolders.has(folderPath)) {
            this.state.expandedFolders.delete(folderPath);
        } else {
            this.state.expandedFolders.add(folderPath);
        }
        this.renderFileList();
    },

    // 文件夹操作
    showCreateFolderDialog() {
        const dialog = document.getElementById('modalCreateFolder');
        const input = document.getElementById('folderNameInput');
        if (dialog && input) {
            input.value = '';
            dialog.classList.add('open');
            setTimeout(() => input.focus(), 100);
        }
    },

    closeCreateFolderDialog() {
        const dialog = document.getElementById('modalCreateFolder');
        if (dialog) {
            dialog.classList.remove('open');
        }
    },

    async confirmCreateFolder() {
        const input = document.getElementById('folderNameInput');
        const folderName = input.value.trim();
        if (!folderName) {
            this.showToast('请输入文件夹名称', 'warning');
            return;
        }

        try {
            const response = await this.api.createFolder(folderName);
            if (response.success) {
                this.showToast('文件夹创建成功', 'success');
                this.closeCreateFolderDialog();
                // 自动展开新文件夹
                this.state.expandedFolders.add(response.data.path);
                await this.loadFiles();
            } else {
                this.showToast(response.error || '创建失败', 'error');
            }
        } catch (error) {
            this.showToast('创建失败: ' + error.message, 'error');
        }
    },

    showRenameFolderDialog(folderPath, folderName) {
        this.state.renamingFolderPath = folderPath;
        const dialog = document.getElementById('modalRenameFolder');
        const input = document.getElementById('renameFolderInput');
        if (dialog && input) {
            input.value = folderName;
            dialog.classList.add('open');
            setTimeout(() => input.focus(), 100);
        }
    },

    closeRenameFolderDialog() {
        const dialog = document.getElementById('modalRenameFolder');
        if (dialog) {
            dialog.classList.remove('open');
        }
        this.state.renamingFolderPath = null;
    },

    async confirmRenameFolder() {
        const input = document.getElementById('renameFolderInput');
        const newName = input.value.trim();
        
        if (!newName) {
            this.showToast('请输入名称', 'warning');
            return;
        }
        
        try {
            const response = await this.api.renameFolder(this.state.renamingFolderPath, newName);
            if (response.success) {
                await this.loadFiles();
                this.showToast('重命名成功', 'success');
                this.closeRenameFolderDialog();
            }
        } catch (error) {
            this.showToast('重命名失败', 'error');
        }
    },

    async confirmDeleteFolder(folderPath, folderName) {
        if (!confirm(`确定要删除文件夹"${folderName}"及其所有内容吗？此操作不可撤销。`)) {
            return;
        }
        
        try {
            const response = await this.api.deleteFolder(folderPath);
            if (response.success) {
                // 移除展开状态
                this.state.expandedFolders.delete(folderPath);
                await this.loadFiles();
                this.showToast('删除成功', 'success');
            }
        } catch (error) {
            this.showToast('删除失败', 'error');
        }
    },

    triggerFileUpload() {
        const input = document.getElementById('file-upload-input');
        if (input) {
            input.click();
        }
    },

    async uploadFiles(files) {
        for (const file of files) {
            try {
                const response = await this.api.uploadFile(file);
                if (response.success) {
                    this.showToast('文件上传成功', 'success');
                    await this.loadFiles();
                } else {
                    this.showToast(response.error || '上传失败', 'error');
                }
            } catch (error) {
                this.showToast('上传失败: ' + error.message, 'error');
            }
        }
    },

    async selectDocument(filePath) {
        try {
            this.state.isLoading = true;
            const response = await this.api.getFile(filePath);
            if (response.success) {
                this.state.currentDoc = response.data;
                this.renderDocumentPreview(response.data);
                await this.checkIndexStatus(filePath);
                await this.loadFiles();
                
                // 查找该文档的对话历史
                const docConversations = this.state.conversations.filter(
                    conv => conv.doc_id === filePath
                );
                
                if (docConversations.length > 0) {
                    // 有对话历史，加载最新的一个
                    const latestConv = docConversations[0];
                    await this.loadConversation(latestConv.id, false);
                } else {
                    // 没有对话历史，显示空页面
                    this.state.currentConversation = null;
                    this.state.messages = [];
                    this.renderChatMessages();
                }
                
                // 更新对话列表高亮
                this.renderConversationList();
            }
        } catch (error) {
            this.showToast('加载文档失败', 'error');
        } finally {
            this.state.isLoading = false;
        }
    },

    renderDocumentPreview(doc) {
        const titleEl = document.getElementById('doc-title');
        const contentEl = document.getElementById('doc-content');

        if (titleEl) titleEl.textContent = doc.name || '文档预览';
        if (contentEl) {
            contentEl.innerHTML = this.markdownToHtml(doc.content || '');
        }
    },

    async checkIndexStatus(docId) {
        try {
            const response = await this.api.getIndexStatus(docId);
            const statusEl = document.getElementById('index-status');
            if (response.success) {
                const { is_indexed, chunk_count } = response.data;
                this.state.indexStatus = is_indexed ? 'indexed' : 'not_indexed';
                if (statusEl) {
                    statusEl.textContent = is_indexed ? `已索引 (${chunk_count} 块)` : '未索引';
                }
            }
        } catch (error) {
            console.error('检查索引状态失败:', error);
        }
    },

    async reindexDocument() {
        if (!this.state.currentDoc) return;

        try {
            this.state.isLoading = true;
            const statusEl = document.getElementById('index-status');
            if (statusEl) statusEl.textContent = '索引中...';

            const response = await this.api.indexDocument(
                this.state.currentDoc.path,
                this.state.currentDoc.path
            );

            if (response.success) {
                this.showToast('索引成功', 'success');
                await this.checkIndexStatus(this.state.currentDoc.path);
            } else {
                this.showToast(response.error || '索引失败', 'error');
            }
        } catch (error) {
            this.showToast('索引失败', 'error');
        } finally {
            this.state.isLoading = false;
        }
    },

    async loadConversations() {
        try {
            const response = await this.api.listConversations();
            if (response.success) {
                this.state.conversations = response.data;
                this.renderConversationList();
            }
        } catch (error) {
            console.error('加载对话列表失败:', error);
        }
    },

    renderConversationList() {
        const container = document.getElementById('conversation-list');
        if (!container) return;

        // 过滤：只显示当前文档的对话（如果有选择文档的话）
        let filteredConversations = this.state.conversations;
        if (this.state.currentDoc) {
            filteredConversations = this.state.conversations.filter(
                conv => conv.doc_id === this.state.currentDoc.path
            );
        }

        if (!filteredConversations || filteredConversations.length === 0) {
            container.innerHTML = '<div class="empty-hint">暂无对话</div>';
            return;
        }

        container.innerHTML = filteredConversations.map(conv => `
            <div class="conversation-item ${this.state.currentConversation?.id === conv.id ? 'active' : ''}"
                 data-id="${conv.id}">
                <div class="conv-info">
                    <span class="conv-title">${conv.title || '未命名对话'}</span>
                    <span class="conv-doc">${conv.doc_name || ''}</span>
                </div>
                <div class="conv-actions">
                    <button class="conv-action-btn conv-rename-btn" title="重命名" data-id="${conv.id}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="conv-action-btn conv-delete-btn" title="删除" data-id="${conv.id}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    },

    async newConversation() {
        try {
            const response = await this.api.newConversation(
                this.state.currentDoc?.path,
                this.state.currentDoc?.name
            );
            if (response.success) {
                this.state.currentConversation = response.data;
                this.state.messages = [];
                this.renderChatMessages();
                await this.loadConversations();
            }
        } catch (error) {
            this.showToast('创建对话失败', 'error');
        }
    },

    async loadConversation(convId, autoLoadDoc = true) {
        try {
            const response = await this.api.getConversation(convId);
            if (response.success) {
                this.state.currentConversation = response.data;
                this.state.messages = response.data.messages || [];
                this.renderChatMessages();
                this.renderConversationList();

                if (autoLoadDoc && response.data.doc_id) {
                    await this.selectDocument(response.data.doc_id);
                }
            }
        } catch (error) {
            this.showToast('加载对话失败', 'error');
        }
    },

    async sendMessage() {
        const input = document.getElementById('chat-input');
        if (!input || !input.value.trim()) return;

        if (!this.state.currentDoc) {
            this.showToast('请先选择文档', 'warning');
            return;
        }

        const question = input.value.trim();
        input.value = '';
        
        // 先显示用户消息，给用户即时反馈
        this.addMessage('user', question);

        try {
            this.showTypingIndicator();

            // 发送请求时，使用添加消息之前的历史（不包含刚添加的这条）
            const historyBeforeAdd = this.state.messages.slice(0, -1);
            const currentConvId = this.state.currentConversation?.id;
            
            const response = await this.api.chat(
                this.state.currentDoc.path,
                question,
                historyBeforeAdd.slice(-20),
                null,
                currentConvId
            );

            this.hideTypingIndicator();

            if (response.success) {
                this.addMessage('assistant', response.data.answer);
                
                // 更新当前对话的 ID（如果后端返回了新的或已有的 conv_id）
                if (response.data.conv_id && (!this.state.currentConversation || this.state.currentConversation.id !== response.data.conv_id)) {
                    // 如果当前没有选中对话，或者返回了不同的 ID，则加载该对话
                    const convResponse = await this.api.getConversation(response.data.conv_id);
                    if (convResponse.success && convResponse.data) {
                        this.state.currentConversation = convResponse.data;
                    }
                }
                
                await this.loadConversations();
            } else {
                this.addMessage('assistant', `错误: ${response.error}`);
            }
        } catch (error) {
            this.hideTypingIndicator();
            this.addMessage('assistant', `请求失败: ${error.message}`);
        }
    },

    addMessage(role, content) {
        this.state.messages.push({ role, content });
        this.renderChatMessages();
    },

    renderChatMessages() {
        const container = document.getElementById('chat-messages');
        if (!container) return;

        if (this.state.messages.length === 0) {
            container.innerHTML = `<div class="empty-hint">${this.state.currentDoc ? '开始提问吧！' : '请先在左侧选择一个文档'}</div>`;
            return;
        }

        let html = '';
        this.state.messages.forEach(msg => {
            let contentHtml;
            let contentClass;
            if (msg.role === 'assistant') {
                contentHtml = this.markdownToHtml(msg.content);
                contentClass = 'message-content markdown-body';
            } else {
                contentHtml = this.escapeHtml(msg.content);
                contentClass = 'message-content';
            }
            
            html += `<div class="chat-message ${msg.role}" data-content="${this.escapeHtml(msg.content)}">`;
            if (msg.role === 'assistant') {
                html += `<div class="message-actions">
                        <button class="btn-favorite" title="收藏">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                            </svg>
                        </button>
                    </div>`;
            }
            html += `<div class="${contentClass}">${contentHtml}</div>`;
            html += '</div>';
        });
        
        container.innerHTML = html;
        container.scrollTop = container.scrollHeight;
    },

    showTypingIndicator() {
        const container = document.getElementById('chat-messages');
        if (!container) return;

        const indicator = document.createElement('div');
        indicator.className = 'chat-message assistant typing';
        indicator.id = 'typing-indicator';
        indicator.innerHTML = '<div class="message-content"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
        container.appendChild(indicator);
        container.scrollTop = container.scrollHeight;
    },

    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    },

    async loadFavorites() {
        try {
            const response = await this.api.listFavorites();
            if (response.success) {
                this.state.favorites = response.data;
                this.renderFavoritesList();
            }
        } catch (error) {
            console.error('加载收藏失败:', error);
        }
    },

    renderFavoritesList() {
        const container = document.getElementById('favorites-list');
        if (!container) return;

        if (!this.state.favorites || this.state.favorites.length === 0) {
            container.innerHTML = '<div class="empty-hint">暂无收藏</div>';
            return;
        }

        container.innerHTML = this.state.favorites.map(fav => `
            <div class="favorite-item" data-id="${fav.id}">
                <div class="favorite-content">${this.escapeHtml(fav.content.substring(0, 100))}...</div>
                <div class="favorite-meta">
                    <span>${fav.document || '未知文档'}</span>
                    <button class="btn-delete-favorite" data-id="${fav.id}" title="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');
    },

    async toggleFavorite(btn, content) {
        const isFavorited = btn.classList.contains('favorited');

        if (isFavorited) {
            const favId = btn.dataset.favId;
            if (favId) {
                await this.deleteFavorite(favId);
                btn.classList.remove('favorited');
                delete btn.dataset.favId;
            }
        } else {
            try {
                const lastUserMsg = this.state.messages.slice().reverse().find(m => m.role === 'user');
                const response = await this.api.addFavorite(
                    content,
                    lastUserMsg?.content || '',
                    this.state.currentDoc?.name || ''
                );
                if (response.success) {
                    btn.classList.add('favorited');
                    btn.dataset.favId = response.data.id;
                    await this.loadFavorites();
                    this.showToast('已添加收藏', 'success');
                }
            } catch (error) {
                this.showToast('收藏失败', 'error');
            }
        }
    },

    async deleteFavorite(favId) {
        try {
            const response = await this.api.deleteFavorite(favId);
            if (response.success) {
                await this.loadFavorites();
                this.showToast('已删除收藏', 'success');
            }
        } catch (error) {
            this.showToast('删除失败', 'error');
        }
    },

    showFavoriteDetail(favId) {
        const fav = this.state.favorites.find(f => f.id === favId);
        if (!fav) return;

        alert(`问题: ${fav.question || '无'}\n\n回答: ${fav.content}`);
    },

    async exportFavorites() {
        try {
            const response = await this.api.exportFavorites();
            if (response.success) {
                this.showToast('收藏已导出到: ' + response.data.path, 'success');
            } else {
                this.showToast('导出失败', 'error');
            }
        } catch (error) {
            this.showToast('导出失败', 'error');
        }
    },

    markdownToHtml(text) {
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
            console.error('Markdown parse error:', e);
            return text.replace(/\n/g, '<br>');
        }
    },

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    },

    // 左侧边栏收起/展开
    toggleLeftSidebar(expand) {
        const leftPanels = document.querySelector('.left-panels');
        const expandBtn = document.getElementById('btn-expand-left');
        
        this.state.sidebarCollapsed = !expand;
        
        if (expand) {
            leftPanels.classList.remove('collapsed');
            expandBtn.style.display = 'none';
        } else {
            leftPanels.classList.add('collapsed');
            expandBtn.style.display = 'flex';
        }
    },

    // 文档预览面板收起/展开（现在在右侧）
    toggleDocPreview(expand) {
        const panel = document.getElementById('doc-preview');
        const expandBtn = document.getElementById('btn-expand-right');
        
        if (expand) {
            panel.classList.remove('collapsed');
            expandBtn.style.display = 'none';
        } else {
            panel.classList.add('collapsed');
            expandBtn.style.display = 'flex';
        }
    },

    // 收藏区域折叠/展开（侧边栏内）
    toggleFavoritesSection() {
        const section = document.getElementById('sidebar-favorites-section');
        if (section) {
            section.classList.toggle('collapsed');
        }
    },

    // 重命名对话相关
    showRenameDialog(convId) {
        this.state.currentRenameConvId = convId;
        const conv = this.state.conversations.find(c => c.id === convId);
        const dialog = document.getElementById('modalRenameConversation');
        const input = document.getElementById('renameConvInput');
        
        if (conv) {
            input.value = conv.title || '';
        }
        dialog.classList.add('open');
        setTimeout(() => input.focus(), 100);
    },

    closeRenameDialog() {
        const dialog = document.getElementById('modalRenameConversation');
        const input = document.getElementById('renameConvInput');
        dialog.classList.remove('open');
        input.value = '';
        this.state.currentRenameConvId = null;
    },

    async confirmRename() {
        const input = document.getElementById('renameConvInput');
        const newTitle = input.value.trim();
        
        if (!newTitle) {
            this.showToast('请输入名称', 'warning');
            return;
        }
        
        try {
            const response = await this.api.renameConversation(
                this.state.currentRenameConvId,
                newTitle
            );
            if (response.success) {
                await this.loadConversations();
                this.showToast('重命名成功', 'success');
                this.closeRenameDialog();
            }
        } catch (error) {
            this.showToast('重命名失败', 'error');
        }
    },

    async deleteConversation(convId) {
        if (!confirm('确定要删除这个对话吗？')) {
            return;
        }
        
        try {
            const response = await this.api.deleteConversation(convId);
            if (response.success) {
                // 如果删除的是当前对话，清空当前状态
                if (this.state.currentConversation?.id === convId) {
                    this.state.currentConversation = null;
                    this.state.messages = [];
                    this.renderChatMessages();
                }
                await this.loadConversations();
                this.showToast('删除成功', 'success');
            }
        } catch (error) {
            this.showToast('删除失败', 'error');
        }
    }
};

window.KnowledgeApp = KnowledgeApp;
