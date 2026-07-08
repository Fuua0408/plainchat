'use strict';

// PlainChatはCommonJS("type":"commonjs")だが、@modelcontextprotocol/sdkはESM中心のため
// ここでのみ動的import()で読み込む(アプリ全体をESM化しない)
const logger = require('../logger');

// HTTPサーバーが無応答でもinitMcp/reloadMcpが起動処理全体を停止させないための接続タイムアウト上限
const CONNECT_TIMEOUT_MS = 10000;

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`connect timed out after ${ms}ms`);
      err.code = 'MCP_CONNECT_TIMEOUT';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 失敗理由を種別だけに絞って分類する。Authorizationヘッダ値・トークン・レスポンス本文等が乗り得る
// e.message はここでは一切参照・返却しない(ログ/呼び出し元summaryへの伏字を担保するため)
function classifyConnectFailure(e) {
  if (!e) return 'unknown';
  if (e.code === 'MCP_CONNECT_TIMEOUT') return 'timeout';
  if (e.code === 401) return 'unauthorized';
  if (typeof e.code === 'number') return `http_${e.code}`;

  const causeCode = (e.cause && e.cause.code) || e.code;
  if (causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'EHOSTUNREACH' || causeCode === 'ETIMEDOUT') {
    return 'unreachable';
  }
  return 'connect_failed';
}

// 正規化済みサーバー設定({label,transport,command,args,env(,url,headers)}、config.jsが構築)を受け取り、
// transportに応じてstdio起動 または HTTP(Streamable HTTP)接続を行う汎用ラッパ。設定の出所
// (.env/DB)は一切意識しない。接続失敗(spawn不可・サーバー無応答・401・タイムアウト)はここで
// 例外を飲み込み、{ok:false,label,reason}を返して「このサーバーのツール無しで続行」させる。
// reasonは種別のみ(unreachable/unauthorized/timeout/connect_failed等)でトークン等は含まない
async function connectServer(serverConfig) {
  const { label, transport, command, args, env, url, headers } = serverConfig;

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    let clientTransport;
    if (transport === 'http') {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      clientTransport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: headers || {} },
      });
    } else {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      clientTransport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env },
        stderr: 'pipe',
      });
    }

    const client = new Client({ name: 'plainchat', version: '1.0.0' }, { capabilities: {} });
    await withTimeout(client.connect(clientTransport), CONNECT_TIMEOUT_MS);

    logger.info(`mcp: connected to "${label}" MCP server (${transport === 'http' ? 'http' : 'stdio'})`);

    return {
      ok: true,
      server: {
        label,
        async listTools() {
          const res = await client.listTools();
          return res.tools || [];
        },
        async callTool(mcpToolName, toolArgs) {
          const res = await client.callTool({ name: mcpToolName, arguments: toolArgs || {} });
          const text = extractTextContent(res.content);
          if (res.isError) {
            throw new Error(text || `MCP tool "${mcpToolName}" returned an error`);
          }
          return text;
        },
        async close() {
          await client.close();
        },
      },
    };
  } catch (e) {
    const reason = classifyConnectFailure(e);
    logger.error(`mcp: failed to connect to "${label}" MCP server, continuing without it`, { reason });
    return { ok: false, label, reason };
  }
}

module.exports = { connectServer };
