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

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(fn) {
  try { fn(); } catch (e) { /* client already disconnected */ }
}

// POST /api/conversations/:id/chat
router.post('/:id/chat', async (req, res) => {
  const db = getDb();
  const conversation = findOwnConversation(db, req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });

  const { content } = req.body || {};
  if (typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: 'content is required' });
  }

  const endpoint = (process.env.LLM_ENDPOINT || '').replace(/\/$/, '');
  if (!endpoint) {
    return res.status(503).json({ error: 'LLMエンドポイントが設定されていません（サーバーの .env を確認してください）' });
  }

  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(req.params.id, 'user', content);

  const history = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(req.params.id)
    .map((m) => ({ role: m.role, content: m.content }));

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
        messages: history,
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
