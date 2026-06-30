// ============================
// pages/video_detail.js
// 职责：视频/音频详情面板、转录、生成总结/笔记/大纲
// ============================
import { API_BASE_URL, appConfig } from '../core/config.js';
import { getAnalysisResult, getTaskStatus, analyzeVideoApi, generateContentApi } from '../core/api.js';
import { state } from '../core/state.js';
import { simpleMarkdownToHtml } from '../core/utils.js';

export function isAudioPath(path) {
    if (!path) return false;
    return /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(path);
}

// 抑制 <video>/<audio> 元素的 ERR_ABORTED 噪音（src 被外部清空或切换时旧请求被 abort）
function attachMediaErrorFilter(mediaEl) {
    if (!mediaEl || mediaEl.__abortFilterAttached) return;
    mediaEl.__abortFilterAttached = true;
    // 记录最近一次用户主动设置的 src（区分浏览器内部请求）
    mediaEl.addEventListener('error', (e) => {
        if (!mediaEl.error) return;
        const isAbort = mediaEl.error.code === MediaError.MEDIA_ERR_ABORTED;
        if (!isAbort) return; // 真实错误（解码/网络）不静默，让上层处理
        // 仅静默"src 为空"或"当前 src 已被替换"时的 abort
        const currentSrc = mediaEl.currentSrc || mediaEl.src || '';
        const isSrcEmpty = !mediaEl.getAttribute('src');
        e.stopImmediatePropagation();
        e.preventDefault();
    }, true);
}

export async function openVideoDetail(path) {
    const isAudio = isAudioPath(path);
    state.currentVideo = { path, media_type: isAudio ? 'audio' : 'video' };
    document.getElementById('detailPanel').classList.add('show');
    document.getElementById('detailName').textContent = path.split(/[\\/]/).pop();
    const detailPanelTitle = document.getElementById('detailPanelTitle');
    if (detailPanelTitle) detailPanelTitle.textContent = isAudio ? '音频详情' : '视频详情';
    const transcribeLabel = isAudio ? '音频转录' : '视频转录';
    document.getElementById('summaryContent').innerHTML = `点击「${transcribeLabel}」获取原文，然后生成总结`;
    document.getElementById('notesContent').innerHTML = '<p>暂无笔记</p>';
    document.getElementById('outlineContent').innerHTML = '<p>暂无大纲</p>';
    document.getElementById('textContent').textContent = `暂无内容，点击「${transcribeLabel}」开始`;
    const videoEl = document.querySelector('#videoPlayer video');
    const audioEl = document.getElementById('audioPlayer');
    attachMediaErrorFilter(videoEl);
    attachMediaErrorFilter(audioEl);
    if (isAudio) {
        if (videoEl) {
            // 切到音频：先停掉视频并清空 src，避免后台继续加载触发 ERR_ABORTED
            try { videoEl.pause(); } catch (e) {}
            videoEl.removeAttribute('src');
            try { videoEl.load(); } catch (e) {}
            videoEl.style.display = 'none';
        }
        if (audioEl) {
            audioEl.style.display = 'block';
            const pathForUrl = path.replace(/\\/g, '/');
            audioEl.src = `${API_BASE_URL}/api/video/${encodeURIComponent(pathForUrl)}?media_type=audio`;
        }
        const btnAnalyze = document.getElementById('btnAnalyze');
        if (btnAnalyze) {
            const textNode = Array.from(btnAnalyze.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
            if (textNode) {
                textNode.textContent = '音频转录';
            } else {
                btnAnalyze.innerHTML = btnAnalyze.innerHTML.replace('视频转录', '音频转录');
            }
        }
    } else {
        if (audioEl) {
            try { audioEl.pause(); } catch (e) {}
            audioEl.removeAttribute('src');
            try { audioEl.load(); } catch (e) {}
            audioEl.style.display = 'none';
        }
        if (videoEl) {
            videoEl.style.display = 'block';
            try {
                // 切换同类视频时也清空旧 src，避免旧请求被 abort 触发 ERR_ABORTED 噪音
                try { videoEl.pause(); } catch (e) {}
                videoEl.removeAttribute('src');
                try { videoEl.load(); } catch (e) {}
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

export async function loadAnalysisResults(videoPath) {
    const mediaType = (state.currentVideo && state.currentVideo.media_type) || (isAudioPath(videoPath) ? 'audio' : 'video');
    ['summary', 'notes', 'outline'].forEach(async type => {
        try {
            const data = await getAnalysisResult(videoPath, type, mediaType);
            if (data && data.success && data.content) {
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
        } catch (e) {}
    });
    try {
        const data = await getAnalysisResult(videoPath, 'subtitle', mediaType);
        if (data && data.success && data.content) {
            const el = document.getElementById('textContent');
            if (el) el.textContent = data.content;
        }
    } catch (e) {}
}

export async function analyzeVideo() {
    if (!state.currentVideo) return;
    const progressBar = document.getElementById('analyzeProgress');
    const progressFill = progressBar ? progressBar.querySelector('.progress-fill') : null;
    const progressMessage = document.getElementById('analyzeProgressMessage');
    const btn = document.getElementById('btnAnalyze');
    try {
        if (progressBar) progressBar.style.display = 'block';
        if (progressMessage) progressMessage.style.display = 'block';
        if (btn) btn.disabled = true;
        if (progressFill) progressFill.style.width = '0%';
        if (progressMessage) progressMessage.textContent = '准备开始...';
        const data = await analyzeVideoApi(state.currentVideo.path, state.currentVideo.media_type || 'video');
        if (data && data.success && data.task_id) {
            await pollTaskProgress(data.task_id);
        } else {
            alert('分析失败: ' + ((data && data.error) || '未知错误'));
            if (progressBar) progressBar.style.display = 'none';
            if (progressMessage) progressMessage.style.display = 'none';
            if (btn) btn.disabled = false;
        }
    } catch (error) {
        alert('分析失败: ' + error.message);
        if (progressBar) progressBar.style.display = 'none';
        if (progressMessage) progressMessage.style.display = 'none';
        if (btn) btn.disabled = false;
    }
}

export async function pollTaskProgress(taskId) {
    const progressBar = document.getElementById('analyzeProgress');
    const progressFill = progressBar ? progressBar.querySelector('.progress-fill') : null;
    const progressMessage = document.getElementById('analyzeProgressMessage');
    const btn = document.getElementById('btnAnalyze');
    let pollInterval;
    try {
        pollInterval = setInterval(async () => {
            try {
                const data = await getTaskStatus(taskId);
                if (data && data.success && data.task) {
                    const task = data.task;
                    if (progressFill) progressFill.style.width = `${task.progress || 0}%`;
                    if (progressMessage) progressMessage.textContent = task.message || '处理中...';
                    if (task.status === 'completed') {
                        clearInterval(pollInterval);
                        if (progressBar) progressBar.style.display = 'none';
                        if (progressMessage) progressMessage.style.display = 'none';
                        if (btn) btn.disabled = false;
                        if (task.result && state.currentVideo) {
                            await loadAnalysisResults(state.currentVideo.path);
                        }
                    } else if (task.status === 'failed') {
                        clearInterval(pollInterval);
                        if (progressBar) progressBar.style.display = 'none';
                        if (progressMessage) progressMessage.style.display = 'none';
                        if (btn) btn.disabled = false;
                        alert('处理失败: ' + (task.message || '未知错误'));
                    }
                }
            } catch (error) {
                console.error('查询任务进度失败:', error);
            }
        }, 500);
    } catch (error) {
        clearInterval(pollInterval);
        if (progressBar) progressBar.style.display = 'none';
        if (btn) btn.disabled = false;
        alert('查询进度失败: ' + error.message);
    }
}

async function generateContent(apiPath, contentElId, progressElId, btnElId) {
    if (!state.currentVideo) return;
    const progress = document.getElementById(progressElId);
    const btn = document.getElementById(btnElId);
    if (progress) progress.classList.add('show');
    if (btn) btn.disabled = true;
    try {
        const payload = { video_path: state.currentVideo.path, media_type: state.currentVideo.media_type || 'video' };
        if (appConfig.currentModel) payload.model = appConfig.currentModel;
        const data = await generateContentApi(apiPath, payload);
        if (data && data.success) {
            const el = document.getElementById(contentElId);
            if (data.content && el) {
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
            alert('生成失败: ' + (data && data.error));
        }
    } catch (error) {
        alert('生成失败: ' + error.message);
    } finally {
        if (progress) progress.classList.remove('show');
        if (btn) btn.disabled = false;
    }
}

export async function generateSummary() {
    return generateContent('/api/analysis/generate-summary', 'summaryContent', 'genSummaryProgress', 'btnGenSummary');
}

export async function generateNotes() {
    return generateContent('/api/analysis/generate-notes', 'notesContent', 'genNotesProgress', 'btnGenNotes');
}

export async function generateOutline() {
    return generateContent('/api/analysis/generate-outline', 'outlineContent', 'genOutlineProgress', 'btnGenOutline');
}
