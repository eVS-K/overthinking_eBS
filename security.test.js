'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixedWindowLimiter, getClientIp, readPositiveInteger } = require('./security');

test('固定時間窓の制限は上限を超える要求を拒否し、時間経過後に回復する', () => {
  let currentTime = 1_000;
  const limiter = createFixedWindowLimiter({
    limit: 2,
    windowMs: 100,
    maxEntries: 3,
    now: () => currentTime
  });

  assert.equal(limiter.consume('client-a'), true);
  assert.equal(limiter.consume('client-a'), true);
  assert.equal(limiter.consume('client-a'), false);
  currentTime += 100;
  assert.equal(limiter.consume('client-a'), true);
});

test('制限器は追跡キーを上限で抑え、期限切れのキーを回収する', () => {
  let currentTime = 0;
  const limiter = createFixedWindowLimiter({
    limit: 1,
    windowMs: 50,
    maxEntries: 2,
    now: () => currentTime
  });

  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('b'), true);
  assert.equal(limiter.consume('c'), false);
  currentTime = 50;
  assert.equal(limiter.consume('c'), true);
  assert.equal(limiter.size, 1);
});

test('クライアントIPは信頼できる単一のedge headerだけを採用し、X-Forwarded-Forの偽装を採用しない', () => {
  assert.equal(getClientIp({
    headers: {
      'cf-connecting-ip': '203.0.113.24',
      'x-forwarded-for': '198.51.100.99, 10.0.0.1'
    }
  }, { trustProxy: true }), '203.0.113.24');
  assert.equal(getClientIp({
    headers: { 'x-forwarded-for': '203.0.113.24' },
    socket: { remoteAddress: '127.0.0.1' }
  }, { trustProxy: true }), '127.0.0.1');
  assert.equal(getClientIp({
    headers: { 'cf-connecting-ip': '203.0.113.24, 198.51.100.1' },
    socket: { remoteAddress: '127.0.0.1' }
  }, { trustProxy: true }), '127.0.0.1');
  assert.equal(getClientIp({
    headers: { 'cf-connecting-ip': '203.0.113.24' },
    socket: { remoteAddress: '127.0.0.1' }
  }, { trustProxy: true, trustedProxyHeader: 'x-forwarded-for' }), '127.0.0.1');
  assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '::ffff:127.0.0.1');
  assert.equal(getClientIp({ headers: { 'cf-connecting-ip': 'not-an-ip' } }, { trustProxy: true }), 'unknown');
});

test('環境変数の数値は安全な範囲だけを受け入れる', () => {
  assert.equal(readPositiveInteger('42', 10, { max: 50 }), 42);
  assert.equal(readPositiveInteger('0', 10, { max: 50 }), 10);
  assert.equal(readPositiveInteger('999', 10, { max: 50 }), 10);
});
