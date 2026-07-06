'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const logger = require('./logger');
const { UPLOAD_ROOT, resolveAttachmentFilePath } = require('./attachmentStorage');

function collectKnownPaths(db) {
  const rows = db.prepare('SELECT id, user_id, path FROM attachments').all();
  const known = new Set();
  for (const row of rows) {
    known.add(path.resolve(resolveAttachmentFilePath(row)));
  }
  return known;
}

// UPLOAD_ROOT配下を再帰的に走査してファイル/ディレクトリを集める。
// シンボリックリンクは実体がuploads外を指す可能性があり判断がつかないため、辿らず残す。
function walk(dir, files, dirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    logger.warn('attachment cleanup: failed to read directory', { dir, error: e.message });
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      dirs.push(full);
      walk(full, files, dirs);
    } else if (entry.isFile()) {
      files.push(full);
    }
    // デバイスファイル等の想定外の形状は無視(削除しない)
  }
}

// 起動時に一度呼び出し、DBのattachments.pathが一切参照していない
// uploads配下の実ファイル(孤児/過去のテスト残骸)を削除する
function cleanupOrphanUploads() {
  const uploadRoot = path.resolve(UPLOAD_ROOT);
  if (!fs.existsSync(uploadRoot)) {
    logger.info('attachment cleanup: upload root does not exist, skipping', { uploadRoot });
    return;
  }

  const db = getDb();
  const known = collectKnownPaths(db);

  const files = [];
  const dirs = [];
  walk(uploadRoot, files, dirs);

  const rootWithSep = uploadRoot + path.sep;
  let deletedCount = 0;
  const deletedPaths = [];

  for (const file of files) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(rootWithSep)) {
      // uploadsルート外は絶対に触らない(安全策。通常はここに到達しない)
      continue;
    }
    if (known.has(resolved)) continue;

    try {
      fs.unlinkSync(resolved);
      deletedCount += 1;
      deletedPaths.push(resolved);
    } catch (e) {
      logger.warn('attachment cleanup: failed to delete orphan file', { path: resolved, error: e.message });
    }
  }

  if (deletedCount > 0) {
    logger.info(`attachment cleanup: deleted ${deletedCount} orphan file(s)`, { paths: deletedPaths });
  } else {
    logger.info('attachment cleanup: no orphan files found');
  }

  // 空になったユーザーディレクトリを削除(深い階層から先に処理)
  dirs
    .sort((a, b) => b.length - a.length)
    .forEach((dir) => {
      try {
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0) {
          fs.rmdirSync(dir);
          logger.info('attachment cleanup: removed empty directory', { dir });
        }
      } catch (e) {
        logger.warn('attachment cleanup: failed to remove directory', { dir, error: e.message });
      }
    });
}

module.exports = { cleanupOrphanUploads };
