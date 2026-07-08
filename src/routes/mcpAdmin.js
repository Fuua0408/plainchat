'use strict';

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');
const { encryptSecret, getKey } = require('../mcp/secretBox');
const { getCatalog, getCatalogEntry } = require('../mcp/catalog');
const { reloadMcp } = require('../mcp');
const logger = require('../logger');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// http/httpsのみ許可(スキーム検証)。不正なら null
function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return url.trim();
  } catch (e) {
    return null;
  }
}

function isUniqueViolation(e) {
  return !!e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(e.message || ''));
}

function nextSortOrder(db) {
  const { next } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM mcp_servers').get();
  return next;
}

// 復号値・暗号文は含めない。has_env/has_headersと平文メタのみ
function toServerView(row) {
  return {
    id: row.id,
    label: row.label,
    enabled: !!row.enabled,
    transport: row.transport,
    url: row.url,
    catalog_id: row.catalog_id,
    sort_order: row.sort_order,
    has_env: !!row.env_enc,
    has_headers: !!row.headers_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// envをカタログのrequiredEnvKeys/optionalEnvKeysに照らして検証・絞り込みする。
// 許可されていないキーは無視し、必須キーの欠落はエラーとして返す
function validateEnvAgainstCatalog(entry, env) {
  if (!isPlainObject(env)) return { error: 'env must be an object' };

  const allowedKeys = new Set([...(entry.requiredEnvKeys || []), ...(entry.optionalEnvKeys || [])]);
  const cleaned = {};
  for (const key of allowedKeys) {
    if (typeof env[key] === 'string' && env[key].trim() !== '') cleaned[key] = env[key];
  }
  for (const key of entry.requiredEnvKeys || []) {
    if (!cleaned[key]) return { error: `env.${key} is required` };
  }
  return { value: cleaned };
}

// GET /api/mcp/catalog
router.get('/catalog', (req, res) => {
  res.json({ catalog: getCatalog() });
});

// GET /api/mcp/servers
router.get('/servers', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY sort_order ASC, id ASC').all();
  res.json({ servers: rows.map(toServerView) });
});

// POST /api/mcp/servers
router.post('/servers', (req, res) => {
  const body = req.body || {};
  const { transport, label } = body;

  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  const enabledInt = body.enabled === false ? 0 : 1;
  const db = getDb();

  if (transport === 'http') {
    const url = validateUrl(body.url);
    if (!url) return res.status(400).json({ error: 'url must be a valid http/https URL' });

    if (body.headers !== undefined && !isPlainObject(body.headers)) {
      return res.status(400).json({ error: 'headers must be an object' });
    }

    let headersEnc = { enc: null, iv: null, tag: null };
    if (body.headers && Object.keys(body.headers).length > 0) {
      if (!getKey()) return res.status(400).json({ error: 'SECRET_ENC_KEY is not set; cannot store secrets' });
      try {
        headersEnc = encryptSecret(body.headers);
      } catch (e) {
        return res.status(400).json({ error: 'failed to encrypt headers' });
      }
    }

    try {
      const info = db
        .prepare(
          `INSERT INTO mcp_servers
             (label, enabled, transport, command, args, url, headers_enc, headers_iv, headers_tag, catalog_id, sort_order)
           VALUES (?, ?, 'http', NULL, NULL, ?, ?, ?, ?, NULL, ?)`
        )
        .run(label.trim(), enabledInt, url, headersEnc.enc, headersEnc.iv, headersEnc.tag, nextSortOrder(db));
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json({ server: toServerView(row) });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'label already exists' });
      logger.error('mcp admin: failed to create http server', { error: e.message });
      return res.status(500).json({ error: 'failed to create server' });
    }
  }

  if (transport === 'stdio') {
    const entry = typeof body.catalog_id === 'string' ? getCatalogEntry(body.catalog_id) : null;
    if (!entry) return res.status(400).json({ error: 'catalog_id is invalid' });
    if (!entry.command) return res.status(500).json({ error: 'catalog entry is unavailable' });

    const envResult = validateEnvAgainstCatalog(entry, body.env);
    if (envResult.error) return res.status(400).json({ error: envResult.error });

    if (!getKey()) return res.status(400).json({ error: 'SECRET_ENC_KEY is not set; cannot store secrets' });
    let envEnc;
    try {
      envEnc = encryptSecret(envResult.value);
    } catch (e) {
      return res.status(400).json({ error: 'failed to encrypt env' });
    }

    try {
      const info = db
        .prepare(
          `INSERT INTO mcp_servers
             (label, enabled, transport, command, args, url, env_enc, env_iv, env_tag, catalog_id, sort_order)
           VALUES (?, ?, 'stdio', ?, ?, NULL, ?, ?, ?, ?, ?)`
        )
        .run(
          label.trim(),
          enabledInt,
          entry.command,
          JSON.stringify(entry.args || []),
          envEnc.enc,
          envEnc.iv,
          envEnc.tag,
          entry.id,
          nextSortOrder(db)
        );
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json({ server: toServerView(row) });
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: 'label already exists' });
      logger.error('mcp admin: failed to create stdio server', { error: e.message });
      return res.status(500).json({ error: 'failed to create server' });
    }
  }

  return res.status(400).json({ error: "transport must be 'http' or 'stdio'" });
});

// PATCH /api/mcp/servers/:id
router.patch('/servers/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const body = req.body || {};
  const updates = [];
  const params = [];

  if (body.transport !== undefined && body.transport !== row.transport) {
    return res.status(400).json({ error: 'transport cannot be changed' });
  }

  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim()) {
      return res.status(400).json({ error: 'label must be a non-empty string' });
    }
    updates.push('label = ?');
    params.push(body.label.trim());
  }

  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }

  if (body.sort_order !== undefined) {
    if (typeof body.sort_order !== 'number' || !Number.isInteger(body.sort_order)) {
      return res.status(400).json({ error: 'sort_order must be an integer' });
    }
    updates.push('sort_order = ?');
    params.push(body.sort_order);
  }

  if (body.url !== undefined) {
    if (row.transport !== 'http') return res.status(400).json({ error: 'url is only for http transport' });
    const url = validateUrl(body.url);
    if (!url) return res.status(400).json({ error: 'url must be a valid http/https URL' });
    updates.push('url = ?');
    params.push(url);
  }

  if (body.headers !== undefined) {
    if (row.transport !== 'http') return res.status(400).json({ error: 'headers is only for http transport' });
    if (!isPlainObject(body.headers)) return res.status(400).json({ error: 'headers must be an object' });

    let enc = { enc: null, iv: null, tag: null };
    if (Object.keys(body.headers).length > 0) {
      if (!getKey()) return res.status(400).json({ error: 'SECRET_ENC_KEY is not set; cannot store secrets' });
      try {
        enc = encryptSecret(body.headers);
      } catch (e) {
        return res.status(400).json({ error: 'failed to encrypt headers' });
      }
    }
    updates.push('headers_enc = ?, headers_iv = ?, headers_tag = ?');
    params.push(enc.enc, enc.iv, enc.tag);
  }

  let newCatalogEntry = null;
  if (body.catalog_id !== undefined) {
    if (row.transport !== 'stdio') return res.status(400).json({ error: 'catalog_id is only for stdio transport' });
    newCatalogEntry = getCatalogEntry(body.catalog_id);
    if (!newCatalogEntry) return res.status(400).json({ error: 'catalog_id is invalid' });
    if (!newCatalogEntry.command) return res.status(500).json({ error: 'catalog entry is unavailable' });
    updates.push('catalog_id = ?, command = ?, args = ?');
    params.push(newCatalogEntry.id, newCatalogEntry.command, JSON.stringify(newCatalogEntry.args || []));
  }

  if (body.env !== undefined) {
    if (row.transport !== 'stdio') return res.status(400).json({ error: 'env is only for stdio transport' });
    const entry = newCatalogEntry || getCatalogEntry(row.catalog_id);
    if (!entry) return res.status(400).json({ error: 'catalog entry not found for this server' });

    const envResult = validateEnvAgainstCatalog(entry, body.env);
    if (envResult.error) return res.status(400).json({ error: envResult.error });

    if (!getKey()) return res.status(400).json({ error: 'SECRET_ENC_KEY is not set; cannot store secrets' });
    let enc;
    try {
      enc = encryptSecret(envResult.value);
    } catch (e) {
      return res.status(400).json({ error: 'failed to encrypt env' });
    }
    updates.push('env_enc = ?, env_iv = ?, env_tag = ?');
    params.push(enc.enc, enc.iv, enc.tag);
  }

  if (updates.length === 0) {
    return res.json({ server: toServerView(row) });
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  try {
    db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'label already exists' });
    logger.error('mcp admin: failed to update server', { error: e.message, id: req.params.id });
    return res.status(500).json({ error: 'failed to update server' });
  }

  const updated = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);
  res.json({ server: toServerView(updated) });
});

// POST /api/mcp/reload
// closeMcp()→initMcp()を実行し、接続結果の要約を返す。トークン等の値は一切含めない
router.post('/reload', async (req, res) => {
  try {
    const { connected, failed } = await reloadMcp();
    res.json({ connected, failed });
  } catch (e) {
    logger.error('mcp admin: reload failed', { error: e.message });
    res.status(500).json({ error: 'reload failed' });
  }
});

// DELETE /api/mcp/servers/:id
router.delete('/servers/:id', (req, res) => {
  const db = getDb();
  const info = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
