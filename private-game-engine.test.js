'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const { createClassicPrivateCardInstances } = require('./private-card-instances');
const { createClassicPrivateRuleset } = require('./private-ruleset');
const {
  applyPrivateRound,
  assertPrivateGameState,
  createClassicPrivateGameState,
  isTerminalPrivateGameState,
  legalPrivateCardInstanceIds,
  privateMatchScore
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
