'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const logger = require('./logger');
const { initDb, getDb } = require('./db');
const tools = require('./tools');
const { initMcp, closeMcp } = require('./mcp');
const { seedBackwardCompatServers } = require('./mcp/seed');
const { cleanupOrphanUploads } = require('./attachmentCleanup');
const authRoutes = require('./routes/auth');
const conversationsRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');
const uploadsRoutes = require('./routes/uploads');
const mcpAdminRoutes = require('./routes/mcpAdmin');

const app = express();
const PORT = process.env.PORT || 18091;

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'plainchat' });
});

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/conversations', chatRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/mcp', mcpAdminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// 起動順序: builtin読み込み(上のrequire('./tools')で自己登録済み)→ MCP接続+登録 →
// tools台帳へのミラー同期。MCP接続は非同期(tools/list)なので起動処理全体をasync化する。
// MCP接続に失敗してもミラー同期・サーバー起動は継続する
async function main() {
  initDb();
  seedBackwardCompatServers();

  await initMcp();
  tools.syncToolsToDb(getDb());

  try {
    cleanupOrphanUploads();
  } catch (e) {
    logger.error('attachment cleanup: unexpected failure at startup, continuing', { error: e.message });
  }

  app.listen(PORT, () => {
    logger.info(`plainchat server listening on port ${PORT}`);
  });
}

// MCPクライアントをcloseし、mcp-searxng子プロセスを終了させてから終了する(孤児プロセス防止)
async function shutdown(signal) {
  logger.info(`plainchat: received ${signal}, shutting down`);
  try {
    await closeMcp();
  } catch (e) {
    logger.error('plainchat: error during mcp shutdown', { error: e.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  logger.error('plainchat: fatal startup error', { error: e.message });
  process.exit(1);
});
