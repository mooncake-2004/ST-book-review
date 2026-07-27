/** ST Book Review v0.2.0 - adaptive floating bubble shell */
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
const EXT_FOLDER = 'third-party/ST-book-review';
function syncViewport(root) {
    const v = window.visualViewport;
    root.style.setProperty('--stbr-vw', `${v?.width || innerWidth}px`);
    root.style.setProperty('--stbr-vh', `${v?.height || innerHeight}px`);
    root.style.setProperty('--stbr-vx', `${v?.offsetLeft || 0}px`);
    root.style.setProperty('--stbr-vy', `${v?.offsetTop || 0}px`);
}
async function init() {
    if (document.querySelector('#stbr-root')) return;
    try {
        const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'template');
        const root = document.createElement('div');
        root.id = 'stbr-root';
        root.innerHTML = `<button type="button" id="stbr-fab" aria-label="打开书评" aria-expanded="false"><i class="fa-solid fa-comments"></i><span id="stbr-fab-badge" hidden>0</span></button><div id="stbr-overlay" hidden><button type="button" id="stbr-backdrop" aria-label="关闭书评面板"></button><section id="stbr-dialog" role="dialog" aria-modal="true" aria-label="ST Book Review">${html}</section></div>`;
        document.body.append(root);
        const fab = root.querySelector('#stbr-fab');
        const overlay = root.querySelector('#stbr-overlay');
        const close = () => { overlay.hidden = true; fab.setAttribute('aria-expanded', 'false'); };
        const open = () => { syncViewport(root); overlay.hidden = false; fab.setAttribute('aria-expanded', 'true'); };
        fab.addEventListener('click', open);
        root.querySelector('#stbr-backdrop')?.addEventListener('click', close);
        root.querySelector('#stbr-close')?.addEventListener('click', close);
        root.querySelector('#stbr-test')?.addEventListener('click', () => {
            const result = root.querySelector('#stbr-test-result');
            if (result) result.textContent = '悬浮气泡与面板运行正常。';
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
        const refresh = () => syncViewport(root);
        window.addEventListener('resize', refresh, { passive: true });
        window.addEventListener('orientationchange', refresh, { passive: true });
        window.visualViewport?.addEventListener('resize', refresh, { passive: true });
        window.visualViewport?.addEventListener('scroll', refresh, { passive: true });
        syncViewport(root);
        console.log('[ST Book Review] v0.2.0 loaded');
    } catch (error) { console.error('[ST Book Review] load failed:', error); }
}
jQuery(init);