import { renderExtensionTemplateAsync } from '/scripts/extensions.js';

const EXT_FOLDER = 'third-party/ST-book-review';
const STORE_KEY = 'st_book_review_v1';
const DEFAULT_IN_PROMPT = `你就是小说世界里的“{name}”，正在故事内用即时消息和用户聊天。你必须以角色本人身份回应，不知道自己在被扮演。像微信聊天一样自然、口语化、简短，通常1到3句，尽量不超过80字；不要写旁白、动作描写、标题或长段分析。`;
const DEFAULT_OUT_PROMPT = `你是现实/作品外负责扮演“{name}”的演员或扮演者，不是“{name}”本人。绝对不要用角色本人的身份、记忆或口吻冒充角色；你清楚角色只是你出演的对象，可以从演员视角聊表演、剧本、角色感受、剧情和日常。像微信聊天一样自然、口语化、简短，通常1到3句，尽量不超过80字。`;
const DEFAULTS = { bubbleEnabled: true, contextDepth: 12, reviewerName: '', apiMode: 'main', apiBaseUrl: '', apiKey: '', apiModel: '', apiModels: [], inChatPrompt: DEFAULT_IN_PROMPT, outChatPrompt: DEFAULT_OUT_PROMPT, compressionEnabled: true, compressionLimit: 30 };
let state = null;
let root = null;
let context = null;
let activeTab = 'reviews';
let activeMessageId = '';
let activeContactId = 'screenwriter';
const typingContacts = new Set();

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const reviewerName = () => state.settings.reviewerName?.trim() || context.name1 || '我';

function getContext() {
    return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
}

function emptyState() {
    return { settings: { ...DEFAULTS }, reviews: {}, rooms: { character: [], normal: [] }, contacts: [{ id: 'screenwriter', name: '编剧', type: 'screenwriter' }], dmRooms: { screenwriter: [] }, dmMemories: {}, dmContextStarts: {} };
}

function roomKey(contact, mode = contact.chatMode) {
    return contact.type === 'screenwriter' ? 'screenwriter' : `${contact.id}:${mode === 'out' ? 'out' : 'in'}`;
}

function ensureMessagingState() {
    state.contacts = Array.isArray(state.contacts) && state.contacts.length ? state.contacts : [{ id: 'screenwriter', name: '编剧', type: 'screenwriter' }];
    if (!state.contacts.some(c => c.id === 'screenwriter')) state.contacts.unshift({ id: 'screenwriter', name: '编剧', type: 'screenwriter' });
    state.dmRooms ||= {};
    state.dmMemories ||= {};
    state.dmContextStarts ||= {};
    state.contacts.forEach(contact => { contact.chatMode ||= contact.type === 'screenwriter' ? 'out' : 'in'; });
    state.dmRooms.screenwriter ||= state.rooms?.normal || [];
    if (state.rooms?.character?.length && !state.contacts.some(c => c.id === 'legacy-character')) {
        state.contacts.push({ id: 'legacy-character', name: context.name2 || '当前角色', type: 'character' });
        state.dmRooms['legacy-character'] = state.rooms.character;
    }
    state.contacts.filter(c => c.type !== 'screenwriter').forEach(contact => {
        if (state.dmRooms[contact.id] && !state.dmRooms[roomKey(contact)]) {
            state.dmRooms[roomKey(contact)] = state.dmRooms[contact.id]; delete state.dmRooms[contact.id];
        }
        state.dmRooms[`${contact.id}:in`] ||= [];
        state.dmRooms[`${contact.id}:out`] ||= [];
    });
    if (!state.contacts.some(c => c.id === activeContactId)) activeContactId = 'screenwriter';
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
        const storedLocal = JSON.parse(localStorage.getItem(`${STORE_KEY}:${chatKey()}`) || '{}');
        return { ...emptyState(), ...storedLocal, settings: { ...DEFAULTS, ...(storedLocal.settings || {}) } };
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

function buildStoryContext(depth = state.settings.contextDepth, maxMessageIndex = null) {
    const chat = maxMessageIndex == null ? (context.chat || []) : (context.chat || []).slice(0, maxMessageIndex + 1);
    return chat.slice(-depth).map(m => `${m.is_user ? (context.name1 || '用户') : (m.name || context.name2 || '角色')}：${m.mes || ''}`).join('\n\n');
}

async function callAI(system, history, userText, maxMessageIndex = null) {
    context = getContext();
    const transcript = history.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
    const storyContext = buildStoryContext(state.settings.contextDepth, maxMessageIndex);
    const prompt = `${system}\n\n【小说只读上下文】\n${storyContext}\n\n【独立聊天记录】\n${transcript}\n用户：${userText}\n助手：`;
    if (state.settings.apiMode === 'custom') {
        const base = String(state.settings.apiBaseUrl || '').replace(/\/+$/, '');
        if (!base || !state.settings.apiModel) throw new Error('请先在设置中填写自定义 API 地址并选择模型。');
        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(state.settings.apiKey ? { Authorization: `Bearer ${state.settings.apiKey}` } : {}) },
            body: JSON.stringify({ model: state.settings.apiModel, messages: [{ role: 'system', content: `${system}\n\n【小说只读上下文】\n${storyContext}` }, ...history.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: userText }], stream: false }),
        });
        if (!response.ok) throw new Error(`自定义 API 请求失败（${response.status}）：${await response.text()}`);
        const data = await response.json();
        return String(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '').trim();
    }
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
          <div class="stbr-comment-head"><strong>${escapeHtml(comment.author)}</strong><div>${comment.isMine || comment.author === reviewerName() ? `<span class="stbr-own-actions"><button data-action="edit-comment" data-id="${comment.id}">修改</button><button data-action="delete-comment" data-id="${comment.id}">删除</button></span>` : ''}<time>${new Date(comment.createdAt).toLocaleString()}</time></div></div>
          <p>${escapeHtml(comment.content)}</p>
          <button class="stbr-link-btn" data-action="reply" data-id="${comment.id}">回复</button>${comment.pending ? '<span class="stbr-pending">待更新</span>' : ''}
          ${(comment.replies || []).map(reply => `<div class="stbr-reply"><div class="stbr-reply-line"><span><strong>${escapeHtml(reply.author)}</strong>${reply.replyTo ? `<small>回复 @${escapeHtml(reply.replyTo)}</small>` : ''}</span>${reply.isMine || reply.author === reviewerName() ? `<span class="stbr-own-actions"><button data-action="edit-reply" data-comment-id="${comment.id}" data-id="${reply.id}">修改</button><button data-action="delete-reply" data-comment-id="${comment.id}" data-id="${reply.id}">删除</button></span>` : ''}</div><span>${escapeHtml(reply.content)}</span>${reply.pending ? '<em>待更新</em>' : ''}</div>`).join('')}
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

function renderMessages() {
    ensureMessagingState();
    const contact = state.contacts.find(c => c.id === activeContactId) || state.contacts[0];
    const key = roomKey(contact);
    const history = state.dmRooms[key] ||= [];
    const contacts = state.contacts.map(c => `<button class="stbr-contact ${c.id === contact.id ? 'active' : ''}" data-action="select-contact" data-id="${c.id}"><span class="stbr-avatar">${escapeHtml(c.name.slice(0, 1))}</span><span>${escapeHtml(c.name)}</span>${c.type !== 'screenwriter' ? `<i data-action="remove-contact" data-id="${c.id}" title="删除联系人" class="fa-solid fa-xmark"></i>` : ''}</button>`).join('');
    const messages = history.map(m => `<div class="stbr-bubble ${m.role}" data-message-id="${m.id}"><div class="stbr-message-wrap"><span>${escapeHtml(m.content)}</span>${m.role === 'assistant' ? `<div class="stbr-message-actions"><button data-action="refresh-message" data-contact-id="${contact.id}" data-id="${m.id}"><i class="fa-solid fa-rotate"></i> 刷新</button><button data-action="delete-message" data-contact-id="${contact.id}" data-id="${m.id}"><i class="fa-solid fa-trash"></i> 删除</button></div>` : ''}</div></div>`).join('');
    const typing = typingContacts.has(key) ? '<div class="stbr-bubble assistant stbr-typing"><div class="stbr-message-wrap"><span><i class="fa-solid fa-ellipsis fa-beat-fade"></i> 回复中</span></div></div>' : '';
    const memory = state.dmMemories[key] ? `<details class="stbr-memory-note"><summary><i class="fa-solid fa-brain"></i> 已生成本地压缩记忆</summary><p>${escapeHtml(state.dmMemories[key])}</p></details>` : '';
    return `<div class="stbr-messenger"><aside class="stbr-contact-pane"><div class="stbr-contact-title">私信</div><div class="stbr-contact-list">${contacts}</div><form id="stbr-add-contact" class="stbr-add-contact"><input class="stbr-input" name="name" maxlength="30" placeholder="输入人物名"><button title="新增私信人物"><i class="fa-solid fa-plus"></i></button></form></aside>
      <section class="stbr-conversation"><header><span class="stbr-avatar">${escapeHtml(contact.name.slice(0, 1))}</span><div><b>${escapeHtml(contact.name)}</b><small>${contact.type === 'screenwriter' ? '可以聊剧情，也可以聊任何日常话题' : '小说角色 · 戏外 1 对 1 私聊'}</small></div></header>
      ${contact.type === 'screenwriter' ? '' : `<div class="stbr-chat-mode"><button data-action="set-chat-mode" data-mode="in" data-contact-id="${contact.id}" class="${contact.chatMode === 'in' ? 'active' : ''}">剧内 · 角色</button><button data-action="set-chat-mode" data-mode="out" data-contact-id="${contact.id}" class="${contact.chatMode === 'out' ? 'active' : ''}">剧外 · 扮演者</button></div>`}
      ${memory}<div class="stbr-chat-log" id="stbr-chat-log">${messages || (!typing ? `<div class="stbr-empty">你和${escapeHtml(contact.name)}的独立对话从这里开始。</div>` : '')}${typing}</div>
      <form class="stbr-composer stbr-dm-composer" id="stbr-room-form" data-contact-id="${contact.id}"><textarea class="stbr-input stbr-room-input" name="content" rows="2" placeholder="发消息给${escapeHtml(contact.name)}…" ${typingContacts.has(key) ? 'disabled' : ''}></textarea><button class="stbr-send" title="发送" ${typingContacts.has(key) ? 'disabled' : ''}><i class="fa-solid fa-paper-plane"></i></button></form>
      <button class="stbr-link-btn stbr-clear" data-action="clear-room" data-room-key="${key}">清空与${escapeHtml(contact.name)}的对话</button></section></div>`;
}

function renderSettings() {
    const api = state.settings;
    const models = Array.isArray(api.apiModels) ? api.apiModels : [];
    const customApi = api.apiMode === 'custom' ? `<div class="stbr-api-fields">
        <label class="stbr-label" for="stbr-api-url">API 地址</label><input id="stbr-api-url" class="stbr-input" type="url" value="${escapeHtml(api.apiBaseUrl || '')}" placeholder="https://example.com/v1">
        <label class="stbr-label" for="stbr-api-key">API Key</label><input id="stbr-api-key" class="stbr-input" type="password" value="${escapeHtml(api.apiKey || '')}" placeholder="sk-…" autocomplete="off">
        <div class="stbr-model-head"><label class="stbr-label" for="stbr-model-search">模型</label><button class="stbr-link-btn" data-action="fetch-models"><i class="fa-solid fa-cloud-arrow-down"></i> 拉取模型</button></div>
        <input id="stbr-model-search" class="stbr-input" type="search" placeholder="输入 3.6 可快速筛选模型" autocomplete="off">
        <select id="stbr-api-model" class="stbr-select stbr-model-select">${models.map(model => `<option value="${escapeHtml(model)}" ${model === api.apiModel ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('') || `<option value="${escapeHtml(api.apiModel || '')}">${escapeHtml(api.apiModel || '请先拉取模型')}</option>`}</select>
        <p class="stbr-hint">地址填写到 <code>/v1</code> 即可，插件会自动请求 <code>/models</code> 和 <code>/chat/completions</code>。</p>
      </div>` : '<p class="stbr-hint">书评、书摘和独立聊天使用当前 SillyTavern 主连接。</p>';
    return `<section class="stbr-section"><label class="stbr-toggle-row"><span><b>显示悬浮气泡</b><small>关闭后仍可从魔法棒菜单打开</small></span><input id="stbr-bubble-toggle" type="checkbox" ${state.settings.bubbleEnabled ? 'checked' : ''}><i></i></label></section>
      <section class="stbr-section"><label class="stbr-label" for="stbr-reviewer-name"><i class="fa-solid fa-user-pen"></i> 书评网名</label><input id="stbr-reviewer-name" class="stbr-input" type="text" maxlength="30" value="${escapeHtml(state.settings.reviewerName || '')}" placeholder="默认使用 SillyTavern 用户名"><p class="stbr-hint">你发表书评和回复时显示的名字；留空则使用当前用户名。</p></section>
      <section class="stbr-section"><label class="stbr-label" for="stbr-api-mode"><i class="fa-solid fa-plug"></i> API 连接</label><select id="stbr-api-mode" class="stbr-select"><option value="main" ${api.apiMode === 'main' ? 'selected' : ''}>使用主酒馆 API</option><option value="custom" ${api.apiMode === 'custom' ? 'selected' : ''}>连接其他 OpenAI 兼容 API</option></select>${customApi}</section>
      <details class="stbr-section stbr-settings-details"><summary><span><i class="fa-solid fa-message"></i> 私信提示词</span><i class="fa-solid fa-chevron-down"></i></summary><div class="stbr-details-body">
        <div class="stbr-model-head"><label class="stbr-label" for="stbr-in-prompt">剧内聊天提示词</label><button class="stbr-link-btn" data-action="reset-prompt" data-kind="in">恢复默认</button></div><textarea id="stbr-in-prompt" class="stbr-input stbr-prompt-editor" rows="6">${escapeHtml(api.inChatPrompt || DEFAULT_IN_PROMPT)}</textarea>
        <div class="stbr-model-head"><label class="stbr-label" for="stbr-out-prompt">剧外聊天提示词</label><button class="stbr-link-btn" data-action="reset-prompt" data-kind="out">恢复默认</button></div><textarea id="stbr-out-prompt" class="stbr-input stbr-prompt-editor" rows="7">${escapeHtml(api.outChatPrompt || DEFAULT_OUT_PROMPT)}</textarea>
        <p class="stbr-hint">可使用 <code>{name}</code> 代表当前联系人。修改后离开输入框即保存。</p>
      </div></details>
      <details class="stbr-section stbr-settings-details"><summary><span><i class="fa-solid fa-brain"></i> 本地上下文压缩</span><i class="fa-solid fa-chevron-down"></i></summary><div class="stbr-details-body">
        <label class="stbr-toggle-row"><span><b>自动压缩私信上下文</b><small>本地提炼，不调用 API；聊天记录仍完整显示</small></span><input id="stbr-compression-enabled" type="checkbox" ${api.compressionEnabled ? 'checked' : ''}><i></i></label>
        <label class="stbr-label" for="stbr-compression-limit">达到多少条消息时压缩</label><input id="stbr-compression-limit" class="stbr-input" type="number" min="6" max="200" value="${Number(api.compressionLimit) || 30}"><p class="stbr-hint">例如填 30：首次累计 30 条消息后生成一份本地记忆；记忆占 1 条，此后再累计 29 条新消息时重新压缩。</p>
      </div></details>
      <section class="stbr-section"><label class="stbr-label" for="stbr-context-depth">侧聊读取正文层数</label><input id="stbr-context-depth" class="stbr-input" type="number" min="2" max="50" value="${state.settings.contextDepth}"><p class="stbr-hint">角色私聊和普通聊天只读取最近这些楼层，独立聊天记录另行保存。</p></section>
      <section class="stbr-section stbr-about"><b>ST Book Review · 1.6.1</b><p>书评区与论坛式私信均绑定当前 SillyTavern 对话保存。</p></section>`;
}

function render() {
    if (!root) return;
    const fab = root.querySelector('#stbr-fab');
    if (fab) fab.hidden = !state.settings.bubbleEnabled;
    root.querySelectorAll('.stbr-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === activeTab));
    const body = root.querySelector('#stbr-body');
    body.classList.toggle('stbr-messages-body', activeTab === 'messages');
    body.innerHTML = activeTab === 'reviews' ? renderReviewTab() : activeTab === 'messages' ? renderMessages() : renderSettings();
    requestAnimationFrame(() => { const log = root.querySelector('#stbr-chat-log'); if (log) log.scrollTop = log.scrollHeight; });
}

function normalizeComments(items = []) {
    const fallbackNames = ['夜航星', '春日邮差', '纸上青苔', '南窗旧梦', '山雀来信', '迟墨', '半糖乌龙', '月下拾句', '北岸书生', '雾里灯', '小满未满', '长街听雨'];
    return items.filter(c => c?.content).map((c, index) => ({
        id: uid(), author: !String(c.author || '').trim() || String(c.author).trim() === '匿名读者' ? fallbackNames[index % fallbackNames.length] : String(c.author).trim(), content: c.content,
        createdAt: now(), replies: (c.replies || []).filter(r => r?.content).map((r, replyIndex) => ({ id: uid(), author: !String(r.author || '').trim() || String(r.author).trim() === '匿名读者' ? fallbackNames[(index + replyIndex + 3) % fallbackNames.length] : String(r.author).trim(), content: r.content, createdAt: now() })),
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
        const raw = await callAI('你是小说阅读站的章节编辑和评论区生成器。输出必须是可解析 JSON，不要附加解释。', [], prompt, message.index);
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
        const pendingTargets = [];
        review.comments.forEach(c => {
            if (c.pending) pendingTargets.push({ id: c.id, parentId: c.id, author: c.author, parentAuthor: '' });
            (c.replies || []).forEach(r => { if (r.pending) pendingTargets.push({ id: r.id, parentId: c.id, author: r.author, parentAuthor: c.author }); });
        });
        const existing = review.comments.map(c => `[主评ID:${c.id}] ${c.author}${c.pending ? `（待回应目标ID:${c.id}）` : ''}：${c.content}${(c.replies || []).map(r => `\n  [回复ID:${r.id}，所属主评ID:${c.id}] ${r.author}${r.pending ? `（待回应目标ID:${r.id}）` : ''}：${r.content}`).join('')}`).join('\n');
        const prompt = `下面是本章完整书评区。请更新评论情况。\n硬性要求：\n1. 保留所有已有内容，不要改写或删除；\n2. 每一个“待回应目标ID”都必须分别生成直接、针对性的回应；\n3. 如果用户回复了别人的楼中楼，必须让该主评的原作者（楼主）亲自回应，并可再让1到3位其他读者一起回应，因此同一个 targetId 可以出现多条 replies；\n4. targetId 必须照抄待回应目标ID，parentId 必须照抄它所属的主评ID；\n5. 另外可新增2到4条主书评；\n6. 只输出 JSON 对象：{"replies":[{"targetId":"待回应目标ID","parentId":"所属主评ID","author":"昵称","content":"针对性回应"}],"comments":[{"author":"昵称","content":"新增主评","replies":[]}]}。\n本层正文：${message.text}\n当前书评区：\n${existing}`;
        const raw = await callAI('你是小说阅读站评论区生成器。承接现有讨论，像真实读者一样产生有差异的回应，只输出 JSON。', [], prompt, message.index);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        const directReplies = Array.isArray(parsed.replies) ? parsed.replies.filter(r => r?.targetId && r?.content) : [];
        const repliedTargets = new Set(directReplies.map(r => String(r.targetId)));
        const missingTargets = pendingTargets.filter(target => !repliedTargets.has(target.id));
        if (missingTargets.length) throw new Error(`模型漏掉了 ${missingTargets.length} 条待处理书评/回复，内容仍已保留，请再次点击更新。`);
        pendingTargets.filter(target => target.parentAuthor).forEach(target => {
            const replies = directReplies.filter(reply => String(reply.targetId) === target.id);
            if (replies.length) replies[0].author = target.parentAuthor;
        });
        directReplies.forEach(reply => {
            const pending = pendingTargets.find(target => target.id === String(reply.targetId));
            const parentId = pending?.parentId || String(reply.parentId || reply.targetId);
            const parent = review.comments.find(c => c.id === parentId);
            if (parent) parent.replies.push({ id: uid(), author: reply.author || '匿名读者', replyTo: pending?.author || '', content: reply.content, createdAt: now() });
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
        const raw = await callAI('你是小说阅读站评论区生成器，只输出可解析 JSON。', [], `为本层正文生成至少12条主书评（必须不少于10条），有LZ、不同读者和部分楼中楼。只输出 JSON 数组。\n正文：${message.text}`, message.index);
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
        const raw = await callAI('你是小说章节编辑，只输出可解析 JSON。', [], `为本层正文重新生成章节标题与80到160字书摘。不要剧透后文，不要直接照抄。只输出 {"title":"章节标题","excerpt":"书摘"}。\n正文：${message.text}`, message.index);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (!parsed.title || !parsed.excerpt) throw new Error('生成结果缺少标题或书摘。');
        review.title = parsed.title.trim(); review.excerpt = parsed.excerpt.trim(); review.updatedAt = now(); await saveState(); render();
    } catch (error) { alert(`刷新书摘失败：${error.message}`); render(); }
}

async function fetchModels() {
    const base = String(state.settings.apiBaseUrl || '').replace(/\/+$/, '');
    if (!base) { alert('请先填写 API 地址（到 /v1）。'); return; }
    const button = root.querySelector('[data-action="fetch-models"]');
    if (button) { button.disabled = true; button.textContent = '拉取中…'; }
    try {
        const response = await fetch(`${base}/models`, { headers: state.settings.apiKey ? { Authorization: `Bearer ${state.settings.apiKey}` } : {} });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const data = await response.json();
        const models = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []).map(item => String(item?.id || item?.name || item)).filter(Boolean).sort((a, b) => a.localeCompare(b));
        if (!models.length) throw new Error('接口没有返回模型列表。');
        state.settings.apiModels = [...new Set(models)];
        if (!state.settings.apiModels.includes(state.settings.apiModel)) state.settings.apiModel = state.settings.apiModels[0];
        await saveState(); render();
    } catch (error) { alert(`拉取模型失败：${error.message}\n如果这是跨域错误，请确认 API 服务允许浏览器 CORS 请求。`); render(); }
}

function privateChatPrompt(contact) {
    if (contact.type === 'screenwriter') return '你叫“编剧”，是作品之外的微信聊天伙伴，可以聊小说，也可以聊任何日常话题。回复自然、口语化、简短，通常1到3句，尽量不超过80字；不要写长段分析、旁白、动作或标题。';
    const template = contact.chatMode === 'in' ? state.settings.inChatPrompt : state.settings.outChatPrompt;
    return String(template || (contact.chatMode === 'in' ? DEFAULT_IN_PROMPT : DEFAULT_OUT_PROMPT)).replaceAll('{name}', contact.name);
}

function localMemorySummary(previous, messages) {
    const compact = messages.map(message => {
        const label = message.role === 'user' ? '用户' : '对方';
        const text = String(message.content || '').replace(/\s+/g, ' ').trim();
        return `${label}：${text.length > 180 ? `${text.slice(0, 177)}…` : text}`;
    }).filter(line => !line.endsWith('：')).join('\n');
    return [previous, compact].filter(Boolean).join('\n').slice(-5000);
}

function maybeCompressRoom(key, history) {
    if (!state.settings.compressionEnabled) return;
    const limit = Math.max(6, Math.min(200, Number(state.settings.compressionLimit) || 30));
    const start = Number(state.dmContextStarts[key] || 0);
    const effectiveCount = history.length - start + (state.dmMemories[key] ? 1 : 0);
    if (effectiveCount < limit) return;
    state.dmMemories[key] = localMemorySummary(state.dmMemories[key] || '', history.slice(start));
    state.dmContextStarts[key] = history.length;
}

function rebuildRoomMemory(key, history) {
    delete state.dmMemories[key]; state.dmContextStarts[key] = 0;
    if (!state.settings.compressionEnabled) return;
    const limit = Math.max(6, Math.min(200, Number(state.settings.compressionLimit) || 30));
    if (history.length >= limit) { state.dmMemories[key] = localMemorySummary('', history); state.dmContextStarts[key] = history.length; }
}

function compressedHistory(key, history, end = history.length) {
    const start = Math.min(Number(state.dmContextStarts[key] || 0), end);
    const recent = history.slice(start, end);
    return state.dmMemories[key] ? [{ role: 'assistant', content: `【本地长期记忆，仅作背景】\n${state.dmMemories[key]}` }, ...recent] : recent;
}

async function generatePrivateReply(contact, key, history, userText, end = history.length) {
    return await callAI(privateChatPrompt(contact), compressedHistory(key, history, end), userText);
}

async function sendRoom(form) {
    ensureMessagingState();
    const contact = state.contacts.find(c => c.id === form.dataset.contactId) || state.contacts[0];
    const key = roomKey(contact);
    const input = form.elements.content;
    const text = input.value.trim(); if (!text) return;
    const history = state.dmRooms[key] ||= [];
    history.push({ id: uid(), role: 'user', content: text, createdAt: now() }); input.value = ''; typingContacts.add(key); render();
    try {
        const answer = await generatePrivateReply(contact, key, history, text, history.length - 1);
        history.push({ id: uid(), role: 'assistant', content: answer || '（没有收到回复）', createdAt: now() });
    } catch (error) { history.push({ id: uid(), role: 'assistant', content: `发送失败：${error.message}`, createdAt: now(), error: true }); }
    finally { typingContacts.delete(key); }
    maybeCompressRoom(key, history);
    await saveState(); render();
}

async function refreshPrivateMessage(contactId, messageId) {
    ensureMessagingState(); const contact = state.contacts.find(c => c.id === contactId); if (!contact) return;
    const key = roomKey(contact); if (typingContacts.has(key)) return;
    const history = state.dmRooms[key]; if (!history) return;
    const index = history.findIndex(m => m.id === messageId); if (index < 0 || history[index].role !== 'assistant') return;
    let userIndex = index - 1; while (userIndex >= 0 && history[userIndex].role !== 'user') userIndex--;
    if (userIndex < 0) return;
    const userText = history[userIndex].content; typingContacts.add(key); render();
    try { history[index].content = await generatePrivateReply(contact, key, history, userText, userIndex) || '（没有收到回复）'; history[index].createdAt = now(); delete history[index].error; rebuildRoomMemory(key, history); await saveState(); }
    catch (error) { alert(`刷新回复失败：${error.message}`); }
    finally { typingContacts.delete(key); render(); }
}

async function onSubmit(event) {
    if (event.target.id === 'stbr-comment-form') {
        event.preventDefault(); const text = event.target.elements.content.value.trim(); if (!text) return;
        reviewFor(selectedMessage()).comments.push({ id: uid(), author: reviewerName(), content: text, createdAt: now(), replies: [], pending: true, isMine: true });
        await saveState(); render();
    }
    if (event.target.id === 'stbr-room-form') { event.preventDefault(); await sendRoom(event.target); }
    if (event.target.id === 'stbr-add-contact') {
        event.preventDefault(); ensureMessagingState(); const name = event.target.elements.name.value.trim(); if (!name) return;
        const existing = state.contacts.find(c => c.name === name);
        if (existing) activeContactId = existing.id;
        else { const id = `contact-${uid()}`; state.contacts.push({ id, name, type: 'character' }); state.dmRooms[id] = []; activeContactId = id; await saveState(); }
        render();
    }
}

async function onClick(event) {
    const target = event.target.closest('[data-action], .stbr-tab'); if (!target) return;
    if (target.classList.contains('stbr-tab')) { activeTab = target.dataset.tab; render(); return; }
    const action = target.dataset.action;
    if (action === 'initial-generate') await generateInitialBundle();
    if (action === 'update-reviews') await updateReviews();
    if (action === 'reset-reviews') await resetReviews();
    if (action === 'reset-excerpt') await resetExcerpt();
    if (action === 'fetch-models') await fetchModels();
    if (action === 'reset-prompt') {
        if (!confirm('恢复这套私信提示词为默认内容？')) return;
        if (target.dataset.kind === 'in') state.settings.inChatPrompt = DEFAULT_IN_PROMPT;
        else state.settings.outChatPrompt = DEFAULT_OUT_PROMPT;
        await saveState(); render();
    }
    if (action === 'select-contact') { activeContactId = target.dataset.id; render(); }
    if (action === 'set-chat-mode') {
        const contact = state.contacts.find(c => c.id === target.dataset.contactId); if (!contact) return;
        contact.chatMode = target.dataset.mode; await saveState(); render();
    }
    if (action === 'refresh-message') await refreshPrivateMessage(target.dataset.contactId, target.dataset.id);
    if (action === 'delete-message' && confirm('删除这条回复？')) {
        const contact = state.contacts.find(c => c.id === target.dataset.contactId); if (!contact) return;
        const key = roomKey(contact); state.dmRooms[key] = (state.dmRooms[key] || []).filter(m => m.id !== target.dataset.id); rebuildRoomMemory(key, state.dmRooms[key]); await saveState(); render();
    }
    if (action === 'remove-contact') {
        event.stopPropagation(); if (!confirm('删除这个私信联系人及全部聊天记录？')) return;
        state.contacts = state.contacts.filter(c => c.id !== target.dataset.id);
        [`${target.dataset.id}:in`, `${target.dataset.id}:out`, target.dataset.id].forEach(key => { delete state.dmRooms[key]; delete state.dmMemories[key]; delete state.dmContextStarts[key]; });
        activeContactId = 'screenwriter'; await saveState(); render();
    }
    if (action === 'clear-room' && confirm('清空这个独立聊天房间？')) { const key = target.dataset.roomKey; state.dmRooms[key] = []; delete state.dmMemories[key]; delete state.dmContextStarts[key]; await saveState(); render(); }
    if (action === 'reply') {
        const text = prompt('回复这条评论：'); if (!text?.trim()) return;
        const comment = reviewFor(selectedMessage()).comments.find(c => c.id === target.dataset.id);
        comment?.replies.push({ id: uid(), author: reviewerName(), content: text.trim(), createdAt: now(), pending: true, isMine: true }); await saveState(); render();
    }
    if (action === 'edit-comment') {
        const comment = reviewFor(selectedMessage()).comments.find(c => c.id === target.dataset.id); if (!comment) return;
        const text = prompt('修改书评：', comment.content); if (!text?.trim()) return;
        comment.content = text.trim(); comment.pending = true; comment.isMine = true; await saveState(); render();
    }
    if (action === 'delete-comment' && confirm('确定删除这条书评及其全部回复吗？')) {
        const review = reviewFor(selectedMessage()); review.comments = review.comments.filter(c => c.id !== target.dataset.id); await saveState(); render();
    }
    if (action === 'edit-reply') {
        const comment = reviewFor(selectedMessage()).comments.find(c => c.id === target.dataset.commentId);
        const reply = comment?.replies.find(r => r.id === target.dataset.id); if (!reply) return;
        const text = prompt('修改回复：', reply.content); if (!text?.trim()) return;
        reply.content = text.trim(); reply.pending = true; reply.isMine = true; await saveState(); render();
    }
    if (action === 'delete-reply' && confirm('确定删除这条回复吗？')) {
        const comment = reviewFor(selectedMessage()).comments.find(c => c.id === target.dataset.commentId);
        if (comment) comment.replies = comment.replies.filter(r => r.id !== target.dataset.id); await saveState(); render();
    }
}

async function onChange(event) {
    if (event.target.id === 'stbr-floor-select') { activeMessageId = event.target.value; render(); }
    if (event.target.id === 'stbr-bubble-toggle') { state.settings.bubbleEnabled = event.target.checked; await saveState(); render(); }
    if (event.target.id === 'stbr-context-depth') { state.settings.contextDepth = Math.max(2, Math.min(50, Number(event.target.value) || 12)); await saveState(); }
    if (event.target.id === 'stbr-reviewer-name') { state.settings.reviewerName = event.target.value.trim(); await saveState(); }
    if (event.target.id === 'stbr-api-mode') { state.settings.apiMode = event.target.value; await saveState(); render(); }
    if (event.target.id === 'stbr-api-url') { state.settings.apiBaseUrl = event.target.value.trim(); await saveState(); }
    if (event.target.id === 'stbr-api-key') { state.settings.apiKey = event.target.value.trim(); await saveState(); }
    if (event.target.id === 'stbr-api-model') { state.settings.apiModel = event.target.value; await saveState(); }
    if (event.target.id === 'stbr-in-prompt') { state.settings.inChatPrompt = event.target.value.trim() || DEFAULT_IN_PROMPT; await saveState(); }
    if (event.target.id === 'stbr-out-prompt') { state.settings.outChatPrompt = event.target.value.trim() || DEFAULT_OUT_PROMPT; await saveState(); }
    if (event.target.id === 'stbr-compression-enabled') { state.settings.compressionEnabled = event.target.checked; await saveState(); }
    if (event.target.id === 'stbr-compression-limit') { state.settings.compressionLimit = Math.max(6, Math.min(200, Number(event.target.value) || 30)); await saveState(); }
}

function onInput(event) {
    if (event.target.id !== 'stbr-model-search') return;
    const query = event.target.value.trim().toLowerCase();
    const select = root.querySelector('#stbr-api-model'); if (!select) return;
    const current = state.settings.apiModel;
    const filtered = (state.settings.apiModels || []).filter(model => model.toLowerCase().includes(query));
    select.innerHTML = filtered.map(model => `<option value="${escapeHtml(model)}" ${model === current ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('') || '<option disabled>没有匹配模型</option>';
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
    context = getContext(); state = loadState(); ensureMessagingState();
    const html = await renderExtensionTemplateAsync(EXT_FOLDER, 'template');
    root = document.createElement('div'); root.id = 'stbr-root'; root.innerHTML = html; document.body.append(root);
    root.querySelector('#stbr-fab').addEventListener('click', () => openPanel());
    root.querySelector('#stbr-close').addEventListener('click', closePanel);
    root.querySelector('#stbr-backdrop').addEventListener('click', closePanel);
    root.addEventListener('click', onClick); root.addEventListener('submit', onSubmit); root.addEventListener('change', onChange); root.addEventListener('input', onInput);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.querySelector('#stbr-overlay').hidden) closePanel(); });
    addMagicWandEntry(); setTimeout(addMagicWandEntry, 1500);
    const events = context.eventSource; const types = context.eventTypes || window.event_types || {};
    [types.MESSAGE_RECEIVED, types.MESSAGE_DELETED, types.MESSAGE_EDITED, types.CHAT_CHANGED].filter(Boolean).forEach(type => events?.on?.(type, () => { context = getContext(); state = loadState(); ensureMessagingState(); activeMessageId = ''; render(); }));
    render(); console.info('[ST Book Review] 1.6.1 loaded');
}

jQuery(init);
