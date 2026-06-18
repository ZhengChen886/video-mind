// ============================
// core/events.js
// 职责：所有全局事件绑定的统一入口 bindEvents()
// 各子模块的 init/bind 由对应模块导出，本文件聚合调用
// ============================
import { bindChartControls } from '../pages/home.js';
import {
    bindSidebarEvents,
    bindParentMenuToggles
} from '../pages/videos.js';
import { switchPage, loadFiles, loadAudioFiles, startTasksPolling, stopTasksPolling, clearCompletedTasks, toggleSelectAll, clearSelection, startBatchTranscribe, createFolder, updateSelectedFilesList, uploadFile, uploadByUrl, initUrlUploadInput, analyzeVideo, generateSummary, generateNotes, generateOutline, renameFile, moveFile, deleteSelected, renderModelList, confirmModelSelect, fetchModels, addModelRow, saveModelsFromTable, saveSettings, switchProviderTab, openSettingsModal, openModelSelectModal } from '../pages/index-bridge.js';
import { debounce } from './utils.js';
import { state } from './state.js';

export function bindEvents() {
    // Page navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => switchPage(link.dataset.page));
    });

    // 文档子菜单（data-doc-type）
    document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (item.classList.contains('menu-item-parent')) return;
            if (item.dataset.docType !== undefined) {
                e.stopPropagation();
                document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                const docType = item.dataset.docType;
                const docTypeNames = {
                    'all': '全部文档',
                    'subtitle': '原文',
                    'summary': '总结',
                    'outline': '大纲',
                    'notes': '笔记'
                };
                const currentPathEl = document.getElementById('currentPath');
                if (currentPathEl) {
                    currentPathEl.textContent = docTypeNames[docType] || '全部文档';
                }
                // 动态加载 loadDocuments（从 videos.js 导出的副作用会注入此函数）
                import('../pages/videos.js').then(m => m.loadDocuments(docType));
                return;
            }
        });
    });

    // 视频/音频子菜单事件绑定
    bindSidebarEvents();
    // 父菜单点击（事件委托）
    bindParentMenuToggles();

    // 图表控件
    bindChartControls();

    // View toggle
    const viewCardsBtn = document.getElementById('viewCards');
    const viewListBtn = document.getElementById('viewList');
    if (viewCardsBtn) {
        viewCardsBtn.addEventListener('click', () => {
            state.currentView = 'cards';
            viewCardsBtn.classList.add('active');
            if (viewListBtn) viewListBtn.classList.remove('active');
            if (state.isShowingDocuments) {
                import('../pages/videos.js').then(m => m.loadDocuments(state.currentDocType));
            } else if (state.isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
        });
    }
    if (viewListBtn) {
        viewListBtn.addEventListener('click', () => {
            state.currentView = 'list';
            viewListBtn.classList.add('active');
            viewCardsBtn.classList.remove('active');
            if (state.isShowingDocuments) {
                import('../pages/videos.js').then(m => m.loadDocuments(state.currentDocType));
            } else if (state.isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
        });
    }

    // Search
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => {
            if (state.isShowingDocuments) {
                import('../pages/videos.js').then(m => m.loadDocuments(state.currentDocType));
            } else if (state.isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
        }, 300));
    }

    // New folder
    const btnNewFolder = document.getElementById('btnNewFolder');
    if (btnNewFolder) {
        btnNewFolder.addEventListener('click', () => {
            document.getElementById('modalNewFolder').classList.add('show');
        });
    }

    // Upload video
    const btnUpload = document.getElementById('btnUpload');
    if (btnUpload) {
        btnUpload.addEventListener('click', () => {
            document.getElementById('modalUpload').classList.add('show');
        });
    }

    // URL upload
    const btnUrlUpload = document.getElementById('btnUrlUpload');
    if (btnUrlUpload) {
        btnUrlUpload.addEventListener('click', () => {
            document.getElementById('modalUrlUpload').classList.add('show');
        });
    }

    // 初始化 URL 链接输入框的 input 事件监听（用于在输入链接后展示待下载列表与重命名框）
    initUrlUploadInput();

    // 任务列表按钮
    const viewTasksBtn = document.getElementById('viewTasksBtn');
    if (viewTasksBtn) {
        viewTasksBtn.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.add('show');
            startTasksPolling();
        });
    }
    const closeTasksModalBtn = document.getElementById('closeTasksModal');
    if (closeTasksModalBtn) {
        closeTasksModalBtn.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.remove('show');
            stopTasksPolling();
        });
    }
    const clearCompletedBtn = document.getElementById('clearCompletedTasks');
    if (clearCompletedBtn) {
        clearCompletedBtn.addEventListener('click', clearCompletedTasks);
    }

    // 批量操作工具栏
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', toggleSelectAll);
    }
    const batchAnalyzeBtn = document.getElementById('batchAnalyzeBtn');
    if (batchAnalyzeBtn) {
        batchAnalyzeBtn.addEventListener('click', startBatchTranscribe);
    }
    const clearSelectionBtn = document.getElementById('clearSelectionBtn');
    if (clearSelectionBtn) {
        clearSelectionBtn.addEventListener('click', clearSelection);
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal-overlay');
            if (modal) {
                modal.classList.remove('show');
                if (modal.id === 'modalTasks') {
                    stopTasksPolling();
                }
            }
        });
    });

    // New folder confirm
    const confirmNewFolderBtn = document.getElementById('confirmNewFolder');
    if (confirmNewFolderBtn) confirmNewFolderBtn.addEventListener('click', createFolder);
    const cancelNewFolderBtn = document.getElementById('cancelNewFolder');
    if (cancelNewFolderBtn) {
        cancelNewFolderBtn.addEventListener('click', () => {
            document.getElementById('modalNewFolder').classList.remove('show');
        });
    }

    // Upload related
    const selectFileBtn = document.getElementById('selectFileBtn');
    if (selectFileBtn) {
        selectFileBtn.addEventListener('click', () => {
            const inp = document.getElementById('uploadFileInput');
            if (inp) inp.click();
        });
    }
    const uploadFileInput = document.getElementById('uploadFileInput');
    if (uploadFileInput) {
        uploadFileInput.addEventListener('change', (e) => {
            state.selectedUploadFiles = Array.from(e.target.files);
            updateSelectedFilesList();
        });
    }
    const confirmUploadBtn = document.getElementById('confirmUpload');
    if (confirmUploadBtn) confirmUploadBtn.addEventListener('click', uploadFile);
    const cancelUploadBtn = document.getElementById('cancelUpload');
    if (cancelUploadBtn) {
        cancelUploadBtn.addEventListener('click', () => {
            document.getElementById('modalUpload').classList.remove('show');
            const inp = document.getElementById('uploadFileInput');
            if (inp) inp.value = '';
            state.selectedUploadFiles = [];
            updateSelectedFilesList();
        });
    }

    // URL upload confirm
    const confirmUrlUploadBtn = document.getElementById('confirmUrlUpload');
    if (confirmUrlUploadBtn) confirmUrlUploadBtn.addEventListener('click', uploadByUrl);
    const cancelUrlUploadBtn = document.getElementById('cancelUrlUpload');
    if (cancelUrlUploadBtn) {
        cancelUrlUploadBtn.addEventListener('click', () => {
            document.getElementById('modalUrlUpload').classList.remove('show');
            const inp = document.getElementById('urlUploadInput');
            if (inp) inp.value = '';
            if (state.urlPollingInterval) {
                clearInterval(state.urlPollingInterval);
                state.urlPollingInterval = null;
            }
        });
    }

    // Delete confirm
    const confirmDeleteBtn = document.getElementById('confirmDelete');
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', deleteSelected);
    const cancelDeleteBtn = document.getElementById('cancelDelete');
    if (cancelDeleteBtn) {
        cancelDeleteBtn.addEventListener('click', () => {
            document.getElementById('modalDelete').classList.remove('show');
        });
    }

    // Detail panel
    const closeDetailBtn = document.getElementById('closeDetail');
    if (closeDetailBtn) {
        closeDetailBtn.addEventListener('click', () => {
            document.getElementById('detailPanel').classList.remove('show');
        });
    }

    // Video analysis
    const btnAnalyze = document.getElementById('btnAnalyze');
    if (btnAnalyze) btnAnalyze.addEventListener('click', analyzeVideo);

    // Generate buttons
    const btnGenSummary = document.getElementById('btnGenSummary');
    if (btnGenSummary) btnGenSummary.addEventListener('click', generateSummary);
    const btnGenNotes = document.getElementById('btnGenNotes');
    if (btnGenNotes) btnGenNotes.addEventListener('click', generateNotes);
    const btnGenOutline = document.getElementById('btnGenOutline');
    if (btnGenOutline) btnGenOutline.addEventListener('click', generateOutline);

    // Rename modal
    const cancelRenameBtn = document.getElementById('cancelRename');
    if (cancelRenameBtn) {
        cancelRenameBtn.addEventListener('click', () => {
            document.getElementById('modalRename').classList.remove('show');
            const inp = document.getElementById('renameInput');
            if (inp) inp.value = '';
        });
    }
    const confirmRenameBtn = document.getElementById('confirmRename');
    if (confirmRenameBtn) confirmRenameBtn.addEventListener('click', renameFile);

    // Move modal
    const cancelMoveBtn = document.getElementById('cancelMove');
    if (cancelMoveBtn) {
        cancelMoveBtn.addEventListener('click', () => {
            document.getElementById('modalMove').classList.remove('show');
        });
    }
    const confirmMoveBtn = document.getElementById('confirmMove');
    if (confirmMoveBtn) confirmMoveBtn.addEventListener('click', moveFile);

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const name = tab.dataset.tab;
            const targetId = 'tab' + name.charAt(0).toUpperCase() + name.slice(1);
            const target = document.getElementById(targetId);
            if (target) target.classList.add('active');
        });
    });

    // Model select modal (avatar / user area)
    const userArea = document.getElementById('userArea');
    if (userArea) {
        userArea.addEventListener('click', (e) => {
            if (!e.target.closest('#openSettings')) {
                openModelSelectModal();
            }
        });
    }
    const openSettings = document.getElementById('openSettings');
    if (openSettings) {
        openSettings.addEventListener('click', (e) => {
            e.stopPropagation();
            openSettingsModal();
        });
    }
    const cancelModelSelectBtn = document.getElementById('cancelModelSelect');
    if (cancelModelSelectBtn) {
        cancelModelSelectBtn.addEventListener('click', () => {
            document.getElementById('modalModelSelect').classList.remove('show');
        });
    }
    const confirmModelSelectBtn = document.getElementById('confirmModelSelect');
    if (confirmModelSelectBtn) {
        confirmModelSelectBtn.addEventListener('click', confirmModelSelect);
    }
    const modelSearchInput = document.getElementById('modelSearchInput');
    if (modelSearchInput) {
        modelSearchInput.addEventListener('input', (e) => {
            renderModelList(state.allModels, e.target.value);
        });
    }

    // Settings modal
    document.querySelectorAll('.provider-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchProviderTab(tab.dataset.provider);
        });
    });
    const cancelSettingsBtn = document.getElementById('cancelSettings');
    if (cancelSettingsBtn) {
        cancelSettingsBtn.addEventListener('click', () => {
            document.getElementById('modalSettings').classList.remove('show');
        });
    }
    const saveSettingsBtn = document.getElementById('saveSettings');
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);
    const toggleApiKeyBtn = document.getElementById('toggleApiKeyVisibility');
    if (toggleApiKeyBtn) {
        toggleApiKeyBtn.addEventListener('click', function() {
            const input = document.getElementById('configApiKey');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
    }
    const fetchModelsBtn = document.getElementById('fetchModelsBtn');
    if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', fetchModels);
    const addModelBtn = document.getElementById('addModelBtn');
    if (addModelBtn) addModelBtn.addEventListener('click', addModelRow);
    const saveModelsBtn = document.getElementById('saveModelsBtn');
    if (saveModelsBtn) saveModelsBtn.addEventListener('click', saveModelsFromTable);

    // 全局 click 委托：关闭所有 .card-actions-menu
    document.addEventListener('click', () => {
        document.querySelectorAll('.card-actions-menu').forEach(menu => {
            menu.style.display = 'none';
        });
    });
}
