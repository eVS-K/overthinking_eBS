'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPresentationEventQueue,
  normalizeEvent,
  prefersReducedMotion
} = require('./presentation-events');

test('表示イベントは安全な識別情報だけを保持し、任意payloadを保存しない', () => {
  const normalized = normalizeEvent({
    id: 'round:room-1:4',
    kind: 'round-reveal',
    priority: 60,
    exclusive: false,
    payload: { hiddenCard: 'the-emperor', nonce: 'never-store-this' }
  });

  assert.deepEqual(normalized, {
    id: 'round:room-1:4',
    kind: 'round-reveal',
    priority: 60,
    exclusive: false
  });
  assert.equal(normalizeEvent({ id: '', kind: 'round-reveal' }), null);
  assert.equal(normalizeEvent({ id: 'round:1', kind: '' }), null);
});

test('同一scopeの公開イベントは一度だけ演出する', () => {
  const queue = createPresentationEventQueue();
  assert.equal(queue.beginScope('pvp:room-a:1').changed, true);

  const first = queue.claim({ id: 'round:1', kind: 'round-reveal', priority: 60 });
  const duplicate = queue.claim({ id: 'round:1', kind: 'round-reveal', priority: 60 });

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(queue.inspect().seen.length, 1);
});

test('初期hydrateは既存結果を記録するだけで再演出しない', () => {
  const queue = createPresentationEventQueue();
  queue.beginScope('pvp:room-a:1');

  const hydrated = queue.claim(
    { id: 'round:3', kind: 'round-reveal', priority: 60 },
    { animate: false }
  );
  const laterRedraw = queue.claim({ id: 'round:3', kind: 'round-reveal', priority: 60 });

  assert.equal(hydrated.accepted, false);
  assert.equal(hydrated.reason, 'hydrated');
  assert.equal(laterRedraw.reason, 'duplicate');
});

test('終局は排他的に低優先度の公開・効果演出を抑止する', () => {
  const queue = createPresentationEventQueue();
  queue.beginScope('pvp:room-a:1');

  const final = queue.claim({ id: 'final:1', kind: 'match-final', priority: 100, exclusive: true });
  const round = queue.claim({ id: 'round:7', kind: 'round-reveal', priority: 60 });
  const effect = queue.claim({ id: 'effect:7', kind: 'round-effect', priority: 40 });

  assert.equal(final.accepted, true);
  assert.equal(round.accepted, false);
  assert.equal(round.reason, 'suppressed');
  assert.equal(effect.accepted, false);
  assert.equal(queue.isBlocked(60), true);
});

test('新しいゲームscopeでは前ゲームの終局抑止を持ち越さない', () => {
  const queue = createPresentationEventQueue();
  queue.beginScope('pvp:room-a:1');
  queue.claim({ id: 'final:1', kind: 'match-final', priority: 100, exclusive: true });

  assert.equal(queue.beginScope('pvp:room-a:2').changed, true);
  const firstRound = queue.claim({ id: 'round:1', kind: 'round-reveal', priority: 60 });

  assert.equal(firstRound.accepted, true);
  assert.equal(queue.inspect().exclusivePriority, -1);
});

test('動きを抑える設定では演出だけを止め、公開状態の観測契約は保てる', () => {
  assert.equal(prefersReducedMotion({
    matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' })
  }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error('unsupported'); } }), false);

  const queue = createPresentationEventQueue();
  queue.beginScope('pvp:room-a:1');
  const reduced = queue.claim(
    { id: 'round:1', kind: 'round-reveal', priority: 60 },
    { animate: false }
  );

  assert.equal(reduced.accepted, false);
  assert.equal(reduced.observed, true);
  assert.equal(reduced.reason, 'hydrated');
});
