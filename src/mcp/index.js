'use strict';

const { loadMcpServers } = require('./config');
const { connectServer } = require('./client');
const { registerServerTools } = require('./register');
const logger = require('../logger');

let activeServers = [];
let reloadInFlight = null;
// 現在生きているはずのstdio子プロセスPID集合。異常終了経路(exitハンドラの同期kill)から
// 辿れるよう、closeMcpの成否に関わらず「閉じ切れた」ことを確認できたものだけ削除する
const activeChildPids = new Set();

// loadMcpServers()が返す正規化配列を元に、enabledな各サーバーへ接続しツールをregistryへ登録する。
// 1サーバーの接続/登録失敗は隔離し(ログを残すのみ)、他サーバーとサーバー起動シーケンス全体は継続する。
// 戻り値は接続成功ラベル一覧と失敗ラベル+理由種別の要約(再接続APIのレスポンスに使う。トークンは含まない)
async function initMcp() {
  const configs = loadMcpServers();
  const servers = [];
  const connected = [];
  const failed = [];

  for (const config of configs) {
    if (!config.enabled) {
      logger.info(`mcp: "${config.label}" is disabled, skipping`);
      continue;
    }

    const result = await connectServer(config);
    if (result.ok) {
      servers.push(result.server);
      connected.push(result.server.label);
      if (result.server.pid) {
        activeChildPids.add(result.server.pid);
      }
    } else {
      failed.push({ label: result.label, reason: result.reason });
    }
  }

  for (const server of servers) {
    await registerServerTools(server);
  }

  activeServers = servers;
  return { connected, failed };
}

// SIGINT/SIGTERM時(や異常終了経路)に呼び、接続中の全MCPクライアントをcloseして子プロセスを終了させる。
// close()が成功したサーバーのpidのみactiveChildPidsから外す(失敗時はexitハンドラの同期killに委ねる)
async function closeMcp() {
  for (const server of activeServers) {
    try {
      await server.close();
      if (server.pid) activeChildPids.delete(server.pid);
      logger.info(`mcp: closed "${server.label}"`);
    } catch (e) {
      logger.error(`mcp: failed to close "${server.label}"`, { error: e.message });
    }
  }
  activeServers = [];
}

// exitハンドラ等の同期後始末が対象にすべきstdio子プロセスPIDの現在集合(コピー)を返す
function getActiveChildPids() {
  return Array.from(activeChildPids);
}

// closeMcp()→initMcp()を安全に実行する明示リロード。実行中に重ねて呼ばれても同じ実行結果を
// 待たせるだけで、多重接続・競合が起きないようにする(実行中フラグではなくpromise自体をガードにする)
async function reloadMcp() {
  if (reloadInFlight) return reloadInFlight;

  reloadInFlight = (async () => {
    await closeMcp();
    return initMcp();
  })();

  try {
    return await reloadInFlight;
  } finally {
    reloadInFlight = null;
  }
}

module.exports = { initMcp, closeMcp, reloadMcp, getActiveChildPids };
