// ============================
// pages/knowledge/index.js
// 职责：KnowledgeApp 编排 init() / loadInitialData() / bindEvents()
// 真正实现拆分到 sidebar.js / chat.js / doc_preview.js / tts.js
// 保留 window.KnowledgeApp / window.knowledgePage 兼容桥
// ============================
import * as Sidebar from './sidebar.js';
import * as Chat from './chat.js';
import * as DocPreview from './doc_preview.js';
import * as TTS from './tts.js';
import { showToast } from '../../core/utils.js';

const state = {
    currentDoc: null,
    currentConversation: null,
    conversations: [],
    messages: [],
    favorites: [],
    indexStatus: 'idle',
    isLoading: false,
    expandedFolders: new Set(),
    searchQuery: '',
    sidebarCollapsed: false,
    // TTS
    ttsVoices: [],
    ttsSelectedVoice: 'zh-CN-XiaoxiaoNeural',
    ttsAudio: null,
    ttsIsPlaying: false,
    ttsIsPaused: false,
    ttsCurrentTime: 0,
    ttsDuration: 0,
    ttsIsConverting: false,
    ttsPlayingIndex: null,
    ttsPlayingMode: 'doc',
    // 模型
    availableModels: [],
    selectedModel: null
};

const ctx = { api: null, state, ctx: {} };

// 把 ctx 注入到所有子模块
function injectCtx() {
    Sidebar.setSidebarCtx(ctx);
    Chat.setChatCtx(ctx);
    DocPreview.setDocPreviewCtx(ctx);
    TTS.setTTSCtx(ctx);
}

const KnowledgeApp = {
    state,

    api: null,

    init() {
        this.api = window.KnowledgeAPI;
        ctx.api = this.api;
        injectCtx();
        this.bindEvents();
        this.loadInitialData();
        TTS.loadTTSVoices();
        Chat.loadModels();
        Sidebar.toggleLeftSidebar(true);
        Sidebar.toggleDocPreview(false);
        const favSection = document.getElementById('sidebar-favorites-section');
        if (favSection) favSection.classList.add('collapsed');
    },

    bindEvents() {
        // TTS 相关事件
        TTS.bindTTSEvents();

        // 其它业务 click 委托
        document.addEventListener('click', (e) => {
            if (e.target.closest('#btn-upload-doc')) {
                this.triggerFileUpload();
            }
            if (e.target.closest('.folder-toggle')) {
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                Sidebar.toggleFolder(folderPath);
            }
            if (e.target.closest('.create-folder-btn')) {
                Sidebar.showCreateFolderDialog();
            }
            if (e.target.closest('.folder-rename-btn')) {
                e.stopPropagation();
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                const folderName = folderEl.dataset.name;
                Sidebar.showRenameFolderDialog(folderPath, folderName);
            }
            if (e.target.closest('.folder-delete-btn')) {
                e.stopPropagation();
                const folderEl = e.target.closest('.folder-item');
                const folderPath = folderEl.dataset.path;
                const folderName = folderEl.dataset.name;
                Sidebar.confirmDeleteFolder(folderPath, folderName);
            }
            if (e.target.closest('.file-item')) {
                const filePath = e.target.closest('.file-item').dataset.path;
                DocPreview.selectDocument(filePath);
            }
            if (e.target.closest('#btn-new-chat')) {
                Chat.newConversation();
            }
            if (e.target.closest('#btn-send')) {
                Chat.sendMessage();
            }
            if (e.target.closest('#btn-reindex')) {
                DocPreview.reindexDocument();
            }
            if (e.target.closest('.conversation-item') && !e.target.closest('.conv-actions')) {
                const convId = e.target.closest('.conversation-item').dataset.id;
                Chat.loadConversation(convId);
            }
            if (e.target.closest('.conv-rename-btn')) {
                e.stopPropagation();
                const convId = e.target.closest('.conv-rename-btn').dataset.id;
                Sidebar.showRenameDialog(convId);
            }
            if (e.target.closest('.conv-delete-btn')) {
                e.stopPropagation();
                const convId = e.target.closest('.conv-delete-btn').dataset.id;
                Sidebar.deleteConversation(convId);
            }
            if (e.target.closest('.btn-favorite')) {
                const content = e.target.closest('.chat-message').dataset.content;
                this.toggleFavorite(e.target.closest('.btn-favorite'), content);
            }
            if (e.target.closest('#btn-export-favorites')) {
                this.exportFavorites();
            }
            if (e.target.closest('#btn-toggle-favorites')) {
                Sidebar.toggleFavoritesSection();
            }
            if (e.target.closest('.favorite-item')) {
                const favId = e.target.closest('.favorite-item').dataset.id;
                Sidebar.showFavoriteDetail(favId);
            }
            if (e.target.closest('.btn-delete-favorite')) {
                const favId = e.target.closest('.btn-delete-favorite').dataset.id;
                Sidebar.deleteFavorite(favId);
            }
            if (e.target.closest('#btn-collapse-left')) {
                Sidebar.toggleLeftSidebar(false);
            }
            if (e.target.closest('#btn-expand-left')) {
                Sidebar.toggleLeftSidebar(true);
            }
            if (e.target.closest('#btn-collapse-right')) {
                Sidebar.toggleDocPreview(false);
            }
            if (e.target.closest('#btn-expand-right')) {
                Sidebar.toggleDocPreview(true);
            }
            if (e.target.closest('#cancelRenameConv')) {
                Sidebar.closeRenameDialog();
            }
            if (e.target.closest('#confirmRenameConv')) {
                Sidebar.confirmRename();
            }
            if (e.target.closest('#cancelCreateFolder')) {
                Sidebar.closeCreateFolderDialog();
            }
            if (e.target.closest('#confirmCreateFolder')) {
                Sidebar.confirmCreateFolder();
            }
            if (e.target.closest('#cancelRenameFolder')) {
                Sidebar.closeRenameFolderDialog();
            }
            if (e.target.closest('#confirmRenameFolder')) {
                Sidebar.confirmRenameFolder();
            }
        });

        // 搜索框事件
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                state.searchQuery = e.target.value.toLowerCase();
                Sidebar.loadFiles();
            });
        }

        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    Chat.sendMessage();
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

        // 模型选择器
        const modelButton = document.getElementById('chat-model-button');
        const modelMenu = document.getElementById('chat-model-menu');
        if (modelButton && modelMenu) {
            modelButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = modelMenu.style.display === 'block';
                modelMenu.style.display = isOpen ? 'none' : 'block';
            });
            document.addEventListener('click', (e) => {
                if (!modelMenu.contains(e.target) && e.target !== modelButton) {
                    modelMenu.style.display = 'none';
                }
            });
            document.addEventListener('click', (e) => {
                const item = e.target.closest('.chat-model-menu-item');
                if (item && modelMenu && modelMenu.contains(item)) {
                    const modelId = item.dataset.modelId || null;
                    state.selectedModel = modelId;
                    Chat.updateModelButtonText();
                    if (modelMenu) modelMenu.style.display = 'none';
                }
            });
        }
    },

    async loadInitialData() {
        await Promise.all([
            Sidebar.loadFiles(),
            Sidebar.loadConversations(),
            Sidebar.loadFavorites()
        ]);
    },

    triggerFileUpload() {
        const input = document.getElementById('file-upload-input');
        if (input) input.click();
    },

    async uploadFiles(files) {
        for (const file of files) {
            try {
                const response = await this.api.uploadFile(file);
                if (response.success) {
                    showToast('文件上传成功', 'success');
                    await Sidebar.loadFiles();
                } else {
                    showToast(response.error || '上传失败', 'error');
                }
            } catch (error) {
                showToast('上传失败: ' + error.message, 'error');
            }
        }
    },

    async toggleFavorite(btn, content) {
        const isFavorited = btn.classList.contains('favorited');
        if (isFavorited) {
            const favId = btn.dataset.favId;
            if (favId) {
                await Sidebar.deleteFavorite(favId);
                btn.classList.remove('favorited');
                delete btn.dataset.favId;
            }
        } else {
            try {
                const lastUserMsg = state.messages.slice().reverse().find(m => m.role === 'user');
                const response = await this.api.addFavorite(
                    content,
                    lastUserMsg?.content || '',
                    state.currentDoc?.name || ''
                );
                if (response.success) {
                    btn.classList.add('favorited');
                    btn.dataset.favId = response.data.id;
                    await Sidebar.loadFavorites();
                    showToast('已添加收藏', 'success');
                }
            } catch (error) {
                showToast('收藏失败', 'error');
            }
        }
    },

    async exportFavorites() {
        try {
            const response = await this.api.exportFavorites();
            if (response.success) {
                showToast('收藏已导出到: ' + response.data.path, 'success');
            } else {
                showToast('导出失败', 'error');
            }
        } catch (error) {
            showToast('导出失败', 'error');
        }
    },

    // 对外暴露的方法（兼容旧 app.js 的引用）
    async loadFiles() { return Sidebar.loadFiles(); },
    async loadConversations() { return Sidebar.loadConversations(); },
    async loadFavorites() { return Sidebar.loadFavorites(); },
    async loadModels() { return Chat.loadModels(); },
    showCreateFolderDialog: Sidebar.showCreateFolderDialog,
    confirmCreateFolder: Sidebar.confirmCreateFolder,
    closeCreateFolderDialog: Sidebar.closeCreateFolderDialog,
    showRenameFolderDialog: Sidebar.showRenameFolderDialog,
    confirmRenameFolder: Sidebar.confirmRenameFolder,
    closeRenameFolderDialog: Sidebar.closeRenameFolderDialog,
    confirmDeleteFolder: Sidebar.confirmDeleteFolder,
    toggleFolder: Sidebar.toggleFolder,
    showRenameDialog: Sidebar.showRenameDialog,
    confirmRename: Sidebar.confirmRename,
    closeRenameDialog: Sidebar.closeRenameDialog,
    deleteConversation: Sidebar.deleteConversation,
    deleteFavorite: Sidebar.deleteFavorite,
    showFavoriteDetail: Sidebar.showFavoriteDetail,
    toggleLeftSidebar: Sidebar.toggleLeftSidebar,
    toggleDocPreview: Sidebar.toggleDocPreview,
    toggleFavoritesSection: Sidebar.toggleFavoritesSection,
    renderDocumentPreview: DocPreview.renderDocumentPreview,
    selectDocument: DocPreview.selectDocument,
    reindexDocument: DocPreview.reindexDocument,
    sendMessage: Chat.sendMessage,
    renderChatMessages: Chat.renderChatMessages,
    showTypingIndicator: Chat.showTypingIndicator,
    renderModelSelect: Chat.renderModelSelect,
    updateModelButtonText: Chat.updateModelButtonText,
    loadConversation: Chat.loadConversation,
    newConversation: Chat.newConversation,
    loadTTSVoices: TTS.loadTTSVoices,
    renderTTSVoiceSelect: TTS.renderTTSVoiceSelect,
    startTTS: TTS.startTTS,
    pauseTTS: TTS.pauseTTS,
    stopTTS: TTS.stopTTS,
    updateTTSProgress: TTS.updateTTSProgress,
    updateTTSControls: TTS.updateTTSControls,
    showToast
};

// 提供给 knowledge api.js 的兼容接口
window.KnowledgeApp = KnowledgeApp;
window.knowledgePage = KnowledgeApp;

// 命名导出 initKnowledgeApp（app.js 引导入口使用）
export function initKnowledgeApp() {
    KnowledgeApp.init();
}

export default KnowledgeApp;
