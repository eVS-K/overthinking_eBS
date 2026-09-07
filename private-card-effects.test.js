'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHARIOT_THRESHOLD_UNITS,
  STRENGTH_SCALE,
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
  assert.equal(getPrivateCardRoundPreview(behind, 'p1', card('strength')).displayStrength, 3);
  assert.equal(JSON.stringify(behind), before);

  const ahead = state({ round: 4, p1Score: 5, p2Score: 1, stackCount: 0 });
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('death')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('temperance')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('the-devil')).displayStrength, 0);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('the-tower')).displayStrength, 8);
  assert.equal(getPrivateCardRoundPreview(ahead, 'p1', card('strength')).displayStrength, '7.5');
});

test('Strengthは整数の半分単位で計算し、Jokerは確定した強さをコピーする', () => {
  const preview = getPrivateCardRoundPreview(
    state({ p1Score: 3 }),
    'p1',
    card('strength')
  );
  assert.equal(STRENGTH_SCALE, 2);
  assert.equal(preview.comparisonStrengthUnits, 9);
  assert.equal(preview.displayStrength, '4.5');

  const strengthRound = resolvePrivateRoundWithContext(
    state({ p2Score: 3 }),
    card('joker'),
    card('strength')
  );
  assert.equal(strengthRound.p1.resolvedStrengthUnits, 9);
  assert.equal(strengthRound.p2.resolvedStrengthUnits, 9);
  assert.equal(strengthRound.p1.resolvedStrength, '4.5');
  assert.equal(strengthRound.canonicalResult, 'draw');
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

test('The Chariotは相手の確定強さが15以上なら数値比較より先に勝つ', () => {
  const againstDevil = resolvePrivateRoundWithContext(
    state({ stackCount: 1 }),
    card('the-chariot'),
    card('the-devil')
  );
  assert.equal(CHARIOT_THRESHOLD_UNITS, 30);
  assert.equal(againstDevil.p2.resolvedStrengthUnits, 30);
  assert.equal(againstDevil.canonicalResult, 'p1');

  const againstTower = resolvePrivateRoundWithContext(
    state({ round: 8 }),
    card('the-chariot'),
    card('the-tower')
  );
  assert.equal(againstTower.p2.resolvedStrengthUnits, 32);
  assert.equal(againstTower.canonicalResult, 'p1');

  const againstAce = resolvePrivateRoundWithContext(
    state(),
    card('the-chariot'),
    card('ace')
  );
  assert.equal(againstAce.canonicalResult, 'p2');
});

test('The Foolは直前の実カードをこの局面で引き継ぎ、The Hermitは対象選択Tarotを反響しない', () => {
  const afterInteractiveTarot = {
    ...state({ round: 2 }),
    history: [{
      p1Card: card('the-high-priestess'),
      p2Card: card('the-star'),
      p1Strength: 2,
      p2Strength: 17,
      p1EchoProfile: { resolvedStrengthUnits: 4, comparisonOverride: '', safePostEffectId: '' },
      p2EchoProfile: { resolvedStrengthUnits: 34, comparisonOverride: '', safePostEffectId: '' }
    }]
  };
  const fool = getPrivateCardRoundPreview(afterInteractiveTarot, 'p1', card('the-fool'));
  const hermit = getPrivateCardRoundPreview(afterInteractiveTarot, 'p1', card('the-hermit'));
  assert.equal(fool.displayStrength, 2);
  assert.equal(fool.behaviorDefinitionId, 'the-high-priestess');
  assert.match(fool.conditionDetail, /The High Priestess として/);
  assert.equal(hermit.displayStrength, 0);
  assert.match(hermit.conditionDetail, /反響できる直前の実カードがない/);
});

test('The FoolがJokerを引き継ぐと、直前の値ではなく今の相手の強さをコピーする', () => {
  const afterJoker = {
    ...state({ round: 2 }),
    history: [{
      p1Card: card('joker'),
      p2Card: card('king'),
      p1Strength: 13,
      p2Strength: 13,
      p1EchoProfile: { resolvedStrengthUnits: 26, comparisonOverride: '', safePostEffectId: '' }
    }]
  };
  const fool = getPrivateCardRoundPreview(afterJoker, 'p1', card('the-fool'));
  assert.equal(fool.behaviorDefinitionId, 'joker');
  assert.equal(fool.displayStrength, null);

  const round = resolvePrivateRoundWithContext(
    afterJoker,
    card('the-fool'),
    card('ace')
  );
  assert.equal(round.p1.resolvedStrength, 14);
  assert.equal(round.p2.resolvedStrength, 14);
  assert.equal(round.canonicalResult, 'draw');
});
