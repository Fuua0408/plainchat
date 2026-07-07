'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

// SECRET_ENC_KEY(base64エンコードされた32バイト)を読み、妥当なら32バイトのBufferを返す。
// 未設定・デコード後に32バイトでない場合はnull(=鍵不正)を返す
function getKey() {
  const raw = process.env.SECRET_ENC_KEY;
  if (!raw || raw.trim() === '') return null;

  let key;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch (e) {
    return null;
  }

  if (key.length !== 32) return null;
  return key;
}

function keyMissingError() {
  const err = new Error('secretBox: SECRET_ENC_KEY is not set or invalid');
  err.code = 'ERR_KEY_MISSING';
  return err;
}

// obj(プレーンなJSオブジェクト)をJSON化しAES-256-GCMで暗号化する。obj が null/undefined、
// もしくはキーを持たない空オブジェクトなら暗号項目なしとして{enc:null,iv:null,tag:null}を返す。
// IVは呼び出しごとにランダム生成する
function encryptSecret(obj) {
  if (!obj || Object.keys(obj).length === 0) {
    return { enc: null, iv: null, tag: null };
  }

  const key = getKey();
  if (!key) throw keyMissingError();

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    enc: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// {enc,iv,tag}(いずれもbase64)を復号し元のオブジェクトを返す。enc が null なら暗号項目なしとして
// null を返す。鍵未設定/不正時は code='ERR_KEY_MISSING' の例外、authTag検証失敗など復号失敗時は
// code='ERR_DECRYPT_FAILED' の例外を投げる。例外メッセージ・呼び出し元のログに復号値・鍵は含めない
function decryptSecret(row) {
  const { enc, iv, tag } = row || {};
  if (!enc) return null;

  const key = getKey();
  if (!key) throw keyMissingError();

  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    const err = new Error('secretBox: decryption failed (invalid key or tampered data)');
    err.code = 'ERR_DECRYPT_FAILED';
    throw err;
  }
}

module.exports = { getKey, encryptSecret, decryptSecret };
