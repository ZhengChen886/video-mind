(function() {
    let extractedVideos = [];
    let currentPageUrl = '';

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 从URL提取视频
    async function extractVideosFromUrl() {
        const urlInput = document.getElementById('urlExtractInput');
        if (!urlInput) {
            alert('URL输入框未找到');
            return;
        }

        const url = urlInput.value.trim();
        if (!url) {
            alert('请输入包含视频的网页URL');
            return;
        }

        // 显示加载状态
        const listDiv = document.getElementById('webVideoList');
        const resultsDiv = document.getElementById('webVideoExtractResults');
        if (listDiv) {
            listDiv.innerHTML = '<div style="color: #666; padding: 20px; text-align: center;">正在获取页面内容...</div>';
        }
        if (resultsDiv) {
            resultsDiv.style.display = 'block';
        }

        try {
            const response = await fetch(`/api/extract/videos?url=${encodeURIComponent(url)}`);
            const data = await response.json();

            if (data.success) {
                extractedVideos = data.videos.map((v, index) => ({
                    type: v.type,
                    src: v.url,
                    label: v.type === 'iframe' ? 'Embedded Player' : v.type === 'link' ? 'Video Link' : 'HTML5 Video',
                    title: v.title || data.page_title || `Video ${index + 1}`
                }));
                currentPageUrl = data.url;
                renderExtractedVideos();
            } else {
                listDiv.innerHTML = `<div style="color: #f56565; padding: 20px; text-align: center;">${escapeHtml(data.error || '提取失败')}</div>`;
                resultsDiv.style.display = 'block';
            }
        } catch (error) {
            listDiv.innerHTML = `<div style="color: #f56565; padding: 20px; text-align: center;">请求失败: ${escapeHtml(error.message)}</div>`;
            resultsDiv.style.display = 'block';
        }
    }

    function renderExtractedVideos() {
        const resultsDiv = document.getElementById('webVideoExtractResults');
        const listDiv = document.getElementById('webVideoList');

        if (!resultsDiv || !listDiv) return;

        if (extractedVideos.length === 0) {
            listDiv.innerHTML = '<div style="color: #666; padding: 20px; text-align: center;">未找到视频资源<br><small style="color:#999">提示：部分网站视频需点击播放后才能获取链接</small></div>';
        } else {
            listDiv.innerHTML = extractedVideos.map((video, index) => `
                <div class="video-item" data-index="${index}" style="padding: 8px; border: 1px solid #e2e8f0; border-radius: 4px; margin-bottom: 8px; cursor: pointer; transition: background 0.2s;">
                    <div style="display: flex; align-items: flex-start; gap: 8px;">
                        <input type="checkbox" class="video-checkbox" data-index="${index}" style="width: 16px; height: 16px; margin-top: 4px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; color: #333;">${escapeHtml(video.title)}</div>
                            <div style="font-size: 12px; color: #666; word-break: break-all;">${escapeHtml(video.src)}</div>
                            <div style="font-size: 11px; color: #999;">类型: ${video.type} | 标签: ${video.label}</div>
                        </div>
                    </div>
                </div>
            `).join('');

            listDiv.querySelectorAll('.video-item').forEach(item => {
                item.addEventListener('click', function(e) {
                    if (e.target.type !== 'checkbox') {
                        const checkbox = this.querySelector('.video-checkbox');
                        checkbox.checked = !checkbox.checked;
                    }
                    this.style.backgroundColor = this.querySelector('.video-checkbox').checked ? '#f0f7ff' : '';
                });
            });
        }

        resultsDiv.style.display = 'block';
    }

    function toggleSelectAll() {
        const checkboxes = document.querySelectorAll('.video-checkbox');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => {
            cb.checked = !allChecked;
            cb.closest('.video-item').style.backgroundColor = !allChecked ? '#f0f7ff' : '';
        });
    }

    function fillSelectedVideos() {
        const selectedVideos = Array.from(document.querySelectorAll('.video-checkbox:checked')).map(cb => {
            const index = parseInt(cb.dataset.index);
            return extractedVideos[index];
        });

        if (selectedVideos.length === 0) {
            alert('请至少选择一个视频！');
            return;
        }

        const content = selectedVideos.map(video => `# ${video.title}\n${video.src}`).join('\n\n');

        const textarea = document.getElementById('urlUploadInput');
        const currentContent = textarea.value.trim();
        textarea.value = currentContent ? currentContent + '\n\n' + content : content;

        textarea.dispatchEvent(new Event('input'));
        document.getElementById('webVideoExtractResults').style.display = 'none';
    }

    function init() {
        const extractUrlBtn = document.getElementById('btnExtractFromUrl');
        if (extractUrlBtn) {
            extractUrlBtn.addEventListener('click', extractVideosFromUrl);
        }

        const selectAllBtn = document.getElementById('btnSelectAllVideos');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', toggleSelectAll);
        }

        const fillBtn = document.getElementById('btnFillSelectedVideos');
        if (fillBtn) {
            fillBtn.addEventListener('click', fillSelectedVideos);
        }

        // 回车键触发URL提取
        const urlInput = document.getElementById('urlExtractInput');
        if (urlInput) {
            urlInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    extractVideosFromUrl();
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();