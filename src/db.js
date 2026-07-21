'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { getCatalogEntry } = require('./mcp/catalog');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || './data/plainchat.db';
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      system_prompt TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT    NOT NULL DEFAULT '新しい会話',
      system_prompt TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
      ON conversations (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT    NOT NULL CHECK(role IN ('system','user','assistant')),
      content         TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages (conversation_id, id);

    CREATE TABLE IF NOT EXISTS attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      kind            TEXT    NOT NULL DEFAULT 'image',
      mime            TEXT    NOT NULL,
      size            INTEGER NOT NULL,
      path            TEXT    NOT NULL,
      original_name   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_conversation_id
      ON attachments (conversation_id);

    -- 039: MCPツール呼び出し(tool_call/tool_result)の往復をassistantメッセージに紐づけて永続化する。
    -- attachmentsに倣いconversation_id/user_idを直接持たせ、所有者スコープの確認を簡潔にする
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      round_index     INTEGER NOT NULL,
      tool_name       TEXT    NOT NULL,
      arguments_json  TEXT    NOT NULL,
      status          TEXT    NOT NULL,
      result_text     TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_message_id
      ON tool_invocations (message_id);

    CREATE TABLE IF NOT EXISTS tools (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT,
      origin      TEXT    NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 028a: MCPサーバー設定のDB保管。label/enabled/transport/command/args/url/catalog_id/sort_order は平文、
    -- env/headers はそれぞれ独立の封筒暗号(enc/iv/tag)で保持する(片方のみ保持=NULL可)
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      label        TEXT    NOT NULL UNIQUE,
      enabled      INTEGER NOT NULL DEFAULT 1,
      transport    TEXT    NOT NULL DEFAULT 'stdio',
      command      TEXT,
      args         TEXT,
      url          TEXT,
      env_enc      TEXT,
      env_iv       TEXT,
      env_tag      TEXT,
      headers_enc  TEXT,
      headers_iv   TEXT,
      headers_tag  TEXT,
      catalog_id   TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 既存DBには上記CREATE TABLEが効かないため、起動のたびに列の有無を確認して追加する(冪等)
  ensureColumn(db, 'users', 'system_prompt', 'TEXT');
  ensureColumn(db, 'conversations', 'system_prompt', 'TEXT');

  cleanupBuiltinTools(db);
}

// 031: builtin撤去に伴う一度きりのクリーンアップ。origin='builtin'で残る旧get_server_time等の行を除去する。
// 2回目以降の起動では対象行が無いため冪等(no-op)
function cleanupBuiltinTools(db) {
  const { changes } = db.prepare("DELETE FROM tools WHERE origin = 'builtin'").run();
  if (changes > 0) {
    logger.info(`db migrate: removed ${changes} legacy builtin tool row(s) from tools table`);
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`db migrate: added column ${table}.${column}`);
  }
}

function seedInitialUser(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) {
    logger.info('db seed: users table is not empty, skipping initial user seed');
    return;
  }

  const username = process.env.INITIAL_ADMIN_USER;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) {
    logger.error('db seed: INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD is not set, skipping initial user seed');
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)'
  ).run(username, passwordHash);
  logger.info(`db seed: initial admin user "${username}" created`);
}

// 040: シークレット不要な自前clock MCPサーバーを、新規/既存デプロイの両方でデフォルト有効にする。
// label='clock'が既に存在する場合(ユーザーの無効化・編集を含む)は何もしない。一度追加するだけ
function seedClockMcpServer(db) {
  const existing = db.prepare('SELECT id FROM mcp_servers WHERE label = ?').get('clock');
  if (existing) return;

  const entry = getCatalogEntry('clock');
  if (!entry || !entry.command) {
    logger.error('db seed: clock catalog entry is unavailable (index.mjs not found?), skipping seed');
    return;
  }

  const { next } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM mcp_servers').get();
  db.prepare(
    `INSERT INTO mcp_servers
       (label, enabled, transport, command, args, url, env_enc, env_iv, env_tag, headers_enc, headers_iv, headers_tag, catalog_id, sort_order)
     VALUES ('clock', 1, 'stdio', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
  ).run(entry.command, JSON.stringify(entry.args || []), entry.id, next);
  logger.info('db seed: clock MCP server added (enabled=1)');
}

function initDb() {
  const db = getDb();
  migrate(db);
  seedInitialUser(db);
  seedClockMcpServer(db);
  return db;
}

module.exports = { getDb, initDb };
