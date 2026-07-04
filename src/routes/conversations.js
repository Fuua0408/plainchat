'use strict';

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
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

// GET /api/conversations
router.get('/', (req, res) => {
  const db = getDb();
  const conversations = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
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

// PATCH /api/conversations/:id
router.patch('/:id', (req, res) => {
  const { title } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    return res.status(400).json({ error: 'title is required and must be 1-200 characters' });
  }

  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, req.params.id);

  const conversation = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
    .get(req.params.id);
  res.json({ conversation });
});

// DELETE /api/conversations/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', (req, res) => {
  const db = getDb();
  const existing = findOwnConversation(db, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const messages = db
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(req.params.id);
  res.json({ messages });
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
