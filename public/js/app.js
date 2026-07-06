'use strict';

/* PlainChat — 画面制御・会話一覧・チャット送受信 */

const loginView = document.getElementById('loginView');
const chatView = document.getElementById('chatView');

const loginForm = document.getElementById('loginForm');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

const newConversationBtn = document.getElementById('newConversationBtn');
const conversationList = document.getElementById('conversationList');
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');
const dateFilterToggleBtn = document.getElementById('dateFilterToggleBtn');
const dateFilterPanel = document.getElementById('dateFilterPanel');
const dateFromInput = document.getElementById('dateFromInput');
const dateToInput = document.getElementById('dateToInput');
const logoutBtn = document.getElementById('logoutBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const settingsBtn = document.getElementById('settingsBtn');
const conversationSettingsBtn = document.getElementById('conversationSettingsBtn');

const messageList = document.getElementById('messageList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatError = document.getElementById('chatError');
const attachBtn = document.getElementById('attachBtn');
const attachInput = document.getElementById('attachInput');
const attachFileBtn = document.getElementById('attachFileBtn');
const attachFileInput = document.getElementById('attachFileInput');
const attachPreviewList = document.getElementById('attachPreviewList');

const hljsLightTheme = document.getElementById('hljsLightTheme');
const hljsDarkTheme = document.getElementById('hljsDarkTheme');

const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalTextarea = document.getElementById('modalTextarea');
const modalMessage = document.getElementById('modalMessage');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const modalCloseBtn = document.getElementById('modalCloseBtn');

let conversations = [];
let currentConversationId = null;
let currentConversationSystemPrompt = '';
let sending = false;
let currentAbortController = null;
let modalMode = null; // 'global' | 'conversation'

// 1メッセージあたりの画像+ファイル合算の添付上限(フロントの定数。DECISIONS.md 2026-07-05参照)
const MAX_ATTACHMENTS = 4;
let selectedAttachments = []; // [{ type: 'image', file, dataUrl } | { type: 'file', file }]
let messageObjectUrls = []; // 履歴表示用に生成したobjectURL(再描画時にrevokeする)

// 履歴のfile添付は original_name が null の場合があり(019参照)、その時だけmimeから種別ラベルを補う
const FILE_MIME_LABEL = {
  'text/plain': 'テキストファイル (.txt)',
  'text/markdown': 'Markdownファイル (.md)',
  'text/csv': 'CSVファイル (.csv)',
  'application/json': 'JSONファイル (.json)',
};

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─────────────────────────────────────────────
// ダークモード
// ─────────────────────────────────────────────
const THEME_KEY = 'plainchat_theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  hljsLightTheme.disabled = theme === 'dark';
  hljsDarkTheme.disabled = theme !== 'dark';
  themeToggleBtn.textContent = theme === 'dark' ? '☀️ ライト' : '🌙 ダーク';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function showLoginView() {
  chatView.classList.remove('active');
  loginView.classList.add('active');
  loginPassword.value = '';
}

function showChatView() {
  loginView.classList.remove('active');
  chatView.classList.add('active');
  currentConversationId = null;
  currentConversationSystemPrompt = '';
  conversationSettingsBtn.disabled = true;
  renderMessages([]);
}

function setLoginError(msg) {
  loginError.textContent = msg || '';
}

function setChatError(msg) {
  chatError.textContent = msg || '';
}

// ─────────────────────────────────────────────
// 会話一覧
// ─────────────────────────────────────────────
function renderConversationList() {
  conversationList.innerHTML = '';

  if (conversations.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'conversation-list-empty';
    empty.textContent = '該当する会話がありません';
    conversationList.appendChild(empty);
    return;
  }

  for (const conv of conversations) {
    const li = document.createElement('li');
    li.className = 'conversation-item' + (conv.id === currentConversationId ? ' active' : '');
    li.dataset.id = String(conv.id);

    const info = document.createElement('div');
    info.className = 'conversation-info';

    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conv.title || '新しい会話';
    title.addEventListener('click', () => selectConversation(conv.id));
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameConversation(conv, li, title);
    });
    info.appendChild(title);

    if (conv.snippet) {
      const snippet = document.createElement('span');
      snippet.className = 'conversation-snippet';
      snippet.textContent = conv.snippet;
      info.appendChild(snippet);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'conversation-delete';
    delBtn.type = 'button';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteConversation(conv.id);
    });

    li.appendChild(info);
    li.appendChild(delBtn);
    conversationList.appendChild(li);
  }
}

// 会話一覧を再生成せず、選択ハイライト(activeクラス)だけを更新する。
// selectConversation()から一覧全体を再生成すると、シングルクリックで
// 会話を切り替えた瞬間にDOMが差し替わり、直後に届くはずのdblclickイベントが
// 既に切り離された旧title要素に発火してリネームUIが開かなくなる不具合があった。
function updateActiveConversationHighlight() {
  for (const li of conversationList.children) {
    li.classList.toggle('active', Number(li.dataset.id) === currentConversationId);
  }
}

function startRenameConversation(conv, li, titleSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conversation-title-input';
  input.value = conv.title || '';
  const titleParent = titleSpan.parentElement;
  titleParent.replaceChild(input, titleSpan);
  input.focus();
  input.select();

  let finished = false;

  function restoreSpan() {
    if (input.parentElement === titleParent) titleParent.replaceChild(titleSpan, input);
  }

  async function commit() {
    if (finished) return;
    finished = true;
    const newTitle = input.value.trim();
    if (newTitle === (conv.title || '')) {
      restoreSpan();
      return;
    }
    try {
      const updated = await renameConversation(conv.id, newTitle);
      conv.title = updated.title;
      await loadConversations();
    } catch (e) {
      setChatError(e.message);
      restoreSpan();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      finished = true;
      restoreSpan();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function loadConversations() {
  try {
    conversations = await listConversations({
      q: searchInput.value.trim(),
      from: dateFromInput.value,
      to: dateToInput.value,
    });
    if (currentConversationId && !conversations.some((c) => c.id === currentConversationId)) {
      currentConversationId = null;
      currentConversationSystemPrompt = '';
      conversationSettingsBtn.disabled = true;
      renderMessages([]);
    }
    renderConversationList();
  } catch (e) {
    setChatError(e.message);
  }
}

// 検索文字列・日付フィルタをUI・状態ともにクリアし、全件表示に戻す
function clearSearchAndFilters() {
  searchInput.value = '';
  dateFromInput.value = '';
  dateToInput.value = '';
  searchClearBtn.hidden = true;
}

let searchDebounceTimer = null;
function scheduleSearchReload() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    loadConversations();
  }, 280);
}

searchInput.addEventListener('input', () => {
  searchClearBtn.hidden = searchInput.value === '';
  scheduleSearchReload();
});

searchClearBtn.addEventListener('click', () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  searchInput.value = '';
  searchClearBtn.hidden = true;
  loadConversations();
});

dateFilterToggleBtn.addEventListener('click', () => {
  const willOpen = dateFilterPanel.hidden;
  dateFilterPanel.hidden = !willOpen;
  dateFilterToggleBtn.setAttribute('aria-expanded', String(willOpen));
});

dateFromInput.addEventListener('change', () => loadConversations());
dateToInput.addEventListener('change', () => loadConversations());

// タイトル未設定(デフォルトのまま)の会話のみ、バックグラウンドでタイトルを自動生成する
// 失敗してもチャット体験には影響させない(console.warnに留め、デフォルトタイトルのまま)
async function maybeGenerateTitle(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv || conv.title !== '新しい会話') return;
  try {
    await generateTitle(id);
    await loadConversations();
  } catch (e) {
    console.warn('generate-title failed:', e.message);
  }
}

async function handleNewConversation() {
  try {
    clearSearchAndFilters();
    const conv = await createConversation();
    await loadConversations();
    await selectConversation(conv.id);
  } catch (e) {
    setChatError(e.message);
  }
}

async function handleDeleteConversation(id) {
  if (!confirm('この会話を削除しますか？')) return;
  try {
    await deleteConversation(id);
    if (currentConversationId === id) {
      currentConversationId = null;
      currentConversationSystemPrompt = '';
      conversationSettingsBtn.disabled = true;
      renderMessages([]);
    }
    await loadConversations();
  } catch (e) {
    setChatError(e.message);
  }
}

// ─────────────────────────────────────────────
// メッセージ表示
// ─────────────────────────────────────────────
function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

// アシスタント応答のみMarkdown化(必ずDOMPurifyでサニタイズしてからinnerHTMLへ)
function renderMarkdown(text) {
  const html = marked.parse(text || '', { breaks: true, gfm: true });
  return DOMPurify.sanitize(html);
}

function decorateCodeBlocks(container) {
  const blocks = container.querySelectorAll('pre code');
  blocks.forEach((codeEl) => {
    hljs.highlightElement(codeEl);
    const pre = codeEl.parentElement;
    if (pre.querySelector('.code-copy-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = 'コピー';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        btn.textContent = 'コピーしました';
        setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
      });
    });
    pre.appendChild(btn);
  });
}

function setBubbleContent(target, role, text) {
  if (role === 'assistant') {
    target.innerHTML = renderMarkdown(text);
    decorateCodeBlocks(target);
  } else {
    target.textContent = text;
  }
}

// item: { type: 'image', src } | { type: 'file', name?, label?, size?, url? }
// url があるファイルはクリックで本文プレビューを開閉できる(認証付きfetch、textContentで描画)
function createFileChip(item) {
  const chip = document.createElement('div');
  chip.className = 'message-file-chip' + (item.url ? ' clickable' : '');

  const header = document.createElement('div');
  header.className = 'file-chip-header';

  const icon = document.createElement('span');
  icon.className = 'file-chip-icon';
  icon.textContent = '📄';
  header.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'file-chip-name';
  nameEl.textContent = item.name || item.label || 'ファイル';
  header.appendChild(nameEl);

  if (item.size) {
    const sizeEl = document.createElement('span');
    sizeEl.className = 'file-chip-size';
    sizeEl.textContent = `(${item.size})`;
    header.appendChild(sizeEl);
  }

  chip.appendChild(header);

  if (item.url) {
    chip.title = 'クリックで内容をプレビュー';
    chip.addEventListener('click', async () => {
      const existing = chip.querySelector('.file-preview');
      if (existing) {
        existing.remove();
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'file-preview';
      pre.textContent = '読み込み中...';
      chip.appendChild(pre);
      try {
        const text = await fetchFileText(item.url);
        pre.textContent = text;
      } catch (err) {
        pre.textContent = `エラー: ${err.message}`;
      }
    });
  }

  return chip;
}

function createMessageAttachmentsEl(items) {
  const wrap = document.createElement('div');
  wrap.className = 'message-attachments';
  for (const item of items) {
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = '';
      img.className = 'message-image';
      wrap.appendChild(img);
    } else {
      wrap.appendChild(createFileChip(item));
    }
  }
  return wrap;
}

// message.attachments(id, kind, mime, url, original_name, size)から表示用item配列を組み立てる。
// 画像はBlob objectURLへ変換して即時表示、ファイルは original_name があれば実名を使い、
// 無ければ(null/空)mimeベースの種別ラベルにフォールバックする
async function buildAttachmentItems(attachments) {
  const items = [];
  for (const a of attachments || []) {
    if (a.kind === 'image') {
      try {
        const src = await fetchImageObjectUrl(a.url);
        messageObjectUrls.push(src);
        items.push({ type: 'image', src });
      } catch (err) {
        console.warn('attachment fetch failed:', err.message);
      }
    } else if (a.kind === 'file') {
      const item = { type: 'file', url: a.url };
      if (a.original_name) {
        item.name = a.original_name;
      } else {
        item.label = FILE_MIME_LABEL[a.mime] || 'ファイル';
      }
      if (typeof a.size === 'number') {
        item.size = formatFileSize(a.size);
      }
      items.push(item);
    }
  }
  return items;
}

// これまでに生成した履歴表示用objectURLを解放する(会話切り替え・再描画時のリーク防止)
function revokeMessageObjectUrls() {
  for (const url of messageObjectUrls) URL.revokeObjectURL(url);
  messageObjectUrls = [];
}

async function renderMessages(messages) {
  revokeMessageObjectUrls();
  messageList.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '会話を選択、または新しい会話を作成してください';
    messageList.appendChild(empty);
    return;
  }
  for (const m of messages) {
    const items = await buildAttachmentItems(m.attachments);
    appendMessageBubble(m.role, m.content, items);
  }
  scrollToBottom();
}

// items: createMessageAttachmentsEl が受け付ける画像/ファイルの表示用item配列
function appendMessageBubble(role, text, items) {
  const existingEmpty = messageList.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.remove();
  const bubble = document.createElement('div');
  bubble.className = 'message message-' + role;

  if (items && items.length > 0) {
    bubble.appendChild(createMessageAttachmentsEl(items));
    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    setBubbleContent(textEl, role, text || '');
    bubble.appendChild(textEl);
  } else {
    setBubbleContent(bubble, role, text);
  }

  messageList.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

// 送信直後〜最初のdelta受信まで表示する「考えています…」インジケータ
function createThinkingBubble() {
  const existingEmpty = messageList.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.remove();
  const bubble = document.createElement('div');
  bubble.className = 'message message-assistant thinking';
  bubble.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
  messageList.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

async function selectConversation(id) {
  currentConversationId = id;
  updateActiveConversationHighlight();
  setChatError('');
  try {
    const { conversation, messages } = await getMessages(id);
    currentConversationSystemPrompt = conversation.system_prompt || '';
    conversationSettingsBtn.disabled = false;
    await renderMessages(messages);
  } catch (e) {
    setChatError(e.message);
  }
}

// ─────────────────────────────────────────────
// 画像添付
// ─────────────────────────────────────────────
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderAttachPreviews() {
  attachPreviewList.innerHTML = '';
  attachPreviewList.hidden = selectedAttachments.length === 0;
  selectedAttachments.forEach((att, idx) => {
    const item = document.createElement('div');

    if (att.type === 'image') {
      item.className = 'attach-thumb';
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = '';
      item.appendChild(img);
    } else {
      item.className = 'attach-chip';
      const icon = document.createElement('span');
      icon.className = 'attach-chip-icon';
      icon.textContent = '📄';
      item.appendChild(icon);

      const nameEl = document.createElement('span');
      nameEl.className = 'attach-chip-name';
      nameEl.textContent = att.file.name;
      item.appendChild(nameEl);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'attach-chip-size';
      sizeEl.textContent = formatFileSize(att.file.size);
      item.appendChild(sizeEl);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = att.type === 'image' ? 'attach-thumb-remove' : 'attach-chip-remove';
    removeBtn.setAttribute('aria-label', '削除');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      selectedAttachments.splice(idx, 1);
      renderAttachPreviews();
    });
    item.appendChild(removeBtn);

    attachPreviewList.appendChild(item);
  });
}

function clearAttachments() {
  selectedAttachments = [];
  renderAttachPreviews();
}

// 画像・ファイル共通の追加処理。上限は画像+ファイルの合計(MAX_ATTACHMENTS)
async function addAttachments(files, type) {
  if (files.length === 0) return;

  setChatError('');
  const remaining = MAX_ATTACHMENTS - selectedAttachments.length;
  if (remaining <= 0) {
    setChatError(`添付は画像+ファイル合計で1メッセージにつき最大${MAX_ATTACHMENTS}点までです`);
    return;
  }
  const accepted = files.slice(0, remaining);
  if (files.length > remaining) {
    setChatError(`添付は画像+ファイル合計で1メッセージにつき最大${MAX_ATTACHMENTS}点までです。超過分は無視しました`);
  }

  for (const file of accepted) {
    if (type === 'image') {
      const dataUrl = await readFileAsDataUrl(file);
      selectedAttachments.push({ type: 'image', file, dataUrl });
    } else {
      selectedAttachments.push({ type: 'file', file });
    }
  }
  renderAttachPreviews();
}

async function handleImageInputChange() {
  const files = Array.from(attachInput.files || []);
  attachInput.value = ''; // 同じファイルを続けて選択できるようにする
  await addAttachments(files, 'image');
}

async function handleFileInputChange() {
  const files = Array.from(attachFileInput.files || []);
  attachFileInput.value = ''; // 同じファイルを続けて選択できるようにする
  await addAttachments(files, 'file');
}

attachBtn.addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', handleImageInputChange);
attachFileBtn.addEventListener('click', () => attachFileInput.click());
attachFileInput.addEventListener('change', handleFileInputChange);

// ─────────────────────────────────────────────
// 送受信
// ─────────────────────────────────────────────
function setSending(isSending) {
  sending = isSending;
  chatInput.disabled = isSending;
  attachBtn.disabled = isSending;
  attachFileBtn.disabled = isSending;
  sendBtn.textContent = isSending ? '停止' : '送信';
  sendBtn.classList.toggle('stop-btn', isSending);
}

async function handleSend(e) {
  e.preventDefault();

  if (sending) {
    if (currentAbortController) currentAbortController.abort();
    return;
  }

  const text = chatInput.value.trim();
  const hasAttachments = selectedAttachments.length > 0;
  if (!text && !hasAttachments) return;

  setChatError('');

  if (!currentConversationId) {
    try {
      const conv = await createConversation();
      currentConversationId = conv.id;
      await loadConversations();
    } catch (e) {
      setChatError(e.message);
      return;
    }
  }

  const conversationId = currentConversationId;

  setSending(true);

  // 添付ありの場合は先に全添付(画像・ファイル混在)をアップロードする。
  // 1つでも失敗したら送信を中断する(部分送信はしない)
  let attachmentIds;
  let previewItems = [];
  if (hasAttachments) {
    previewItems = selectedAttachments.map((att) =>
      att.type === 'image'
        ? { type: 'image', src: att.dataUrl }
        : { type: 'file', name: att.file.name, size: formatFileSize(att.file.size) }
    );
    try {
      const ids = [];
      for (const att of selectedAttachments) {
        const uploaded = att.type === 'image'
          ? await uploadImage(conversationId, att.file)
          : await uploadFile(conversationId, att.file);
        ids.push(uploaded.id);
      }
      attachmentIds = ids;
    } catch (err) {
      setChatError(err.message);
      setSending(false);
      return;
    }
  }

  appendMessageBubble('user', text, previewItems);
  chatInput.value = '';
  clearAttachments();

  const assistantBubble = createThinkingBubble();
  let assistantText = '';
  let firstDeltaReceived = false;

  const controller = new AbortController();
  currentAbortController = controller;

  try {
    await streamChat(currentConversationId, text, {
      attachment_ids: attachmentIds,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!firstDeltaReceived) {
          firstDeltaReceived = true;
          assistantBubble.classList.remove('thinking');
          assistantBubble.classList.add('streaming');
          assistantBubble.innerHTML = '';
        }
        assistantText += delta;
        // ストリーミング中はプレーン表示、確定後にMarkdown化する(逐次パースによるちらつき回避)
        assistantBubble.textContent = assistantText;
        scrollToBottom();
      },
      onDone: async () => {
        currentAbortController = null;
        assistantBubble.classList.remove('streaming');
        setBubbleContent(assistantBubble, 'assistant', assistantText);
        scrollToBottom();
        setSending(false);
        await loadConversations();
        maybeGenerateTitle(conversationId);
      },
      onError: (msg) => {
        currentAbortController = null;
        setChatError(msg);
        setSending(false);
      },
      onAbort: async () => {
        currentAbortController = null;
        setSending(false);
        try {
          const { conversation, messages } = await getMessages(currentConversationId);
          currentConversationSystemPrompt = conversation.system_prompt || '';
          await renderMessages(messages);
        } catch (err) {
          setChatError(err.message);
        }
        await loadConversations();
      },
    });
  } catch (e) {
    currentAbortController = null;
    setChatError(e.message);
    setSending(false);
  }
}

// ─────────────────────────────────────────────
// 設定モーダル(グローバル/会話別 共通)
// ─────────────────────────────────────────────
function setModalMessage(text, kind) {
  modalMessage.textContent = text || '';
  modalMessage.className = 'modal-message' + (kind ? ' ' + kind : '');
}

async function openGlobalSettingsModal() {
  modalMode = 'global';
  modalTitle.textContent = 'グローバル設定';
  modalTextarea.placeholder = '例: 語尾に必ず「ですわ」を付けて応答してください';
  modalTextarea.value = '';
  setModalMessage('');
  modalOverlay.classList.add('active');
  modalTextarea.focus();
  try {
    modalTextarea.value = await getGlobalSettings();
  } catch (e) {
    setModalMessage(e.message, 'error');
  }
}

function openConversationSettingsModal() {
  if (!currentConversationId) return;
  modalMode = 'conversation';
  modalTitle.textContent = '会話設定';
  modalTextarea.placeholder = '未設定（グローバル設定を使用）';
  modalTextarea.value = currentConversationSystemPrompt;
  setModalMessage('');
  modalOverlay.classList.add('active');
  modalTextarea.focus();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  modalMode = null;
}

async function handleModalSave() {
  const value = modalTextarea.value;
  setModalMessage('');
  try {
    if (modalMode === 'global') {
      modalTextarea.value = await updateGlobalSettings(value);
    } else if (modalMode === 'conversation') {
      const conv = await updateConversationSystemPrompt(currentConversationId, value);
      currentConversationSystemPrompt = conv.system_prompt || '';
      modalTextarea.value = currentConversationSystemPrompt;
    }
    setModalMessage('保存しました', 'success');
  } catch (e) {
    setModalMessage(e.message, 'error');
  }
}

settingsBtn.addEventListener('click', openGlobalSettingsModal);
conversationSettingsBtn.addEventListener('click', openConversationSettingsModal);
modalCloseBtn.addEventListener('click', closeModal);
modalSaveBtn.addEventListener('click', handleModalSave);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.classList.contains('active')) closeModal();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// ─────────────────────────────────────────────
// ログイン・ログアウト
// ─────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  setLoginError('');
  try {
    await login(loginUsername.value.trim(), loginPassword.value);
    showChatView();
    await loadConversations();
  } catch (e) {
    setLoginError(e.message);
  }
}

function handleLogout() {
  logout();
  conversations = [];
  currentConversationId = null;
  showLoginView();
}

onUnauthorized(() => {
  handleLogout();
});

loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
newConversationBtn.addEventListener('click', handleNewConversation);
chatForm.addEventListener('submit', handleSend);
themeToggleBtn.addEventListener('click', toggleTheme);

// ─────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────
async function init() {
  initTheme();
  if (!getAuthToken()) {
    showLoginView();
    return;
  }
  try {
    await fetchMe();
    showChatView();
    await loadConversations();
  } catch {
    clearAuth();
    showLoginView();
  }
}

init();
