'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPrivateCardRoundPreview,
  resolvePrivateRoundWithContext
} = require('./private-card-effects');

function state({ round = 1, p1Score = 0, p2Score = 0, stackCount = 0 } = {}) {
  return {
    round,
    p1: { score: p1Score },
    p2: { score: p2Score },
    stack: Array.from({ length: stackCount })
  };
}

const card = (definitionId) => ({ definitionId });

test('条件型Tarotの強さはラウンド開始時の局面だけから決まり、状態を変更しない', () => {
  const behind = state({ round: 3, p1Score: 2, p2Score: 4, stackCount: 2 });
  const before = JSON.stringify(behind);
  assert.equal(getPrivateCardRoundPreview(behind, 'p1', card('death')).displayStrength, 13);
  assert.equal(getPrivateCardRoundPreview(behind, 'p1', card('temperance')).displayStrength, 14);
  assert.equal(getPrivateCardRoundPreview(behind, 'p1', card('the-devil')).displayStrength, 15);
  assert.equal(getPrivateCardRoundPreview(behind, 'p1', card('the-tower')).displayStrength, 6);
  assert.equal(JSON.stringify(behind), before);

  const ahead = state({ round: 4, p1Score: 5, p2Score: 1, stackCount: 0 });
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('death')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('temperance')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('the-devil')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('the-tower')).displayStrength, 8);
});

test('Jokerは条件型Tarotで確定した強さをコピーし、既存のThree対Joker例外を保つ', () => {
  const devilRound = resolvePrivateRoundWithContext(
    state({ stackCount: 1 }),
    card('joker'),
    card('the-devil')
  );
  assert.equal(devilRound.p1.resolvedStrength, 15);
  assert.equal(devilRound.p2.resolvedStrength, 15);
  assert.equal(devilRound.canonicalResult, 'draw');

  const threeRound = resolvePrivateRoundWithContext(
    state({ stackCount: 1 }),
    card('three'),
    card('joker')
  );
  assert.equal(threeRound.p1.resolvedStrength, 3);
  assert.equal(threeRound.p2.resolvedStrength, 3);
  assert.equal(threeRound.canonicalResult, 'p1');
});
