'use strict';

const { connectSearxng } = require('./client');
const { registerServerTools } = require('./register');
const logger = require('../logger');

let activeServers = [];

// MCPサーバーへ接続しツールをregistryへ登録する。026時点では単一サーバー(searxng)のみ。
// 接続失敗時もここで例外を飲み込み、呼び出し元(起動シーケンス)は必ず継続できるようにする
async function initMcp() {
  const servers = [];

  const searxng = await connectSearxng();
  if (searxng) servers.push(searxng);

  for (const server of servers) {
    await registerServerTools(server);
  }

  activeServers = servers;
  return servers;
}

// SIGINT/SIGTERM時に呼び、接続中の全MCPクライアントをcloseして子プロセスを終了させる
async function closeMcp() {
  for (const server of activeServers) {
    try {
      await server.close();
      logger.info(`mcp: closed "${server.label}"`);
    } catch (e) {
      logger.error(`mcp: failed to close "${server.label}"`, { error: e.message });
    }
  }
  activeServers = [];
}

module.exports = { initMcp, closeMcp };
