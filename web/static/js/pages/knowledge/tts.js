// ============================
// pages/knowledge/tts.js
// 职责：TTS 音色加载、播放控制、进度更新
// ============================
import { showToast } from '../../core/utils.js';

let _api = null;
let _state = null;

function setCtx({ api, state }) { _api = api; _state = state; }

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export async function loadTTSVoices() {
    try {
        const response = await _api.getTTSVoices();
        if (response.success) {
            _state.ttsVoices = response.data;
            renderTTSVoiceSelect();
        }
    } catch (error) {
        console.error('加载音色列表失败:', error);
    }
}

export function renderTTSVoiceSelect() {
    const select = document.getElementById('tts-voice-select');
    if (select) {
        select.innerHTML = _state.ttsVoices.map(voice =>
            `<option value="${voice.code}" ${voice.code === _state.ttsSelectedVoice ? 'selected' : ''}>${voice.name}</option>`
        ).join('');
    }
}

export async function startTTS(mode = 'doc', messageIndex = null) {
    let textToConvert = '';
    let warningMessage = '';
    if (mode === 'doc') {
        if (!_state.currentDoc) {
            showToast('请先选择文档', 'warning');
            return;
        }
        textToConvert = _state.currentDoc.content;
        warningMessage = '文档内容为空';
        _state.ttsPlayingIndex = null;
        _state.ttsPlayingMode = 'doc';
    } else if (mode === 'message') {
        if (messageIndex === null || !_state.messages[messageIndex]) {
            showToast('消息不存在', 'warning');
            return;
        }
        const msg = _state.messages[messageIndex];
        if (msg.role !== 'assistant') {
            showToast('只能播放助手回复', 'warning');
            return;
        }
        textToConvert = msg.content;
        warningMessage = '消息内容为空';
        _state.ttsPlayingIndex = messageIndex;
        _state.ttsPlayingMode = 'message';
    }
    if (!textToConvert.trim()) {
        showToast(warningMessage, 'warning');
        return;
    }
    if (_state.ttsIsPaused && _state.ttsAudio && _state.ttsPlayingMode === mode) {
        _state.ttsAudio.play();
        _state.ttsIsPlaying = true;
        _state.ttsIsPaused = false;
        updateTTSControls();
        return;
    }
    if (_state.ttsAudio && _state.ttsIsConverting) return;
    try {
        _state.ttsIsConverting = true;
        showToast('正在转换语音...', 'info');
        const response = await _api.convertTextToSpeech(
            textToConvert,
            _state.ttsSelectedVoice
        );
        if (response.success) {
            playTTSAudio(response.data.audio_url);
            showToast('语音转换成功', 'success');
        } else {
            showToast(response.error || '语音转换失败', 'error');
        }
    } catch (error) {
        showToast('语音转换失败: ' + error.message, 'error');
    } finally {
        _state.ttsIsConverting = false;
    }
}

function playTTSAudio(audioUrl) {
    if (_state.ttsAudio) {
        try { _state.ttsAudio.pause(); } catch (e) {}
        // 清空 src 并 load()，避免后台请求被 abort 触发 ERR_ABORTED 噪音
        try { _state.ttsAudio.removeAttribute('src'); } catch (e) {}
        try { _state.ttsAudio.load(); } catch (e) {}
        _state.ttsAudio = null;
    }
    const audioEl = new Audio(audioUrl);
    _state.ttsAudio = audioEl;
    _state.ttsIsPlaying = true;
    _state.ttsIsPaused = false;
    audioEl.addEventListener('loadedmetadata', () => {
        // 仅当 audioEl 仍是当前活动音频时更新状态
        if (_state.ttsAudio === audioEl) {
            _state.ttsDuration = audioEl.duration;
            updateTTSProgress();
        }
    });
    audioEl.addEventListener('timeupdate', () => {
        // 仅当 audioEl 仍是当前活动音频时更新进度，避免已被替换/停止后读到 null
        if (_state.ttsAudio === audioEl) {
            _state.ttsCurrentTime = audioEl.currentTime;
            updateTTSProgress();
        }
    });
    audioEl.addEventListener('ended', () => {
        if (_state.ttsAudio === audioEl) {
            _state.ttsIsPlaying = false;
            _state.ttsIsPaused = false;
            updateTTSControls();
        }
    });
    audioEl.addEventListener('error', (e) => {
        // 仅当 audioEl 仍是当前活动音频，且不是因为 src 被外部清空导致的 abort
        const isAbortedEmpty = !audioEl.getAttribute('src') && audioEl.error && audioEl.error.code === MediaError.MEDIA_ERR_ABORTED;
        if (_state.ttsAudio === audioEl && !isAbortedEmpty) {
            _state.ttsIsPlaying = false;
            _state.ttsIsPaused = false;
            updateTTSControls();
            showToast('音频播放失败', 'error');
        }
    });
    audioEl.play().catch(error => {
        // 静默 abort 错误（src 被清空/快速切换触发的正常 abort）
        if (error && error.name === 'AbortError') return;
        if (_state.ttsAudio === audioEl) {
            showToast('音频播放失败: ' + error.message, 'error');
            _state.ttsIsPlaying = false;
        }
    });
    updateTTSControls();
}

export function pauseTTS() {
    if (_state.ttsAudio && _state.ttsIsPlaying) {
        _state.ttsAudio.pause();
        _state.ttsIsPlaying = false;
        _state.ttsIsPaused = true;
        updateTTSControls();
    }
}

export function stopTTS() {
    if (_state.ttsAudio) {
        try { _state.ttsAudio.pause(); } catch (e) {}
        try { _state.ttsAudio.removeAttribute('src'); } catch (e) {}
        try { _state.ttsAudio.load(); } catch (e) {}
        _state.ttsAudio = null;
    }
    _state.ttsIsPlaying = false;
    _state.ttsIsPaused = false;
    _state.ttsCurrentTime = 0;
    _state.ttsDuration = 0;
    _state.ttsPlayingIndex = null;
    _state.ttsPlayingMode = 'doc';
    updateTTSControls();
    updateTTSProgress();
}

export function updateTTSProgress() {
    const progressBar = document.getElementById('tts-progress');
    const timeLabel = document.getElementById('tts-time');
    if (progressBar) {
        progressBar.max = _state.ttsDuration || 0;
        progressBar.value = _state.ttsCurrentTime || 0;
    }
    if (timeLabel) {
        const current = formatTime(_state.ttsCurrentTime);
        const total = formatTime(_state.ttsDuration);
        timeLabel.textContent = `${current} / ${total}`;
    }
}

export function updateTTSControls() {
    const playBtn = document.getElementById('btn-tts-play');
    const pauseBtn = document.getElementById('btn-tts-pause');
    if (playBtn) {
        playBtn.style.display = (_state.ttsIsPlaying && _state.ttsPlayingMode === 'doc') ? 'none' : 'inline-flex';
    }
    if (pauseBtn) {
        pauseBtn.style.display = (_state.ttsIsPlaying && _state.ttsPlayingMode === 'doc') ? 'inline-flex' : 'none';
    }
    // 重新渲染消息列表以更新消息内的 TTS 按钮
    import('./chat.js').then(m => m.renderChatMessages());
}

export function bindTTSEvents() {
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btn-tts-play')) {
            startTTS('doc');
        }
        const msgPlay = e.target.closest('.btn-tts-message-play');
        if (msgPlay) {
            const index = parseInt(msgPlay.dataset.messageIndex, 10);
            startTTS('message', index);
        }
        if (e.target.closest('#btn-tts-pause')) {
            pauseTTS();
        }
        if (e.target.closest('.btn-tts-message-pause')) {
            pauseTTS();
        }
        if (e.target.closest('#btn-tts-stop')) {
            stopTTS();
        }
        if (e.target.closest('.btn-tts-message-stop')) {
            stopTTS();
        }
    });
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'tts-voice-select') {
            _state.ttsSelectedVoice = e.target.value;
            renderTTSVoiceSelect();
        }
    });
    const ttsProgress = document.getElementById('tts-progress');
    if (ttsProgress) {
        ttsProgress.addEventListener('input', (e) => {
            if (_state.ttsAudio) {
                _state.ttsAudio.currentTime = e.target.value;
                _state.ttsCurrentTime = parseFloat(e.target.value);
                updateTTSProgress();
            }
        });
    }
}

export { setCtx as setTTSCtx };
