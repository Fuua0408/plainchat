'use strict';

const fs = require('fs');
const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const logger = require('../logger');
const { expandPromptTemplate } = require('../promptTemplate');
const { resolveAttachmentFilePath } = require('../attachmentStorage');

const router = express.Router();
router.use(authMiddleware);

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id must be a number' });
  }
  req.params.id = Number(id);
  next();
});

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(fn) {
  try { fn(); } catch (e) { /* client already disconnected */ }
}

// 会話ごとのsystem_promptが設定されていればそれを、なければユーザーのグローバル設定を使う。
// どちらも空ならnull(systemメッセージを付けない)
function resolveSystemPrompt(db, conversation, userId) {
  if (conversation.system_prompt && conversation.system_prompt.trim() !== '') {
    return conversation.system_prompt;
  }
  const user = db.prepare('SELECT system_prompt FROM users WHERE id = ?').get(userId);
  if (user?.system_prompt && user.system_prompt.trim() !== '') {
    return user.system_prompt;
  }
  return null;
}

// 画像attachmentを読み込みLLMのVision入力形式(data URL)に変換する。
// 読み込みに失敗した場合はそのメッセージ内の当該画像のみ諦め、送信自体は継続する
function buildImageDataUrl(attachment) {
  try {
    const filePath = resolveAttachmentFilePath(attachment);
    const buf = fs.readFileSync(filePath);
    return `data:${attachment.mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    logger.warn('chat: failed to read attachment image', { id: attachment.id, error: e.message });
    return null;
  }
}

const FILE_TEXT_MAX_CHARS = 40000;

// テキストファイルattachmentの本文を読み込み、上限超過分は切り詰めて省略を明示する。
// 読み込みに失敗した場合はそのファイルのみ諦め、送信自体は継続する
function buildFileText(attachment) {
  try {
    const filePath = resolveAttachmentFilePath(attachment);
    const body = fs.readFileSync(filePath, 'utf8');
    let text = body;
    if (body.length > FILE_TEXT_MAX_CHARS) {
      text = body.slice(0, FILE_TEXT_MAX_CHARS) +
        `\n…(${FILE_TEXT_MAX_CHARS}文字で切り詰め。元は${body.length}文字)`;
    }
    return `[添付ファイル: ${attachment.original_name}]\n${text}`;
  } catch (e) {
    logger.warn('chat: failed to read attachment file', { id: attachment.id, error: e.message });
    return null;
  }
}

// 会話中の各messageに、紐づく画像・ファイルattachments(id, mime, path, user_id, original_name)を
// kind別にまとめて付与する
function loadAttachmentsByMessage(db, conversationId, messageIds) {
  const byMessage = new Map();
  if (messageIds.length === 0) return byMessage;

  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, message_id, kind, mime, path, user_id, original_name FROM attachments
       WHERE conversation_id = ? AND kind IN ('image', 'file') AND message_id IN (${placeholders})`
    )
    .all(conversationId, ...messageIds);

  for (const row of rows) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, { images: [], files: [] });
    byMessage.get(row.message_id)[row.kind === 'image' ? 'images' : 'files'].push(row);
  }
  return byMessage;
}

// userテキストと、そのメッセージに紐づくファイル添付の本文をまとめて1つのテキストにする
function buildMessageText(text, files) {
  const parts = [];
  if (text.trim() !== '') parts.push(text);
  for (const file of files) {
    const fileText = buildFileText(file);
    if (fileText) parts.push(fileText);
  }
  return parts.join('\n');
}

// messageのcontentを、画像attachmentの有無に応じて文字列 or マルチモーダル配列に組み立てる
function buildMessageContent(text, images, files) {
  const combinedText = buildMessageText(text, files);
  if (images.length === 0) return combinedText;

  const parts = [];
  if (combinedText.trim() !== '') parts.push({ type: 'text', text: combinedText });
  for (const image of images) {
    const url = buildImageDataUrl(image);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

// POST /api/conversations/:id/chat
router.post('/:id/chat', async (req, res) => {
  const db = getDb();
  const conversation = db
    .prepare('SELECT id, system_prompt FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });

  const { content: rawContent, attachment_ids: rawAttachmentIds } = req.body || {};
  const content = typeof rawContent === 'string' ? rawContent : '';
  const hasContent = content.trim() !== '';

  let attachmentIds = [];
  if (rawAttachmentIds !== undefined) {
    if (!Array.isArray(rawAttachmentIds) || rawAttachmentIds.some((v) => !Number.isInteger(v))) {
      return res.status(400).json({ error: 'attachment_ids must be an array of integers' });
    }
    attachmentIds = [...new Set(rawAttachmentIds)];
  }

  if (!hasContent && attachmentIds.length === 0) {
    return res.status(400).json({ error: 'content is required' });
  }

  if (attachmentIds.length > 0) {
    const placeholders = attachmentIds.map(() => '?').join(',');
    const owned = db
      .prepare(
        `SELECT id FROM attachments
         WHERE id IN (${placeholders}) AND user_id = ? AND conversation_id = ?
           AND message_id IS NULL AND kind IN ('image', 'file')`
      )
      .all(...attachmentIds, req.user.id, req.params.id);
    if (owned.length !== attachmentIds.length) {
      return res.status(400).json({ error: 'invalid attachment_ids' });
    }
  }

  const endpoint = (process.env.LLM_ENDPOINT || '').replace(/\/$/, '');
  if (!endpoint) {
    return res.status(503).json({ error: 'LLMエンドポイントが設定されていません（サーバーの .env を確認してください）' });
  }

  const userMessageId = db
    .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(req.params.id, 'user', content).lastInsertRowid;

  if (attachmentIds.length > 0) {
    const placeholders = attachmentIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE attachments SET message_id = ? WHERE id IN (${placeholders}) AND user_id = ? AND conversation_id = ?`
    ).run(userMessageId, ...attachmentIds, req.user.id, req.params.id);
  }

  const messageRows = db
    .prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(req.params.id);
  const attachmentsByMessage = loadAttachmentsByMessage(db, req.params.id, messageRows.map((m) => m.id));

  const history = messageRows
    .map((m) => {
      const atts = attachmentsByMessage.get(m.id) || { images: [], files: [] };
      return { role: m.role, text: m.content, images: atts.images, files: atts.files };
    })
    .filter((m) => m.text.trim() !== '' || m.images.length > 0 || m.files.length > 0)
    .map((m) => ({ role: m.role, content: buildMessageContent(m.text, m.images, m.files) }));

  const systemPrompt = resolveSystemPrompt(db, conversation, req.user.id);
  const messages = systemPrompt
    ? [{ role: 'system', content: expandPromptTemplate(systemPrompt) }, ...history]
    : history;

  const url         = endpoint.replace(/\/chat\/completions$/, '') + '/chat/completions';
  const apiKey      = process.env.LLM_API_KEY || 'sk-fake';
  const maxTok      = parseInt(process.env.LLM_MAX_TOKENS || '2048');
  const temp        = parseFloat(process.env.LLM_TEMP || '0.7');
  const topP        = parseFloat(process.env.LLM_TOP_P || '0.95');
  const topK        = parseInt(process.env.LLM_TOP_K || '64');
  const repPen      = parseFloat(process.env.LLM_REP_PENALTY || '1.15');
  const timeoutSec  = parseInt(process.env.LLM_TIMEOUT || '120');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });

  const controller = new AbortController();
  let settled = false;
  let abortReason = null;

  const timeoutId = setTimeout(() => {
    abortReason = 'timeout';
    controller.abort();
  }, timeoutSec * 1000);

  res.on('close', () => {
    if (!settled) {
      abortReason = abortReason || 'disconnect';
      controller.abort();
    }
  });

  function saveAssistantMessage(text) {
    const result = db
      .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(req.params.id, 'assistant', text);
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    return result.lastInsertRowid;
  }

  let fullText = '';
  let firstTokenReceived = false;

  try {
    const upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        // ストリーム中断時にAbortControllerで切断すると、undiciのkeep-aliveプールに
        // 壊れたソケットが残り以降の全リクエストが terminated エラーになるため、
        // 各リクエストでコネクションを使い捨てる
        'Connection': 'close',
      },
      signal: controller.signal,
      body: JSON.stringify({
        messages,
        stream: true,
        max_tokens: maxTok,
        temperature: temp,
        top_p: topP,
        top_k: topK,
        repetition_penalty: repPen,
      }),
    });

    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text().catch(() => '');
      throw new Error(`LLMエラー (${upstreamRes.status}): ${txt.slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    for await (const chunk of upstreamRes.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }

        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          firstTokenReceived = true;
          safeWrite(() => sendEvent(res, 'delta', { text: delta }));
        }
      }
      if (done) break;
    }

    clearTimeout(timeoutId);

    if (fullText.trim() === '') {
      settled = true;
      safeWrite(() => sendEvent(res, 'error', { error: 'LLMの応答が空でした(思考トークン超過の可能性)' }));
      safeWrite(() => res.end());
      return;
    }

    const messageId = saveAssistantMessage(fullText);
    safeWrite(() => sendEvent(res, 'done', { messageId }));
    settled = true;
    safeWrite(() => res.end());
  } catch (e) {
    clearTimeout(timeoutId);

    if (firstTokenReceived) {
      saveAssistantMessage(fullText);
      settled = true;
      safeWrite(() => res.end());
      return;
    }

    let message;
    if (e.name === 'AbortError' && abortReason === 'timeout') {
      message = `LLMがタイムアウトしました（${timeoutSec}秒）`;
    } else if (e.name === 'AbortError') {
      message = 'クライアントが切断されました';
    } else {
      message = 'LLMサーバーに接続できません: ' + e.message;
    }
    logger.error('chat: llm request failed', { error: message });
    safeWrite(() => sendEvent(res, 'error', { error: message }));
    settled = true;
    safeWrite(() => res.end());
  }
});

module.exports = router;
