#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOL_NAME = 'get_current_datetime';
const TOOL_DESCRIPTION =
  '現在のシステム日時を取得します。相対的な日付表現(今日・今年・最新等)を扱う場合や、' +
  'Web検索のクエリに年号を含める前には、まずこのツールで現在日時を確認してください。';

function pad(n) {
  return String(n).padStart(2, '0');
}

function buildCurrentDatetime() {
  const now = new Date();

  const tzOffsetMin = -now.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(tzOffsetMin);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const iso = `${date}T${time}${offset}`;
  const weekday = new Intl.DateTimeFormat('ja-JP', { weekday: 'long' }).format(now);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const unix = Math.floor(now.getTime() / 1000);

  return { iso, date, time, weekday, timezone, unix };
}

const server = new Server(
  { name: 'plainchat-clock', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(buildCurrentDatetime()) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('clock MCP server failed to start:', error);
  process.exit(1);
});
