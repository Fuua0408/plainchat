'use strict';

const path = require('path');

// DB_PATH と同じ基準(データディレクトリ)を使い、アップロードもその配下に置く
const DATA_DIR = path.resolve(path.dirname(process.env.DB_PATH || './data/plainchat.db'));
const UPLOAD_ROOT = path.join(DATA_DIR, 'uploads');

// path列の値をそのまま結合せず、basenameで再構成してトラバーサルを防止
function resolveAttachmentFilePath(attachment) {
  const filename = path.basename(attachment.path);
  return path.join(UPLOAD_ROOT, String(attachment.user_id), filename);
}

module.exports = { DATA_DIR, UPLOAD_ROOT, resolveAttachmentFilePath };
