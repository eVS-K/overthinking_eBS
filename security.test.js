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

test('クライアントIPはプロキシの転送IPを優先し、不正値は安全に退避する', () => {
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '203.0.113.24, 10.0.0.1' } }), '203.0.113.24');
  assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '::ffff:127.0.0.1');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': 'not-an-ip' } }), 'unknown');
});

test('環境変数の数値は安全な範囲だけを受け入れる', () => {
  assert.equal(readPositiveInteger('42', 10, { max: 50 }), 42);
  assert.equal(readPositiveInteger('0', 10, { max: 50 }), 10);
  assert.equal(readPositiveInteger('999', 10, { max: 50 }), 10);
});
