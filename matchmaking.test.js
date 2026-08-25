'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RandomMatchQueue } = require('./matchmaking');

test('ランダム対戦待機列はFIFOで有効な相手だけを取り出す', () => {
  const queue = new RandomMatchQueue({ maxEntries: 3 });
  queue.enqueue({ clientId: 'first', socketId: 'socket-1', ip: '192.0.2.1' }, 10);
  queue.enqueue({ clientId: 'stale', socketId: 'socket-stale', ip: '192.0.2.2' }, 11);
  queue.enqueue({ clientId: 'second', socketId: 'socket-2', ip: '192.0.2.3' }, 12);

  assert.equal(queue.takeNext((entry) => entry.socketId !== 'socket-stale').clientId, 'first');
  assert.equal(queue.takeNext((entry) => entry.socketId !== 'socket-stale').clientId, 'second');
  assert.equal(queue.size, 0);
});

test('同一clientIdの再待機は重複せず、上限とIP数を保つ', () => {
  const queue = new RandomMatchQueue({ maxEntries: 2 });
  assert.deepEqual(queue.enqueue({ clientId: 'same', socketId: 'old', ip: '198.51.100.1' }, 10), { ok: true, updated: false });
  assert.deepEqual(queue.enqueue({ clientId: 'same', socketId: 'new', ip: '198.51.100.1' }, 20), { ok: true, updated: true });
  assert.equal(queue.size, 1);
  assert.equal(queue.countByIp('198.51.100.1'), 1);
  queue.enqueue({ clientId: 'other', socketId: 'socket-2', ip: '198.51.100.2' }, 21);
  assert.deepEqual(queue.enqueue({ clientId: 'overflow', socketId: 'socket-3', ip: '198.51.100.3' }, 22), { ok: false, reason: 'full' });
  assert.equal(queue.removeBySocket('new').clientId, 'same');
  assert.equal(queue.size, 1);
});

test('ランダム対戦待機列は長時間残ったエントリを回収する', () => {
  const queue = new RandomMatchQueue({ maxAgeMs: 100 });
  queue.enqueue({ clientId: 'old', socketId: 'socket-old', ip: '203.0.113.1' }, 10);
  queue.enqueue({ clientId: 'recent', socketId: 'socket-recent', ip: '203.0.113.2' }, 80);
  assert.equal(queue.prune(111), 1);
  assert.equal(queue.size, 1);
  assert.equal(queue.takeNext().clientId, 'recent');
});

test('接続切れと待機lease切れを区別して回収できる', () => {
  const queue = new RandomMatchQueue({ maxAgeMs: 100 });
  queue.enqueue({ clientId: 'connected', socketId: 'socket-connected', ip: '203.0.113.9' }, 10);
  queue.enqueue({ clientId: 'gone', socketId: 'socket-gone', ip: '203.0.113.10' }, 10);
  const removed = [];
  assert.equal(queue.prune((entry) => entry.socketId === 'socket-connected', 10_000, (entry, reason) => {
    removed.push([entry.clientId, reason]);
  }), 2);
  assert.deepEqual(removed, [['connected', 'expired'], ['gone', 'unavailable']]);
  assert.equal(queue.size, 0);
});
