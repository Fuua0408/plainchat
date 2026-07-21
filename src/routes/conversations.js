'use strict';

const fs = require('fs');
const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { resolveAttachmentFilePath } = require('../attachmentStorage');
const logger = require('../logger');

const router = express.Router();

router.use(authMiddleware);

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id must be a number' });
  }
  req.params.id = Number(id);
  next();
});

function findOwnConversation(db, id, userId) {
  return db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

const LIKE_ESCAPE_CHAR = '\\';
const SEARCH_QUERY_MAX_LEN = 200;
const SNIPPET_HALF_WINDOW = 40;

// LIKE のワイルドカード(% _)とエスケープ文字自身を \ でエスケープし、
// ユーザー入力の % / _ をリテラルとして扱えるようにする
function escapeLikePattern(str) {
  return str.replace(/[\\%_]/g, (ch) => LIKE_ESCAPE_CHAR + ch);
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// 一致箇所前後を切り出し、改行・連続空白を単一スペースに圧縮したスニペットを作る
function buildSnippet(content, query) {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const idx = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    const head = normalized.slice(0, SNIPPET_HALF_WINDOW * 2);
    return head + (normalized.length > SNIPPET_HALF_WINDOW * 2 ? '…' : '');
  }
  const start = Math.max(0, idx - SNIPPET_HALF_WINDOW);
  const end = Math.min(normalized.length, idx + query.length + SNIPPET_HALF_WINDOW);
  let snippet = normalized.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < normalized.length) snippet = snippet + '…';
  return snippet;
}

// GET /api/conversations?q=&from=&to=
router.get('/', (req, res) => {
  const { q: qRaw, from: fromRaw, to: toRaw } = req.query;

  const q = typeof qRaw === 'string' ? qRaw.trim() : '';
  if (q.length > SEARCH_QUERY_MAX_LEN) {
    return res.status(400).json({ error: `q must be ${SEARCH_QUERY_MAX_LEN} characters or fewer` });
  }

  let from = null;
  if (typeof fromRaw === 'string' && fromRaw !== '') {
    if (!isValidDateStr(fromRaw)) return res.status(400).json({ error: 'from must be a valid YYYY-MM-DD date' });
    from = fromRaw;
  }

  let to = null;
  if (typeof toRaw === 'string' && toRaw !== '') {
    if (!isValidDateStr(toRaw)) return res.status(400).json({ error: 'to must be a valid YYYY-MM-DD date' });
    to = toRaw;
  }

  const hasQ = q.length > 0;
  const pattern = hasQ ? `%${escapeLikePattern(q)}%` : null;

  const params = { userId: req.user.id };
  let sql = 'SELECT c.id, c.title, c.created_at, c.updated_at';
  if (hasQ) {
    sql += `, (c.title LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}') AS title_match`;
    params.pattern = pattern;
  }
  sql += ' FROM conversations c WHERE c.user_id = @userId';
  if (hasQ) {
    sql += ` AND (c.title LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}'` +
      ` OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE @pattern ESCAPE '${LIKE_ESCAPE_CHAR}'))`;
  }
  if (from) {
    sql += ' AND date(c.updated_at) >= @from';
    params.from = from;
  }
  if (to) {
    sql += ' AND date(c.updated_at) <= @to';
    params.to = to;
  }
  sql += ' ORDER BY c.updated_at DESC LIMIT 100';

  const db = getDb();
  const rows = db.prepare(sql).all(params);

  const conversations = rows.map((row) => {
    const conv = { id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at, snippet: null };
    if (hasQ && !row.title_match) {
      const msg = db
        .prepare(`SELECT content FROM messages WHERE conversation_id = ? AND content LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}' ORDER BY id ASC LIMIT 1`)
        .get(row.id, pattern);
      if (msg) conv.snippet = buildSnippet(msg.content, q);
    }
    return conv;
  });

  res.json({ conversations });
});

// POST /api/conversations
router.post('/', (req, res) => {
  const { title } = req.body || {};
  const db = getDb();

  let result;
  if (typeof title === 'string' && title.trim() !== '') {
    result = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(req.user.id, title);
  } else {
    result = db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(req.user.id);
  }

  const conversation = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json({ conversation });
});

const SYSTEM_PROMPT_MAX_LEN = 20000;

// PATCH /api/conversations/:id
router.patch('/:id', (req, res) => {
  const { title, system_prompt } = req.body || {};
  const hasTitle = title !== undefined;
  const hasSystemPrompt = system_prompt !== undefined;

  if (!hasTitle && !hasSystemPrompt) {
    return res.status(400).json({ error: 'title or system_prompt is required' });
  }
  if (hasTitle && (typeof title !== 'string' || title.trim() === '' || title.length > 200)) {
    return res.status(400).json({ error: 'title must be 1-200 characters' });
  }
  if (hasSystemPrompt && (typeof system_prompt !== 'string' || system_prompt.length > SYSTEM_PROMPT_MAX_LEN)) {
    return res.status(400).json({ error: `system_prompt must be a string up to ${SYSTEM_PROMPT_MAX_LEN} characters` });
  }

  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (hasTitle) {
    db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, req.params.id);
  }
  if (hasSystemPrompt) {
    const value = system_prompt === '' ? null : system_prompt;
    db.prepare("UPDATE conversations SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?")
      .run(value, req.params.id);
  }

  const conversation = db
    .prepare('SELECT id, title, system_prompt, created_at, updated_at FROM conversations WHERE id = ?')
    .get(req.params.id);
  res.json({ conversation: { ...conversation, system_prompt: conversation.system_prompt || '' } });
});

// DELETE /api/conversations/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // attachments行はconversations削除のON DELETE CASCADEで消えるため、
  // 実ファイルだけを先に(行が消える前に)解決して削除しておく
  const attachments = db
    .prepare('SELECT id, user_id, path FROM attachments WHERE conversation_id = ?')
    .all(req.params.id);
  for (const attachment of attachments) {
    const filePath = resolveAttachmentFilePath(attachment);
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      // 欠損やunlink失敗は致命エラーにせず、ログに残して会話削除自体は続行する
      logger.warn('conversation delete: attachment file missing or removal failed', {
        attachmentId: attachment.id,
        path: filePath,
        error: e.message,
      });
    }
  }

  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', (req, res) => {
  const db = getDb();
  const conversation = db
    .prepare('SELECT id, title, system_prompt FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });

  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(req.params.id);

  const attachmentsByMessage = new Map();
  if (messages.length > 0) {
    const placeholders = messages.map(() => '?').join(',');
    const attachmentRows = db
      .prepare(
        `SELECT id, message_id, kind, mime, original_name, size FROM attachments WHERE message_id IN (${placeholders})`
      )
      .all(...messages.map((m) => m.id));
    for (const row of attachmentRows) {
      if (!attachmentsByMessage.has(row.message_id)) attachmentsByMessage.set(row.message_id, []);
      attachmentsByMessage.get(row.message_id).push({
        id: row.id,
        kind: row.kind,
        mime: row.mime,
        url: row.kind === 'image' ? `/api/uploads/image/${row.id}` : `/api/uploads/file/${row.id}`,
        original_name: row.original_name,
        size: row.size,
      });
    }
  }

  const toolInvocationsByMessage = new Map();
  if (messages.length > 0) {
    const placeholders = messages.map(() => '?').join(',');
    const toolInvocationRows = db
      .prepare(
        `SELECT message_id, round_index, tool_name, arguments_json, status, result_text
         FROM tool_invocations WHERE message_id IN (${placeholders}) ORDER BY round_index ASC`
      )
      .all(...messages.map((m) => m.id));
    for (const row of toolInvocationRows) {
      if (!toolInvocationsByMessage.has(row.message_id)) toolInvocationsByMessage.set(row.message_id, []);
      toolInvocationsByMessage.get(row.message_id).push({
        round_index: row.round_index,
        tool_name: row.tool_name,
        arguments_json: row.arguments_json,
        status: row.status,
        result_text: row.result_text,
      });
    }
  }

  const messagesWithAttachments = messages.map((m) => ({
    ...m,
    attachments: attachmentsByMessage.get(m.id) || [],
    tool_invocations: toolInvocationsByMessage.get(m.id) || [],
  }));

  res.json({
    conversation: { id: conversation.id, title: conversation.title, system_prompt: conversation.system_prompt || '' },
    messages: messagesWithAttachments,
  });
});

// POST /api/conversations/:id/generate-title
router.post('/:id/generate-title', async (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const firstUser = db
    .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1")
    .get(req.params.id);
  const firstAssistant = db
    .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id ASC LIMIT 1")
    .get(req.params.id);

  if (!firstUser || !firstAssistant) {
    return res.status(400).json({ error: 'No messages to summarize' });
  }

  const endpoint = (process.env.LLM_ENDPOINT || '').replace(/\/$/, '');
  if (!endpoint) {
    return res.status(502).json({ error: 'LLMエンドポイントが設定されていません（サーバーの .env を確認してください）' });
  }

  const url = endpoint.replace(/\/chat\/completions$/, '') + '/chat/completions';
  const apiKey = process.env.LLM_API_KEY || 'sk-fake';

  const userSnippet = firstUser.content.slice(0, 500);
  const assistantSnippet = firstAssistant.content.slice(0, 500);

  const messages = [
    {
      role: 'system',
      content:
        '以下の会話に短いタイトルを付けてください。会話と同じ言語で、10〜20文字程度、' +
        '記号や引用符や説明は不要です。タイトルのみを出力してください。',
    },
    { role: 'user', content: userSnippet },
    { role: 'assistant', content: assistantSnippet },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let title;
  try {
    const upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        // chat.jsと同じ理由: AbortControllerでの中断がkeep-aliveプールを汚さないよう使い捨てる
        'Connection': 'close',
      },
      signal: controller.signal,
      body: JSON.stringify({
        messages,
        stream: false,
        max_tokens: 60,
        temperature: 0.3,
        enable_thinking: false,
      }),
    });

    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text().catch(() => '');
      throw new Error(`LLMエラー (${upstreamRes.status}): ${txt.slice(0, 200)}`);
    }

    const data = await upstreamRes.json();
    const raw = data.choices?.[0]?.message?.content || '';
    title = raw
      .trim()
      .split('\n')[0]
      .replace(/^["'「」『』\s]+|["'「」『』\s]+$/g, '')
      .slice(0, 50);
  } catch (e) {
    const message = e.name === 'AbortError'
      ? 'LLMがタイムアウトしました（30秒）'
      : 'LLMサーバーに接続できません: ' + e.message;
    logger.error('generate-title: llm request failed', { error: message });
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!title) {
    return res.status(502).json({ error: 'タイトルの生成に失敗しました' });
  }

  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, req.params.id);

  const conversation = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(req.params.id);
  res.json({ conversation });
});

module.exports = router;
