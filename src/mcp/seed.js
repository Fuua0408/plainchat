'use strict';

// 028a限定の後方互換seed。030でDEBUG_searxng依存・builtinごと撤去予定。
// mcp_servers(DB)が唯一の源になった後もsearxngが無登録にならないよう、DBが空の初回起動時だけ
// .envのDEBUG_searxngからsearxng 1件を暗号化seedする

const { getDb } = require('../db');
const { encryptSecret, getKey } = require('./secretBox');
const logger = require('../logger');

// mcp-searxngのインストール済みエントリ(dist/cli.js、shebang付きの素のNode ESMスクリプト)を直接
// nodeで起動する。npx経由だとWindowsで.cmdラッパーを踏むため、実行ファイルパスを直接解決して
// process.execPathで起動することでシェル/.cmd問題を回避する(026/027から継承)
function resolveSearxngEntry() {
  try {
    return require.resolve('mcp-searxng/dist/cli.js');
  } catch (e) {
    logger.error('mcp seed: failed to resolve mcp-searxng entry point', { error: e.message });
    return null;
  }
}

// PlainChat側の変数名(DEBUG_searxng)をmcp-searxngが期待する変数名(SEARXNG_URL)へマッピングする。
// 末尾スラッシュは正規化して落とす
function resolveSearxngUrl() {
  const raw = process.env.DEBUG_searxng;
  if (!raw || raw.trim() === '') return null;
  return raw.trim().replace(/\/+$/, '');
}

// MCP_SEARXNG_ENABLED: 'false'のみ無効とみなし、未設定・不正値はtrue扱い(TOOLS_ENABLEDと同方針)
function parseSearxngEnabled() {
  const raw = (process.env.MCP_SEARXNG_ENABLED || '').trim().toLowerCase();
  return raw !== 'false';
}

// mcp_serversが空 かつ DEBUG_searxng設定済みの場合のみsearxngを1件seedする。
// 2回目以降の起動(mcp_serversが空でない)では何もしない=DBが正
function seedBackwardCompatServers() {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM mcp_servers').get();
  if (count > 0) return;

  const url = resolveSearxngUrl();
  if (!url) return;

  const entry = resolveSearxngEntry();
  if (!entry) return;

  if (!getKey()) {
    logger.error(
      'mcp seed: SECRET_ENC_KEY is not set or invalid, skipping searxng backward-compat seed. ' +
        'Set SECRET_ENC_KEY in .env to enable it.'
    );
    return;
  }

  const enabled = parseSearxngEnabled() ? 1 : 0;
  const { enc, iv, tag } = encryptSecret({ SEARXNG_URL: url });

  db.prepare(
    `INSERT INTO mcp_servers
       (label, enabled, transport, command, args, url, env_enc, env_iv, env_tag, catalog_id)
     VALUES (?, ?, 'stdio', ?, ?, NULL, ?, ?, ?, NULL)`
  ).run('searxng', enabled, process.execPath, JSON.stringify([entry]), enc, iv, tag);

  logger.info('mcp seed: seeded "searxng" MCP server from DEBUG_searxng (028a backward compat)');
}

module.exports = { seedBackwardCompatServers };
