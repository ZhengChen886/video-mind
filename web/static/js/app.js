// ============================
// Configuration
// ============================
const API_BASE_URL = 'http://localhost:8000';

// ============================
// Global State
// ============================
let currentPath = '';
let currentView = 'cards';
let selectedItems = [];
let currentVideo = null;
let isShowingDocuments = false;
let isShowingAudio = false;
let currentDocType = 'all';
let currentAudioPath = '';  // 当前音频子菜单路径
let selectedVideoPaths = []; // 用于批量转录的选中视频
let currentTranscribeTaskId = null;
let transcribePollingInterval = null;
let appConfig = {
    activeProvider: 'open-ai',
    providers: {
        'open-ai': { name: 'Open AI', apiUrl: '', defaultModel: '' },
        'openroute': { name: 'OpenRoute', apiUrl: '', apiKey: '', defaultModel: '' },
        'nvidia': { name: 'NVIDIA', apiUrl: '', apiKey: '', defaultModel: '' }
    },
    currentModel: ''
};
let allModels = [];
let selectedModel = null;
let editingProvider = null;

// ============================
// Utilities
// ============================
function debounce(func, wait) {
    let timeout;
    return function() {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

function simpleMarkdownToHtml(text) {
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

function formatFileSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================
// Config Management
// ============================
function loadAppConfig() {
    const saved = localStorage.getItem('appConfig');
    if (saved) {
        try {
            appConfig = { ...appConfig, ...JSON.parse(saved) };
        } catch (e) {
            console.error('加载配置失败:', e);
        }
    }
    updateModelDisplay();
}

function saveAppConfig() {
    localStorage.setItem('appConfig', JSON.stringify(appConfig));
}

function updateModelDisplay() {
    const modelNameEl = document.getElementById('currentModelName');
    const providerNameEl = document.getElementById('currentProviderName');
    if (modelNameEl) modelNameEl.textContent = appConfig.currentModel;
    if (providerNameEl) providerNameEl.textContent = appConfig.providers[appConfig.activeProvider].name;
}

// ============================
// Page Navigation
// ============================
function switchPage(pageName) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));

    const targetPage = document.getElementById('page-' + pageName);
    if (targetPage) {
        targetPage.classList.add('active');
        const navLink = document.querySelector('[data-page="' + pageName + '"]');
        if (navLink) {
            navLink.classList.add('active');
        }

        if (pageName === 'home') {
            loadStats();
            loadDashboardCharts();
            loadRecentActivity();
        } else if (pageName === 'videos') {
            if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            loadDirectories();
        } else if (pageName === 'knowledge') {
            if (window.KnowledgeApp) {
                KnowledgeApp.init();
                // 每次进入知识库页面都重新拉取配置中的模型列表
                if (typeof KnowledgeApp.loadModels === 'function') {
                    KnowledgeApp.loadModels();
                }
            }
        }
    }
}

// ============================
// Home Page
// ============================
async function loadStats() {
    try {
        // 尝试使用新的 dashboard API
        try {
            const response = await fetch(`${API_BASE_URL}/api/dashboard/stats`);
            const data = await response.json();

            if (data.success && data.data) {
                const stats = data.data;

                // 更新视频统计
                document.getElementById('stat-videos').textContent = stats.videos.total;
                document.getElementById('stat-videos-today').textContent = `今日新增 ${stats.videos.today}`;

                // 更新处理时长
                document.getElementById('stat-duration').textContent = stats.duration.total;
                document.getElementById('stat-transcribed').textContent = `已转录 ${stats.duration.transcribed}`;

                // 更新文档统计
                document.getElementById('stat-documents').textContent = stats.documents.total;
                document.getElementById('stat-docs-today').textContent = `今日生成 ${stats.documents.today}`;

                // 更新任务统计
                document.getElementById('stat-tasks-pending').textContent = stats.tasks.pending;
                document.getElementById('stat-tasks-info').textContent = `已完成 ${stats.tasks.completed} / 失败 ${stats.tasks.failed}`;

                return;
            }
        } catch (e) {
            console.log('Dashboard API not available, falling back to basic stats');
        }

        // 降级方案：使用原有的 /api/files 接口
        const response = await fetch(`${API_BASE_URL}/api/files?path=`);
        const data = await response.json();

        if (data.success) {
            let videoCount = 0;
            let totalSize = 0;

            function countItems(items) {
                items.forEach(item => {
                    if (item.type === 'directory') {
                    } else {
                        videoCount++;
                        totalSize += item.size || 0;
                    }
                });
            }

            countItems(data.items);

            document.getElementById('stat-videos').textContent = videoCount;
            document.getElementById('stat-size').textContent = formatFileSize(totalSize);
        }
    } catch (error) {
        console.error('加载统计失败:', error);
    }
}

// ============================
// Dashboard Functions
// ============================
let distributionChart = null;
let trendsChart = null;

function initGreeting() {
    const hour = new Date().getHours();
    let greeting = '晚上好';

    if (hour >= 5 && hour < 12) {
        greeting = '早上好';
    } else if (hour >= 12 && hour < 18) {
        greeting = '下午好';
    }

    const welcomeTitle = document.getElementById('welcomeTitle');
    if (welcomeTitle) {
        welcomeTitle.textContent = greeting;
    }
}

async function loadDashboardCharts() {
    // 并行加载两个图表数据
    await Promise.all([
        loadDistributionChart(),
        loadTrendsChart(7)
    ]);
}

async function loadDistributionChart() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/distribution`);
        const result = await response.json();

        if (!result.success || !result.data) return;

        const { categories } = result.data;

        const ctx = document.getElementById('distributionChart');
        if (!ctx) return;

        if (distributionChart) {
            distributionChart.destroy();
        }

        const labels = categories.map(c => c.name);
        const data = categories.map(c => c.count);

        const colors = [
            '#667eea', '#764ba2', '#f59e0b', '#10b981', '#3b82f6',
            '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
        ];

        distributionChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors.slice(0, labels.length),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            boxWidth: 12,
                            padding: 15,
                            font: {
                                size: 12
                            }
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('加载分布图表失败:', error);
    }
}

async function loadTrendsChart(days = 7) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/trends?days=${days}`);
        const result = await response.json();

        if (!result.success || !result.data) return;

        const { dates, videos_processed, documents_generated } = result.data;

        const ctx = document.getElementById('trendsChart');
        if (!ctx) return;

        if (trendsChart) {
            trendsChart.destroy();
        }

        trendsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates.map(d => d.slice(5)), // MM-DD格式
                datasets: [
                    {
                        label: '视频处理',
                        data: videos_processed,
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: '文档生成',
                        data: documents_generated,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            boxWidth: 12,
                            padding: 15,
                            font: {
                                size: 12
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('加载趋势图表失败:', error);
    }
}

async function loadRecentActivity() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/recent?limit=5`);
        const result = await response.json();

        if (!result.success || !result.data) return;

        const { videos } = result.data;
        const container = document.getElementById('recentActivityList');

        if (!container) return;

        if (videos.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <div>暂无最近活动</div>
                </div>
            `;
            return;
        }

        container.innerHTML = videos.map(video => `
            <div class="activity-item" onclick="openVideoFromActivity('${escapeHtml(video.path)}')">
                <div class="activity-icon video">📹</div>
                <div class="activity-content">
                    <div class="activity-name">${escapeHtml(video.name)}</div>
                    <div class="activity-meta">${escapeHtml(video.directory || '未分类')}</div>
                </div>
                <div class="activity-time">${video.modified}</div>
            </div>
        `).join('');
    } catch (error) {
        console.error('加载最近活动失败:', error);
    }
}

function openVideoFromActivity(path) {
    switchPage('videos');
    setTimeout(() => {
        openVideoDetail(path);
    }, 100);
}

function showBatchAnalyze() {
    switchPage('videos');
}

function bindChartControls() {
    document.querySelectorAll('.chart-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const days = parseInt(this.dataset.days);
            document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            loadTrendsChart(days);
        });
    });

    // 绑定任务中心按钮
    const btnViewTasks = document.getElementById('btnViewTasks');
    if (btnViewTasks) {
        btnViewTasks.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.add('show');
            startTasksPolling();
        });
    }
}

// ============================
// Files Management
// ============================
async function loadFiles() {
    isShowingDocuments = false;
    isShowingAudio = false;
    updateTopBarMode();
    const searchQuery = document.getElementById('searchInput').value.toLowerCase();

    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=${encodeURIComponent(currentPath)}&media_type=video`);
        const data = await response.json();

        if (data.success) {
            // 后端已按 media_type=video 过滤；目录保留
            const videoItems = (data.items || []).filter(item => item.type === 'directory' || item.media_type === 'video');
            renderFiles(videoItems, searchQuery, { mode: 'video' });
            updatePathNav('视频库');
        }
    } catch (error) {
        console.error('加载文件失败:', error);
        renderFiles([], '', { mode: 'video' });
    }
}

// 加载音频文件
async function loadAudioFiles() {
    isShowingDocuments = false;
    isShowingAudio = true;
    updateTopBarMode();
    const searchQuery = document.getElementById('searchInput').value.toLowerCase();

    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=${encodeURIComponent(currentAudioPath)}&media_type=audio`);
        const data = await response.json();

        if (data.success) {
            // 过滤仅音频
            const audioItems = (data.items || []).filter(item => {
                if (item.type === 'directory') return true;
                return item.media_type === 'audio';
            });
            renderFiles(audioItems, searchQuery, { mode: 'audio' });
            updatePathNav('音频库');
        }
    } catch (error) {
        console.error('加载音频失败:', error);
        renderFiles([], '', { mode: 'audio' });
    }
}

// 同步顶部操作栏按钮的文案/图标（音频模式下显示"上传音频"，视频模式保持原样）
function updateTopBarMode() {
    const btnUpload = document.getElementById('btnUpload');
    const btnUrlUpload = document.getElementById('btnUrlUpload');
    const modalUploadTitle = document.getElementById('modalUploadTitle');
    const uploadFileInput = document.getElementById('uploadFileInput');
    const uploadFormatHint = document.getElementById('uploadFormatHint');
    const modalUrlUploadTitle = document.querySelector('#modalUrlUpload .modal-header span');

    if (isShowingAudio) {
        // 切换为音频模式
        if (btnUpload) {
            const iconVideo = btnUpload.querySelector('.btn-icon-video');
            const iconAudio = btnUpload.querySelector('.btn-icon-audio');
            const text = btnUpload.querySelector('.btn-label');
            if (iconVideo) iconVideo.style.display = 'none';
            if (iconAudio) iconAudio.style.display = 'inline-block';
            if (text) text.textContent = '上传音频';
        }
        if (btnUrlUpload) {
            const text = btnUrlUpload.querySelector('.btn-label');
            if (text) text.textContent = '音频链接';
        }
        if (modalUploadTitle) modalUploadTitle.textContent = '上传音频';
        if (uploadFileInput) uploadFileInput.setAttribute('accept', 'audio/*');
        if (uploadFormatHint) uploadFormatHint.textContent = '支持格式: MP3, M4A, WAV, FLAC, OGG, AAC 等';
        if (modalUrlUploadTitle) modalUrlUploadTitle.textContent = '音频链接下载';
    } else {
        // 恢复为视频模式
        if (btnUpload) {
            const iconVideo = btnUpload.querySelector('.btn-icon-video');
            const iconAudio = btnUpload.querySelector('.btn-icon-audio');
            const text = btnUpload.querySelector('.btn-label');
            if (iconVideo) iconVideo.style.display = 'inline-block';
            if (iconAudio) iconAudio.style.display = 'none';
            if (text) text.textContent = '上传视频';
        }
        if (btnUrlUpload) {
            const text = btnUrlUpload.querySelector('.btn-label');
            if (text) text.textContent = '链接上传';
        }
        if (modalUploadTitle) modalUploadTitle.textContent = '上传视频';
        if (uploadFileInput) uploadFileInput.setAttribute('accept', 'video/*');
        if (uploadFormatHint) uploadFormatHint.textContent = '支持格式: MP4, WebM, MOV, AVI, MKV 等';
        if (modalUrlUploadTitle) modalUrlUploadTitle.textContent = '链接下载';
    }
}

// 更新路径导航
function updatePathNav(rootLabel) {
    const pathNav = document.querySelector('.path-nav');
    if (!pathNav) return;

    let html = '';
    const rootName = rootLabel || (isShowingAudio ? '音频库' : '视频库');

    // 根节点
    html += `<span class="path-segment" data-path="" style="cursor:pointer;color:var(--primary);">${rootName}</span>`;

    // 分割路径
    if (currentPath) {
        const pathParts = currentPath.split(/[\\/]/).filter(p => p);
        let accumulatedPath = '';

        pathParts.forEach((part, index) => {
            html += `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin:0 8px;" fill="currentColor">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>`;

            accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
            const isLast = index === pathParts.length - 1;

            html += `<span class="path-segment" data-path="${escapeHtml(accumulatedPath)}" style="cursor:pointer;${isLast ? 'color:var(--text-primary);font-weight:500;' : 'color:var(--primary);'}">${escapeHtml(part)}</span>`;
        });
    } else {
        // 根目录
        html += `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin:0 8px;" fill="currentColor">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
        </svg>`;
        html += `<span class="path-segment" data-path="" style="cursor:pointer;color:var(--text-primary);font-weight:500;">${isShowingAudio ? '全部音频' : '全部视频'}</span>`;
    }

    pathNav.innerHTML = html;

    // 绑定点击事件
    pathNav.querySelectorAll('.path-segment').forEach(segment => {
        segment.addEventListener('click', () => {
            const path = segment.dataset.path;
            if (path !== undefined) {
                navigateToPath(path);
            }
        });
    });
}

// 导航到指定路径
function navigateToPath(path) {
    currentPath = path;
    if (isShowingAudio) {
        currentAudioPath = path;
        loadAudioFiles();
    } else {
        loadFiles();
    }
    updateSidebarActiveState();
}

// 更新侧边栏激活状态
function updateSidebarActiveState() {
    // 视频子菜单激活状态
    document.querySelectorAll('#videos-submenu .menu-item:not(.menu-item-parent)').forEach(item => {
        item.classList.remove('active');
        if (!isShowingAudio && item.dataset.path === currentPath) {
            item.classList.add('active');
        }
    });
    // 音频子菜单激活状态（与视频共用 data-path）
    document.querySelectorAll('#audios-submenu .menu-item:not(.menu-item-parent)').forEach(item => {
        item.classList.remove('active');
        if (isShowingAudio && item.dataset.path === currentAudioPath) {
            item.classList.add('active');
        }
    });
}

// 动态加载侧边栏视频子菜单
async function loadSidebarVideoFolders() {
    const submenu = document.getElementById('videos-submenu');
    if (!submenu) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=&media_type=video`);
        const data = await response.json();

        if (data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');

            let html = '';
            // "全部视频" 根选项
            html += `<div class="menu-item" data-path="">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                    <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                <span>全部视频</span>
            </div>`;

            // 实际文件夹
            dirs.forEach(dir => {
                html += `<div class="menu-item" data-path="${escapeHtml(dir.path)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span>${escapeHtml(dir.name)}</span>
                </div>`;
            });

            submenu.innerHTML = html;

            // 重新绑定事件
            bindSidebarEvents();
            updateSidebarActiveState();

            // 同步加载音频子菜单
            await loadSidebarAudioFolders();
        }
    } catch (error) {
        console.error('加载侧边栏文件夹失败:', error);
    }
}

// 动态加载侧边栏音频子菜单
async function loadSidebarAudioFolders() {
    const submenu = document.getElementById('audios-submenu');
    if (!submenu) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=&media_type=audio`);
        const data = await response.json();

        if (data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');

            let html = '';
            // "全部音频" 根选项（与视频子菜单共用 data-path）
            html += `<div class="menu-item" data-path="">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"/>
                    <circle cx="6" cy="18" r="3"/>
                    <circle cx="18" cy="16" r="3"/>
                </svg>
                <span>全部音频</span>
            </div>`;

            // 实际文件夹
            dirs.forEach(dir => {
                html += `<div class="menu-item" data-path="${escapeHtml(dir.path)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span>${escapeHtml(dir.name)}</span>
                </div>`;
            });

            submenu.innerHTML = html;

            // 重新绑定音频子菜单事件
            bindSidebarEvents();
            updateSidebarActiveState();
        }
    } catch (error) {
        console.error('加载侧边栏音频文件夹失败:', error);
    }
}

// 绑定侧边栏事件（视频 + 音频子菜单共用 data-path，通过父容器区分）
function bindSidebarEvents() {
    // 视频子菜单点击
    document.querySelectorAll('#videos-submenu .menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            isShowingDocuments = false;
            isShowingAudio = false;
            currentPath = item.dataset.path || '';
            loadFiles();
        });
    });
    // 音频子菜单点击（与视频共用 data-path，靠 isShowingAudio 区分）
    document.querySelectorAll('#audios-submenu .menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            isShowingDocuments = false;
            isShowingAudio = true;
            const audioPath = item.dataset.path || '';
            currentPath = audioPath;
            currentAudioPath = audioPath;
            loadAudioFiles();
        });
    });
}

// 父菜单展开/收起通用函数（与视频/文档同款）
function toggleSubmenu(action) {
    const submenuId = {
        'toggle-videos':    'videos-submenu',
        'toggle-audios':    'audios-submenu',
        'toggle-documents': 'documents-submenu'
    }[action];
    if (!submenuId) return;
    const submenu = document.getElementById(submenuId);
    if (!submenu) return;
    submenu.classList.toggle('submenu-open');
    // 找到对应的父菜单项
    const parentItem = document.querySelector(`[data-action="${action}"]`);
    if (parentItem) {
        const toggleIcon = parentItem.querySelector('.menu-toggle-icon');
        if (toggleIcon) {
            toggleIcon.style.transform = submenu.classList.contains('submenu-open')
                ? 'rotate(0deg)'
                : 'rotate(-90deg)';
        }
    }
}

// 直接绑定父菜单的点击事件（使用事件委托，确保浏览器兼容性）
function bindParentMenuToggles() {
    const sidebar = document.querySelector('.sidebar-menu');
    if (!sidebar) return;
    // 用事件委托，父菜单点击时只处理 toggle-* 父项
    sidebar.addEventListener('click', (e) => {
        const parent = e.target.closest('.menu-item-parent');
        if (!parent) return;
        const action = parent.dataset.action;
        if (!action || !action.startsWith('toggle-')) return;
        e.stopPropagation();
        e.preventDefault();
        toggleSubmenu(action);
    });
}

// 文档文件扩展名列表
const DOCUMENT_EXTENSIONS = ['.md', '.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt'];

async function loadDocuments(docType = 'all') {
    isShowingDocuments = true;
    currentDocType = docType;
    const searchQuery = document.getElementById('searchInput').value.toLowerCase();
    
    try {
        // 调用统一的 /api/documents 端点，支持 type 参数
        const apiUrl = docType === 'all' 
            ? `${API_BASE_URL}/api/documents` 
            : `${API_BASE_URL}/api/documents?type=${docType}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        
        if (data.success) {
            renderDocuments(data.items, searchQuery);
        }
    } catch (error) {
        console.error('加载文档失败:', error);
        renderDocuments([], '');
    }
}

function renderDocuments(items, searchQuery) {
    const contentArea = document.getElementById('contentArea');
    if (!items || items.length === 0) {
        contentArea.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <div>暂无文档</div>
            </div>
        `;
        return;
    }

    let filteredItems = items;
    if (searchQuery) {
        filteredItems = items.filter(item => item.name.toLowerCase().includes(searchQuery));
    }

    if (filteredItems.length === 0) {
        contentArea.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 110-15 7.5 7.5 0 010 15z"/>
                </svg>
                <div>未找到匹配的文档</div>
            </div>
        `;
        return;
    }

    if (currentView === 'cards') {
        contentArea.innerHTML = renderDocumentCardsView(filteredItems);
    } else {
        contentArea.innerHTML = renderDocumentListView(filteredItems);
    }
    
    // 绑定文档点击事件
    bindFileEvents();
}

function renderDocumentCardsView(items) {
    let html = '<div class="cards-view">';
    items.forEach(item => {
        const ext = item.name.toLowerCase().substring(item.name.lastIndexOf('.'));
        let iconColor = '#64748b';
        if (ext === '.md') iconColor = '#0891b2';
        else if (ext === '.pdf') iconColor = '#ef4444';
        else if (['.doc', '.docx'].includes(ext)) iconColor = '#3b82f6';
        else if (['.xls', '.xlsx'].includes(ext)) iconColor = '#10b981';
        else if (['.ppt', '.pptx'].includes(ext)) iconColor = '#f59e0b';
        
        html += `
            <div class="file-card" data-path="${escapeHtml(item.path)}" data-type="document">
                <div class="card-thumbnail" style="background: ${iconColor}15;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" style="width: 48px; height: 48px;">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                </div>
                <div class="card-info">
                    <div class="card-name">${escapeHtml(item.name)}</div>
                    <div class="card-meta">${formatFileSize(item.size)}</div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    return html;
}

function renderDocumentListView(items) {
    let html = `
        <div class="list-view">
            <div class="list-header">
                <div></div>
                <div>名称</div>
                <div>大小</div>
                <div></div>
                <div></div>
            </div>
    `;
    items.forEach(item => {
        html += `
            <div class="list-item" data-path="${escapeHtml(item.path)}" data-type="document">
                <div class="list-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                </div>
                <div class="list-name">${escapeHtml(item.name)}</div>
                <div class="list-meta">${formatFileSize(item.size)}</div>
                <div class="list-meta"></div>
                <div></div>
            </div>
        `;
    });
    html += '</div>';
    return html;
}

function renderFiles(items, searchQuery, options) {
    const contentArea = document.getElementById('contentArea');
    const mode = (options && options.mode) || 'video';
    if (!items || items.length === 0) {
        contentArea.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 7h18M3 12h18M3 17h18"/>
                </svg>
                <div>暂无文件</div>
            </div>
        `;
        return;
    }

    let filteredItems = items;
    if (searchQuery) {
        filteredItems = items.filter(item => item.name.toLowerCase().includes(searchQuery));
    }

    if (filteredItems.length === 0) {
        contentArea.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 110-15 7.5 7.5 0 010 15z"/>
                </svg>
                <div>未找到匹配的文件</div>
            </div>
        `;
        return;
    }

    if (currentView === 'cards') {
        contentArea.innerHTML = renderCardsView(filteredItems, { mode });
        // 加载缩略图（仅视频）
        if (mode === 'video') {
            setTimeout(loadThumbnails, 100);
        }
    } else {
        contentArea.innerHTML = renderListView(filteredItems, { mode });
    }

    bindFileEvents();
}

function renderCardsView(items, options) {
    const mode = (options && options.mode) || 'video';
    let html = '<div class="cards-view">';
    items.forEach(item => {
        if (item.type === 'directory') {
            html += `
                <div class="file-card" data-path="${escapeHtml(item.path)}" data-type="directory" data-item-name="${escapeHtml(item.name)}">
                    <div class="card-thumbnail-wrapper">
                        <div class="card-thumbnail">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
                            </svg>
                            <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                                <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="1"/>
                                    <circle cx="19" cy="12" r="1"/>
                                    <circle cx="5" cy="12" r="1"/>
                                </svg>
                            </button>
                            <div class="card-actions-menu" style="top: 44px; right: 8px; z-index: 100;">
                                <button class="action-item" data-action="rename">重命名</button>
                                <button class="action-item" data-action="move">移动</button>
                                <button class="action-item danger" data-action="delete">删除</button>
                            </div>
                        </div>
                    </div>
                    <div class="card-info">
                        <div class="card-name">${escapeHtml(item.name)}</div>
                    </div>
                </div>
            `;
        } else {
            // 构建缩略图 URL，将反斜杠替换为正斜杠
            const pathForUrl = item.path.replace(/\\/g, '/');
            const isAudioItem = (item.media_type === 'audio') || /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(item.name);
            const thumbnailUrl = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?thumbnail=true`;
            const isSelected = selectedVideoPaths.includes(item.path);
            const mediaBadge = isAudioItem
                ? '<div style="position:absolute;top:8px;right:8px;z-index:10;background:rgba(99,102,241,0.9);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">音频</div>'
                : '';
            const placeholderIcon = isAudioItem
                ? '<svg viewBox="0 0 24 24" style="width:48px;height:48px;color:#6366f1" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
                : '<svg viewBox="0 0 24 24" style="width:48px;height:48px;color:#94a3b8" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/></svg>';
            html += `
                <div class="file-card ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(item.path)}" data-type="file" data-media-type="${isAudioItem ? 'audio' : 'video'}">
                    <div style="position: absolute; top: 8px; left: 8px; z-index: 10;">
                        <input type="checkbox"
                               ${isSelected ? 'checked' : ''}
                               onchange="toggleVideoSelection(this.closest('.file-card').dataset.path)"
                               style="width: 18px; height: 18px; cursor: pointer;">
                    </div>
                    ${mediaBadge}
                    <div class="card-thumbnail-wrapper">
                        <div class="card-thumbnail ${isAudioItem ? 'audio' : 'video'}" ${isAudioItem ? '' : `data-thumbnail="${thumbnailUrl}"`}>
                            <!-- 缩略图将通过 JS 动态加载 -->
                            <div class="thumbnail-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
                                ${placeholderIcon}
                            </div>
                            <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                                <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="1"/>
                                    <circle cx="19" cy="12" r="1"/>
                                    <circle cx="5" cy="12" r="1"/>
                                </svg>
                            </button>
                            <!-- 卡片内部的菜单 -->
                            <div class="card-actions-menu" style="top: 44px; right: 8px; z-index: 100;">
                                <button class="action-item" data-action="rename">重命名</button>
                                <button class="action-item" data-action="move">移动</button>
                                <button class="action-item danger" data-action="delete">删除</button>
                            </div>
                        </div>
                    </div>
                    <div class="card-info">
                        <div class="card-name">${escapeHtml(item.name)}</div>
                        <div class="card-meta">${formatFileSize(item.size)}</div>
                    </div>
                </div>
            `;
        }
    });
    html += '</div>';
    return html;
}

function renderListView(items, options) {
    const mode = (options && options.mode) || 'video';
    let html = `
        <div class="list-view">
            <div class="list-header">
                <div></div>
                <div>名称</div>
                <div>大小</div>
                <div>修改时间</div>
                <div></div>
            </div>
    `;
    items.forEach(item => {
        const isAudioItem = (item.media_type === 'audio') || /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(item.name);
        const iconPath = item.type === 'directory'
            ? '<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>'
            : (isAudioItem
                ? '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'
                : '<rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/>');

        const isSelected = selectedVideoPaths.includes(item.path);
        const isVideoFile = item.type === 'file';

        html += `
            <div class="list-item" data-path="${escapeHtml(item.path)}" data-type="${item.type}" data-item-name="${escapeHtml(item.name)}" data-media-type="${isAudioItem ? 'audio' : 'video'}">
                <div class="list-icon">
                    ${isVideoFile ? `
                        <input type="checkbox"
                            ${isSelected ? 'checked' : ''}
                            onclick="event.stopPropagation(); toggleVideoSelection(this.closest('.list-item').dataset.path)"
                            style="width:18px;height:18px;cursor:pointer;margin-right:8px">
                    ` : ''}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${iconPath}
                    </svg>
                </div>
                <div class="list-name">${escapeHtml(item.name)}</div>
                <div class="list-meta">${item.type === 'directory' ? '-' : formatFileSize(item.size)}</div>
                <div class="list-meta">-</div>
                <div style="position: relative;">
                    <button class="card-actions-btn" data-item-path="${escapeHtml(item.path)}">
                        <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"/>
                            <circle cx="19" cy="12" r="1"/>
                            <circle cx="5" cy="12" r="1"/>
                        </svg>
                    </button>
                    <div class="card-actions-menu" style="top: 100%; right: 0; margin-top: 4px; z-index: 100;">
                        <button class="action-item" data-action="rename">重命名</button>
                        <button class="action-item" data-action="move">移动</button>
                        <button class="action-item danger" data-action="delete">删除</button>
                    </div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    return html;
}

function loadThumbnails() {
    document.querySelectorAll('.card-thumbnail.video').forEach(thumbnail => {
        const thumbnailUrl = thumbnail.dataset.thumbnail;
        if (!thumbnailUrl) return;

        const placeholder = thumbnail.querySelector('.thumbnail-placeholder');

        // 清理旧的 img，避免重复渲染造成堆叠
        thumbnail.querySelectorAll('img.card-thumbnail-img').forEach(old => old.remove());

        const img = document.createElement('img');
        img.className = 'card-thumbnail-img';
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        // 让 img 始终是块级且填满容器，避免与 placeholder 重叠
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;z-index:1;';

        let finished = false;
        const finish = (ok) => {
            if (finished) return;
            finished = true;
            if (ok && placeholder) {
                placeholder.style.display = 'none';
            }
        };

        img.onload = () => finish(true);
        img.onerror = () => {
            // 加载失败：移除 img，回退到 placeholder
            img.remove();
            finish(false);
        };

        img.src = thumbnailUrl;
        // 添加到缩略图容器中
        thumbnail.appendChild(img);
    });
}

// ============================
// 批量选择功能
// ============================
function toggleVideoSelection(path) {
    const index = selectedVideoPaths.indexOf(path);
    if (index > -1) {
        selectedVideoPaths.splice(index, 1);
    } else {
        selectedVideoPaths.push(path);
    }
    updateBatchToolbar();
    if (isShowingAudio) {
        loadAudioFiles();
    } else {
        renderFilesWithSelection();
    }
}

function renderFilesWithSelection() {
    // 重新渲染，但保持当前状态
    if (isShowingAudio) {
        loadAudioFiles();
    } else {
        loadFiles();
    }
}

function updateBatchToolbar() {
    const toolbar = document.getElementById('batchToolbar');
    const countSpan = document.getElementById('selectedCount');
    const batchBtn = document.getElementById('batchAnalyzeBtn');
    
    if (selectedVideoPaths.length > 0) {
        toolbar.style.display = 'flex';
        countSpan.textContent = `已选择 ${selectedVideoPaths.length} 个文件`;
        batchBtn.disabled = false;
    } else {
        toolbar.style.display = 'none';
    }
}

function toggleSelectAll() {
    const contentArea = document.getElementById('contentArea');
    const items = contentArea.querySelectorAll('.file-card[data-type="file"], .list-item[data-type="file"]');

    // 获取所有可选择路径
    const allVideoPaths = Array.from(items).map(el => el.dataset.path);

    if (selectedVideoPaths.length === allVideoPaths.length && allVideoPaths.length > 0) {
        // 全部取消选择
        selectedVideoPaths = [];
    } else {
        // 全选
        selectedVideoPaths = allVideoPaths;
    }

    updateBatchToolbar();
    renderFilesWithSelection();
}

function clearSelection() {
    selectedVideoPaths = [];
    updateBatchToolbar();
    renderFilesWithSelection();
}

// ============================
// 批量转录功能
// ============================
async function startBatchTranscribe() {
    if (selectedVideoPaths.length === 0) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/video/analyze/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: selectedVideoPaths })
        });
        const data = await response.json();
        
        if (data.success) {
            currentTranscribeTaskId = data.task_id;
            // 打开任务列表窗口
            document.getElementById('modalTasks').classList.add('show');
            // 开始轮询并刷新任务列表
            startTasksPolling();
            // 清空选择
            clearSelection();
        } else {
            alert('创建转录任务失败: ' + data.error);
        }
    } catch (error) {
        alert('创建转录任务失败: ' + error.message);
    }
}

// ============================
// 任务管理功能
// ============================
let tasksPollingInterval = null;

async function loadTasks() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/tasks`);
        const data = await response.json();
        if (data.success) {
            renderTasks(data.tasks);
        }
    } catch (error) {
        console.error('加载任务失败:', error);
    }
}

function renderTasks(tasks) {
    const container = document.getElementById('tasksList');
    
    if (tasks.length === 0) {
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: #94a3b8;">暂无任务</div>';
        return;
    }
    
    container.innerHTML = tasks.map(task => {
        const statusColors = {
            'pending': '#f59e0b',
            'running': '#3b82f6',
            'completed': '#10b981',
            'failed': '#ef4444'
        };
        
        const typeNames = {
            'batch_transcribe': '批量转录',
            'batch_url_download': '批量下载'
        };
        
        return `
            <div style="padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong>${typeNames[task.type] || task.type}</strong>
                    <span style="color: ${statusColors[task.status] || '#666'};"> ${task.status}</span>
                </div>
                <div style="margin-bottom: 8px;">
                    <div style="background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                        <div style="background: #3b82f6; height: 100%; width: ${task.progress}%; transition: width 0.3s;"></div>
                    </div>
                    <div style="margin-top: 4px; font-size: 12px; color: #666;">${task.progress}%</div>
                </div>
                <div style="font-size: 13px; color: #555; margin-bottom: 4px;">${task.message || ''}</div>
                <div style="font-size: 12px; color: #999;">
                    创建于: ${new Date(task.created_at * 1000).toLocaleString()}
                </div>
                ${task.result ? `
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">结果:</div>
                        <div style="max-height: 100px; overflow-y: auto; font-size: 12px;">
                            ${task.result.map(r => `
                                <div style="padding: 2px 0;">
                                    ${r.success ? '✅' : '❌'} ${r.filename || r.path || r.url}
                                    ${!r.success ? ` - ${r.error}` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function startTasksPolling() {
    if (!tasksPollingInterval) {
        tasksPollingInterval = setInterval(loadTasks, 2000);
    }
    loadTasks();
}

function stopTasksPolling() {
    if (tasksPollingInterval) {
        clearInterval(tasksPollingInterval);
        tasksPollingInterval = null;
    }
}

async function clearCompletedTasks() {
    try {
        await fetch(`${API_BASE_URL}/api/tasks/clear-completed`, { method: 'POST' });
        loadTasks();
    } catch (error) {
        console.error('清除任务失败:', error);
    }
}

function bindFileEvents() {
    const contentArea = document.getElementById('contentArea');
    if (!contentArea) return;
    
    // 绑定文件/目录点击事件
    document.querySelectorAll('.file-card, .list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.card-actions-btn') || e.target.closest('input')) return;
            
            const path = el.dataset.path;
            const type = el.dataset.type;
            
            if (type === 'directory') {
                navigateToPath(path);
            } else if (type === 'document') {
                // 处理文档文件点击 - 先不做具体实现
                console.log('文档点击:', path);
            } else {
                openVideoDetail(path);
            }
        });
    });
    
    // 绑定操作按钮事件
    contentArea.querySelectorAll('.card-actions-btn').forEach(btn => {
        btn.addEventListener('click', showCardActions);
    });
}

function showCardActions(event) {
    event.stopPropagation();
    const btn = event.currentTarget;
    const itemPath = btn.dataset.itemPath;
    // 获取按钮所在容器（卡片缩略图或列表项）中的菜单
    const menu = btn.nextElementSibling;
    
    // 关闭其他所有菜单
    document.querySelectorAll('.card-actions-menu').forEach(m => {
        if (m !== menu) {
            m.style.display = 'none';
        }
    });
    
    // 切换当前菜单的显示状态
    if (menu.style.display === 'block') {
        menu.style.display = 'none';
    } else {
        menu.style.display = 'block';
    }
    
    // 绑定菜单项事件
    const menuItems = menu.querySelectorAll('.action-item');
    menuItems.forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const action = item.dataset.action;
            if (action === 'rename') {
                renameFileFromCard(itemPath);
            } else if (action === 'move') {
                moveFileFromCard(itemPath);
            } else if (action === 'delete') {
                deleteFileFromCard(itemPath);
            }
            menu.style.display = 'none';
        };
    });
}

document.addEventListener('click', () => {
    document.querySelectorAll('.card-actions-menu').forEach(menu => {
        menu.style.display = 'none';
    });
});

async function loadDirectories() {
    const media_type = isShowingAudio ? 'audio' : 'video';
    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=&media_type=${media_type}`);
        const data = await response.json();

        if (data.success) {
            const dirs = data.items.filter(item => item.type === 'directory');
            const urlUploadDir = document.getElementById('urlUploadDir');
            const moveTargetDir = document.getElementById('moveTargetDir');

            if (urlUploadDir) {
                while (urlUploadDir.options.length > 1) {
                    urlUploadDir.remove(1);
                }
            }
            if (moveTargetDir) {
                while (moveTargetDir.options.length > 1) {
                    moveTargetDir.remove(1);
                }
            }

            dirs.forEach(dir => {
                if (urlUploadDir) {
                    const option1 = document.createElement('option');
                    option1.value = dir.path;
                    option1.textContent = dir.name;
                    urlUploadDir.appendChild(option1);
                }

                if (moveTargetDir) {
                    const option2 = document.createElement('option');
                    option2.value = dir.path;
                    option2.textContent = dir.name;
                    moveTargetDir.appendChild(option2);
                }
            });
        }
    } catch (error) {
        console.error('加载目录列表失败:', error);
    }
}

// ============================
// Folder Creation
// ============================
async function createFolder() {
    const name = document.getElementById('folderNameInput').value.trim();
    if (!name) return;

    const media_type = isShowingAudio ? 'audio' : 'video';
    const basePath = isShowingAudio ? currentAudioPath : currentPath;

    try {
        const response = await fetch(`${API_BASE_URL}/api/folders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: basePath, name: name, media_type })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalNewFolder').classList.remove('show');
            document.getElementById('folderNameInput').value = '';
            if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            loadDirectories();
            // 刷新侧边栏文件夹
            if (isShowingAudio) {
                loadSidebarAudioFolders();
            } else {
                loadSidebarVideoFolders();
            }
        } else {
            alert('创建失败: ' + data.error);
        }
    } catch (error) {
        alert('创建失败: ' + error.message);
    }
}

// ============================
// File Upload
// ============================
let selectedUploadFiles = [];

function handleFileSelect(e) {
    selectedUploadFiles = Array.from(e.target.files);
    updateSelectedFilesList();
}

function updateSelectedFilesList() {
    const listContainer = document.getElementById('selectedFilesList');
    const container = document.getElementById('selectedFilesContainer');
    const confirmBtn = document.getElementById('confirmUpload');
    
    if (selectedUploadFiles.length === 0) {
        listContainer.style.display = 'none';
        confirmBtn.disabled = true;
        return;
    }
    
    listContainer.style.display = 'block';
    confirmBtn.disabled = false;
    
    container.innerHTML = selectedUploadFiles.map((file, index) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee;">
            <span>${escapeHtml(file.name)} (${formatFileSize(file.size)})</span>
            <button onclick="removeSelectedFile(${index})" style="color: #ef4444; border: none; background: none; cursor: pointer;">&times;</button>
        </div>
    `).join('');
}

function removeSelectedFile(index) {
    selectedUploadFiles.splice(index, 1);
    updateSelectedFilesList();
}

async function uploadFile() {
    if (selectedUploadFiles.length === 0) return;

    const formData = new FormData();
    selectedUploadFiles.forEach(file => {
        formData.append('files', file);
    });
    const media_type = isShowingAudio ? 'audio' : 'video';
    const basePath = isShowingAudio ? currentAudioPath : currentPath;
    formData.append('path', basePath);
    formData.append('media_type', media_type);

    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressList = document.getElementById('uploadProgressList');
    progressContainer.style.display = 'block';
    progressList.innerHTML = '<div>正在上传...</div>';

    try {
        const response = await fetch(`${API_BASE_URL}/api/upload/batch`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.success) {
            progressList.innerHTML = data.results.map(r => `
                <div style="padding: 4px 0;">
                    ${r.success ? '✅' : '❌'} ${r.filename}
                    ${!r.success ? ` - ${r.error}` : ''}
                </div>
            `).join('');

            setTimeout(() => {
                document.getElementById('modalUpload').classList.remove('show');
                document.getElementById('uploadFileInput').value = '';
                selectedUploadFiles = [];
                updateSelectedFilesList();
                progressContainer.style.display = 'none';
                if (isShowingAudio) {
                    loadAudioFiles();
                } else {
                    loadFiles();
                }
            }, 1500);
        } else {
            alert('上传失败');
        }
    } catch (error) {
        alert('上传失败: ' + error.message);
    }
}

let currentUrlDownloadTaskId = null;
let urlPollingInterval = null;
let urlDownloadItems = []; // 存储带文件名的下载项

// 从URL提取文件名
function extractFilenameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        let filename = pathname.split('/').pop();
        
        // 移除查询参数
        if (filename.includes('?')) {
            filename = filename.split('?')[0];
        }
        
        // 如果没有扩展名，添加.mp4
        if (!filename.includes('.')) {
            filename += '.mp4';
        }
        
        // 清理文件名中的非法字符
        filename = filename.replace(/[<>:"/\\|?*]/g, '_');
        
        return filename;
    } catch {
        return 'video_' + Date.now() + '.mp4';
    }
}

async function uploadByUrl() {
    const targetDir = document.getElementById('urlUploadDir').value;
    const media_type = isShowingAudio ? 'audio' : 'video';

    if (urlDownloadItems.length === 0) return;

    const confirmBtn = document.getElementById('confirmUrlUpload');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '创建任务...';

    try {
        const response = await fetch(`${API_BASE_URL}/api/upload/url/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: urlDownloadItems, target_dir: targetDir, media_type })
        });
        const data = await response.json();

        if (data.success) {
            currentUrlDownloadTaskId = data.task_id;
            confirmBtn.textContent = '下载中...';
            
            // 隐藏待下载列表，显示进度
            document.getElementById('urlListContainer').style.display = 'none';
            
            // 开始轮询任务状态
            startUrlDownloadPolling();
        } else {
            alert('创建下载任务失败: ' + data.error);
            confirmBtn.disabled = false;
            confirmBtn.textContent = '批量下载';
        }
    } catch (error) {
        alert('创建下载任务失败: ' + error.message);
        confirmBtn.disabled = false;
        confirmBtn.textContent = '批量下载';
    }
}

function startUrlDownloadPolling() {
    const progressContainer = document.getElementById('batchUrlProgressContainer');
    const progressList = document.getElementById('batchUrlProgressList');
    const progressSummary = document.getElementById('downloadProgressSummary');
    progressContainer.style.display = 'block';
    
    urlPollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/tasks/${currentUrlDownloadTaskId}`);
            const data = await response.json();
            
            if (data.success) {
                const task = data.task;
                
                // 更新总进度摘要
                let completedCount = 0;
                let totalCount = 0;
                if (task.result) {
                    totalCount = task.result.length;
                    completedCount = task.result.filter(r => r.success || r.status === 'completed').length;
                }
                
                let statusText = '';
                if (task.status === 'pending') statusText = '等待中';
                else if (task.status === 'running') statusText = '下载中';
                else if (task.status === 'completed') statusText = '已完成';
                else if (task.status === 'failed') statusText = '失败';
                
                progressSummary.textContent = `${statusText} · ${task.progress}%`;
                
                // 渲染下载进度列表
                let html = '';
                
                // 如果有任务结果，按结果渲染
                if (task.result && task.result.length > 0) {
                    task.result.forEach((r, index) => {
                        const item = urlDownloadItems[index] || { filename: r.filename || r.url, url: r.url };
                        const filename = item.filename || r.filename || `文件${index + 1}`;
                        
                        let itemStatus = 'pending';
                        let progressWidth = 0;
                        let statusLabel = '等待中';
                        
                        if (r.success) {
                            itemStatus = 'completed';
                            progressWidth = 100;
                            statusLabel = '已完成';
                        } else if (r.error) {
                            itemStatus = 'failed';
                            progressWidth = 0;
                            statusLabel = '失败';
                        } else {
                            // 根据任务总进度估算当前下载项的进度
                            const itemsPerStep = Math.max(1, Math.floor(100 / task.result.length));
                            const currentStep = Math.floor(task.progress / itemsPerStep);
                            if (index < currentStep) {
                                itemStatus = 'completed';
                                progressWidth = 100;
                                statusLabel = '已完成';
                            } else if (index === currentStep) {
                                itemStatus = 'downloading';
                                progressWidth = task.progress % itemsPerStep * (100 / itemsPerStep);
                                statusLabel = '下载中';
                            } else {
                                itemStatus = 'pending';
                                progressWidth = 0;
                                statusLabel = '等待中';
                            }
                        }
                        
                        html += `
                            <div class="download-item">
                                <div class="download-item-header">
                                    <div class="download-item-name">${escapeHtml(filename)}</div>
                                    <div class="download-item-status ${itemStatus}">${statusLabel}</div>
                                </div>
                                <div class="download-progress-bar-container">
                                    <div class="download-progress-bar" style="width: ${progressWidth}%"></div>
                                </div>
                                <div class="download-item-meta">
                                    <div class="download-item-speed">
                                        <span>进度 ${Math.round(progressWidth)}%</span>
                                    </div>
                                    <div></div>
                                </div>
                                ${r.error ? `<div class="download-item-error">${escapeHtml(r.error)}</div>` : ''}
                            </div>
                        `;
                    });
                } else {
                    // 没有结果时显示基本信息
                    html += `
                        <div class="download-item">
                            <div class="download-item-header">
                                <div class="download-item-name">准备下载...</div>
                                <div class="download-item-status ${task.status === 'failed' ? 'failed' : 'downloading'}">${statusText}</div>
                            </div>
                            <div class="download-progress-bar-container">
                                <div class="download-progress-bar" style="width: ${task.progress}%"></div>
                            </div>
                            <div class="download-item-meta">
                                <div class="download-item-speed">
                                    <span>进度 ${task.progress}%</span>
                                </div>
                                <div></div>
                            </div>
                        </div>
                    `;
                }
                
                progressList.innerHTML = html;
                
                // 任务完成
                if (task.status === 'completed' || task.status === 'failed') {
                    clearInterval(urlPollingInterval);
                    
                    setTimeout(() => {
                        document.getElementById('modalUrlUpload').classList.remove('show');
                        document.getElementById('urlUploadInput').value = '';
                        urlDownloadItems = [];
                        document.getElementById('urlListContainer').style.display = 'none';
                        progressContainer.style.display = 'none';
                        const confirmBtn = document.getElementById('confirmUrlUpload');
                        confirmBtn.disabled = false;
                        confirmBtn.textContent = '批量下载';
                        loadFiles();
                    }, 3000);
                }
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 1000);
}

// 监听 URL 输入变化，显示待下载列表
function initUrlUploadInput() {
    const input = document.getElementById('urlUploadInput');
    if (input) {
        input.addEventListener('input', () => {
            const urlText = input.value.trim();
            const urls = urlText.split('\n').map(u => u.trim()).filter(u => u.length > 0);
            const listContainer = document.getElementById('urlListContainer');
            const list = document.getElementById('urlList');
            const countSpan = document.getElementById('urlListCount');
            const confirmBtn = document.getElementById('confirmUrlUpload');
            
            if (urls.length === 0) {
                listContainer.style.display = 'none';
                confirmBtn.disabled = true;
                urlDownloadItems = [];
            } else {
                // 初始化或更新urlDownloadItems
                urlDownloadItems = urls.map((url, i) => {
                    const existing = urlDownloadItems.find(item => item.url === url);
                    if (existing) {
                        return existing;
                    }
                    return {
                        url: url,
                        filename: extractFilenameFromUrl(url)
                    };
                });
                
                listContainer.style.display = 'block';
                confirmBtn.disabled = false;
                countSpan.textContent = urls.length + '个';
                
                renderUrlList();
            }
        });
    }
}

// 渲染URL列表
function renderUrlList() {
    const list = document.getElementById('urlList');
    list.innerHTML = urlDownloadItems.map((item, i) => `
        <div class="url-list-item" data-index="${i}">
            <div class="url-item-index">${i + 1}.</div>
            <div class="url-item-main">
                <div class="url-item-filename">
                    <input type="text" 
                           value="${escapeHtml(item.filename)}" 
                           data-index="${i}"
                           onchange="updateFilename(${i}, this.value)"
                           onblur="updateFilename(${i}, this.value)"
                           placeholder="文件名">
                </div>
                <div class="url-item-url">${escapeHtml(item.url.length > 60 ? item.url.substring(0, 60) + '...' : item.url)}</div>
            </div>
            <div class="url-item-actions">
                <button class="url-item-btn danger" onclick="removeUrlItem(${i})">删除</button>
            </div>
        </div>
    `).join('');
}

// 更新文件名
function updateFilename(index, newFilename) {
    if (urlDownloadItems[index]) {
        urlDownloadItems[index].filename = newFilename;
    }
}

// 删除URL项
function removeUrlItem(index) {
    urlDownloadItems.splice(index, 1);
    
    // 更新textarea
    const input = document.getElementById('urlUploadInput');
    input.value = urlDownloadItems.map(item => item.url).join('\n');
    
    // 重新渲染
    if (urlDownloadItems.length === 0) {
        document.getElementById('urlListContainer').style.display = 'none';
        document.getElementById('confirmUrlUpload').disabled = true;
    } else {
        document.getElementById('urlListCount').textContent = urlDownloadItems.length + '个';
        renderUrlList();
    }
}

// ============================
// Video Detail
// ============================
function isAudioPath(path) {
    if (!path) return false;
    return /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(path);
}

async function openVideoDetail(path) {
    const isAudio = isAudioPath(path);
    currentVideo = { path, media_type: isAudio ? 'audio' : 'video' };
    document.getElementById('detailPanel').classList.add('show');
    document.getElementById('detailName').textContent = path.split(/[\\/]/).pop();

    // 详情面板标题：音频显示"音频详情"，视频保持"视频详情"
    const detailPanelTitle = document.getElementById('detailPanelTitle');
    if (detailPanelTitle) {
        detailPanelTitle.textContent = isAudio ? '音频详情' : '视频详情';
    }

    // 占位提示文本：音频显示"音频转录"，视频保持"视频转录"
    const transcribeLabel = isAudio ? '音频转录' : '视频转录';
    document.getElementById('summaryContent').innerHTML = `点击「${transcribeLabel}」获取原文，然后生成总结`;
    document.getElementById('notesContent').innerHTML = '<p>暂无笔记</p>';
    document.getElementById('outlineContent').innerHTML = '<p>暂无大纲</p>';
    document.getElementById('textContent').textContent = `暂无内容，点击「${transcribeLabel}」开始`;

    // 切换播放器：视频用 <video>，音频用 <audio>
    const videoEl = document.querySelector('#videoPlayer video');
    const audioEl = document.getElementById('audioPlayer');
    if (isAudio) {
        if (videoEl) videoEl.style.display = 'none';
        if (audioEl) {
            audioEl.style.display = 'block';
            const pathForUrl = path.replace(/\\/g, '/');
            audioEl.src = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?media_type=audio`;
        }
        // 音频文件按"音频转录"命名按钮
        const btnAnalyze = document.getElementById('btnAnalyze');
        if (btnAnalyze) {
            const lastSpan = btnAnalyze.querySelector('span') || btnAnalyze;
            // 直接修改文本（保留 SVG）
            const textNode = Array.from(btnAnalyze.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
            if (textNode) {
                textNode.textContent = '音频转录';
            } else {
                // 简单替换：直接覆盖按钮的最后一个文本
                btnAnalyze.innerHTML = btnAnalyze.innerHTML.replace('视频转录', '音频转录');
            }
        }
    } else {
        if (audioEl) {
            audioEl.pause();
            audioEl.removeAttribute('src');
            audioEl.style.display = 'none';
        }
        if (videoEl) {
            videoEl.style.display = 'block';
            try {
                const pathForUrl = path.replace(/\\/g, '/');
                const videoUrl = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?media_type=video`;
                videoEl.src = videoUrl;
            } catch (e) {}
        }
        const btnAnalyze = document.getElementById('btnAnalyze');
        if (btnAnalyze) {
            const textNode = Array.from(btnAnalyze.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
            if (textNode) {
                textNode.textContent = '视频转录';
            } else {
                btnAnalyze.innerHTML = btnAnalyze.innerHTML.replace('音频转录', '视频转录');
            }
        }
    }

    await loadAnalysisResults(path);
}

async function loadAnalysisResults(videoPath) {
    const videoFullPath = videoPath;
    const baseName = videoFullPath.replace(/\.[^/.]+$/, '');
    const mediaType = (currentVideo && currentVideo.media_type) || (isAudioPath(videoPath) ? 'audio' : 'video');

    ['summary', 'notes', 'outline'].forEach(async type => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/analysis/result?video_path=${encodeURIComponent(videoPath)}&type=${type}&media_type=${mediaType}`);
            const data = await response.json();

            if (data.success && data.content) {
                const el = document.getElementById(type + 'Content');
                if (el) {
                    try {
                        if (typeof marked !== 'undefined' && marked.parse) {
                            el.innerHTML = marked.parse(data.content);
                        } else {
                            el.innerHTML = simpleMarkdownToHtml(data.content);
                        }
                    } catch (e) {
                        el.innerHTML = simpleMarkdownToHtml(data.content);
                    }
                }
            }
        } catch (e) {
        }
    });

    // 处理原文（subtitle），直接显示文本
    try {
        const response = await fetch(`${API_BASE_URL}/api/analysis/result?video_path=${encodeURIComponent(videoPath)}&type=subtitle&media_type=${mediaType}`);
        const data = await response.json();

        if (data.success && data.content) {
            const el = document.getElementById('textContent');
            if (el) {
                el.textContent = data.content;
            }
        }
    } catch (e) {
    }
}

// ============================
// Video Analysis
// ============================
async function analyzeVideo() {
    if (!currentVideo) return;

    const progressBar = document.getElementById('analyzeProgress');
    const progressFill = progressBar.querySelector('.progress-fill');
    const progressMessage = document.getElementById('analyzeProgressMessage');
    const btn = document.getElementById('btnAnalyze');
    
    try {
        // 显示进度条，禁用按钮
        progressBar.style.display = 'block';
        progressMessage.style.display = 'block';
        btn.disabled = true;
        progressFill.style.width = '0%';
        progressMessage.textContent = '准备开始...';
        
        const response = await fetch(`${API_BASE_URL}/api/video/analyze?path=${encodeURIComponent(currentVideo.path)}&media_type=${currentVideo.media_type || 'video'}`, {
            method: 'POST'
        });
        const data = await response.json();
        
        if (data.success && data.task_id) {
            // 轮询任务进度
            const taskId = data.task_id;
            await pollTaskProgress(taskId);
        } else {
            alert('分析失败: ' + (data.error || '未知错误'));
            progressBar.style.display = 'none';
            progressMessage.style.display = 'none';
            btn.disabled = false;
        }
    } catch (error) {
        alert('分析失败: ' + error.message);
        progressBar.style.display = 'none';
        progressMessage.style.display = 'none';
        btn.disabled = false;
    }
}

async function pollTaskProgress(taskId) {
    const progressBar = document.getElementById('analyzeProgress');
    const progressFill = progressBar.querySelector('.progress-fill');
    const progressMessage = document.getElementById('analyzeProgressMessage');
    const btn = document.getElementById('btnAnalyze');
    
    let pollInterval;
    
    try {
        pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/tasks/${taskId}`);
                const data = await response.json();
                
                if (data.success && data.task) {
                    const task = data.task;
                    
                    // 更新进度条
                    progressFill.style.width = `${task.progress || 0}%`;
                    progressMessage.textContent = task.message || '处理中...';
                    
                    // 任务完成或失败
                    if (task.status === 'completed') {
                        clearInterval(pollInterval);
                        progressBar.style.display = 'none';
                        progressMessage.style.display = 'none';
                        btn.disabled = false;
                        
                        if (task.result) {
                            // 加载结果
                            await loadAnalysisResults(currentVideo.path);
                        }
                    } else if (task.status === 'failed') {
                        clearInterval(pollInterval);
                        progressBar.style.display = 'none';
                        progressMessage.style.display = 'none';
                        btn.disabled = false;
                        alert('处理失败: ' + (task.message || '未知错误'));
                    }
                }
            } catch (error) {
                console.error('查询任务进度失败:', error);
            }
        }, 500); // 每500ms查询一次
    } catch (error) {
        clearInterval(pollInterval);
        progressBar.style.display = 'none';
        btn.disabled = false;
        alert('查询进度失败: ' + error.message);
    }
}

async function generateSummary() {
    if (!currentVideo) return;

    const progress = document.getElementById('genSummaryProgress');
    const btn = document.getElementById('btnGenSummary');
    
    progress.classList.add('show');
    btn.disabled = true;

    try {
        const payload = { video_path: currentVideo.path, media_type: currentVideo.media_type || 'video' };
        if (appConfig.currentModel) {
            payload.model = appConfig.currentModel;
        }
        const response = await fetch(`${API_BASE_URL}/api/analysis/generate-summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.success) {
            const el = document.getElementById('summaryContent');
            if (data.content) {
                try {
                    if (typeof marked !== 'undefined' && marked.parse) {
                        el.innerHTML = marked.parse(data.content);
                    } else {
                        el.innerHTML = simpleMarkdownToHtml(data.content);
                    }
                } catch (e) {
                    el.innerHTML = simpleMarkdownToHtml(data.content);
                }
            }
        } else {
            alert('生成失败: ' + data.error);
        }
    } catch (error) {
        alert('生成失败: ' + error.message);
    } finally {
        progress.classList.remove('show');
        btn.disabled = false;
    }
}

async function generateNotes() {
    if (!currentVideo) return;

    const progress = document.getElementById('genNotesProgress');
    const btn = document.getElementById('btnGenNotes');
    
    progress.classList.add('show');
    btn.disabled = true;

    try {
        const payload = { video_path: currentVideo.path, media_type: currentVideo.media_type || 'video' };
        if (appConfig.currentModel) {
            payload.model = appConfig.currentModel;
        }
        const response = await fetch(`${API_BASE_URL}/api/analysis/generate-notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.success) {
            const el = document.getElementById('notesContent');
            if (data.content) {
                try {
                    if (typeof marked !== 'undefined' && marked.parse) {
                        el.innerHTML = marked.parse(data.content);
                    } else {
                        el.innerHTML = simpleMarkdownToHtml(data.content);
                    }
                } catch (e) {
                    el.innerHTML = simpleMarkdownToHtml(data.content);
                }
            }
        } else {
            alert('生成失败: ' + data.error);
        }
    } catch (error) {
        alert('生成失败: ' + error.message);
    } finally {
        progress.classList.remove('show');
        btn.disabled = false;
    }
}

async function generateOutline() {
    if (!currentVideo) return;

    const progress = document.getElementById('genOutlineProgress');
    const btn = document.getElementById('btnGenOutline');
    
    progress.classList.add('show');
    btn.disabled = true;

    try {
        const payload = { video_path: currentVideo.path, media_type: currentVideo.media_type || 'video' };
        if (appConfig.currentModel) {
            payload.model = appConfig.currentModel;
        }
        const response = await fetch(`${API_BASE_URL}/api/analysis/generate-outline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.success) {
            const el = document.getElementById('outlineContent');
            if (data.content) {
                try {
                    if (typeof marked !== 'undefined' && marked.parse) {
                        el.innerHTML = marked.parse(data.content);
                    } else {
                        el.innerHTML = simpleMarkdownToHtml(data.content);
                    }
                } catch (e) {
                    el.innerHTML = simpleMarkdownToHtml(data.content);
                }
            }
        } else {
            alert('生成失败: ' + data.error);
        }
    } catch (error) {
        alert('生成失败: ' + error.message);
    } finally {
        progress.classList.remove('show');
        btn.disabled = false;
    }
}

// ============================
// File Operations
// ============================
// 根据被操作的项的旧路径与新路径，更新当前路径（如果当前路径等于被操作项，或在被操作项之下）
function computePathAfterOperation(oldItemPath, newItemPath) {
    const isAudio = isShowingAudio;
    const current = isAudio ? currentAudioPath : currentPath;
    if (!current || !oldItemPath) return current;
    const oldPrefix = oldItemPath.endsWith('/') ? oldItemPath : oldItemPath + '/';
    if (current === oldItemPath) {
        return newItemPath || '';
    }
    if (current.startsWith(oldPrefix)) {
        const suffix = current.slice(oldPrefix.length);
        if (!newItemPath) return suffix;
        return suffix ? `${newItemPath}/${suffix}` : newItemPath;
    }
    return current;
}

// 同步侧边栏与当前路径状态
function refreshAfterStructureChange() {
    if (isShowingAudio) {
        loadSidebarAudioFolders();
    } else {
        loadSidebarVideoFolders();
    }
    updateSidebarActiveState();
}

function renameFileFromCard(path) {
    document.getElementById('renameInput').value = path.split('/').pop();
    document.getElementById('modalRename').dataset.path = path;
    document.getElementById('modalRename').classList.add('show');
}

async function renameFile() {
    const path = document.getElementById('modalRename').dataset.path;
    const newName = document.getElementById('renameInput').value.trim();
    if (!path || !newName) return;

    const media_type = isShowingAudio ? 'audio' : 'video';

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, new_name: newName, media_type })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalRename').classList.remove('show');
            // 计算被重命名项的新路径（父目录不变，仅替换最后一段）
            const segments = path.split('/').filter(Boolean);
            segments[segments.length - 1] = newName;
            const newItemPath = segments.join('/');
            const newCurrent = computePathAfterOperation(path, newItemPath);
            if (isShowingAudio) {
                currentAudioPath = newCurrent;
            } else {
                currentPath = newCurrent;
            }
            if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            refreshAfterStructureChange();
        } else {
            alert('重命名失败: ' + data.error);
        }
    } catch (error) {
        alert('重命名失败: ' + error.message);
    }
}

function moveFileFromCard(path) {
    document.getElementById('modalMove').dataset.path = path;
    document.getElementById('modalMove').classList.add('show');
}

async function moveFile() {
    const path = document.getElementById('modalMove').dataset.path;
    const targetDir = document.getElementById('moveTargetDir').value;
    if (!path) return;

    const media_type = isShowingAudio ? 'audio' : 'video';

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, target_dir: targetDir, media_type })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalMove').classList.remove('show');
            // 计算移动后的新路径
            const oldName = path.split('/').filter(Boolean).pop() || '';
            const newItemPath = targetDir ? `${targetDir}/${oldName}` : oldName;
            const newCurrent = computePathAfterOperation(path, newItemPath);
            if (isShowingAudio) {
                currentAudioPath = newCurrent;
            } else {
                currentPath = newCurrent;
            }
            if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            refreshAfterStructureChange();
        } else {
            alert('移动失败: ' + data.error);
        }
    } catch (error) {
        alert('移动失败: ' + error.message);
    }
}

async function deleteFileFromCard(path) {
    selectedItems = [path];
    await renderDeleteModal(path);
    document.getElementById('modalDelete').classList.add('show');
}

async function renderDeleteModal(path) {
    const modal = document.getElementById('modalDelete');
    const titleEl = document.getElementById('deleteModalTitle');
    const descEl = document.getElementById('deleteModalDesc');
    if (!modal || !titleEl || !descEl) return;

    // 兜底：使用 card 上保存的 data-item-name（如果存在）
    let itemName = '';
    try {
        const card = document.querySelector(
            `.file-card[data-type][data-path="${CSS.escape(path)}"], .list-item[data-type][data-path="${CSS.escape(path)}"]`
        );
        if (card && card.dataset.itemName) itemName = card.dataset.itemName;
    } catch (e) { /* CSS.escape 在旧浏览器可能不存在，回退到已存在的 name */ }
    if (!itemName) {
        // 取路径最后一段作为兜底名称
        itemName = (path || '').split('/').filter(Boolean).pop() || path || '该项';
    }

    // 先用兜底文案显示，避免空白
    titleEl.textContent = '确认删除';
    descEl.textContent = `确定要删除「${itemName}」吗？此操作不可撤销。`;
    modal.dataset.path = path;
    modal.dataset.itemName = itemName;
    modal.dataset.itemType = '';

    const media_type = isShowingAudio ? 'audio' : 'video';
    try {
        const response = await fetch(
            `${API_BASE_URL}/api/item/count?path=${encodeURIComponent(path)}&media_type=${media_type}`
        );
        const data = await response.json();
        if (!data.success) return; // 保留兜底文案

        const realName = data.name || itemName;
        modal.dataset.itemName = realName;
        modal.dataset.itemType = data.type;

        if (data.type === 'directory') {
            titleEl.textContent = '确认删除文件夹';
            const count = data.count || 0;
            descEl.textContent = `将永久删除文件夹「${realName}」及其内的 ${count} 个文件，此操作不可撤销。`;
        } else {
            titleEl.textContent = '确认删除文件';
            descEl.textContent = `将永久删除文件「${realName}」，此操作不可撤销。`;
        }
    } catch (error) {
        console.error('渲染删除弹窗失败:', error);
        // 保留兜底文案
    }
}

async function deleteSelected() {
    if (selectedItems.length === 0) return;

    const media_type = isShowingAudio ? 'audio' : 'video';
    const path = selectedItems[0];

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, media_type })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalDelete').classList.remove('show');
            selectedItems = [];
            if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
            // 删除目录时刷新侧边栏
            if (data.deleted_type === 'directory') {
                if (isShowingAudio) {
                    loadSidebarAudioFolders();
                } else {
                    loadSidebarVideoFolders();
                }
            }
        } else {
            alert('删除失败: ' + data.error);
        }
    } catch (error) {
        alert('删除失败: ' + error.message);
    }
}

// ============================
// Model Selection
// ============================
function openModelSelectModal() {
    selectedModel = null;
    document.getElementById('confirmModelSelect').disabled = true;
    document.getElementById('modelSearchInput').value = '';
    document.getElementById('modalModelSelect').classList.add('show');
    loadModels();
}

async function loadModels() {
    const modelListEl = document.getElementById('modelList');
    modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">加载中...</div>';
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/models?provider=${appConfig.activeProvider}`);
        const data = await response.json();
        
        if (data.success) {
            allModels = data.models;
            renderModelList(allModels);
        } else {
            modelListEl.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">${data.error || '加载失败'}</div>`;
        }
    } catch (error) {
        console.error('加载模型失败:', error);
        modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444">加载失败</div>';
    }
}

function renderModelList(models, searchQuery = '') {
    const modelListEl = document.getElementById('modelList');
    const filteredModels = models.filter(m => 
        m.id.toLowerCase().includes((searchQuery || '').toLowerCase())
    );

    if (filteredModels.length === 0) {
        modelListEl.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">暂无模型</div>';
        return;
    }

    modelListEl.innerHTML = filteredModels.map(model => `
        <div class="model-item ${selectedModel === model.id ? 'selected' : ''}" data-id="${model.id}">
            <div class="model-item-name">${model.id}</div>
            <div class="model-item-meta">${model.owned_by || ''}</div>
        </div>
    `).join('');

    document.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
            selectedModel = item.dataset.id;
            document.querySelectorAll('.model-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            document.getElementById('confirmModelSelect').disabled = false;
        });
    });
}

function confirmModelSelect() {
    if (!selectedModel) return;
    appConfig.currentModel = selectedModel;
    saveAppConfig();
    updateModelDisplay();
    document.getElementById('modalModelSelect').classList.remove('show');
}

// ============================
// API Settings
// ============================
async function openSettingsModal() {
    document.getElementById('modalSettings').classList.add('show');
    await loadConfigFromServer();
}

async function loadConfigFromServer() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        if (data.success) {
            currentConfig = data.config;
            const activeProvider = currentConfig.active_provider || 'open-ai';
            editingProvider = activeProvider;
            // 同步 provider tab 激活状态
            document.querySelectorAll('.provider-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.provider === activeProvider);
            });
            loadProviderConfig(activeProvider);
        }
    } catch (e) {
        console.error('Load config failed:', e);
    }
}

function loadProviderConfig(providerId) {
    const provider = currentConfig.providers[providerId];
    if (!provider) return;

    const urlInput = document.getElementById('configApiUrl');
    const keyInput = document.getElementById('configApiKey');
    const modelsUrlInput = document.getElementById('configModelsUrl');
    const modelSelect = document.getElementById('configDefaultModel');

    if (urlInput) urlInput.value = provider.api_url || '';
    if (keyInput) keyInput.value = provider.api_key ? '***' : '';
    if (modelsUrlInput) modelsUrlInput.value = provider.models_url || '';

    // 1. 填充模型下拉框选项
    loadModelSelectModels(providerId);

    // 2. 渲染模型列表表格
    renderModelsTable(providerId);

    // 3. 设置默认模型的选中值
    if (modelSelect) modelSelect.value = provider.default_model || '';
}

function loadModelSelectModels(providerId) {
    const modelSelect = document.getElementById('configDefaultModel');
    if (!modelSelect) return;

    modelSelect.innerHTML = '<option value="">请选择默认模型</option>';

    const provider = currentConfig.providers[providerId];
    if (provider && Array.isArray(provider.models) && provider.models.length > 0) {
        provider.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name || model.id;
            modelSelect.appendChild(option);
        });
        if (provider.default_model) {
            modelSelect.value = provider.default_model;
        }
    }
}

function renderModelsTable(providerId) {
    const tbody = document.getElementById('configModelsTbody');
    const emptyEl = document.getElementById('configModelsEmpty');
    if (!tbody || !emptyEl) return;

    const provider = currentConfig.providers[providerId] || { models: [] };
    const models = provider.models || [];
    tbody.innerHTML = '';

    if (models.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    models.forEach((model, idx) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #f1f5f9';
        tr.innerHTML = `
            <td style="padding:6px 10px;">
                <input type="text" data-field="id" data-index="${idx}" value="${escapeAttr(model.id || '')}" placeholder="模型 ID（必填）" style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
            </td>
            <td style="padding:6px 10px;">
                <input type="text" data-field="name" data-index="${idx}" value="${escapeAttr(model.name || '')}" placeholder="显示名称（可空）" style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
            </td>
            <td style="padding:6px 10px;text-align:center;">
                <button type="button" class="config-model-delete-btn" data-index="${idx}" title="删除" style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:13px;padding:4px 8px;">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.config-model-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.dataset.index, 10);
            removeModelRow(idx);
        });
    });
}

function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function switchProviderTab(providerId) {
    // 切 tab 时直接切换，不做复杂保存
    editingProvider = providerId;
    document.querySelectorAll('.provider-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.provider === providerId);
    });
    loadProviderConfig(providerId);
}

function getCurrentEditingProviderId() {
    const activeTab = document.querySelector('.provider-tab.active');
    return activeTab ? activeTab.dataset.provider : (currentConfig.active_provider || 'open-ai');
}

function addModelRow() {
    const providerId = getCurrentEditingProviderId();
    if (!currentConfig.providers[providerId]) currentConfig.providers[providerId] = {};
    if (!currentConfig.providers[providerId].models) currentConfig.providers[providerId].models = [];
    currentConfig.providers[providerId].models.push({
        id: '', name: '', created: 0, owned_by: ''
    });
    renderModelsTable(providerId);
    loadModelSelectModels(providerId);
}

function removeModelRow(idx) {
    const providerId = getCurrentEditingProviderId();
    const provider = currentConfig.providers[providerId];
    if (!provider || !Array.isArray(provider.models)) return;
    provider.models.splice(idx, 1);
    renderModelsTable(providerId);
    loadModelSelectModels(providerId);
}

async function fetchModels() {
    const activeTab = document.querySelector('.provider-tab.active');
    const providerId = activeTab ? activeTab.dataset.provider : null;
    const apiUrl = document.getElementById('configApiUrl')?.value;
    const apiKey = document.getElementById('configApiKey')?.value;
    const modelsUrl = document.getElementById('configModelsUrl')?.value;

    if (!apiKey) { alert('请先填写 API 密钥'); return; }
    if (!apiUrl && !modelsUrl) { alert('请先填写 API 地址或模型列表 URL'); return; }

    const btn = document.getElementById('fetchModelsBtn');
    const originalText = btn.textContent;
    btn.textContent = '获取中...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/knowledge/models/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_url: apiUrl || '',
                api_key: apiKey,
                models_url: modelsUrl || ''
            })
        });
        const data = await response.json();
        if (data.success) {
            await saveModelsToProvider(providerId, data.models);
            loadModelSelectModels(providerId);
            renderModelsTable(providerId);
            // 通知聊天界面刷新
            if (window.knowledgePage && typeof window.knowledgePage.loadModels === 'function') {
                await window.knowledgePage.loadModels();
            }
            alert('成功获取并保存 ' + data.models.length + ' 个模型！');
        } else {
            alert('获取模型失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('获取模型失败：' + e.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function saveModelsToProvider(providerId, models) {
    if (!currentConfig.providers[providerId]) currentConfig.providers[providerId] = {};
    currentConfig.providers[providerId].models = models;

    try {
        await fetch('/api/knowledge/models/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider_id: providerId,
                models: models
            })
        });
    } catch (e) {
        console.error('保存模型失败', e);
    }
}

async function saveModelsFromTable() {
    const providerId = getCurrentEditingProviderId();
    const tbody = document.getElementById('configModelsTbody');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr');
    const newModels = [];
    const seenIds = new Set();
    for (const tr of rows) {
        const idInput = tr.querySelector('input[data-field="id"]');
        const nameInput = tr.querySelector('input[data-field="name"]');
        const id = (idInput?.value || '').trim();
        const name = (nameInput?.value || '').trim();
        if (!id) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        newModels.push({ id, name: name || id, created: 0, owned_by: '' });
    }

    const btn = document.getElementById('saveModelsBtn');
    const originalText = btn?.textContent;
    if (btn) { btn.textContent = '保存中...'; btn.disabled = true; }

    try {
        const resp = await fetch('/api/knowledge/models/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider_id: providerId, models: newModels })
        });
        const data = await resp.json();
        if (data.success) {
            if (!currentConfig.providers[providerId]) currentConfig.providers[providerId] = {};
            currentConfig.providers[providerId].models = newModels;
            renderModelsTable(providerId);
            loadModelSelectModels(providerId);
            if (window.knowledgePage && typeof window.knowledgePage.loadModels === 'function') {
                await window.knowledgePage.loadModels();
            }
            alert('模型列表已保存（' + newModels.length + ' 个）');
        } else {
            alert('保存失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    } finally {
        if (btn) { btn.textContent = originalText || '保存模型列表'; btn.disabled = false; }
    }
}

async function saveSettings() {
    const activeTab = document.querySelector('.provider-tab.active');
    const currentEditingProvider = activeTab ? activeTab.dataset.provider : (currentConfig.active_provider || 'open-ai');

    const providers = JSON.parse(JSON.stringify(currentConfig.providers || {}));

    // 从表单读取最新值（包括 models_url 和 default_model）
    const finalModel = document.getElementById('configDefaultModel')?.value || '';
    const modelsUrl = document.getElementById('configModelsUrl')?.value || '';

    if (!providers[currentEditingProvider]) providers[currentEditingProvider] = {};
    providers[currentEditingProvider] = {
        ...providers[currentEditingProvider],
        api_url: document.getElementById('configApiUrl')?.value || '',
        api_key: document.getElementById('configApiKey')?.value || '',
        models_url: modelsUrl,
        default_model: finalModel
    };

    try {
        const response = await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providers: providers,
                active_provider: currentEditingProvider,
                set_initialized: true
            })
        });
        const data = await response.json();
        if (data.success) {
            currentConfig.active_provider = currentEditingProvider;
            currentConfig.providers = providers;
            currentConfig.initialized = true;
            // 同步到 localStorage 的 appConfig
            appConfig.activeProvider = currentEditingProvider;
            if (providers[currentEditingProvider]) {
                const p = providers[currentEditingProvider];
                appConfig.providers[currentEditingProvider] = {
                    ...(appConfig.providers[currentEditingProvider] || {}),
                    name: p.name || appConfig.providers[currentEditingProvider]?.name || '',
                    apiUrl: p.api_url || '',
                    apiKey: p.api_key || '',
                    defaultModel: p.default_model || ''
                };
                if (p.default_model) appConfig.currentModel = p.default_model;
            }
            saveAppConfig();
            updateModelDisplay();
            document.getElementById('modalSettings').classList.remove('show');
            alert('保存成功！');
        } else {
            alert('保存失败：' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败：' + e.message);
    }
}

// ============================
// Event Binding
// ============================
function bindEvents() {
    // 初始化 URL 上传输入监听
    initUrlUploadInput();
    
    // Page navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => switchPage(link.dataset.page));
    });

    // Sidebar menu
    document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // 父菜单（展开/收起）由 bindParentMenuToggles 用事件委托统一处理
            if (item.classList.contains('menu-item-parent')) {
                return;
            }

            // 检查是否是文档子菜单（有 data-doc-type 属性）
            if (item.dataset.docType !== undefined) {
                e.stopPropagation();
                // 只移除子菜单项的 active 类，排除父菜单项
                document.querySelectorAll('.menu-item:not(.menu-item-parent)').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                
                // 获取文档类型
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
                
                // 加载对应类型的文档
                loadDocuments(docType);
                return;
            }
        });
    });
    
    // 视频/音频子菜单事件绑定
    bindSidebarEvents();

    // 父菜单点击（事件委托，处理音频父菜单在部分浏览器不响应的问题）
    bindParentMenuToggles();

    // View toggle
    const viewCardsBtn = document.getElementById('viewCards');
    const viewListBtn = document.getElementById('viewList');
    if (viewCardsBtn) {
        viewCardsBtn.addEventListener('click', () => {
            currentView = 'cards';
            viewCardsBtn.classList.add('active');
            viewListBtn.classList.remove('active');
            if (isShowingDocuments) {
                loadDocuments(currentDocType);
            } else if (isShowingAudio) {
                loadAudioFiles();
            } else {
                loadFiles();
            }
        });
    }
    if (viewListBtn) {
        viewListBtn.addEventListener('click', () => {
            currentView = 'list';
            viewListBtn.classList.add('active');
            viewCardsBtn.classList.remove('active');
            if (isShowingDocuments) {
                loadDocuments(currentDocType);
            } else if (isShowingAudio) {
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
            if (isShowingDocuments) {
                loadDocuments(currentDocType);
            } else if (isShowingAudio) {
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

    // 任务列表按钮
    const viewTasksBtn = document.getElementById('viewTasksBtn');
    if (viewTasksBtn) {
        viewTasksBtn.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.add('show');
            startTasksPolling();
        });
    }

    // 任务列表模态框关闭
    const closeTasksModalBtn = document.getElementById('closeTasksModal');
    if (closeTasksModalBtn) {
        closeTasksModalBtn.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.remove('show');
            stopTasksPolling();
        });
    }

    // 清除已完成任务
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
            modal.classList.remove('show');
            // 关闭任务列表时停止轮询
            if (modal.id === 'modalTasks') {
                stopTasksPolling();
            }
        });
    });

    // New folder confirm
    const confirmNewFolderBtn = document.getElementById('confirmNewFolder');
    if (confirmNewFolderBtn) {
        confirmNewFolderBtn.addEventListener('click', createFolder);
    }
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
            document.getElementById('uploadFileInput').click();
        });
    }
    const uploadFileInput = document.getElementById('uploadFileInput');
    if (uploadFileInput) {
        uploadFileInput.addEventListener('change', handleFileSelect);
    }
    const confirmUploadBtn = document.getElementById('confirmUpload');
    if (confirmUploadBtn) {
        confirmUploadBtn.addEventListener('click', uploadFile);
    }
    const cancelUploadBtn = document.getElementById('cancelUpload');
    if (cancelUploadBtn) {
        cancelUploadBtn.addEventListener('click', () => {
            document.getElementById('modalUpload').classList.remove('show');
            document.getElementById('uploadFileInput').value = '';
            selectedUploadFiles = [];
            updateSelectedFilesList();
        });
    }

    // URL upload confirm
    const confirmUrlUploadBtn = document.getElementById('confirmUrlUpload');
    if (confirmUrlUploadBtn) {
        confirmUrlUploadBtn.addEventListener('click', uploadByUrl);
    }
    const cancelUrlUploadBtn = document.getElementById('cancelUrlUpload');
    if (cancelUrlUploadBtn) {
        cancelUrlUploadBtn.addEventListener('click', () => {
            document.getElementById('modalUrlUpload').classList.remove('show');
            document.getElementById('urlUploadInput').value = '';
            if (urlPollingInterval) {
                clearInterval(urlPollingInterval);
                urlPollingInterval = null;
            }
        });
    }

    // Delete confirm
    const confirmDeleteBtn = document.getElementById('confirmDelete');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', deleteSelected);
    }
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
    if (btnAnalyze) {
        btnAnalyze.addEventListener('click', analyzeVideo);
    }

    // Generate buttons
    const btnGenSummary = document.getElementById('btnGenSummary');
    if (btnGenSummary) btnGenSummary.addEventListener('click', generateSummary);
    
    const btnGenNotes = document.getElementById('btnGenNotes');
    if (btnGenNotes) btnGenNotes.addEventListener('click', generateNotes);
    
    const btnGenOutline = document.getElementById('btnGenOutline');
    if (btnGenOutline) btnGenOutline.addEventListener('click', generateOutline);

    // Rename modal functionality (still used by card actions)
    const cancelRenameBtn = document.getElementById('cancelRename');
    if (cancelRenameBtn) {
        cancelRenameBtn.addEventListener('click', () => {
            document.getElementById('modalRename').classList.remove('show');
            document.getElementById('renameInput').value = '';
        });
    }
    const confirmRenameBtn = document.getElementById('confirmRename');
    if (confirmRenameBtn) {
        confirmRenameBtn.addEventListener('click', renameFile);
    }

    // Move modal functionality (still used by card actions)
    const cancelMoveBtn = document.getElementById('cancelMove');
    if (cancelMoveBtn) {
        cancelMoveBtn.addEventListener('click', () => {
            document.getElementById('modalMove').classList.remove('show');
        });
    }
    const confirmMoveBtn = document.getElementById('confirmMove');
    if (confirmMoveBtn) {
        confirmMoveBtn.addEventListener('click', moveFile);
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)).classList.add('active');
        });
    });

    // Model selection
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
            renderModelList(allModels, e.target.value);
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
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', saveSettings);
    }
    const toggleApiKeyBtn = document.getElementById('toggleApiKeyVisibility');
    if (toggleApiKeyBtn) {
        toggleApiKeyBtn.addEventListener('click', function() {
            const input = document.getElementById('configApiKey');
            if (input) {
                input.type = input.type === 'password' ? 'text' : 'password';
            }
        });
    }
    const fetchModelsBtn = document.getElementById('fetchModelsBtn');
    if (fetchModelsBtn) {
        fetchModelsBtn.addEventListener('click', fetchModels);
    }
    const addModelBtn = document.getElementById('addModelBtn');
    if (addModelBtn) {
        addModelBtn.addEventListener('click', addModelRow);
    }
    const saveModelsBtn = document.getElementById('saveModelsBtn');
    if (saveModelsBtn) {
        saveModelsBtn.addEventListener('click', saveModelsFromTable);
    }
}

// ============================
// Initialize
// ============================
document.addEventListener('DOMContentLoaded', () => {
    loadAppConfig();
    bindEvents();
    bindChartControls();
    initGreeting();
    
    // 并行加载所有数据
    Promise.all([
        loadStats(),
        loadDashboardCharts(),
        loadRecentActivity()
    ]);
    
    // 加载侧边栏视频文件夹
    loadSidebarVideoFolders();
    // 初始化路径导航
    updatePathNav();
});