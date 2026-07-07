'use strict';

// PlainChatはCommonJS("type":"commonjs")だが、@modelcontextprotocol/sdkはESM中心のため
// ここでのみ動的import()で読み込む(アプリ全体をESM化しない)
const logger = require('../logger');

// mcp-searxngのインストール済みエントリ(dist/cli.js、shebang付きの素のNode ESMスクリプト)を直接
// nodeで起動する。npx経由だとWindowsで.cmdラッパーを踏むため、実行ファイルパスを直接解決して
// process.execPathで起動することでシェル/.cmd問題を回避する
function resolveSearxngEntry() {
  return require.resolve('mcp-searxng/dist/cli.js');
}

// PlainChat側の変数名(DEBUG_searxng)をmcp-searxngが期待する変数名(SEARXNG_URL)へマッピングする。
// 末尾スラッシュは正規化して落とす
function resolveSearxngUrl() {
  const raw = process.env.DEBUG_searxng;
  if (!raw || raw.trim() === '') return null;
  return raw.trim().replace(/\/+$/, '');
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// MCP_SEARXNG_ENABLED: 'false'のみ無効とみなし、未設定・不正値はtrue扱いにする(TOOLS_ENABLEDと同じ方針)
function parseSearxngEnabled() {
  const raw = (process.env.MCP_SEARXNG_ENABLED || '').trim().toLowerCase();
  return raw !== 'false';
}

// 1サーバー(searxng)をstdioで起動し接続する薄いラッパ。
// 接続失敗(spawn不可・URL未設定・サーバー無応答)はここで例外を飲み込み、
// 呼び出し元へnullを返して「searxngツール無しで続行」させる
async function connectSearxng() {
  if (!parseSearxngEnabled()) {
    logger.info('mcp: MCP_SEARXNG_ENABLED=false, skipping searxng MCP server');
    return null;
  }

  const searxngUrl = resolveSearxngUrl();
  if (!searxngUrl) {
    logger.warn('mcp: DEBUG_searxng is not set, skipping searxng MCP server');
    return null;
  }

  let entry;
  try {
    entry = resolveSearxngEntry();
  } catch (e) {
    logger.error('mcp: failed to resolve mcp-searxng entry point, skipping', { error: e.message });
    return null;
  }

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, SEARXNG_URL: searxngUrl },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'plainchat', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    logger.info('mcp: connected to searxng MCP server (stdio)');

    return {
      label: 'searxng',
      async listTools() {
        const res = await client.listTools();
        return res.tools || [];
      },
      async callTool(mcpToolName, args) {
        const res = await client.callTool({ name: mcpToolName, arguments: args || {} });
        const text = extractTextContent(res.content);
        if (res.isError) {
          throw new Error(text || `MCP tool "${mcpToolName}" returned an error`);
        }
        return text;
      },
      async close() {
        await client.close();
      },
    };
  } catch (e) {
    logger.error('mcp: failed to connect to searxng MCP server, continuing without it', { error: e.message });
    return null;
  }
}

module.exports = { connectSearxng };
