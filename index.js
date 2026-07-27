/**
 * ST Book Review - SillyTavern extension shell v0.1.0
 * 第一阶段只验证：扩展能加载、顶部图标能出现、面板能打开。
 */
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';

const EXT_NAME = 'ST-book-review';
const EXT_FOLDER = `third-party/${EXT_NAME}`;

async function init() {
    try {
        const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'template');
        const drawer = document.createElement('div');
        drawer.id = 'stbr_drawer';
        drawer.className = 'drawer-content closedDrawer';
        drawer.innerHTML = html;

        const icon = document.createElement('div');
        icon.id = 'stbr_drawer_icon';
        icon.className = 'drawer-icon fa-solid fa-comments closedIcon';
        icon.title = 'ST Book Review';
        icon.setAttribute('aria-label', '打开书评插件');

        const anchor = document.querySelector('#extensions_settings') || document.body;
        anchor.append(drawer);

        const topBar = document.querySelector('#top-bar')
            || document.querySelector('#top-bar-left')
            || document.querySelector('#top-bar-right')
            || document.querySelector('#extensionsMenu');
        (topBar || document.body).append(icon);

        const close = () => {
            drawer.classList.remove('openDrawer');
            drawer.classList.add('closedDrawer');
            icon.classList.remove('openIcon');
            icon.classList.add('closedIcon');
        };
        const open = () => {
            drawer.classList.remove('closedDrawer');
            drawer.classList.add('openDrawer');
            icon.classList.remove('closedIcon');
            icon.classList.add('openIcon');
        };
        icon.addEventListener('click', () => drawer.classList.contains('openDrawer') ? close() : open());
        drawer.querySelector('#stbr-close')?.addEventListener('click', close);
        drawer.querySelector('#stbr-test')?.addEventListener('click', () => {
            const result = drawer.querySelector('#stbr-test-result');
            if (result) result.textContent = '插件外壳运行正常。';
        });

        console.log('[ST Book Review] v0.1.0 loaded');
    } catch (error) {
        console.error('[ST Book Review] load failed:', error);
    }
}

jQuery(init);
