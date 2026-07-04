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

const messageList = document.getElementById('messageList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatError = document.getElementById('chatError');

let conversations = [];
let currentConversationId = null;
let sending = false;

function showLoginView() {
  chatView.classList.remove('active');
  loginView.classList.add('active');
  loginPassword.value = '';
}

function showChatView() {
  loginView.classList.remove('active');
  chatView.classList.add('active');
  currentConversationId = null;
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

async function loadConversations() {
  try {
    conversations = await listConversations();
    if (currentConversationId && !conversations.some((c) => c.id === currentConversationId)) {
      currentConversationId = null;
      renderMessages([]);
    }
    renderConversationList();
  } catch (e) {
    setChatError(e.message);
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
  bubble.textContent = text;
  messageList.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

async function selectConversation(id) {
  currentConversationId = id;
  renderConversationList();
  setChatError('');
  try {
    const messages = await getMessages(id);
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
  sendBtn.disabled = isSending;
  chatInput.disabled = isSending;
}

async function handleSend(e) {
  e.preventDefault();
  if (sending) return;

  const text = chatInput.value.trim();
  if (!text) return;
  if (!currentConversationId) {
    setChatError('会話を選択または新規作成してください');
    return;
  }

  setChatError('');
  appendMessageBubble('user', text);
  chatInput.value = '';
  setSending(true);

  const assistantBubble = appendMessageBubble('assistant', '');
  let assistantText = '';

  try {
    await streamChat(currentConversationId, text, {
      onDelta: (delta) => {
        assistantText += delta;
        assistantBubble.textContent = assistantText;
        scrollToBottom();
      },
      onDone: () => {
        setSending(false);
        loadConversations();
      },
      onError: (msg) => {
        setChatError(msg);
        setSending(false);
      },
    });
  } catch (e) {
    setChatError(e.message);
    setSending(false);
  }
}

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

// ─────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────
async function init() {
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
