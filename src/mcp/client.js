'use strict';

// PlainChatはCommonJS("type":"commonjs")だが、@modelcontextprotocol/sdkはESM中心のため
// ここでのみ動的import()で読み込む(アプリ全体をESM化しない)
const logger = require('../logger');

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// 正規化済みサーバー設定({label,command,args,env}、config.jsが構築)を受け取りstdioで起動・接続する
// 汎用ラッパ。設定の出所(.env/将来DB)は一切意識しない。接続失敗(spawn不可・サーバー無応答)は
// ここで例外を飲み込み、呼び出し元へnullを返して「このサーバーのツール無しで続行」させる
async function connectServer(serverConfig) {
  const { label, command, args, env } = serverConfig;

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'plainchat', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    logger.info(`mcp: connected to "${label}" MCP server (stdio)`);

    return {
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
    };
  } catch (e) {
    logger.error(`mcp: failed to connect to "${label}" MCP server, continuing without it`, { error: e.message });
    return null;
  }
}

module.exports = { connectServer };
