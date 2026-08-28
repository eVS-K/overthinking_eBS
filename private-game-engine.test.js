'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const { createClassicPrivateCardInstances } = require('./private-card-instances');
const { createClassicPrivateRuleset, createExpandedPrivateRuleset } = require('./private-ruleset');
const { VIRTUAL_BLANK_SELECTION_ID } = require('./private-blank');
const {
  applyPrivateRound,
  assertPrivateGameState,
  createClassicPrivateGameState,
  createExpandedPrivateGameState,
  isTerminalPrivateGameState,
  legalPrivateCardInstanceIds,
  privateMatchScore,
  resolvePrivateRound
} = require('./private-game-engine');

function instanceIdFor(state, seat, definitionId) {
  return state[seat].hand.find((card) => card.definitionId === definitionId)?.instanceId;
}

test('Private基盤のクラシック遷移はcanonical resolveRoundと一致し、入力stateを変更しない', () => {
  for (const first of CARD_DEFINITIONS) {
    for (const second of CARD_DEFINITIONS) {
      const state = createClassicPrivateGameState({ instanceNamespace: `case${first.id}${second.id}` });
      const before = JSON.stringify(state);
      const result = applyPrivateRound(state, instanceIdFor(state, 'p1', first.id), instanceIdFor(state, 'p2', second.id));
      assert.equal(result.canonicalResult, resolveRound(first, second));
      assert.equal(result.state.p1.hand.length, 6);
      assert.equal(result.state.p2.hand.length, 6);
      assert.equal(result.state.p1.score + result.state.p2.score + result.state.stack.length, 2);
      assert.equal(JSON.stringify(state), before);
    }
  }
});

test('引き分けの持ち越し札は次の勝者へ渡り、カード実体IDは一度しか使えない', () => {
  let state = createClassicPrivateGameState({ instanceNamespace: 'stack' });
  const firstP1 = instanceIdFor(state, 'p1', 'joker');
  const firstP2 = instanceIdFor(state, 'p2', 'king');
  state = applyPrivateRound(state, firstP1, firstP2).state;
  assert.equal(state.stack.length, 2);
  const result = applyPrivateRound(state, instanceIdFor(state, 'p1', 'ace'), instanceIdFor(state, 'p2', 'queen'));
  assert.equal(result.winnerSeat, 'p1');
  assert.equal(result.awardedCards, 4);
  assert.equal(result.state.p1.score, 4);
  assert.equal(result.state.stack.length, 0);
  assert.throws(() => applyPrivateRound(result.state, firstP1, instanceIdFor(result.state, 'p2', 'jack')), /not legal/);
});

test('同名コピーはdefinitionIdではなくinstanceId単位で一枚ずつ消費する', () => {
  const rules = createClassicPrivateRuleset();
  const state = {
    rules,
    initialCardsPerSide: 2,
    round: 1,
    p1: { hand: createClassicPrivateCardInstances({ namespace: 'copies', seat: 'p1', definitionIds: ['ace', 'ace'] }), score: 0 },
    p2: { hand: createClassicPrivateCardInstances({ namespace: 'copies', seat: 'p2', definitionIds: ['king', 'king'] }), score: 0 },
    stack: [],
    history: []
  };
  assert.doesNotThrow(() => assertPrivateGameState(state));
  const first = applyPrivateRound(state, 'copies:p1:1', 'copies:p2:1');
  assert.deepEqual(first.state.p1.hand.map((card) => card.instanceId), ['copies:p1:2']);
  assert.deepEqual(first.state.p2.hand.map((card) => card.instanceId), ['copies:p2:2']);
  assert.deepEqual(legalPrivateCardInstanceIds(first.state, 'p1'), ['copies:p1:2']);
  const final = applyPrivateRound(first.state, 'copies:p1:2', 'copies:p2:2');
  assert.equal(final.terminal, true);
  assert.equal(isTerminalPrivateGameState(final.state), true);
  assert.equal(privateMatchScore(final.state), 1);
});

test('保存済みPrivate状態の履歴・持ち越し札が矛盾していれば次の手へ進ませない', () => {
  let state = createClassicPrivateGameState({ instanceNamespace: 'integrity' });
  state = applyPrivateRound(
    state,
    instanceIdFor(state, 'p1', 'joker'),
    instanceIdFor(state, 'p2', 'king')
  ).state;

  const forgedAward = structuredClone(state);
  forgedAward.history[0].awardedCards = 2;
  assert.throws(() => assertPrivateGameState(forgedAward), /history award/);

  const forgedStack = structuredClone(state);
  forgedStack.stack[0].instanceId = forgedStack.p1.hand[0].instanceId;
  assert.throws(() => assertPrivateGameState(forgedStack), /duplicate private card instance/);
});

test('Privateクラシックはスコア到達でも現行どおり即座に終了する', () => {
  let state = createClassicPrivateGameState({ instanceNamespace: 'score' });
  const route = [
    ['ace', 'king'],
    ['queen', 'jack'],
    ['three', 'joker'],
    ['two', 'ace']
  ];
  for (const [p1DefinitionId, p2DefinitionId] of route) {
    state = applyPrivateRound(
      state,
      instanceIdFor(state, 'p1', p1DefinitionId),
      instanceIdFor(state, 'p2', p2DefinitionId)
    ).state;
  }
  assert.equal(state.p1.score, 8);
  assert.equal(state.p1.hand.length, 3);
  assert.doesNotThrow(() => assertPrivateGameState(state));
  const result = applyPrivateRound(state, instanceIdFor(state, 'p1', 'king'), instanceIdFor(state, 'p2', 'queen'));
  assert.equal(result.terminal, true);
  assert.equal(result.state.p1.score, 10);
  assert.equal(result.matchScore, 1);
});

test('クラシックPrivate状態へ追加通常札を注入しても、既存ルールの境界で拒否する', () => {
  const state = createClassicPrivateGameState({ instanceNamespace: 'classic-injection' });
  state.p1.hand[0].definitionId = 'ten';
  assert.throws(() => assertPrivateGameState(state), /unknown private card definition/);
});

test('拡張Privateは追加通常札をcanonical比較へ接続し、総ラウンド数で終了できる', () => {
  const rules = createExpandedPrivateRuleset({ roundLimit: 3, scoreTarget: null });
  const state = createExpandedPrivateGameState({
    rules,
    instanceNamespace: 'expanded-round-limit',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'ten', copies: 1 },
      { definitionId: 'nine', copies: 1 },
      { definitionId: 'eight', copies: 1 }
    ]
  });
  assert.equal(resolvePrivateRound(
    { definitionId: 'ten' },
    { definitionId: 'nine' }
  ), 'p1');
  let next = applyPrivateRound(state, instanceIdFor(state, 'p1', 'ten'), instanceIdFor(state, 'p2', 'nine')).state;
  next = applyPrivateRound(next, instanceIdFor(next, 'p1', 'ace'), instanceIdFor(next, 'p2', 'king')).state;
  const result = applyPrivateRound(next, instanceIdFor(next, 'p1', 'eight'), instanceIdFor(next, 'p2', 'ten'));
  assert.equal(result.terminal, true);
  assert.equal(result.terminalReason, 'round-limit');
  assert.equal(result.state.p1.hand.length, 2);
  assert.equal(result.matchScore, 1);
});

test('拡張Privateの即時勝利は設定された獲得枚数で終了し、凍結済みデッキの改ざんを拒否する', () => {
  const state = createExpandedPrivateGameState({
    rules: createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: 2 }),
    instanceNamespace: 'expanded-score-target',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  });
  const result = applyPrivateRound(state, instanceIdFor(state, 'p1', 'ace'), instanceIdFor(state, 'p2', 'ten'));
  assert.equal(result.terminal, true);
  assert.equal(result.terminalReason, 'score-target');
  assert.equal(result.state.p1.score, 2);
  assert.equal(result.state.p1.hand.length, 4);

  const forged = structuredClone(result.state);
  forged.deck[0].copies = 2;
  assert.throws(() => assertPrivateGameState(forged), /deck snapshot|deck does not match/);
});

test('有効なBlankは手札を消費せず、相手が勝っても仮想札そのものを獲得させない', () => {
  const state = createExpandedPrivateGameState({
    rules: createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: null, blankEnabled: true }),
    instanceNamespace: 'blank-win',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  });
  assert.equal(legalPrivateCardInstanceIds(state, 'p1').includes(VIRTUAL_BLANK_SELECTION_ID), true);
  const result = applyPrivateRound(state, VIRTUAL_BLANK_SELECTION_ID, instanceIdFor(state, 'p2', 'ace'));
  assert.equal(result.canonicalResult, 'p2');
  assert.equal(result.awardedCards, 1);
  assert.equal(result.state.p1.hand.length, 5);
  assert.equal(result.state.p2.hand.length, 4);
  assert.equal(result.state.p2.score, 1);
  assert.equal(result.state.stack.length, 0);
  assert.equal(result.p1Card.virtual, true);
  assert.doesNotThrow(() => assertPrivateGameState(result.state));
});

test('BlankとJokerの引き分けは実カードだけを持ち越し、次の勝者がその一枚を得る', () => {
  const state = createExpandedPrivateGameState({
    rules: createExpandedPrivateRuleset({ roundLimit: 3, scoreTarget: null, blankEnabled: true }),
    instanceNamespace: 'blank-draw',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'joker', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  });
  const draw = applyPrivateRound(state, VIRTUAL_BLANK_SELECTION_ID, instanceIdFor(state, 'p2', 'joker'));
  assert.equal(draw.canonicalResult, 'draw');
  assert.equal(draw.state.stack.length, 1);
  const win = applyPrivateRound(
    draw.state,
    instanceIdFor(draw.state, 'p1', 'ace'),
    instanceIdFor(draw.state, 'p2', 'king')
  );
  assert.equal(win.awardedCards, 3);
  assert.equal(win.state.p1.score, 3);
  assert.equal(win.state.stack.length, 0);
});

test('Blankが無効な拡張設定では、仮想Blankを選択・確定できない', () => {
  const state = createExpandedPrivateGameState({
    rules: createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: null, blankEnabled: false }),
    instanceNamespace: 'blank-disabled',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'ten', copies: 1 }
    ]
  });
  assert.equal(legalPrivateCardInstanceIds(state, 'p1').includes(VIRTUAL_BLANK_SELECTION_ID), false);
  assert.throws(() => applyPrivateRound(state, VIRTUAL_BLANK_SELECTION_ID, instanceIdFor(state, 'p2', 'ace')), /not legal/);
});

test('条件型Tarotの強さは履歴へ確定保存され、改ざんされた強さは次の手の前に拒否される', () => {
  const rules = createExpandedPrivateRuleset({ roundLimit: 5, scoreTarget: null });
  let state = createExpandedPrivateGameState({
    rules,
    instanceNamespace: 'conditional-tarot',
    deck: [
      { definitionId: 'ace', copies: 1 },
      { definitionId: 'king', copies: 1 },
      { definitionId: 'queen', copies: 1 },
      { definitionId: 'jack', copies: 1 },
      { definitionId: 'death', copies: 1 }
    ]
  });
  const first = applyPrivateRound(
    state,
    instanceIdFor(state, 'p1', 'death'),
    instanceIdFor(state, 'p2', 'ace')
  );
  assert.equal(first.canonicalResult, 'p2');
  assert.equal(first.p1Strength, 13);
  assert.equal(first.p2Strength, 14);
  state = first.state;

  const second = applyPrivateRound(
    state,
    instanceIdFor(state, 'p1', 'ace'),
    instanceIdFor(state, 'p2', 'death')
  );
  assert.equal(second.canonicalResult, 'p1');
  assert.equal(second.p1Strength, 14);
  assert.equal(second.p2Strength, 0);

  const forged = structuredClone(second.state);
  forged.history[0].p1Strength = 0;
  assert.throws(() => assertPrivateGameState(forged), /history strength/);
});
