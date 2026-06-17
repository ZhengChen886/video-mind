// ============================
// modal/user_menu.js
// 职责：顶部头像下拉菜单（avatarBtn）+ 侧栏 sidebarUser 下拉菜单
// 从原 index.html 内联脚本中迁出
// ============================

export function initUserMenu() {
    // 1) 顶部 user-area 头像下拉
    const avatarBtn = document.getElementById('avatarBtn');
    const userDropdown = document.getElementById('userDropdown');
    if (avatarBtn && userDropdown) {
        avatarBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
        });
        const openSettingsItem = document.getElementById('openSettingsModal');
        if (openSettingsItem) {
            openSettingsItem.addEventListener('click', function() {
                userDropdown.classList.remove('show');
                import('../pages/settings.js').then(m => m.openSettingsModal());
            });
        }
        const openProfileItem = document.getElementById('openProfileModal');
        if (openProfileItem) {
            openProfileItem.addEventListener('click', function() {
                userDropdown.classList.remove('show');
                import('./profile.js').then(m => m.openProfileModal());
            });
        }
    }

    // 2) 侧边栏 sidebarUser 下拉
    const sidebarUser = document.getElementById('sidebarUser');
    const sidebarUserDropdown = document.getElementById('sidebarUserDropdown');

    function positionSidebarUserDropdown() {
        if (!sidebarUser || !sidebarUserDropdown) return;
        const rect = sidebarUser.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left;
        const dropdownWidth = 200;
        const viewportWidth = window.innerWidth;
        if (left + dropdownWidth > viewportWidth - 12) {
            left = Math.max(12, viewportWidth - dropdownWidth - 12);
        }
        const dropdownHeight = sidebarUserDropdown.offsetHeight || 120;
        const viewportHeight = window.innerHeight;
        if (top + dropdownHeight > viewportHeight - 12) {
            const topPosition = rect.top - dropdownHeight - 6;
            if (topPosition > 12) {
                top = topPosition;
            } else {
                top = viewportHeight - dropdownHeight - 12;
            }
        }
        sidebarUserDropdown.style.left = left + 'px';
        sidebarUserDropdown.style.top = top + 'px';
    }

    if (sidebarUser && sidebarUserDropdown) {
        sidebarUser.addEventListener('click', function(e) {
            e.stopPropagation();
            if (userDropdown) userDropdown.classList.remove('show');
            positionSidebarUserDropdown();
            sidebarUserDropdown.classList.toggle('show');
            if (sidebarUserDropdown.classList.contains('show')) {
                positionSidebarUserDropdown();
            }
        });
        sidebarUserDropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                sidebarUserDropdown.classList.remove('show');
                const action = item.dataset.action;
                if (action === 'settings') {
                    import('../pages/settings.js').then(m => m.openSettingsModal());
                } else if (action === 'profile') {
                    import('./profile.js').then(m => m.openProfileModal());
                }
            });
        });
        window.addEventListener('resize', function() {
            if (sidebarUserDropdown.classList.contains('show')) {
                positionSidebarUserDropdown();
            }
        });
        window.addEventListener('scroll', function() {
            if (sidebarUserDropdown.classList.contains('show')) {
                positionSidebarUserDropdown();
            }
        }, true);
    }

    // 点击页面其他地方关闭所有下拉菜单
    document.addEventListener('click', function() {
        if (userDropdown) userDropdown.classList.remove('show');
        if (sidebarUserDropdown) sidebarUserDropdown.classList.remove('show');
    });
}
