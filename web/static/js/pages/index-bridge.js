// ============================
// pages/index-bridge.js
// 职责：聚合 pages/ 各模块的导出，避免 core/events.js 与具体子模块之间的循环依赖
// 同时把跨多个模块使用的桥接函数（switchPage、openSettingsModal 等）集中再导出
// ============================
import { state } from '../core/state.js?v=20260618i';
import { API_BASE_URL } from '../core/config.js?v=20260618i';
import { loadFiles, loadAudioFiles, loadDirectories, updatePathNav, navigateToPath, updateSidebarActiveState, loadSidebarVideoFolders, loadSidebarAudioFolders, toggleSubmenu, loadDocuments, renderDocuments, renderDocumentCardsView, renderDocumentListView, renderFiles, renderCardsView, renderListView, loadThumbnails, bindSidebarEvents, bindParentMenuToggles, bindFileEvents, updateTopBarMode } from './videos.js?v=20260618i';
import { toggleVideoSelection, renderFilesWithSelection, updateBatchToolbar, toggleSelectAll, clearSelection, startBatchTranscribe } from './selection.js?v=20260618i';
import { loadTasks, renderTasks, startTasksPolling, stopTasksPolling, clearCompletedTasks } from './tasks.js?v=20260618i';
import { handleFileSelect, updateSelectedFilesList, removeSelectedFile, uploadFile, extractFilenameFromUrl, uploadByUrl, startUrlDownloadPolling, initUrlUploadInput, renderUrlList, updateFilename, removeUrlItem } from './upload.js?v=20260618i';
import { isAudioPath, openVideoDetail, loadAnalysisResults, analyzeVideo, pollTaskProgress, generateSummary, generateNotes, generateOutline } from './video_detail.js?v=20260618i';
import { loadDirectories as loadDirectoriesModal, createFolder, computePathAfterOperation, refreshAfterStructureChange, renameFileFromCard, renameFile, moveFileFromCard, moveFile, deleteFileFromCard, renderDeleteModal, deleteSelected } from './file_ops.js?v=20260618i';
import { openModelSelectModal, loadModels, renderModelList, confirmModelSelect } from './model_select.js?v=20260618i';
import { openSettingsModal, loadConfigFromServer, loadProviderConfig, loadModelSelectModels, renderModelsTable, switchProviderTab, getCurrentEditingProviderId, addModelRow, removeModelRow, fetchModels, saveModelsToProvider, saveModelsFromTable, saveSettings, testConnection } from './settings.js?v=20260618i';
import { initGreeting, bindChartControls, openVideoFromActivity, showBatchAnalyze } from './home.js?v=20260618i';

// 重新导出以方便 events.js 一次性 import
export {
    state,
    API_BASE_URL,
    loadFiles,
    loadAudioFiles,
    loadDirectories,
    loadDirectoriesModal,
    updatePathNav,
    navigateToPath,
    updateSidebarActiveState,
    loadSidebarVideoFolders,
    loadSidebarAudioFolders,
    toggleSubmenu,
    openVideoFromActivity,
    showBatchAnalyze,
    loadDocuments,
    renderDocuments,
    renderDocumentCardsView,
    renderDocumentListView,
    renderFiles,
    renderCardsView,
    renderListView,
    loadThumbnails,
    bindSidebarEvents,
    bindParentMenuToggles,
    bindFileEvents,
    updateTopBarMode,
    toggleVideoSelection,
    renderFilesWithSelection,
    updateBatchToolbar,
    toggleSelectAll,
    clearSelection,
    startBatchTranscribe,
    loadTasks,
    renderTasks,
    startTasksPolling,
    stopTasksPolling,
    clearCompletedTasks,
    handleFileSelect,
    updateSelectedFilesList,
    removeSelectedFile,
    uploadFile,
    extractFilenameFromUrl,
    uploadByUrl,
    startUrlDownloadPolling,
    initUrlUploadInput,
    renderUrlList,
    updateFilename,
    removeUrlItem,
    isAudioPath,
    openVideoDetail,
    loadAnalysisResults,
    analyzeVideo,
    pollTaskProgress,
    generateSummary,
    generateNotes,
    generateOutline,
    createFolder,
    computePathAfterOperation,
    refreshAfterStructureChange,
    renameFileFromCard,
    renameFile,
    moveFileFromCard,
    moveFile,
    deleteFileFromCard,
    renderDeleteModal,
    deleteSelected,
    openModelSelectModal,
    loadModels,
    renderModelList,
    confirmModelSelect,
    openSettingsModal,
    loadConfigFromServer,
    loadProviderConfig,
    loadModelSelectModels,
    renderModelsTable,
    switchProviderTab,
    getCurrentEditingProviderId,
    addModelRow,
    removeModelRow,
    fetchModels,
    saveModelsToProvider,
    saveModelsFromTable,
    saveSettings,
    testConnection,
    initGreeting,
    bindChartControls
};

// 页面切换：在 events.js 之外也直接 import 时使用
export function switchPage(pageName) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));

    const targetPage = document.getElementById('page-' + pageName);
    if (targetPage) {
        targetPage.classList.add('active');
        const navLink = document.querySelector('[data-page="' + pageName + '"]');
        if (navLink) navLink.classList.add('active');

        if (pageName === 'home') {
            import('./home.js').then(m => {
                m.loadStats();
                m.loadDashboardCharts();
                m.loadRecentActivity();
            });
        } else if (pageName === 'videos') {
            if (state.isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            loadDirectories();
        } else if (pageName === 'knowledge') {
            if (window.KnowledgeApp) {
                // init() 内部已做幂等保护并会调用 Chat.loadModels()，
                // 这里不再显式调用 loadModels()，避免重复请求 /api/knowledge/models
                window.KnowledgeApp.init();
            }
        }
    }
}
