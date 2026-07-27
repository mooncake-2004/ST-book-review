import { renderExtensionTemplateAsync } from '/scripts/extensions.js';

const EXT_FOLDER = 'third-party/ST-book-review';
const STORE_KEY = 'st_book_review_v1';
const DEFAULTS = { bubbleEnabled: true, contextDepth: 12, reviewerName: '' };
let state = null;
let root = null;
let context = null;
let activeTab = 'reviews';
let activeMessageId = '';

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const reviewerName = () => state.settings.reviewerName?.trim() || context.name1 || '我';

function getContext() {
    return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
}

function emptyState() {
    return { settings: { ...DEFAULTS }, reviews: {}, rooms: { character: [], normal: [] } };
}

function chatKey() {
    return context?.chatId || context?.chat?.[0]?.chat_id || location.pathname;
}

function loadState() {
    context = getContext();
    const metadata = context.chatMetadata || context.chat_metadata;
    const stored = metadata?.[STORE_KEY];
    if (stored) return { ...emptyState(), ...structuredClone(stored), settings: { ...DEFAULTS, ...(stored.settings || {}) } };
    try {
        return { ...emptyState(), ...JSON.parse(localStorage.getItem(`${STORE_KEY}:${chatKey()}`) || '{}') };
    } catch { return emptyState(); }
}

async function saveState() {
    const metadata = context.chatMetadata || context.chat_metadata;
    if (metadata) {
        metadata[STORE_KEY] = state;
        await context.saveMetadata?.();
    } else {
        localStorage.setItem(`${STORE_KEY}:${chatKey()}`, JSON.stringify(state));
    }
}

function aiMessages() {
    return (context.chat || []).map((message, index) => ({ message, index }))
        .filter(({ message }) => !message.is_user && !message.is_system)
        .map(({ message, index }) => ({
            id: String(message.send_date || message.extra?.gen_id || index),
            index,
            name: message.name || context.name2 || '角色',
            text: String(message.mes || ''),
        }));
}

function selectedMessage() {
    const messages = aiMessages();
    return messages.find(x => x.id === activeMessageId) || messages.at(-1) || null;
}

function reviewFor(message) {
    if (!message) return null;
    const review = state.reviews[message.id] ||= { messageIndex: message.index, title: '', excerpt: '', comments: [], generated: false, updatedAt: now() };
    review.title ||= '';
    review.excerpt ||= '';
    review.comments ||= [];
    review.generated = Boolean(review.title && review.excerpt && review.comments.length >= 10);
    return review;
}

function buildStoryContext(depth = state.settings.contextDepth) {
    return (context.chat || []).slice(-depth).map(m => `${m.is_user ? (context.name1 || '用户') : (m.name || context.name2 || '角色')}：${m.mes || ''}`).join('\n\n');
}

async function callAI(system, history, userText) {
    context = getContext();
    const transcript = history.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
    const prompt = `${system}\n\n【小说只读上下文】\n${buildStoryContext()}\n\n【独立聊天记录】\n${transcript}\n用户：${userText}\n助手：`;
    const fn = context.generateRaw || window.generateRaw;
    if (!fn) throw new Error('当前 SillyTavern 版本未提供 generateRaw，请升级到支持扩展生成接口的版本。');
    let result;
    try { result = await fn.call(context, prompt); }
    catch (firstError) {
        try { result = await fn.call(context, { prompt, streaming: false }); }
        catch { throw firstError; }
    }
    if (typeof result === 'string') return result.trim();
    return String(result?.content || result?.text || result?.choices?.[0]?.message?.content || '').trim();
}

function openPanel(tab = activeTab) {
    activeTab = tab;
    root.querySelector('#stbr-overlay').hidden = false;
    root.querySelector('#stbr-fab')?.setAttribute('aria-expanded', 'true');
    render();
}

function closePanel() {
    root.querySelector('#stbr-overlay').hidden = true;
    root.querySelector('#stbr-fab')?.setAttribute('aria-expanded', 'false');
}

function renderReviewTab() {
    const messages = aiMessages();
    const current = selectedMessage();
    if (current) activeMessageId = current.id;
    const review = reviewFor(current);
    const options = messages.slice().reverse().map(m => {
        const item = state.reviews[m.id];
        const label = `第 ${m.index + 1} 层 · ${item?.title || '尚未生成章节标题'}`;
        return `<option value="${escapeHtml(m.id)}" ${m.id === activeMessageId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const comments = (review?.comments || []).map(comment => `
        <article class="stbr-comment" data-comment-id="${comment.id}">
          <div class="stbr-comment-head"><strong>${escapeHtml(comment.author)}</strong><time>${new Date(comment.createdAt).toLocaleString()}</time></div>
          <p>${escapeHtml(comment.content)}</p>
          <button class="stbr-link-btn" data-action="reply" data-id="${comment.id}">回复</button>${comment.pending ? '<span class="stbr-pending">待更新</span>' : ''}
          ${(comment.replies || []).map(reply => `<div class="stbr-reply"><strong>${escapeHtml(reply.author)}</strong><span>${escapeHtml(reply.content)}</span>${reply.pending ? '<em>待更新</em>' : ''}</div>`).join('')}
        </article>`).join('');
    return `${review?.generated ? `<div class="stbr-update-dock"><span><i class="fa-solid fa-thumbtack"></i> ${review.comments.some(c => c.pending || c.replies?.some(r => r.pending)) ? '有书评或回复待处理' : '评论区已同步'}</span><button class="stbr-btn stbr-btn-primary" data-action="update-reviews"><i class="fa-solid fa-arrows-rotate"></i> 更新评论区</button></div>` : ''}<section class="stbr-section">
      <label class="stbr-label" for="stbr-floor-select"><i class="fa-solid fa-book-open"></i> 章节标题</label>
      <select id="stbr-floor-select" class="stbr-select">${options || '<option>暂无 AI 回复</option>'}</select>
      ${!current ? '<div class="stbr-empty">等待小说中的第一条角色回复</div>' : review?.excerpt ? `<div class="stbr-excerpt-head"><span>本章书摘</span><button class="stbr-link-btn" data-action="reset-excerpt"><i class="fa-solid fa-rotate"></i> 刷新书摘</button></div><blockquote class="stbr-excerpt">${escapeHtml(review.excerpt)}</blockquote>` : '<div class="stbr-empty stbr-excerpt-empty">首次生成后，这里会显示本章书摘。</div>'}
      <div class="stbr-row"><span class="stbr-hint">${review?.comments?.length || 0} 条书评${review?.comments?.some(c => c.pending || c.replies?.some(r => r.pending)) ? ' · 有操作待更新' : ''}</span>${!review?.generated ? `<button class="stbr-btn stbr-btn-primary" data-action="initial-generate" ${current ? '' : 'disabled'}><i class="fa-solid fa-wand-magic-sparkles"></i> 生成书摘与书评</button>` : ''}</div>
    </section>
    <section class="stbr-section"><div class="stbr-review-toolbar"><b>读者书评</b>${review?.generated ? '<button class="stbr-link-btn stbr-danger-link" data-action="reset-reviews"><i class="fa-solid fa-rotate"></i> 刷新书评</button>' : ''}</div><div class="stbr-comments">${comments || '<div class="stbr-empty">这一层还没有评论，来坐沙发吧。</div>'}</div>
      <form id="stbr-comment-form" class="stbr-composer"><input class="stbr-input" name="content" placeholder="写下你的书评…" autocomplete="off"><button class="stbr-send" title="发送"><i class="fa-solid fa-paper-plane"></i></button></form>
      <p class="stbr-hint stbr-operation-hint">书评和回复会先保存为待处理操作；全部完成后，请点上方“更新”。</p>
    </section>`;
}

function renderRoom(mode) {
    const isCharacter = mode === 'character';
    const history = state.rooms[mode] || [];
    return `<section class="stbr-section stbr-room-intro"><div class="stbr-mode-icon"><i class="fa-solid ${isCharacter ? 'fa-masks-theater' : 'fa-mug-hot'}"></i></div><div><b>${isCharacter ? '角色私聊' : '普通聊天'}</b><p>${isCharacter ? '角色知道自己身处小说，可与你谈感受、选择与命运。' : '以戏外视角讨论剧情、人物和你的任何疑问，不写入正文。'}</p></div></section>
      <section class="stbr-section stbr-chat-section"><div class="stbr-chat-log" id="stbr-chat-log">${history.map(m => `<div class="stbr-bubble ${m.role}"><span>${escapeHtml(m.content)}</span></div>`).join('') || '<div class="stbr-empty">这是独立房间，不会污染小说正文。</div>'}</div>
      <form class="stbr-composer" id="stbr-room-form" data-mode="${mode}"><textarea class="stbr-input stbr-room-input" name="content" rows="2" placeholder="${isCharacter ? '想对角色说什么？' : '想聊什么？'}"></textarea><button class="stbr-send" title="发送"><i class="fa-solid fa-paper-plane"></i></button></form>
      <button class="stbr-link-btn stbr-clear" data-action="clear-room" data-mode="${mode}">清空此房间</button></section>`;
}

function renderSettings() {
    return `<section class="stbr-section"><label class="stbr-toggle-row"><span><b>显示悬浮气泡</b><small>关闭后仍可从魔法棒菜单打开</small></span><input id="stbr-bubble-toggle" type="checkbox" ${state.settings.bubbleEnabled ? 'checked' : ''}><i></i></label></section>
      <section class="stbr-section"><label class="stbr-label" for="stbr-reviewer-name"><i class="fa-solid fa-user-pen"></i> 书评网名</label><input id="stbr-reviewer-name" class="stbr-input" type="text" maxlength="30" value="${escapeHtml(state.settings.reviewerName || '')}" placeholder="默认使用 SillyTavern 用户名"><p class="stbr-hint">你发表书评和回复时显示的名字；留空则使用当前用户名。</p></section>
      <section class="stbr-section"><label class="stbr-label" for="stbr-context-depth">侧聊读取正文层数</label><input id="stbr-context-depth" class="stbr-input" type="number" min="2" max="50" value="${state.settings.contextDepth}"><p class="stbr-hint">角色私聊和普通聊天只读取最近这些楼层，独立聊天记录另行保存。</p></section>
      <section class="stbr-section stbr-about"><b>ST Book Review · 1.2.0</b><p>书评区、角色私聊与普通聊天均绑定当前 SillyTavern 对话保存。</p></section>`;
}

function render() {
    if (!root) return;
    const fab = root.querySelector('#stbr-fab');
    if (fab) fab.hidden = !state.settings.bubbleEnabled;
    root.querySelectorAll('.stbr-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === activeTab));
    const body = root.querySelector('#stbr-body');
    body.innerHTML = activeTab === 'reviews' ? renderReviewTab() : activeTab === 'character' ? renderRoom('character') : activeTab === 'normal' ? renderRoom('normal') : renderSettings();
    requestAnimationFrame(() => { const log = root.querySelector('#stbr-chat-log'); if (log) log.scrollTop = log.scrollHeight; });
}

function normalizeComments(items = []) {
    return items.filter(c => c?.content).map(c => ({
        id: uid(), author: c.author || '匿名读者', content: c.content,
        createdAt: now(), replies: (c.replies || []).filter(r => r?.content).map(r => ({ id: uid(), author: r.author || '匿名读者', content: r.content, createdAt: now() })),
    }));
}

async function generateInitialBundle() {
    const message = selectedMessage();
    if (!message) return;
    const review = reviewFor(message);
    const button = root.querySelector('[data-action="initial-generate"]');
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中'; }
    try {
        const prompt = `阅读本层小说正文，同时完成三件事：\n1. 写一个贴合正文、避免剧透后文的章节标题；\n2. 提炼一段80到160字的书摘式摘要，不要直接照抄原文；\n3. 模拟小说阅读站评论区，生成至少12条主书评（必须不少于10条），包含LZ与不同读者，观点和语气各异，部分书评带楼中楼回复。\n只输出 JSON 对象：{"title":"章节标题","excerpt":"书摘","comments":[{"author":"昵称","content":"评论","replies":[{"author":"昵称","content":"回复"}]}]}。\n\n本层正文：${message.text}`;
        const raw = await callAI('你是小说阅读站的章节编辑和评论区生成器。输出必须是可解析 JSON，不要附加解释。', [], prompt);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        const comments = normalizeComments(parsed.comments);
        if (!parsed.title || !parsed.excerpt || comments.length < 10) throw new Error('生成结果不完整（章节标题、书摘或至少10条书评缺失），请重试。');
        review.title = parsed.title.trim(); review.excerpt = parsed.excerpt.trim(); review.comments = comments; review.generated = true;
        review.updatedAt = now(); await saveState(); render();
    } catch (error) { alert(`首次生成失败：${error.message}`); render(); }
}

async function updateReviews() {
    const message = selectedMessage(); if (!message) return;
    const review = reviewFor(message);
    const button = root.querySelector('[data-action="update-reviews"]');
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 更新中'; }
    try {
        const pendingTargets = review.comments.filter(c => c.pending || c.replies?.some(r => r.pending));
        const existing = review.comments.map(c => `[主评ID:${c.id}] ${c.author}${c.pending ? '（用户本轮新书评，必须回复）' : ''}：${c.content}${(c.replies || []).map(r => `\n  [回复ID:${r.id}] ${r.author}${r.pending ? '（用户本轮新回复，必须继续回应）' : ''}：${r.content}`).join('')}`).join('\n');
        const prompt = `下面是本章完整书评区。请更新评论情况。\n硬性要求：\n1. 保留所有已有内容，不要改写或删除；\n2. 每一条标注“必须回复/必须继续回应”的用户内容，都至少生成1条读者回应；\n3. 回应必须挂到对应主评下面，targetId 必须照抄该主评ID；即使回应的是其楼中楼，也使用所属主评ID；\n4. 另外可新增2到4条主书评；\n5. 只输出 JSON 对象：{"replies":[{"targetId":"主评ID","author":"昵称","content":"针对性回应"}],"comments":[{"author":"昵称","content":"新增主评","replies":[]}]}。\n本层正文：${message.text}\n当前书评区：\n${existing}`;
        const raw = await callAI('你是小说阅读站评论区生成器。承接现有讨论，像真实读者一样产生有差异的回应，只输出 JSON。', [], prompt);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        const directReplies = Array.isArray(parsed.replies) ? parsed.replies.filter(r => r?.targetId && r?.content) : [];
        const repliedTargets = new Set(directReplies.map(r => String(r.targetId)));
        const missingTargets = pendingTargets.filter(c => !repliedTargets.has(c.id));
        if (missingTargets.length) throw new Error(`模型漏掉了 ${missingTargets.length} 条待处理书评/回复，内容仍已保留，请再次点击更新。`);
        directReplies.forEach(reply => {
            const target = review.comments.find(c => c.id === String(reply.targetId));
            if (target) target.replies.push({ id: uid(), author: reply.author || '匿名读者', content: reply.content, createdAt: now() });
        });
        const additions = normalizeComments(parsed.comments);
        review.comments.forEach(c => { delete c.pending; (c.replies || []).forEach(r => delete r.pending); });
        review.comments.push(...additions); review.updatedAt = now(); await saveState(); render();
    } catch (error) { alert(`更新失败：${error.message}`); render(); }
}

async function resetReviews() {
    if (!confirm('确定清除这一章现有的全部书评和回复，并重新生成至少10条书评吗？此操作无法撤销。')) return;
    const message = selectedMessage(); if (!message) return;
    const review = reviewFor(message); review.comments = []; review.generated = false; await saveState(); render();
    await generateInitialBundleKeepingExcerpt();
}

async function generateInitialBundleKeepingExcerpt() {
    const message = selectedMessage(); if (!message) return;
    const review = reviewFor(message);
    try {
        const raw = await callAI('你是小说阅读站评论区生成器，只输出可解析 JSON。', [], `为本层正文生成至少12条主书评（必须不少于10条），有LZ、不同读者和部分楼中楼。只输出 JSON 数组。\n正文：${message.text}`);
        const comments = normalizeComments(JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]'));
        if (comments.length < 10) throw new Error('生成不足10条，请再次刷新。');
        review.comments = comments; review.generated = true; review.updatedAt = now(); await saveState(); render();
    } catch (error) { alert(`刷新书评失败：${error.message}`); render(); }
}

async function resetExcerpt() {
    if (!confirm('确定清除这一章现有的章节标题和书摘，并重新生成吗？此操作无法撤销。')) return;
    const message = selectedMessage(); if (!message) return;
    const review = reviewFor(message); review.title = ''; review.excerpt = ''; await saveState(); render();
    try {
        const raw = await callAI('你是小说章节编辑，只输出可解析 JSON。', [], `为本层正文重新生成章节标题与80到160字书摘。不要剧透后文，不要直接照抄。只输出 {"title":"章节标题","excerpt":"书摘"}。\n正文：${message.text}`);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (!parsed.title || !parsed.excerpt) throw new Error('生成结果缺少标题或书摘。');
        review.title = parsed.title.trim(); review.excerpt = parsed.excerpt.trim(); review.updatedAt = now(); await saveState(); render();
    } catch (error) { alert(`刷新书摘失败：${error.message}`); render(); }
}

async function sendRoom(form) {
    const mode = form.dataset.mode;
    const input = form.elements.content;
    const text = input.value.trim(); if (!text) return;
    const history = state.rooms[mode];
    history.push({ id: uid(), role: 'user', content: text, createdAt: now() }); input.value = ''; render();
    const system = mode === 'character'
        ? `你是小说角色“${context.name2 || '当前角色'}”，但这是小说之外的私聊。你清楚自己是故事角色，了解刚才发生的剧情，可以诚实谈论心情、动机、遗憾与作者/读者，但不要续写小说正文。保持角色的性格与口吻。`
        : '你是小说的戏外聊天伙伴。结合只读故事上下文与用户讨论剧情、人物和感受。除非用户明确要求草稿，否则不要续写或扮演正文。';
    try {
        const answer = await callAI(system, history.slice(0, -1), text);
        history.push({ id: uid(), role: 'assistant', content: answer || '（没有收到回复）', createdAt: now() });
    } catch (error) { history.push({ id: uid(), role: 'assistant', content: `发送失败：${error.message}`, createdAt: now(), error: true }); }
    await saveState(); render();
}

async function onSubmit(event) {
    if (event.target.id === 'stbr-comment-form') {
        event.preventDefault(); const text = event.target.elements.content.value.trim(); if (!text) return;
        reviewFor(selectedMessage()).comments.push({ id: uid(), author: reviewerName(), content: text, createdAt: now(), replies: [], pending: true });
        await saveState(); render();
    }
    if (event.target.id === 'stbr-room-form') { event.preventDefault(); await sendRoom(event.target); }
}

async function onClick(event) {
    const target = event.target.closest('[data-action], .stbr-tab'); if (!target) return;
    if (target.classList.contains('stbr-tab')) { activeTab = target.dataset.tab; render(); return; }
    const action = target.dataset.action;
    if (action === 'initial-generate') await generateInitialBundle();
    if (action === 'update-reviews') await updateReviews();
    if (action === 'reset-reviews') await resetReviews();
    if (action === 'reset-excerpt') await resetExcerpt();
    if (action === 'clear-room' && confirm('清空这个独立聊天房间？')) { state.rooms[target.dataset.mode] = []; await saveState(); render(); }
    if (action === 'reply') {
        const text = prompt('回复这条评论：'); if (!text?.trim()) return;
        const comment = reviewFor(selectedMessage()).comments.find(c => c.id === target.dataset.id);
        comment?.replies.push({ id: uid(), author: reviewerName(), content: text.trim(), createdAt: now(), pending: true }); await saveState(); render();
    }
}

async function onChange(event) {
    if (event.target.id === 'stbr-floor-select') { activeMessageId = event.target.value; render(); }
    if (event.target.id === 'stbr-bubble-toggle') { state.settings.bubbleEnabled = event.target.checked; await saveState(); render(); }
    if (event.target.id === 'stbr-context-depth') { state.settings.contextDepth = Math.max(2, Math.min(50, Number(event.target.value) || 12)); await saveState(); }
    if (event.target.id === 'stbr-reviewer-name') { state.settings.reviewerName = event.target.value.trim(); await saveState(); }
}

function addMagicWandEntry() {
    if (document.querySelector('#stbr-menu-entry')) return;
    const menu = document.querySelector('#extensionsMenu'); if (!menu) return;
    const entry = document.createElement('div'); entry.id = 'stbr-menu-entry'; entry.className = 'list-group-item flex-container flexGap5 interactable';
    entry.tabIndex = 0; entry.innerHTML = '<i class="fa-solid fa-book-open"></i><span>千页书评</span>';
    entry.addEventListener('click', () => openPanel('reviews')); menu.append(entry);
}

async function init() {
    if (document.querySelector('#stbr-root')) return;
    context = getContext(); state = loadState();
    const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'template');
    root = document.createElement('div'); root.id = 'stbr-root'; root.innerHTML = html; document.body.append(root);
    root.querySelector('#stbr-fab').addEventListener('click', () => openPanel());
    root.querySelector('#stbr-close').addEventListener('click', closePanel);
    root.querySelector('#stbr-backdrop').addEventListener('click', closePanel);
    root.addEventListener('click', onClick); root.addEventListener('submit', onSubmit); root.addEventListener('change', onChange);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.querySelector('#stbr-overlay').hidden) closePanel(); });
    addMagicWandEntry(); setTimeout(addMagicWandEntry, 1500);
    const events = context.eventSource; const types = context.eventTypes || window.event_types || {};
    [types.MESSAGE_RECEIVED, types.MESSAGE_DELETED, types.MESSAGE_EDITED, types.CHAT_CHANGED].filter(Boolean).forEach(type => events?.on?.(type, () => { context = getContext(); state = loadState(); activeMessageId = ''; render(); }));
    render(); console.info('[ST Book Review] 1.2.0 loaded');
}

jQuery(init);
