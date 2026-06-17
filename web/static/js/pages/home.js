// ============================
// pages/home.js
// 职责：首页统计、图表、最近活动、问候语
// ============================
import { API_BASE_URL } from '../core/config.js';
import { state } from '../core/state.js';
import { formatFileSize, escapeHtml } from '../core/utils.js';

export async function loadStats() {
    try {
        try {
            const response = await fetch(`${API_BASE_URL}/api/dashboard/stats`);
            const data = await response.json();
            if (data.success && data.data) {
                const stats = data.data;
                const setText = (id, text) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = text;
                };
                setText('stat-videos', stats.videos.total);
                setText('stat-videos-today', `今日新增 ${stats.videos.today}`);
                setText('stat-duration', stats.duration.total);
                setText('stat-transcribed', `已转录 ${stats.duration.transcribed}`);
                setText('stat-documents', stats.documents.total);
                setText('stat-docs-today', `今日生成 ${stats.documents.today}`);
                setText('stat-tasks-pending', stats.tasks.pending);
                setText('stat-tasks-info', `已完成 ${stats.tasks.completed} / 失败 ${stats.tasks.failed}`);
                return;
            }
        } catch (e) {
            console.log('Dashboard API not available, falling back to basic stats');
        }

        // 降级：使用 /api/files
        const response = await fetch(`${API_BASE_URL}/api/files?path=`);
        const data = await response.json();
        if (data.success) {
            let videoCount = 0;
            let totalSize = 0;
            (data.items || []).forEach(item => {
                if (item.type !== 'directory') {
                    videoCount++;
                    totalSize += item.size || 0;
                }
            });
            const setText = (id, text) => {
                const el = document.getElementById(id);
                if (el) el.textContent = text;
            };
            setText('stat-videos', videoCount);
            setText('stat-size', formatFileSize(totalSize));
        }
    } catch (error) {
        console.error('加载统计失败:', error);
    }
}

export function initGreeting() {
    const hour = new Date().getHours();
    let greeting = '晚上好';
    if (hour >= 5 && hour < 12) greeting = '早上好';
    else if (hour >= 12 && hour < 18) greeting = '下午好';
    const welcomeTitle = document.getElementById('welcomeTitle');
    if (welcomeTitle) welcomeTitle.textContent = greeting;
}

export async function loadDashboardCharts() {
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
        if (state.distributionChart) state.distributionChart.destroy();
        const labels = categories.map(c => c.name);
        const data = categories.map(c => c.count);
        const colors = [
            '#667eea', '#764ba2', '#f59e0b', '#10b981', '#3b82f6',
            '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
        ];
        state.distributionChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: colors.slice(0, labels.length),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { boxWidth: 12, padding: 15, font: { size: 12 } } }
                }
            }
        });
    } catch (error) {
        console.error('加载分布图表失败:', error);
    }
}

export async function loadTrendsChart(days = 7) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/dashboard/trends?days=${days}`);
        const result = await response.json();
        if (!result.success || !result.data) return;
        const { dates, videos_processed, documents_generated } = result.data;
        const ctx = document.getElementById('trendsChart');
        if (!ctx) return;
        if (state.trendsChart) state.trendsChart.destroy();
        state.trendsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates.map(d => d.slice(5)),
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
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 15, font: { size: 12 } } } },
                scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
            }
        });
    } catch (error) {
        console.error('加载趋势图表失败:', error);
    }
}

export async function loadRecentActivity() {
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
                </div>`;
            return;
        }
        container.innerHTML = videos.map(video => `
            <div class="activity-item" data-path="${escapeHtml(video.path)}">
                <div class="activity-icon video">📹</div>
                <div class="activity-content">
                    <div class="activity-name">${escapeHtml(video.name)}</div>
                    <div class="activity-meta">${escapeHtml(video.directory || '未分类')}</div>
                </div>
                <div class="activity-time">${video.modified}</div>
            </div>`).join('');
        // 委托：点击活动项跳转
        container.querySelectorAll('.activity-item').forEach(el => {
            el.addEventListener('click', () => openVideoFromActivity(el.dataset.path));
        });
    } catch (error) {
        console.error('加载最近活动失败:', error);
    }
}

export function bindChartControls() {
    document.querySelectorAll('.chart-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const days = parseInt(this.dataset.days);
            document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            loadTrendsChart(days);
        });
    });
    const btnViewTasks = document.getElementById('btnViewTasks');
    if (btnViewTasks) {
        btnViewTasks.addEventListener('click', () => {
            document.getElementById('modalTasks').classList.add('show');
            import('./tasks.js').then(m => m.startTasksPolling());
        });
    }
}

// 跳转到视频页并打开详情（首页最近活动）
export function openVideoFromActivity(path) {
    import('./index-bridge.js').then(m => {
        m.switchPage('videos');
        setTimeout(() => {
            import('./video_detail.js').then(vd => vd.openVideoDetail(path));
        }, 100);
    });
}

export function showBatchAnalyze() {
    import('./index-bridge.js').then(m => m.switchPage('videos'));
}

export function initHome() {
    Promise.all([
        loadStats(),
        loadDashboardCharts(),
        loadRecentActivity()
    ]);
    initGreeting();
    bindChartControls();
    // 视频文件夹侧栏
    import('./videos.js').then(m => {
        m.loadSidebarVideoFolders();
        m.updatePathNav();
    });
}
