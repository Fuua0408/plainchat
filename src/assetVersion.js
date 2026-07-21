'use strict';

const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

const FALLBACK_VERSION = 'na';
const HASH_LENGTH = 10;

// absoluteFilePath -> { mtimeMs, hash }
const cache = new Map();

// ファイル内容のsha256先頭HASH_LENGTH桁を返す。mtimeMsが前回計算時と変わっていなければ
// 再計算せずキャッシュ済みhashを返す(呼び出しごとにfs.statSyncするだけで済む軽量パス)
function getAssetVersion(absoluteFilePath) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(absoluteFilePath).mtimeMs;
  } catch (e) {
    logger.warn(`assetVersion: failed to stat ${absoluteFilePath}`, { error: e.message });
    return FALLBACK_VERSION;
  }

  const cached = cache.get(absoluteFilePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.hash;
  }

  try {
    const content = fs.readFileSync(absoluteFilePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, HASH_LENGTH);
    cache.set(absoluteFilePath, { mtimeMs, hash });
    return hash;
  } catch (e) {
    logger.warn(`assetVersion: failed to read ${absoluteFilePath}`, { error: e.message });
    return FALLBACK_VERSION;
  }
}

module.exports = { getAssetVersion };
