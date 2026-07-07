'use strict';

const logger = require('../logger');

// mcp-searxngのインストール済みエントリ(dist/cli.js、shebang付きの素のNode ESMスクリプト)を直接
// nodeで起動する。npx経由だとWindowsで.cmdラッパーを踏むため、実行ファイルパスを直接解決して
// process.execPathで起動することでシェル/.cmd問題を回避する
function resolveSearxngEntry() {
  try {
    return require.resolve('mcp-searxng/dist/cli.js');
  } catch (e) {
    logger.error('mcp: failed to resolve mcp-searxng entry point', { error: e.message });
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

// MCP_SEARXNG_ENABLED: 'false'のみ無効とみなし、未設定・不正値はtrue扱いにする(TOOLS_ENABLEDと同じ方針)
function parseSearxngEnabled() {
  const raw = (process.env.MCP_SEARXNG_ENABLED || '').trim().toLowerCase();
  return raw !== 'false';
}

const DISABLED_SERVER_DEFAULTS = { command: process.execPath, args: [], env: {} };

// searxng 1エントリを.envから構築する。command/argsは026同様「node + mcp-searxng cli絶対パス」、
// envは子プロセスへ渡す解決済み実値(SEARXNG_URL)。無効化条件(フラグfalse/URL未設定/エントリ解決不可)は
// enabled=falseとして返し、呼び出し側はcommand/argsを一切気にせずenabledだけを見ればよい
function buildSearxngServerConfig() {
  if (!parseSearxngEnabled()) {
    return { label: 'searxng', enabled: false, ...DISABLED_SERVER_DEFAULTS };
  }

  const url = resolveSearxngUrl();
  if (!url) {
    logger.warn('mcp: DEBUG_searxng is not set, disabling searxng MCP server');
    return { label: 'searxng', enabled: false, ...DISABLED_SERVER_DEFAULTS };
  }

  const entry = resolveSearxngEntry();
  if (!entry) {
    return { label: 'searxng', enabled: false, ...DISABLED_SERVER_DEFAULTS };
  }

  return {
    label: 'searxng',
    enabled: true,
    command: process.execPath,
    args: [entry],
    env: { SEARXNG_URL: url },
  };
}

// MCPサーバー設定の唯一の出所。正規化済み配列 [{label,enabled,command,args,env}] を返す。
// 027時点の実装ソースは.env(searxng 1エントリ)。028でDB+封筒復号に差し替える際も、
// この関数の内部だけを変更すれば呼び出し側(src/mcp/client.js, index.js)は無改修で動く
function loadMcpServers() {
  return [buildSearxngServerConfig()];
}

module.exports = { loadMcpServers };
