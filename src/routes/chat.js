'use strict';

const fs = require('fs');
const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const logger = require('../logger');
const { expandPromptTemplate } = require('../promptTemplate');
const { resolveAttachmentFilePath } = require('../attachmentStorage');
const { getEnabledToolSchemas, getToolByName } = require('../tools');

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

// TOOLS_ENABLED: 'false'のみ無効とみなし、未設定・不正値はtrue扱いにする
function parseToolsEnabled() {
  const raw = (process.env.TOOLS_ENABLED || '').trim().toLowerCase();
  return raw !== 'false';
}

// TOOLS_MAX_ROUNDS: 未設定・不正値は4。0以下は1に丸める
function parseMaxRounds() {
  const n = parseInt(process.env.TOOLS_MAX_ROUNDS, 10);
  if (!Number.isInteger(n)) return 4;
  return Math.max(1, n);
}

function safeParseJsonArgs(text) {
  try {
    return { ok: true, value: JSON.parse(text && text.trim() !== '' ? text : '{}') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function formatToolResultContent(result) {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

// reasoning_content救済時のみ使う簡易な思考タグ除去(NookResonanceのcleanLLMResponse相当の考え方を
// 参考にした最小実装。移植ではない)。除去後に実体が残らなければ呼び出し側が空応答扱いへフォールバックする
function stripThinkingTags(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\[think\][\s\S]*?\[\/think\]/gi, '')
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, '')
    .trim();
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

  const toolsEnabled = parseToolsEnabled();
  const maxRounds     = parseMaxRounds();
  const toolSchemas   = toolsEnabled ? getEnabledToolSchemas(db) : [];
  const useTools      = toolSchemas.length > 0;
  const enabledToolNames = new Set(toolSchemas.map((t) => t.function.name));

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
  let reasoningText = '';
  let firstTokenReceived = false;
  let roundsUsed = 0;

  try {
    for (;;) {
      const forceNoTools = useTools && roundsUsed >= maxRounds;
      const requestBody = {
        messages,
        stream: true,
        max_tokens: maxTok,
        temperature: temp,
        top_p: topP,
        top_k: topK,
        repetition_penalty: repPen,
      };
      if (useTools) {
        requestBody.tools = toolSchemas;
        if (forceNoTools) requestBody.tool_choice = 'none';
      }

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
        body: JSON.stringify(requestBody),
      });

      if (!upstreamRes.ok) {
        const txt = await upstreamRes.text().catch(() => '');
        throw new Error(`LLMエラー (${upstreamRes.status}): ${txt.slice(0, 200)}`);
      }

      fullText = '';
      reasoningText = '';
      firstTokenReceived = false;
      let finishReason = null;
      const toolCallsByIndex = new Map();

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
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (delta.content) {
            fullText += delta.content;
            firstTokenReceived = true;
            safeWrite(() => sendEvent(res, 'delta', { text: delta.content }));
          }

          // content とは別枠。ユーザーには出さず、最終ラウンドでcontentが皆無だった時の救済にのみ使う
          if (delta.reasoning_content) {
            reasoningText += delta.reasoning_content;
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!toolCallsByIndex.has(idx)) {
                toolCallsByIndex.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
              }
              const entry = toolCallsByIndex.get(idx);
              if (tc.id) entry.id = tc.id;
              if (tc.type) entry.type = tc.type;
              if (tc.function?.name) entry.function.name += tc.function.name;
              if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (done) break;
      }

      const isToolRound = finishReason === 'tool_calls' && !forceNoTools;
      const toolCalls = Array.from(toolCallsByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);

      if (!isToolRound || toolCalls.length === 0) {
        // 通常のstop、または上限到達によるtool_choice:'none'強制後の最終回答
        break;
      }

      // 中間ツールラウンド: このラウンドのcontentは最終回答として扱わずストリームしない
      messages.push({ role: 'assistant', content: fullText || null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        safeWrite(() => sendEvent(res, 'tool_call', { name: toolName }));

        let status = 'success';
        let resultContent;

        const parsedArgs = safeParseJsonArgs(toolCall.function.arguments);
        const tool = getToolByName(toolName);
        if (!parsedArgs.ok) {
          status = 'error';
          resultContent = JSON.stringify({ error: `引数のJSON解析に失敗しました: ${parsedArgs.error}` });
        } else if (!enabledToolNames.has(toolName) || !tool) {
          status = 'error';
          resultContent = JSON.stringify({ error: `未登録または無効なツールです: ${toolName}` });
        } else {
          try {
            const result = await tool.handler(parsedArgs.value);
            resultContent = formatToolResultContent(result);
          } catch (e) {
            status = 'error';
            resultContent = JSON.stringify({ error: e.message || String(e) });
          }
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent });
        safeWrite(() => sendEvent(res, 'tool_result', { name: toolName, status }));
      }

      roundsUsed += 1;
    }

    clearTimeout(timeoutId);

    // 最終回答ラウンドでcontentが一度も来ておらずreasoning_contentのみ得られた場合の救済。
    // 途中までcontentが来ていた場合(firstTokenReceived)はここに来ないため誤発動しない
    if (fullText.trim() === '' && reasoningText.trim() !== '') {
      const fallbackText = stripThinkingTags(reasoningText);
      if (fallbackText !== '') {
        logger.info('chat: content was empty, using reasoning_content fallback', {
          conversationId: req.params.id,
          reasoningLength: reasoningText.length,
          fallbackLength: fallbackText.length,
        });
        fullText = fallbackText;
        firstTokenReceived = true;
        safeWrite(() => sendEvent(res, 'delta', { text: fallbackText }));
      }
    }

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
