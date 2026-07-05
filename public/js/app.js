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
const logoutBtn = document.getElementById('logoutBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const settingsBtn = document.getElementById('settingsBtn');
const conversationSettingsBtn = document.getElementById('conversationSettingsBtn');

const messageList = document.getElementById('messageList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatError = document.getElementById('chatError');

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
  for (const conv of conversations) {
    const li = document.createElement('li');
    li.className = 'conversation-item' + (conv.id === currentConversationId ? ' active' : '');
    li.dataset.id = String(conv.id);

    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conv.title || '新しい会話';
    title.addEventListener('click', () => selectConversation(conv.id));
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameConversation(conv, li, title);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'conversation-delete';
    delBtn.type = 'button';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteConversation(conv.id);
    });

    li.appendChild(title);
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
  li.replaceChild(input, titleSpan);
  input.focus();
  input.select();

  let finished = false;

  function restoreSpan() {
    if (input.parentElement === li) li.replaceChild(titleSpan, input);
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
    conversations = await listConversations();
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

function setBubbleContent(bubble, role, text) {
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(text);
    decorateCodeBlocks(bubble);
  } else {
    bubble.textContent = text;
  }
}

function renderMessages(messages) {
  messageList.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '会話を選択、または新しい会話を作成してください';
    messageList.appendChild(empty);
    return;
  }
  for (const m of messages) {
    appendMessageBubble(m.role, m.content);
  }
  scrollToBottom();
}

function appendMessageBubble(role, text) {
  const existingEmpty = messageList.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.remove();
  const bubble = document.createElement('div');
  bubble.className = 'message message-' + role;
  setBubbleContent(bubble, role, text);
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
    renderMessages(messages);
  } catch (e) {
    setChatError(e.message);
  }
}

// ─────────────────────────────────────────────
// 送受信
// ─────────────────────────────────────────────
function setSending(isSending) {
  sending = isSending;
  chatInput.disabled = isSending;
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
  if (!text) return;

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

  appendMessageBubble('user', text);
  chatInput.value = '';
  setSending(true);

  const assistantBubble = createThinkingBubble();
  let assistantText = '';
  let firstDeltaReceived = false;

  const controller = new AbortController();
  currentAbortController = controller;

  try {
    await streamChat(currentConversationId, text, {
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
          renderMessages(messages);
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
