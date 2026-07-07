'use strict';

const { loadMcpServers } = require('./config');
const { connectServer } = require('./client');
const { registerServerTools } = require('./register');
const logger = require('../logger');

let activeServers = [];

// loadMcpServers()が返す正規化配列を元に、enabledな各サーバーへ接続しツールをregistryへ登録する。
// 1サーバーの接続/登録失敗は隔離し(ログを残すのみ)、他サーバーとサーバー起動シーケンス全体は継続する
async function initMcp() {
  const configs = loadMcpServers();
  const servers = [];

  for (const config of configs) {
    if (!config.enabled) {
      logger.info(`mcp: "${config.label}" is disabled, skipping`);
      continue;
    }

    const server = await connectServer(config);
    if (server) servers.push(server);
  }

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
