// ============================
// core/api.js
// 职责：前端统一 API 客户端，封装 request() 与跨模块共用的请求方法
// 所有页面都应通过本模块发起 fetch，避免直接散落 fetch
// ============================
import { API_BASE_URL } from './config.js';
import { showToast } from './utils.js';

// 统一 fetch 封装：
// - 自动拼接 API_BASE_URL
// - 自动处理 JSON / FormData / GET 查询串
// - 非 2xx 抛错，附带 status / payload
// - 统一 console.error 错误日志
export async function request(path, options = {}) {
    const opts = { ...options };
    const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    const headers = { ...(opts.headers || {}) };
    if (!isFormData && opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob)) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    if (Object.keys(headers).length > 0) opts.headers = headers;

    const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;

    try {
        const response = await fetch(url, opts);
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const errMsg = (data && (data.error || data.message || data.detail)) || `HTTP ${response.status}`;
            const error = new Error(errMsg);
            error.status = response.status;
            error.payload = data;
            throw error;
        }
        return data;
    } catch (error) {
        console.error('[API] 请求失败:', { path, url, API_BASE_URL, error: error.message, status: error.status });
        if (error.message === 'Failed to fetch' || /NetworkError|fetch failed/i.test(error.message)) {
            showToast(`网络请求失败，请确认服务在 ${API_BASE_URL} 运行`, 'error');
        }
        throw error;
    }
}

// GET 便捷方法
export function get(path, params) {
    if (params && typeof params === 'object') {
        const qs = new URLSearchParams();
        Object.keys(params).forEach(k => {
            const v = params[k];
            if (v !== undefined && v !== null && v !== '') qs.append(k, v);
        });
        const s = qs.toString();
        if (s) path += (path.includes('?') ? '&' : '?') + s;
    }
    return request(path, { method: 'GET' });
}

// POST 便捷方法
export function post(path, body) {
    return request(path, { method: 'POST', body });
}

// DELETE 便捷方法
export function del(path, body) {
    return request(path, { method: 'DELETE', body });
}

// PUT 便捷方法
export function put(path, body) {
    return request(path, { method: 'PUT', body });
}

// ============================================================
// 通用方法（替代前端散落 fetch）
// ============================================================

// 加载文件/目录列表：替换 6 处 /api/files 调用
// path 为空时传 ''，后端会返回根目录
export function loadFileList(path = '', mediaType = 'video') {
    return get('/api/files', { path, media_type: mediaType });
}

// 获取配置状态：替换 2 处 /api/config/status 调用
export function getConfigStatus() {
    return get('/api/config/status');
}

// 获取完整配置：替换 1 处 /api/config 调用
export function getConfig() {
    return get('/api/config');
}

// 保存配置：替换 2 处 /api/config/save 调用
export function saveConfig(payload) {
    return post('/api/config/save', payload);
}

// 远程拉取模型列表（基于当前 provider 的 api_url+api_key）
// 替换 /api/knowledge/models/fetch 的 2 处调用 + /api/models 的 1 处
export function fetchModelsFromProvider(apiUrl, apiKey, modelsUrl = '') {
    return post('/api/knowledge/models/fetch', {
        api_url: apiUrl || '',
        api_key: apiKey,
        models_url: modelsUrl || ''
    });
}

// 拉取已保存的模型列表（/api/knowledge/models?source=saved）
export function getSavedModels(providerId) {
    return get('/api/knowledge/models', { provider_id: providerId });
}

// 拉取远程模型列表（/api/knowledge/models?source=remote）
export function getRemoteModels(providerId) {
    return get('/api/knowledge/models', { provider_id: providerId, source: 'remote' });
}

// 保存模型到 provider
export function saveModelsForProvider(providerId, models) {
    return post('/api/knowledge/models/save', { provider_id: providerId, models });
}

// 测试模型连通性
export function testModelConnection(providerId, model) {
    return post('/api/model/test', { provider_id: providerId, model });
}

// 任务进度查询（统一封装）
export function getTaskStatus(taskId) {
    return get(`/api/tasks/${taskId}`);
}

// 任务列表
export function listTasks() {
    return get('/api/tasks');
}

// 清理已完成任务
export function clearCompletedTasksApi() {
    return post('/api/tasks/clear-completed', {});
}

// 创建文件夹（替换 /api/folders /api/directory）
export function createFolderApi(path, name, mediaType = 'video') {
    return post('/api/folders', { path, name, media_type: mediaType });
}

// 项目计数（删除前的统计）
export function countItem(path, mediaType = 'video') {
    return get('/api/item/count', { path, media_type: mediaType });
}

// 删除项目
export function deleteItemApi(sourcePath, mediaType = 'video') {
    return post('/api/item/delete', { source_path: sourcePath, media_type: mediaType });
}

// 重命名项目
export function renameItemApi(sourcePath, newName, mediaType = 'video') {
    return post('/api/item/rename', { source_path: sourcePath, new_name: newName, media_type: mediaType });
}

// 移动项目
export function moveItemApi(sourcePath, targetDir, mediaType = 'video') {
    return post('/api/item/move', { source_path: sourcePath, target_dir: targetDir, media_type: mediaType });
}

// 分析结果查询
export function getAnalysisResult(videoPath, type, mediaType = 'video') {
    return get('/api/analysis/result', { video_path: videoPath, type, media_type: mediaType });
}

// 启动视频分析
export function analyzeVideoApi(path, mediaType = 'video') {
    return post(`/api/video/analyze?path=${encodeURIComponent(path)}&media_type=${mediaType}`, {});
}

// 启动批量转录
export function batchAnalyzeApi(paths, mediaType = 'video') {
    return post('/api/video/analyze/batch', { paths, media_type: mediaType });
}

// 生成总结 / 笔记 / 大纲
export function generateContentApi(endpoint, payload) {
    return post(endpoint, payload);
}

// 扫描文件夹中的所有文件类型（用于一键清理弹窗）
export function listFolderFileTypes(path = '', mediaType = 'video') {
    return get('/api/files/types', { path, media_type: mediaType });
}

// 一键清理：列出所有子目录
export function listAllFolders(path = '', mediaType = 'video') {
    return get('/api/files/all-folders', { path, media_type: mediaType });
}

// 一键清理：弹出本地资源管理器选目录
export function pickFolderApi() {
    return post('/api/files/pick-folder', {});
}

// 按保留后缀一键清理文件夹内非保留类型文件
export function cleanupFolderFilesApi(path, keepExtensions, mediaType = 'video') {
    return post('/api/files/cleanup', {
        path,
        media_type: mediaType,
        keep_extensions: keepExtensions,
    });
}
