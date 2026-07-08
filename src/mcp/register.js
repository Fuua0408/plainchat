'use strict';

const { register, unregisterByOrigin } = require('../tools/registry');
const logger = require('../logger');

// LLMへ渡すツール名はMCPサーバー単位でnamespace prefixを付与する。
// prefix -> (serverLabel, mcpToolName) の対応はhandlerクロージャに閉じ込め、別テーブルは持たない
function buildToolName(serverLabel, mcpToolName) {
  return `${serverLabel}__${mcpToolName}`;
}

// 接続済みMCPサーバーのlistTools()結果をPlainChatのツール定義へ変換しregistry.register()する
async function registerServerTools(server) {
  if (!server) return 0;

  let mcpTools;
  try {
    mcpTools = await server.listTools();
  } catch (e) {
    logger.error(`mcp: failed to list tools for "${server.label}", continuing without it`, { error: e.message });
    return 0;
  }

  // 前回接続時に登録された同originのツールを一掃してから登録し直す。register()は追加のみで
  // 自動削除しないため、再接続でtools/list結果が減った場合でもここで一掃しないとin-memory
  // registryに前回分が残り続け、syncToolsToDbの孤児判定(現在の登録ツール集合との照合)が狂う
  unregisterByOrigin(`mcp:${server.label}`);

  for (const mcpTool of mcpTools) {
    register({
      name: buildToolName(server.label, mcpTool.name),
      description: mcpTool.description || '',
      parameters: mcpTool.inputSchema,
      origin: `mcp:${server.label}`,
      handler: async (args) => server.callTool(mcpTool.name, args),
    });
  }

  logger.info(`mcp: registered ${mcpTools.length} tool(s) from "${server.label}"`);
  return mcpTools.length;
}

module.exports = { registerServerTools, buildToolName };
