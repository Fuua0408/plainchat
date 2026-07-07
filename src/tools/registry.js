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

  registry.set(tool.name, {
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters,
    handler: tool.handler,
    origin: tool.origin || 'builtin',
  });
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

// 登録源(このタスクではコードレジストリのみ)が申告したツールをtools台帳へミラーする。
// 失敗しても起動を止めないよう、この関数の内側でエラーを隔離する。
function syncToolsToDb(db) {
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
    logger.info(`tools: synced ${tools.length} registered tool(s) to db`);
  } catch (e) {
    logger.error('tools: failed to sync registered tools to db, continuing', { error: e.message });
  }
}

module.exports = {
  register,
  getRegisteredTools,
  getToolByName,
  buildOpenAIToolSchemas,
  getEnabledToolSchemas,
  syncToolsToDb,
};
