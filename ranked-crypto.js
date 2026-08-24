'use strict';

const crypto = require('crypto');
const { SEED_BYTES } = require('./ranked-rng');

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function parseEncryptionKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== AES_KEY_BYTES) throw new TypeError('ranked seed encryption key must be 256 bits');
    return Buffer.from(value);
  }
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('ranked seed encryption key is required');
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== AES_KEY_BYTES) throw new TypeError('ranked seed encryption key must be 256 bits');
  return key;
}

function encryptSeed(seed, keyInput) {
  const key = parseEncryptionKey(keyInput);
  const plaintext = Buffer.isBuffer(seed) ? seed : Buffer.from(seed || '');
  if (plaintext.length !== SEED_BYTES) throw new TypeError('ranked seed must be 256 bits');
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag()
  };
}

function decryptSeed(encrypted, keyInput) {
  const key = parseEncryptionKey(keyInput);
  if (!encrypted || !Buffer.isBuffer(encrypted.ciphertext) || !Buffer.isBuffer(encrypted.iv) || !Buffer.isBuffer(encrypted.authTag)) {
    throw new TypeError('encrypted seed is malformed');
  }
  if (encrypted.iv.length !== GCM_IV_BYTES || encrypted.authTag.length !== GCM_TAG_BYTES) {
    throw new TypeError('encrypted seed parameters are invalid');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);
  const seed = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  if (seed.length !== SEED_BYTES) throw new Error('decrypted ranked seed is invalid');
  return seed;
}

module.exports = { decryptSeed, encryptSeed, parseEncryptionKey };
