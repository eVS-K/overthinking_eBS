'use strict';

/**
 * Read-only, player-facing glossary for the Private expansion.
 *
 * Game mechanics stay in the server-side engine. This module only derives
 * which explanations belong to a frozen expanded deck, so the browser never
 * has to guess a rule from a translated card description.
 */
const { EXPANDED_PRIVATE_RULESET_ID } = require('./private-ruleset');
const { getPrivateCardDefinition } = require('./private-card-definitions');

const PRIVATE_RULE_CONCEPTS = Object.freeze({
  'conditional-strength': Object.freeze({
    id: 'conditional-strength',
    order: 5,
    title: '状況で変わる強さ',
    description: '一部のTarotは、得点・ラウンド・持ち越し札など現在の局面によって強さが変化します。'
  }),
  'ability-echo': Object.freeze({
    id: 'ability-echo',
    order: 10,
    title: '能力をコピー',
    description: 'The Foolは自分の直前の実カードとして、このラウンドの強さ・能力を引き継ぎます。The Hermitは直前ラウンドで確定した強さと、安全な勝敗判定能力だけを反響します。札は増えません。'
  }),
  'card-duplication': Object.freeze({
    id: 'card-duplication',
    order: 20,
    title: 'カードを複製',
    description: '指定された札と同じ種類の新しい札を手札へ作ります。元札のロックやノイズ状態は引き継ぎません。'
  }),
  'card-addition': Object.freeze({
    id: 'card-addition',
    order: 30,
    title: 'カードを追加',
    description: '能力で決まった種類の新しい札を手札へ加えます。手札・総札の上限では増えない場合があります。'
  }),
  lock: Object.freeze({
    id: 'lock',
    order: 40,
    title: 'ロック',
    description: 'ロックされた札は、対象プレイヤーの次のラウンドが終わるまで選べません。Blankが有効なら代わりに選べます。'
  }),
  'destroy-discard': Object.freeze({
    id: 'destroy-discard',
    order: 50,
    title: '破壊・破棄',
    description: '対象札を破棄札へ移します。破棄された札は、この対局中には戻りません。'
  }),
  noise: Object.freeze({
    id: 'noise',
    order: 60,
    title: 'ノイズ',
    description: 'ノイズ札の正体は所有者だけに見えます。出した時点で全員へ公開されます。'
  }),
  'round-limit-change': Object.freeze({
    id: 'round-limit-change',
    order: 70,
    title: '総ラウンド数の変更',
    description: '能力により、この対局の残りラウンド数が増減することがあります。'
  }),
  'tarot-negation': Object.freeze({
    id: 'tarot-negation',
    order: 80,
    title: 'Tarot効果の無効化',
    description: 'The EmperorはTarotとの勝負で優先し、対象Tarotのこのラウンド由来の効果を無効化します。'
  }),
  'won-pile-operation': Object.freeze({
    id: 'won-pile-operation',
    order: 90,
    title: '獲得札への操作',
    description: '能力が獲得済みの札を破棄または参照することがあります。得点は残っている獲得札の枚数です。'
  }),
  'target-selection': Object.freeze({
    id: 'target-selection',
    order: 100,
    title: '対象選択',
    description: '対象が必要な能力では、盤面上で候補の札を選び、その後に確定します。対象を選ぶ時間は30秒です。'
  }),
  blank: Object.freeze({
    id: 'blank',
    order: 110,
    title: 'Blank',
    description: '手札を消費しない仮想札です。選択できない札しかないときにも使え、時間切れ時の候補にも含まれます。'
  })
});

function isDeckEntryInUse(entry) {
  return entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && typeof entry.definitionId === 'string'
    && Number.isSafeInteger(entry.copies)
    && entry.copies > 0;
}

/**
 * Builds a deterministic, immutable glossary for one frozen room config.
 * Invalid or retired definitions are ignored rather than letting a stale
 * room config invent client-visible rules.
 */
function getPrivateRuleConceptsForDeck({ ruleset, deck, blankEnabled = false } = {}) {
  if (ruleset !== EXPANDED_PRIVATE_RULESET_ID || !Array.isArray(deck)) {
    return Object.freeze([]);
  }
  const conceptIds = new Set();
  for (const entry of deck) {
    if (!isDeckEntryInUse(entry)) continue;
    let definition;
    try {
      definition = getPrivateCardDefinition(entry.definitionId);
    } catch {
      continue;
    }
    if (definition.status !== 'available' || !definition.availability.includes(ruleset)) continue;
    for (const conceptId of definition.ruleConceptIds || []) {
      if (Object.hasOwn(PRIVATE_RULE_CONCEPTS, conceptId)) conceptIds.add(conceptId);
    }
  }
  if (blankEnabled === true) conceptIds.add('blank');
  return Object.freeze([...conceptIds]
    .map((conceptId) => PRIVATE_RULE_CONCEPTS[conceptId])
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)));
}

module.exports = {
  PRIVATE_RULE_CONCEPTS,
  getPrivateRuleConceptsForDeck
};
