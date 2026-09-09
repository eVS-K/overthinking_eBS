'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExpandedPrivateRuleset } = require('./private-ruleset');
const { VIRTUAL_BLANK_SELECTION_ID } = require('./private-blank');
const {
  applyAdvancedTargetAction,
  applyPrivateRound,
  applySunPreCommitAction,
  assertPrivateGameState,
  beginAdvancedPrivateRound,
  createExpandedPrivateGameState,
  finalizeAdvancedPrivateRound,
  isCardLocked,
  isNoiseCard,
  legalPrivateCardInstanceIds,
  skipAdvancedTargetAction
} = require('./private-game-engine');

function idFor(state, seat, definitionId) {
  const card = state[seat].hand.find((candidate) => candidate.definitionId === definitionId);
  assert.ok(card, `${seat} must hold ${definitionId}`);
  return card.instanceId;
}

function makeState(namespace, definitionIds, {
  blankEnabled = false,
  roundLimit = definitionIds.length,
  scoreTarget = null
} = {}) {
  return createExpandedPrivateGameState({
    instanceNamespace: namespace,
    rules: createExpandedPrivateRuleset({ roundLimit, scoreTarget, blankEnabled }),
    deck: definitionIds.map((definitionId) => ({ definitionId, copies: 1 }))
  });
}

function finalizeStarted(started, choices = []) {
  let state = started.state;
  started.targetActions.forEach((action, index) => {
    const target = choices[index] ?? action.candidates[0];
    assert.notEqual(target, undefined, `action ${action.type} requires a deterministic target`);
    state = applyAdvancedTargetAction(state, action, target).state;
  });
  return finalizeAdvancedPrivateRound(state);
}

test('The FoolとThe Hermitは直前の実カードとして振る舞い、現在の局面で強さを解決する', () => {
  let foolState = makeState('advanced-fool', ['joker', 'ace', 'king', 'the-fool', 'the-hermit']);
  foolState = applyPrivateRound(foolState, idFor(foolState, 'p1', 'joker'), idFor(foolState, 'p2', 'king')).state;
  const fool = applyPrivateRound(foolState, idFor(foolState, 'p1', 'the-fool'), idFor(foolState, 'p2', 'ace'));
  assert.equal(fool.p1Strength, 14);
  assert.equal(fool.canonicalResult, 'draw');
  assert.equal(fool.state.history[1].p1EchoProfile, null);
  assert.doesNotThrow(() => assertPrivateGameState(fool.state));

  let hermitState = makeState('advanced-hermit', ['ace', 'king', 'queen', 'death', 'the-hermit']);
  hermitState = applyPrivateRound(hermitState, idFor(hermitState, 'p1', 'ace'), idFor(hermitState, 'p2', 'death')).state;
  assert.equal(hermitState.p1.score, 2);
  const hermit = applyPrivateRound(hermitState, idFor(hermitState, 'p1', 'the-hermit'), idFor(hermitState, 'p2', 'king'));
  assert.equal(hermit.p1Strength, 0, 'Hermit must re-evaluate the copied Death in the current score state');
  assert.equal(hermit.winnerSeat, 'p2');
  assert.doesNotThrow(() => assertPrivateGameState(hermit.state));
});

test('The Emperor はTarotへ先に勝利し、両者なら引き分け、通常札には強さ0で参加する', () => {
  const againstTarot = makeState('advanced-emperor-tarot', ['the-emperor', 'death', 'ace', 'king', 'queen']);
  const forcedWin = applyPrivateRound(
    againstTarot,
    idFor(againstTarot, 'p1', 'the-emperor'),
    idFor(againstTarot, 'p2', 'death')
  );
  assert.equal(forcedWin.winnerSeat, 'p1');
  assert.equal(forcedWin.state.history[0].effects.length, 0);
  assert.doesNotThrow(() => assertPrivateGameState(forcedWin.state));

  const both = makeState('advanced-emperor-both', ['the-emperor', 'ace', 'king', 'queen', 'jack']);
  const emperorDraw = applyPrivateRound(both, idFor(both, 'p1', 'the-emperor'), idFor(both, 'p2', 'the-emperor'));
  assert.equal(emperorDraw.canonicalResult, 'draw');
  assert.equal(emperorDraw.state.stack.length, 2);

  const againstNormal = makeState('advanced-emperor-normal', ['the-emperor', 'ace', 'king', 'queen', 'jack']);
  const normalComparison = applyPrivateRound(
    againstNormal,
    idFor(againstNormal, 'p1', 'the-emperor'),
    idFor(againstNormal, 'p2', 'ace')
  );
  assert.equal(normalComparison.winnerSeat, 'p2');
});

test('The Empress と Justice のロックはBlankを残し、対象操作は一回だけ解決される', () => {
  const empressState = makeState('advanced-empress', ['the-empress', 'ace', 'king', 'queen', 'jack'], { blankEnabled: true });
  const empress = applyPrivateRound(
    empressState,
    idFor(empressState, 'p1', 'the-empress'),
    VIRTUAL_BLANK_SELECTION_ID
  );
  const p2NonTarot = empress.state.p2.hand.filter((card) => card.definitionId !== 'the-empress');
  assert.ok(p2NonTarot.every(isCardLocked));
  assert.equal(isCardLocked(empress.state.p2.hand.find((card) => card.definitionId === 'the-empress')), false);
  assert.equal(legalPrivateCardInstanceIds(empress.state, 'p2').includes(VIRTUAL_BLANK_SELECTION_ID), true);

  const justiceState = makeState('advanced-justice', ['justice', 'ace', 'king', 'queen', 'jack'], { blankEnabled: true });
  const started = beginAdvancedPrivateRound(
    justiceState,
    idFor(justiceState, 'p1', 'justice'),
    VIRTUAL_BLANK_SELECTION_ID
  );
  assert.equal(started.targetActions.length, 1);
  const action = started.targetActions[0];
  const target = action.candidates.find((candidate) => candidate === idFor(justiceState, 'p2', 'ace'));
  const resolved = applyAdvancedTargetAction(started.state, action, target);
  assert.equal(isCardLocked(resolved.state.p2.hand.find((card) => card.instanceId === target)), true);
  assert.throws(() => applyAdvancedTargetAction(resolved.state, action, target), /already been resolved/);
  const justice = finalizeAdvancedPrivateRound(resolved.state);
  assert.doesNotThrow(() => assertPrivateGameState(justice.state));
});

test('敗北時のコピーTarotは対象候補だけを使い、生成札は一回だけ増える', () => {
  const highPriestessState = makeState('advanced-priestess', ['the-high-priestess', 'ace', 'king', 'queen', 'jack']);
  const highPriestessStart = beginAdvancedPrivateRound(
    highPriestessState,
    idFor(highPriestessState, 'p1', 'the-high-priestess'),
    idFor(highPriestessState, 'p2', 'ace')
  );
  const priestessAction = highPriestessStart.targetActions[0];
  assert.equal(priestessAction.type, 'copy-opponent-hand');
  const priestess = finalizeStarted(highPriestessStart, [idFor(highPriestessState, 'p2', 'king')]);
  const priestessCopies = priestess.state.p1.hand.filter((card) => card.definitionId === 'king');
  assert.equal(priestessCopies.length, 2);
  assert.equal(priestessCopies.some((card) => card.state.generated === true), true);

  const hierophantState = makeState('advanced-hierophant', ['the-hierophant', 'ace', 'king', 'queen', 'jack']);
  const hierophantStart = beginAdvancedPrivateRound(
    hierophantState,
    idFor(hierophantState, 'p1', 'the-hierophant'),
    idFor(hierophantState, 'p2', 'ace')
  );
  assert.equal(hierophantStart.targetActions[0].type, 'copy-own-hand');
  const hierophant = finalizeStarted(hierophantStart, [idFor(hierophantState, 'p1', 'king')]);
  assert.equal(hierophant.state.p1.hand.filter((card) => card.definitionId === 'king').length, 2);
  assert.doesNotThrow(() => assertPrivateGameState(hierophant.state));
});

test('The Hanged Man と The Star は凍結デッキ内だけを生成し、Starは所有者以外へノイズ化する', () => {
  const hangedState = makeState('advanced-hanged', ['the-hanged-man', 'ace', 'king', 'queen', 'jack']);
  const hangedStart = beginAdvancedPrivateRound(
    hangedState,
    idFor(hangedState, 'p1', 'the-hanged-man'),
    idFor(hangedState, 'p2', 'ace')
  );
  const hanged = finalizeStarted(hangedStart, ['king']);
  assert.equal(hanged.state.p2.hand.filter((card) => card.definitionId === 'king').length, 2);

  const starState = makeState('advanced-star', ['the-star', 'the-sun', 'ace', 'king', 'queen']);
  const sun = applySunPreCommitAction(
    starState,
    'p2',
    idFor(starState, 'p2', 'the-sun'),
    idFor(starState, 'p2', 'ace')
  );
  const starStart = beginAdvancedPrivateRound(
    starState,
    idFor(starState, 'p1', 'the-star'),
    idFor(starState, 'p2', 'the-sun'),
    { preCommitEffects: [sun.effect] }
  );
  assert.equal(starStart.targetActions[0].type, 'opponent-choose-noise');
  const star = finalizeStarted(starStart, ['king']);
  const noise = star.state.p2.hand.find((card) => card.definitionId === 'king' && isNoiseCard(card));
  assert.ok(noise);
  assert.equal(noise.state.generated, true);
  assert.doesNotThrow(() => assertPrivateGameState(star.state));
});

test('The Moon、The Sun、Judgement、The World は獲得札・破棄札・履歴の上限を保つ', () => {
  let moonState = makeState('advanced-moon', ['the-moon', 'the-sun', 'ace', 'king', 'queen']);
  moonState = applyPrivateRound(moonState, idFor(moonState, 'p1', 'ace'), idFor(moonState, 'p2', 'king')).state;
  const sunEffect = applySunPreCommitAction(
    moonState,
    'p2',
    idFor(moonState, 'p2', 'the-sun'),
    idFor(moonState, 'p2', 'ace')
  );
  const moonStart = beginAdvancedPrivateRound(
    moonState,
    idFor(moonState, 'p1', 'the-moon'),
    idFor(moonState, 'p2', 'the-sun'),
    { preCommitEffects: [sunEffect.effect] }
  );
  const moon = finalizeStarted(moonStart);
  assert.equal(moon.state.p1.score, 0);
  assert.ok(moon.state.discardPile.some((entry) => entry.reason === 'moon'));

  const sunState = makeState('advanced-sun', ['the-sun', 'ace', 'king', 'queen', 'jack']);
  assert.throws(() => beginAdvancedPrivateRound(
    sunState, idFor(sunState, 'p1', 'the-sun'), idFor(sunState, 'p2', 'king')
  ), /requires a pre-commit target/);
  const preparedSun = applySunPreCommitAction(
    sunState, 'p1', idFor(sunState, 'p1', 'the-sun'), idFor(sunState, 'p1', 'ace')
  );
  assert.equal(preparedSun.state.p1.hand.length, sunState.p1.hand.length);
  const sun = finalizeStarted(beginAdvancedPrivateRound(
    sunState, idFor(sunState, 'p1', 'the-sun'), idFor(sunState, 'p2', 'king'),
    { preCommitEffects: [preparedSun.effect] }
  ));
  assert.equal(sun.state.discardPile.filter((entry) => entry.reason === 'sun').length, 1);

  let judgementState = makeState('advanced-judgement', ['judgement', 'ace', 'king', 'queen', 'two']);
  judgementState = applyPrivateRound(judgementState, idFor(judgementState, 'p1', 'ace'), idFor(judgementState, 'p2', 'king')).state;
  const judgement = applyPrivateRound(
    judgementState, idFor(judgementState, 'p1', 'judgement'), idFor(judgementState, 'p2', 'two')
  );
  assert.equal(judgement.state.p1.hand.filter((card) => card.definitionId === 'ace').length, 1);
  assert.equal(judgement.effects.find((effect) => effect.type === 'copy-played-history').cardInstanceIds.length, 1);

  let worldState = makeState('advanced-world', ['the-world', 'ace', 'king', 'queen', 'four']);
  worldState = applyPrivateRound(worldState, idFor(worldState, 'p1', 'king'), idFor(worldState, 'p2', 'ace')).state;
  assert.equal(worldState.p2.score, 2);
  const worldStart = beginAdvancedPrivateRound(
    worldState, idFor(worldState, 'p1', 'the-world'), idFor(worldState, 'p2', 'four')
  );
  assert.equal(worldStart.targetActions[0].type, 'transfer-won-card');
  const world = finalizeStarted(worldStart, [worldStart.targetActions[0].candidates[0]]);
  // The World removes one of the two *previous* acquired cards. The opponent
  // still won this round with Four and therefore keeps the two current cards.
  assert.equal(world.state.p2.score, 3);
  assert.equal(world.state.p1.hand.filter((card) => card.definitionId === 'ace').length, 1);
  assert.doesNotThrow(() => assertPrivateGameState(world.state));
});

test('高度な履歴では勝敗スナップショット、対象計画、カード状態の改ざんを拒否する', () => {
  const initial = makeState('advanced-integrity', ['justice', 'ace', 'king', 'queen', 'jack'], { blankEnabled: true });
  const started = beginAdvancedPrivateRound(
    initial, idFor(initial, 'p1', 'justice'), VIRTUAL_BLANK_SELECTION_ID
  );
  const done = finalizeStarted(started, [started.targetActions[0].candidates[0]]).state;
  const forgedStrength = structuredClone(done);
  forgedStrength.history[0].p1Strength = 99;
  assert.throws(() => assertPrivateGameState(forgedStrength), /canonical rules/);

  const forgedPlan = structuredClone(done);
  forgedPlan.history[0].resolvedActionKeys.push('unexpected');
  assert.throws(() => assertPrivateGameState(forgedPlan), /resolved action ledger/);

  const forgedLock = structuredClone(done);
  forgedLock.p2.hand[0].state.locks.push({ id: 'forged', releaseAfterRound: 99 });
  forgedLock.p2.hand[0].state.locked = true;
  assert.throws(() => assertPrivateGameState(forgedLock), /private card lock is invalid|round does not match|card state is not canonical|advanced private/);

  const forgedGeneratedFlag = structuredClone(done);
  forgedGeneratedFlag.history[0].p1Card.state.generated = true;
  assert.throws(() => assertPrivateGameState(forgedGeneratedFlag), /advanced private history card is invalid|card state is not canonical/);
});

test('期限切れなどで対象選択を飛ばしても、その操作だけを一度安全に完了できる', () => {
  const state = makeState('advanced-skip-action', ['the-high-priestess', 'ace', 'king', 'queen', 'jack']);
  const started = beginAdvancedPrivateRound(
    state,
    idFor(state, 'p1', 'the-high-priestess'),
    idFor(state, 'p2', 'ace')
  );
  const [action] = started.targetActions;
  assert.equal(action.type, 'copy-opponent-hand');

  const skipped = skipAdvancedTargetAction(started.state, action, 'timeout');
  assert.deepEqual(skipped.record.effects.at(-1), {
    type: 'skipped-target-action',
    advanced: true,
    sourceSeat: 'p1',
    sourceDefinitionId: 'the-high-priestess',
    actionKey: action.actionKey,
    reason: 'timeout'
  });
  assert.equal(skipped.record.resolvedActionKeys.includes(action.actionKey), true);
  assert.throws(() => skipAdvancedTargetAction(skipped.state, action, 'duplicate'), /cannot be skipped/);

  const completed = finalizeAdvancedPrivateRound(skipped.state);
  assert.doesNotThrow(() => assertPrivateGameState(completed.state));
});

test('決着した高度ラウンドは対象効果を待たず、計画を監査可能なskipとして一度だけ完了する', () => {
  const state = makeState(
    'advanced-terminal-before-target',
    ['justice', 'four', 'ace', 'king', 'queen'],
    { scoreTarget: 2 }
  );
  const started = beginAdvancedPrivateRound(
    state,
    idFor(state, 'p1', 'justice'),
    idFor(state, 'p2', 'four')
  );

  // Justice normally produces a target picker. Winning the two cards reaches
  // the configured score target, so no player may be kept in an effect UI.
  assert.equal(started.terminalReasonBeforeTargetActions, 'score-target');
  assert.equal(started.skippedTargetActionCount, 1);
  assert.deepEqual(started.targetActions, []);
  assert.equal(started.record.actionPlan.length, 1);
  assert.deepEqual(started.record.resolvedActionKeys, [started.record.actionPlan[0].actionKey]);
  assert.deepEqual(started.record.effects.at(-1), {
    type: 'skipped-target-action',
    advanced: true,
    sourceSeat: 'p1',
    sourceDefinitionId: 'justice',
    actionKey: started.record.actionPlan[0].actionKey,
    reason: 'game-ended-before-target-selection'
  });

  const finalized = finalizeAdvancedPrivateRound(started.state);
  assert.equal(finalized.terminal, true);
  assert.equal(finalized.terminalReason, 'score-target');
  assert.doesNotThrow(() => assertPrivateGameState(finalized.state));
});
