'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

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

    CREATE TABLE IF NOT EXISTS tools (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT,
      origin      TEXT    NOT NULL DEFAULT 'builtin',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 既存DBには上記CREATE TABLEが効かないため、起動のたびに列の有無を確認して追加する(冪等)
  ensureColumn(db, 'users', 'system_prompt', 'TEXT');
  ensureColumn(db, 'conversations', 'system_prompt', 'TEXT');
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

function initDb() {
  const db = getDb();
  migrate(db);
  seedInitialUser(db);
  return db;
}

module.exports = { getDb, initDb };
