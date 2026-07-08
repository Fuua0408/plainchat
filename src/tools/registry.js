'use strict';

require('./types');
const logger = require('../logger');

/** @type {Map<string, import('./types').ToolDefinition & { origin: string }>} */
const registry = new Map();

function register(tool) {
  if (!tool || typeof tool.name !== 'string' || !tool.name) {
    throw new Error('tool.name is required');
  }
  if (typeof tool.handler !== 'function') {
    throw new Error(`tool "${tool.name}": handler must be a function`);
  }
  if (!tool.parameters || typeof tool.parameters !== 'object') {
    throw new Error(`tool "${tool.name}": parameters (JSON Schema) is required`);
  }
  if (typeof tool.origin !== 'string' || !tool.origin) {
    throw new Error(`tool "${tool.name}": origin is required`);
  }

  registry.set(tool.name, {
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters,
    handler: tool.handler,
    origin: tool.origin,
  });
}

// 指定originに属する登録済みツールをすべてregistryから外す。MCPサーバー再接続時に
// 前回のtools/list結果を持ち越さないため、再登録前に同originを一掃する用途で使う
function unregisterByOrigin(origin) {
  for (const [name, tool] of registry) {
    if (tool.origin === origin) registry.delete(name);
  }
}

function getRegisteredTools() {
  return Array.from(registry.values());
}

function getToolByName(name) {
  return registry.get(name);
}

function toOpenAISchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function buildOpenAIToolSchemas(names) {
  const tools = names
    ? names.map((name) => registry.get(name)).filter(Boolean)
    : getRegisteredTools();
  return tools.map(toOpenAISchema);
}

function getEnabledToolSchemas(db) {
  const registered = getRegisteredTools();
  if (registered.length === 0) return [];

  const placeholders = registered.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name FROM tools WHERE enabled = 1 AND name IN (${placeholders})`)
    .all(...registered.map((tool) => tool.name));
  const enabledNames = new Set(rows.map((row) => row.name));

  return registered
    .filter((tool) => enabledNames.has(tool.name))
    .map(toOpenAISchema);
}

// registryが申告したツールをtools台帳へミラーし、あわせて孤児tools(登録源から消えたツール行)を
// 無効化する。connectedLabels は今回MCP接続に成功したサーバーのラベル一覧(initMcp/reloadMcpの戻り値)。
// - upsert は enabled 列に触れない(新規行のみスキーマ既定の enabled=1、既存行はユーザー設定を保持)
// - 無効化は origin='mcp:<label>' の label が connectedLabels に含まれる行のみが対象。接続失敗サーバーの
//   行は一時的な接続断で無効化しないため無視する
// 失敗しても起動を止めないよう、この関数の内側でエラーを隔離する。
function syncToolsToDb(db, connectedLabels = []) {
  try {
    const tools = getRegisteredTools();
    const upsert = db.prepare(`
      INSERT INTO tools (name, description, origin, sort_order)
      VALUES (@name, @description, @origin, @sortOrder)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        origin = excluded.origin,
        updated_at = datetime('now')
    `);
    const syncAll = db.transaction((items) => {
      items.forEach((tool, index) => {
        upsert.run({
          name: tool.name,
          description: tool.description,
          origin: tool.origin,
          sortOrder: index,
        });
      });
    });
    syncAll(tools);

    const connectedSet = new Set(connectedLabels);
    let disabledCount = 0;
    if (connectedSet.size > 0) {
      const currentNames = new Set(tools.map((tool) => tool.name));
      const existing = db.prepare("SELECT name, origin FROM tools WHERE origin LIKE 'mcp:%' AND enabled = 1").all();
      const disable = db.prepare("UPDATE tools SET enabled = 0, updated_at = datetime('now') WHERE name = ?");
      const disableOrphans = db.transaction((rows) => {
        for (const row of rows) {
          const label = row.origin.slice('mcp:'.length);
          if (connectedSet.has(label) && !currentNames.has(row.name)) {
            disable.run(row.name);
            disabledCount += 1;
          }
        }
      });
      disableOrphans(existing);
    }

    logger.info(`tools: synced ${tools.length} registered tool(s) to db, disabled ${disabledCount} orphan tool(s)`);
  } catch (e) {
    logger.error('tools: failed to sync registered tools to db, continuing', { error: e.message });
  }
}

module.exports = {
  register,
  unregisterByOrigin,
  getRegisteredTools,
  getToolByName,
  buildOpenAIToolSchemas,
  getEnabledToolSchemas,
  syncToolsToDb,
};
