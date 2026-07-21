'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const logger = require('./logger');
const { initDb, getDb } = require('./db');
const tools = require('./tools');
const { initMcp, closeMcp, getActiveChildPids } = require('./mcp');
const { cleanupOrphanUploads } = require('./attachmentCleanup');
const { getAssetVersion } = require('./assetVersion');
const authRoutes = require('./routes/auth');
const conversationsRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');
const uploadsRoutes = require('./routes/uploads');
const mcpAdminRoutes = require('./routes/mcpAdmin');

const app = express();
const PORT = process.env.PORT || 18091;
const publicDir = path.join(__dirname, '..', 'public');

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

// css/style.css・js/api.js・js/app.js への参照に、その時点のファイル内容ハッシュを?v=として
// 付与する。対象はhref/src="<path>" または "<path>?v=旧値" のどちらの形でも一致させ、常に
// 現在のハッシュへ揃える(041)
const VERSIONED_ASSETS = ['css/style.css', 'js/api.js', 'js/app.js'];

function injectAssetVersions(html) {
  let result = html;
  for (const assetPath of VERSIONED_ASSETS) {
    const version = getAssetVersion(path.join(publicDir, assetPath));
    const pattern = new RegExp(`(["'])${assetPath}(?:\\?v=[^"']*)?\\1`, 'g');
    result = result.replace(pattern, `$1${assetPath}?v=${version}$1`);
  }
  return result;
}

function serveIndexHtml(req, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  } catch (e) {
    logger.error('failed to read index.html', { error: e.message });
    return res.status(500).send('internal server error');
  }
  res.set('Cache-Control', 'no-cache');
  res.send(injectAssetVersions(html));
}

app.get('/', serveIndexHtml);
app.get('/index.html', serveIndexHtml);

app.use(express.static(publicDir, { index: false }));

// 起動順序: MCP接続+登録(initMcp、registryはbuiltinが無いため空から始まる)→
// その接続成功サーバー集合を使ってtools台帳へミラー同期(孤児tools無効化はここで判定)。
// MCP接続は非同期(tools/list)なので起動処理全体をasync化する。
// MCP接続に失敗してもミラー同期・サーバー起動は継続する
async function main() {
  initDb();

  const { connected } = await initMcp();
  tools.syncToolsToDb(getDb(), connected);

  try {
    cleanupOrphanUploads();
  } catch (e) {
    logger.error('attachment cleanup: unexpected failure at startup, continuing', { error: e.message });
  }

  const httpServer = app.listen(PORT, () => {
    logger.info(`plainchat server listening on port ${PORT}`);
  });
  // EADDRINUSE等のlisten時エラーを未捕捉例外にせず、起きているMCP子プロセスを後始末してから終了する
  httpServer.on('error', (e) => {
    crashShutdown('app.listen error', e);
  });
}

// 正常経路(SIGINT/SIGTERM)・異常経路(listenエラー/uncaughtException/unhandledRejection)を問わず、
// 後始末(closeMcp)→終了は一度きりにする多重ガード。二重に走っても安全(冪等)
let shuttingDown = false;

// MCPクライアントをcloseし、mcp-searxng子プロセスを終了させてから終了する(孤児プロセス防止)
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`plainchat: received ${signal}, shutting down`);
  try {
    await closeMcp();
  } catch (e) {
    logger.error('plainchat: error during mcp shutdown', { error: e.message });
  }
  process.exit(0);
}

// 異常終了経路(listenエラー/uncaughtException/unhandledRejection)共通の後始末。
// アプリを継続させるためではなく「落ちる前にMCP子プロセスを後始末する」ためのベストエフォートであり、
// 後始末後は非ゼロ終了でよい。closeMcp自体の失敗はここで飲み込み、ハンドラ内エラーで無限ループしない
async function crashShutdown(label, error) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.error(`plainchat: ${label}, shutting down`, { error: error && error.message });
  try {
    await closeMcp();
  } catch (e) {
    logger.error('plainchat: error during mcp shutdown', { error: e.message });
  }
  process.exit(1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => crashShutdown('uncaughtException', e));
process.on('unhandledRejection', (reason) => {
  crashShutdown('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// 非同期closeが間に合わずプロセスが落ちる場合の最終防衛。exitハンドラは同期処理のみ実行できるため、
// 保持しているstdio子プロセスPIDへ同期的にkillを撃つ。対象は自分が起動したPIDに厳密限定
// (Windowsはprocess.kill(pid)がシグナル種別を無視し強制終了として働く)。多重に走ってもtry/catchで無害
process.on('exit', () => {
  for (const pid of getActiveChildPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      // 既に終了済み等はここで無視してよい(誤爆防止のため対象PID以外には触れない)
    }
  }
});

main().catch((e) => {
  crashShutdown('fatal startup error', e);
});
