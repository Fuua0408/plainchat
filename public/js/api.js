'use strict';

/* PlainChat — トークン管理 + fetchラッパー */

const AUTH_KEY = 'plainchat_auth';

let unauthorizedHandler = null;
function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

function getAuthToken() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.token || null; }
  catch { return null; }
}
function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.user || null; }
  catch { return null; }
}
function setAuth(token, user) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ token, user }));
}
function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

// 認証付きfetch。Bearerヘッダーを自動付与し、401時はハンドラを呼ぶ
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // FormData送信時はブラウザがboundary付きContent-Typeを自動設定するため、上書きしない
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const resp = await fetch(path, Object.assign({}, options, { headers }));
  if (resp.status === 401) {
    clearAuth();
    if (unauthorizedHandler) unauthorizedHandler();
  }
  return resp;
}

// JSONレスポンスを返すAPI呼び出し。失敗時はエラーメッセージ付きでthrow
async function apiJson(path, options = {}) {
  const resp = await apiFetch(path, options);
  let data = null;
  try { data = await resp.json(); } catch { /* no body */ }
  if (!resp.ok) {
    throw new Error((data && data.error) || `サーバーエラー (${resp.status})`);
  }
  return data;
}

async function login(username, password) {
  const resp = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'ログインに失敗しました');
  setAuth(data.token, data.user);
  return data;
}

async function fetchMe() {
  return apiJson('/api/auth/me');
}

function logout() {
  clearAuth();
}

async function listConversations({ q, from, to } = {}) {
  const usp = new URLSearchParams();
  if (q) usp.set('q', q);
  if (from) usp.set('from', from);
  if (to) usp.set('to', to);
  const qs = usp.toString();
  const data = await apiJson('/api/conversations' + (qs ? `?${qs}` : ''));
  return data.conversations;
}

async function createConversation() {
  const data = await apiJson('/api/conversations', { method: 'POST' });
  return data.conversation;
}

async function deleteConversation(id) {
  return apiJson(`/api/conversations/${id}`, { method: 'DELETE' });
}

async function renameConversation(id, title) {
  const data = await apiJson(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return data.conversation;
}

async function getMessages(id) {
  const data = await apiJson(`/api/conversations/${id}/messages`);
  return data;
}

async function updateConversationSystemPrompt(id, systemPrompt) {
  const data = await apiJson(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ system_prompt: systemPrompt }),
  });
  return data.conversation;
}

async function getGlobalSettings() {
  const data = await apiJson('/api/settings');
  return data.system_prompt;
}

async function updateGlobalSettings(systemPrompt) {
  const data = await apiJson('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ system_prompt: systemPrompt }),
  });
  return data.system_prompt;
}

async function generateTitle(id) {
  const data = await apiJson(`/api/conversations/${id}/generate-title`, { method: 'POST' });
  return data.conversation;
}

// 画像1枚をアップロードして { id, url } を返す(1リクエスト1画像)
async function uploadImage(conversationId, file) {
  const formData = new FormData();
  formData.append('conversation_id', String(conversationId));
  formData.append('image', file);
  const resp = await apiFetch('/api/uploads/image', { method: 'POST', body: formData });
  let data = null;
  try { data = await resp.json(); } catch { /* no body */ }
  if (!resp.ok) {
    throw new Error((data && data.error) || `アップロードに失敗しました (${resp.status})`);
  }
  return data;
}

// Bearer必須の画像URLを認証付きfetchで取得し、objectURLへ変換する
// (表示認証はBlob方式のため、<img src>への直指定は不可)
async function fetchImageObjectUrl(url) {
  const resp = await apiFetch(url);
  if (!resp.ok) {
    throw new Error(`画像の取得に失敗しました (${resp.status})`);
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

// SSEチャット送信。event: delta/done/error を自前パースしてコールバックへ渡す
// fetch + getReader()を使う理由: EventSourceはGET専用でPOSTボディを送れないため
// signalで中断された場合は例外を投げず onAbort を呼ぶ(呼び出し側でエラー扱いしないため)
async function streamChat(conversationId, content, { attachment_ids, onDelta, onDone, onError, onAbort, signal }) {
  const token = getAuthToken();
  const body = Array.isArray(attachment_ids) ? { content, attachment_ids } : { content };
  let resp;
  try {
    resp = await fetch(`/api/conversations/${conversationId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') { onAbort && onAbort(); return; }
    throw e;
  }

  if (resp.status === 401) {
    clearAuth();
    if (unauthorizedHandler) unauthorizedHandler();
    throw new Error('ログインが必要です');
  }
  if (!resp.ok || !resp.body) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `サーバーエラー (${resp.status})`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatchSseEvent(rawEvent, { onDelta, onDone, onError });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { onAbort && onAbort(); return; }
    throw e;
  }
}

function dispatchSseEvent(rawEvent, { onDelta, onDone, onError }) {
  let eventType = 'message';
  const dataLines = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;

  let data = {};
  try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

  if (eventType === 'delta') onDelta && onDelta(data.text || '');
  else if (eventType === 'done') onDone && onDone(data);
  else if (eventType === 'error') onError && onError(data.error || 'エラーが発生しました');
}
