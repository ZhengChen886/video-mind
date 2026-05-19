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
let currentDocType = 'all';
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
            loadFiles();
            loadDirectories();
        } else if (pageName === 'knowledge') {
            if (window.KnowledgeApp) {
                KnowledgeApp.init();
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
    await loadDistributionChart();
    await loadTrendsChart(7);
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
    const searchQuery = document.getElementById('searchInput').value.toLowerCase();
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=${encodeURIComponent(currentPath)}`);
        const data = await response.json();
        
        if (data.success) {
            renderFiles(data.items, searchQuery);
        }
    } catch (error) {
        console.error('加载文件失败:', error);
        renderFiles([], '');
    }
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

function renderFiles(items, searchQuery) {
    const contentArea = document.getElementById('contentArea');
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
        contentArea.innerHTML = renderCardsView(filteredItems);
        // 加载缩略图
        setTimeout(loadThumbnails, 100);
    } else {
        contentArea.innerHTML = renderListView(filteredItems);
    }

    bindFileEvents();
}

function renderCardsView(items) {
    let html = '<div class="cards-view">';
    items.forEach(item => {
        if (item.type === 'directory') {
            html += `
                <div class="file-card" data-path="${escapeHtml(item.path)}" data-type="directory">
                    <div class="card-thumbnail">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
                        </svg>
                    </div>
                    <div class="card-info">
                        <div class="card-name">${escapeHtml(item.name)}</div>
                    </div>
                </div>
            `;
        } else {
            // 构建缩略图 URL，将反斜杠替换为正斜杠
            const pathForUrl = item.path.replace(/\\/g, '/');
            const thumbnailUrl = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?thumbnail=true`;
            const isSelected = selectedVideoPaths.includes(item.path);
            html += `
                <div class="file-card ${isSelected ? 'selected' : ''}" data-path="${escapeHtml(item.path)}" data-type="file">
                    <div style="position: absolute; top: 8px; left: 8px; z-index: 10;">
                        <input type="checkbox" 
                               ${isSelected ? 'checked' : ''} 
                               onchange="toggleVideoSelection('${escapeHtml(item.path)}')"
                               style="width: 18px; height: 18px; cursor: pointer;">
                    </div>
                    <div class="card-thumbnail video" data-thumbnail="${thumbnailUrl}">
                        <!-- 缩略图将通过 JS 动态加载 -->
                        <div class="thumbnail-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
                            <svg viewBox="0 0 24 24" style="width:48px;height:48px;color:#94a3b8" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/>
                            </svg>
                        </div>
                        <button class="card-actions-btn" onclick="showCardActions(event, '${escapeHtml(item.path)}')">
                            <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="1"/>
                                <circle cx="19" cy="12" r="1"/>
                                <circle cx="5" cy="12" r="1"/>
                            </svg>
                        </button>
                        <div class="card-actions-menu" id="actions-${escapeHtml(item.path).replace(/[./\\]/g, '-')}">
                            <button class="action-item" onclick="renameFileFromCard('${escapeHtml(item.path)}')">重命名</button>
                            <button class="action-item" onclick="moveFileFromCard('${escapeHtml(item.path)}')">移动</button>
                            <button class="action-item danger" onclick="deleteFileFromCard('${escapeHtml(item.path)}')">删除</button>
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

function renderListView(items) {
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
        const iconSvg = item.type === 'directory' 
            ? '<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>'
            : '<rect x="2" y="2" width="20" height="20" rx="2.1" ry="2.1"/>';

        const isSelected = selectedVideoPaths.includes(item.path);
        const isVideoFile = item.type === 'file';

        html += `
            <div class="list-item" data-path="${escapeHtml(item.path)}" data-type="${item.type}">
                <div class="list-icon">
                    ${isVideoFile ? `
                        <input type="checkbox" 
                            ${isSelected ? 'checked' : ''} 
                            onclick="event.stopPropagation(); toggleVideoSelection('${escapeHtml(item.path)}')"
                            style="width:18px;height:18px;cursor:pointer;margin-right:8px">
                    ` : ''}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${iconSvg}
                    </svg>
                </div>
                <div class="list-name">${escapeHtml(item.name)}</div>
                <div class="list-meta">${formatFileSize(item.size)}</div>
                <div class="list-meta">-</div>
                <div>
                    ${isVideoFile ? `
                        <button class="card-actions-btn" onclick="event.stopPropagation(); showCardActions(event, '${escapeHtml(item.path)}')">
                            <svg viewBox="0 0 24 24" style="width:16px;height:16px" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="1"/>
                                <circle cx="19" cy="12" r="1"/>
                                <circle cx="5" cy="12" r="1"/>
                            </svg>
                        </button>
                        <div class="card-actions-menu" id="actions-${escapeHtml(item.path).replace(/[./\\]/g, '-')}" style="right:0;left:auto">
                            <button class="action-item" onclick="renameFileFromCard('${escapeHtml(item.path)}')">重命名</button>
                            <button class="action-item" onclick="moveFileFromCard('${escapeHtml(item.path)}')">移动</button>
                            <button class="action-item danger" onclick="deleteFileFromCard('${escapeHtml(item.path)}')">删除</button>
                        </div>
                    ` : ''}
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
        if (thumbnailUrl) {
            const placeholder = thumbnail.querySelector('.thumbnail-placeholder');
            if (placeholder) {
                const img = document.createElement('img');
                img.src = thumbnailUrl;
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                img.onload = () => {
                    placeholder.style.display = 'none';
                    img.style.display = 'block';
                };
                img.onerror = () => {
                    // 如果加载失败，保持原样
                };
                // 添加到缩略图容器的前面
                thumbnail.insertBefore(img, thumbnail.firstChild);
            }
        }
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
    renderFilesWithSelection();
}

function renderFilesWithSelection() {
    // 重新渲染，但保持当前状态
    loadFiles();
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
    
    // 获取所有视频路径
    const allVideoPaths = Array.from(items).map(el => el.dataset.path);
    
    if (selectedVideoPaths.length === allVideoPaths.length) {
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
    document.querySelectorAll('.file-card, .list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.card-actions-btn') || e.target.closest('.action-item')) return;
            
            const path = el.dataset.path;
            const type = el.dataset.type;
            
            if (type === 'directory') {
                currentPath = path;
                document.getElementById('currentPath').textContent = path || '全部视频';
                loadFiles();
            } else if (type === 'document') {
                // 处理文档文件点击 - 先不做具体实现
                console.log('文档点击:', path);
            } else {
                openVideoDetail(path);
            }
        });
    });
}

function showCardActions(event, path) {
    event.stopPropagation();
    const menuId = 'actions-' + path.replace(/[./\\]/g, '-');
    const menu = document.getElementById(menuId);
    
    document.querySelectorAll('.card-actions-menu').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });
    
    if (menu) menu.classList.toggle('show');
}

document.addEventListener('click', () => {
    document.querySelectorAll('.card-actions-menu').forEach(m => m.classList.remove('show'));
});

async function loadDirectories() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/files?path=`);
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

    try {
        const response = await fetch(`${API_BASE_URL}/api/folders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name: name })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalNewFolder').classList.remove('show');
            document.getElementById('folderNameInput').value = '';
            loadFiles();
            loadDirectories();
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
    formData.append('path', currentPath);
    
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
                loadFiles();
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

    if (urlDownloadItems.length === 0) return;

    const confirmBtn = document.getElementById('confirmUrlUpload');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '创建任务...';

    try {
        const response = await fetch(`${API_BASE_URL}/api/upload/url/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: urlDownloadItems, target_dir: targetDir })
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
async function openVideoDetail(path) {
    currentVideo = { path };
    document.getElementById('detailPanel').classList.add('show');
    document.getElementById('detailName').textContent = path.split(/[\\/]/).pop();

    // 清空之前的解析结果（参考 index.html 的实现）
    document.getElementById('summaryContent').innerHTML = '点击「视频转录」获取原文，然后生成总结';
    document.getElementById('notesContent').innerHTML = '<p>暂无笔记</p>';
    document.getElementById('outlineContent').innerHTML = '<p>暂无大纲</p>';
    document.getElementById('textContent').textContent = '暂无内容，点击「视频转录」开始';

    try {
        const pathForUrl = path.replace(/\\/g, '/');
        const videoUrl = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}`;
        document.querySelector('#videoPlayer video').src = videoUrl;
    } catch (e) {}

    await loadAnalysisResults(path);
}

async function loadAnalysisResults(videoPath) {
    const videoFullPath = videoPath;
    const baseName = videoFullPath.replace(/\.[^/.]+$/, '');

    ['summary', 'notes', 'outline'].forEach(async type => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/analysis/result?video_path=${encodeURIComponent(videoPath)}&type=${type}`);
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
        const response = await fetch(`${API_BASE_URL}/api/analysis/result?video_path=${encodeURIComponent(videoPath)}&type=subtitle`);
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
        
        const response = await fetch(`${API_BASE_URL}/api/video/analyze?path=${encodeURIComponent(currentVideo.path)}`, {
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
        const payload = { video_path: currentVideo.path };
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
        const payload = { video_path: currentVideo.path };
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
        const payload = { video_path: currentVideo.path };
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
function renameFileFromCard(path) {
    document.getElementById('renameInput').value = path.split('/').pop();
    document.getElementById('modalRename').dataset.path = path;
    document.getElementById('modalRename').classList.add('show');
}

async function renameFile() {
    const path = document.getElementById('modalRename').dataset.path;
    const newName = document.getElementById('renameInput').value.trim();
    if (!path || !newName) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, new_name: newName })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalRename').classList.remove('show');
            loadFiles();
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

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, target_dir: targetDir })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalMove').classList.remove('show');
            loadFiles();
        } else {
            alert('移动失败: ' + data.error);
        }
    } catch (error) {
        alert('移动失败: ' + error.message);
    }
}

function deleteFileFromCard(path) {
    selectedItems = [path];
    document.getElementById('modalDelete').classList.add('show');
}

async function deleteSelected() {
    if (selectedItems.length === 0) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/item/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: selectedItems[0] })
        });
        const data = await response.json();

        if (data.success) {
            document.getElementById('modalDelete').classList.remove('show');
            selectedItems = [];
            loadFiles();
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
function openSettingsModal() {
    editingProvider = appConfig.activeProvider;
    loadConfigForm(editingProvider);
    updateProviderTabs();
    document.getElementById('modalSettings').classList.add('show');
}

function loadConfigForm(providerId) {
    const provider = appConfig.providers[providerId];
    document.getElementById('configApiUrl').value = provider.apiUrl || '';
    document.getElementById('configApiKey').value = provider.apiKey ? '***' : '';
    document.getElementById('configDefaultModel').value = provider.defaultModel || '';
}

function updateProviderTabs() {
    document.querySelectorAll('.provider-tab').forEach(tab => {
        if (tab.dataset.provider === editingProvider) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

function switchProviderTab(providerId) {
    saveCurrentProviderConfig();
    editingProvider = providerId;
    loadConfigForm(editingProvider);
    updateProviderTabs();
}

function saveCurrentProviderConfig() {
    const apiUrl = document.getElementById('configApiUrl').value.trim();
    const apiKeyInput = document.getElementById('configApiKey').value.trim();
    const defaultModel = document.getElementById('configDefaultModel').value.trim();

    if (apiKeyInput !== '***') {
        appConfig.providers[editingProvider].apiKey = apiKeyInput;
    }
    appConfig.providers[editingProvider].apiUrl = apiUrl;
    appConfig.providers[editingProvider].defaultModel = defaultModel;
}

async function saveSettings() {
    saveCurrentProviderConfig();
    appConfig.activeProvider = editingProvider;
    
    const provider = appConfig.providers[editingProvider];
    if (provider.defaultModel) {
        appConfig.currentModel = provider.defaultModel;
    }

    saveAppConfig();
    updateModelDisplay();

    try {
        const response = await fetch(`${API_BASE_URL}/api/config/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providers: appConfig.providers,
                active_provider: appConfig.activeProvider
            })
        });
        const data = await response.json();
        if (!data.success) {
            console.warn('保存到后端失败:', data.error);
        }
    } catch (e) {
        console.warn('保存到后端失败:', e);
    }

    document.getElementById('modalSettings').classList.remove('show');
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
            // 检查是否是视频父菜单（展开/收起）
            if (item.dataset.action === 'toggle-videos') {
                e.stopPropagation();
                const submenu = document.getElementById('videos-submenu');
                const toggleIcon = item.querySelector('.menu-toggle-icon');
                if (submenu) {
                    submenu.classList.toggle('submenu-open');
                    if (toggleIcon) {
                        toggleIcon.style.transform = submenu.classList.contains('submenu-open') 
                            ? 'rotate(0deg)' 
                            : 'rotate(-90deg)';
                    }
                }
                return;
            }
            
            // 检查是否是文档父菜单（展开/收起）
            if (item.dataset.action === 'toggle-documents') {
                e.stopPropagation();
                const submenu = document.getElementById('documents-submenu');
                const toggleIcon = item.querySelector('.menu-toggle-icon');
                if (submenu) {
                    submenu.classList.toggle('submenu-open');
                    if (toggleIcon) {
                        toggleIcon.style.transform = submenu.classList.contains('submenu-open') 
                            ? 'rotate(0deg)' 
                            : 'rotate(-90deg)';
                    }
                }
                return;
            }
            
            // 检查是否是文档子菜单（有 data-doc-type 属性）
            if (item.dataset.docType !== undefined) {
                e.stopPropagation();
                document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                
                // 获取文档类型
                const docType = item.dataset.docType;
                
                // 更新路径显示
                const docTypeNames = {
                    'all': '全部文档',
                    'subtitle': '原文',
                    'summary': '总结',
                    'outline': '大纲',
                    'notes': '笔记'
                };
                document.getElementById('currentPath').textContent = docTypeNames[docType] || '全部文档';
                
                // 加载对应类型的文档
                loadDocuments(docType);
                return;
            }
            
            // 普通视频目录菜单
            document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            currentPath = item.dataset.path;
            document.getElementById('currentPath').textContent = currentPath || '全部视频';
            loadFiles();
        });
    });

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

    // Rename
    const btnRename = document.getElementById('btnRename');
    if (btnRename) {
        btnRename.addEventListener('click', () => {
            if (currentVideo) renameFileFromCard(currentVideo.path);
        });
    }
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

    // Move
    const btnMove = document.getElementById('btnMove');
    if (btnMove) {
        btnMove.addEventListener('click', () => {
            if (currentVideo) moveFileFromCard(currentVideo.path);
        });
    }
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
}

// ============================
// Initialize
// ============================
document.addEventListener('DOMContentLoaded', () => {
    loadAppConfig();
    bindEvents();
    bindChartControls();
    initGreeting();
    loadStats();
    loadDashboardCharts();
    loadRecentActivity();
});