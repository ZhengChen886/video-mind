// ============================
// core/state.js
// 职责：集中所有全局可变状态，便于跨模块共享
// 字段含义与原 app.js 顶层 let 变量一致
// ============================

export const state = {
    // 当前浏览路径
    currentPath: '',
    // 视频/音频当前浏览路径
    currentAudioPath: '',
    // 当前视图（cards / list）
    currentView: 'cards',
    // 已选择（用于删除/移动/重命名弹窗）
    selectedItems: [],
    // 当前打开的视频/音频
    currentVideo: null,
    // 侧栏模式标记
    isShowingDocuments: false,
    isShowingAudio: false,
    currentDocType: 'all',

    // 批量选择：当前选中的视频/音频路径
    selectedVideoPaths: [],
    currentTranscribeTaskId: null,
    transcribePollingInterval: null,

    // 模型选择弹窗
    allModels: [],
    selectedModel: null,
    editingProvider: null,

    // 图表实例
    distributionChart: null,
    trendsChart: null,

    // 任务中心轮询
    tasksPollingInterval: null,

    // URL 下载任务
    currentUrlDownloadTaskId: null,
    urlPollingInterval: null,
    urlDownloadItems: [],

    // 上传文件
    selectedUploadFiles: [],

    // 服务端 config（含 initialized、active_provider、providers）
    // 兼容原 index.html 内联中的 currentConfig
    currentConfig: {
        initialized: false,
        active_provider: 'open-ai',
        providers: {
            'open-ai': { name: 'Open AI', api_url: '', api_key: '', default_model: '' },
            'openroute': { name: 'OpenRoute', api_url: '', api_key: '', default_model: '' },
            'nvidia': { name: 'NVIDIA', api_url: '', api_key: '', default_model: '' }
        }
    }
};
