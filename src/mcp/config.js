'use strict';

const { getDb } = require('../db');
const { decryptSecret } = require('./secretBox');
const logger = require('../logger');

function parseArgs(argsJson) {
  if (!argsJson) return [];
  try {
    const parsed = JSON.parse(argsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logger.error('mcp: failed to parse args JSON, treating as empty', { error: e.message });
    return [];
  }
}

function decryptColumns(row, prefix) {
  return decryptSecret({
    enc: row[`${prefix}_enc`],
    iv: row[`${prefix}_iv`],
    tag: row[`${prefix}_tag`],
  });
}

// MCPサーバー設定の唯一の出所。mcp_servers(DB)のenabled=1行をsort_order,id順に読み、
// env/headersを封筒復号して正規化配列 [{label,enabled,transport,command,args,env(,url,headers)}] を返す。
// 028a時点の呼び出し側(initMcp()/register.js/client.js)は027から無改修のまま動く(この関数の内部のみ差替)
function loadMcpServers() {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY sort_order ASC, id ASC')
    .all();

  const servers = [];

  for (const row of rows) {
    let env;
    let headers;
    try {
      env = decryptColumns(row, 'env') || {};
      headers = decryptColumns(row, 'headers') || {};
    } catch (e) {
      if (e.code === 'ERR_KEY_MISSING') {
        logger.error(
          `mcp: SECRET_ENC_KEY is not set or invalid, skipping "${row.label}" (set SECRET_ENC_KEY in .env to enable it)`
        );
      } else {
        logger.error(`mcp: failed to decrypt secrets for "${row.label}", skipping`, { error: e.message });
      }
      continue;
    }

    const server = {
      label: row.label,
      enabled: !!row.enabled,
      transport: row.transport,
      command: row.command,
      args: parseArgs(row.args),
      env,
    };

    if (row.transport === 'http') {
      server.url = row.url;
      server.headers = headers;
    }

    servers.push(server);
  }

  return servers;
}

module.exports = { loadMcpServers };
