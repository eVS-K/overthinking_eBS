'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('PvPの最終結果パネルは空いた手札領域を使い、新しい終局だけをライブ通知する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="final-result-panel"[^>]*role="region"[^>]*aria-live="off"/);
  assert.ok(
    html.indexOf('id="my-hand"') < html.indexOf('id="final-result-panel"'),
    '最終結果パネルは、終了時に空く自分の手札の直後に置く'
  );
  assert.match(client, /function renderFinalResult\(/);
  assert.match(client, /elements\.myHand\.classList\.toggle\('hidden', finished\);/);
  assert.match(client, /if \(!finaleChanged\) return;/);
  assert.match(client, /function setFinalResultAnnouncement\(panel, announce = false\)/);
  assert.match(client, /setFinalResultAnnouncement\(panel, isNewFinale\);/);
  assert.match(client, /kind: 'match-final', priority: 100, exclusive: true/);
  assert.match(client, /winnerSeat/);
  assert.match(client, /forfeitedBySeat/);
  assert.match(css, /\.final-result-panel\s*\{[^}]*min-height:\s*clamp\(190px, 25vw, 265px\);/);
});

test('公開済みのラウンド結果は再接続・チャット更新で再描画／再通知せず、新しい公開結果だけを読み上げる', () => {
  const html = read('index.html');
  const client = read('main.js');

  assert.match(html, /id="reveal-area"[^>]*aria-live="off"/);
  assert.match(client, /let lastRevealRenderKey = '';/);
  assert.match(client, /function getRevealRenderKey\(lastRound, finishReason = null, winnerName = null\)/);
  assert.match(client, /function setRevealAnnouncementMode\(announce = false\)/);
  assert.match(client, /if \(!roundChanged && !hasNewExpandedEffect && lastRevealRenderKey === revealRenderKey\) return;/);
  assert.match(client, /setRevealAnnouncementMode\(isNewRound \|\| shouldPlayExpandedEffect\);/);
  assert.match(client, /setRevealAnnouncementMode\(false\);/);
  assert.match(client, /lastRevealRenderKey = '';/);
});

test('カード能力は常設せず、選択中の自分のカードだけを手札直下で説明する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="selected-card-panel"[^>]*aria-live="off"/);
  assert.match(html, /id="selected-card-name"/);
  assert.match(html, /id="selected-card-strength"/);
  assert.match(html, /id="selected-card-description"/);
  assert.ok(
    html.indexOf('id="my-hand"') < html.indexOf('id="selected-card-panel"')
      && html.indexOf('id="selected-card-panel"') < html.indexOf('id="final-result-panel"'),
    '選択中カードの詳細は、手札の直下かつ最終結果パネルの前に表示する'
  );
  assert.match(client, /function renderSelectedCardDetails\(/);
  assert.match(client, /let lastSelectedCardRenderKey = '';/);
  assert.match(client, /function getSelectedCardRenderKey\(card, suitType\)/);
  assert.match(client, /function setSelectedCardAnnouncementMode\(announce = false\)/);
  assert.match(client, /if \(!selectionChanged\) \{/);
  assert.match(client, /setSelectedCardAnnouncementMode\(!presentationHydrating\);/);
  assert.match(client, /function getCardBaseStrengthLabel\(/);
  assert.match(client, /baseStrength: Number\.isSafeInteger\(card\.baseStrength\)/);
  assert.match(client, /setText\(elements\.selectedCardStrength, strengthText\);/);
  assert.match(client, /selectedCard\.roundInfo\?\.detail/);
  assert.match(client, /renderSelectedCardDetails\(displayedBottomHand, \{ isInteractive, suitType: 'spade' \}\);/);
  assert.doesNotMatch(client, /description\.className = 'card-desc'/);
  assert.match(css, /\.selected-card-panel\s*\{/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.selected-card-panel\s*\{/);
  assert.match(css, /\.card-center-suit\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*translate\(-50%, -50%\)/);
});

test('開始前の拡張デッキ札は設定プレビューとして明示し、選択可能な実札と誤認させない', () => {
  const client = read('main.js');

  assert.match(client, /const isPreview = card\?\.preview === true;/);
  assert.match(client, /isPreview \? ' card-preview' : ''/);
  assert.match(client, /開始時に使う設定デッキの札です。/);
  assert.match(client, /const canChooseCard = isInteractive && !isLocked;/);
});

test('高度なTarotの対象選択は盤面上の札を選んでから確定し、候補情報は選択者だけが送る', () => {
  const html = read('index.html');
  const client = read('main.js');
  const server = read('server.js');
  const css = read('style.css');

  assert.match(html, /id="private-action-panel"[^>]*role="region"[^>]*aria-live="off"/);
  assert.match(html, /id="private-action-selection"[^>]*aria-live="off"/);
  assert.match(html, /id="private-action-confirm"[^>]*type="button"/);
  assert.match(html, /id="opp-action-target-tray"[^>]*aria-live="off"/);
  assert.match(html, /id="my-action-target-tray"[^>]*aria-live="off"/);
  assert.doesNotMatch(html, /id="private-action-candidates"/);
  assert.ok(
    html.indexOf('id="selected-card-panel"') < html.indexOf('id="private-action-panel"')
      && html.indexOf('id="private-action-panel"') < html.indexOf('id="final-result-panel"'),
    '対象を選んだ後の確定操作は選択中カードと最終結果の間に置く'
  );
  assert.match(client, /function getPrivateActionTarget\(/);
  assert.match(client, /function getPrivateActionRenderKey\(action, target, canChoose\)/);
  assert.match(client, /function setPrivateActionAnnouncementMode\(announce = false\)/);
  assert.match(client, /function setPrivateActionSelectionAnnouncementMode\(announce = false\)/);
  assert.match(client, /const isNewAction = actionRenderKey !== lastPrivateActionRenderKey;/);
  assert.match(client, /setPrivateActionAnnouncementMode\(isNewAction && !presentationHydrating\);/);
  assert.match(client, /const isNewSelection = Boolean\(selectionRenderKey && selectionRenderKey !== lastPrivateActionSelectionRenderKey\);/);
  assert.match(client, /setPrivateActionSelectionAnnouncementMode\(isNewSelection && !presentationHydrating\);/);
  assert.match(client, /function renderPrivateActionTargetTrays\(/);
  assert.match(client, /privateActionSelectedTargetId/);
  assert.match(client, /card-effect-target/);
  assert.match(client, /effect-target-selected/);
  assert.match(client, /cardElement\.setAttribute\('aria-pressed', String\(isEffectTargetSelected\)\);/);
  assert.match(client, /function renderPrivatePendingAction\(/);
  assert.match(client, /function submitPrivateActionChoice\(/);
  assert.match(client, /socket\.emit\('resolve_private_action'/);
  assert.match(client, /actionId: action\.id/);
  assert.match(client, /nonce: action\.nonce/);
  assert.match(client, /gameRevision: action\.gameRevision/);
  assert.match(client, /!getPrivatePendingAction\(currentRoom\)/);
  assert.match(server, /publicPrivatePendingActionForViewer/);
  assert.match(server, /onSocketEvent\('resolve_private_action'/);
  assert.match(css, /\.private-action-panel\s*\{/);
  assert.match(css, /\.card-effect-target\s*\{/);
  assert.match(css, /\.private-action-confirm\s*\{[^}]*min-height:\s*44px;/);
  assert.match(css, /\.private-action-target-tray\s*\{/);
});

test('ロック札とThe Starのノイズ札は、色だけに頼らず状態を明示して操作不能にする', () => {
  const client = read('main.js');
  const css = read('style.css');

  assert.match(client, /const isLocked = card\?\.state\?\.locked === true;/);
  assert.match(client, /const isNoise = card\?\.category === 'noise' \|\| card\?\.state\?\.ownerOnlyNoise === true;/);
  assert.match(client, /const canChooseCard = isInteractive && !isLocked;/);
  assert.match(client, /cardElement\.setAttribute\('aria-pressed', String\(isSelected\)\);/);
  assert.match(client, /ロック中のため、今は選べません。/);
  assert.match(client, /card-lock-badge/);
  assert.match(css, /\.card-locked\s*\{[^}]*border-style:\s*dashed;/);
  assert.match(css, /\.card-lock-badge\s*\{/);
  assert.match(css, /\.card-noise\s*\{[^}]*border-style:\s*dashed;/);
  assert.match(css, /\.card-generated\.card-noise .*card-generated-glitch/);
});

test('クラシック書体はカード中央だけへ適用し、Jokerも同じ大きさと幅で読める', () => {
  const client = read('main.js');
  const css = read('style.css');

  assert.match(client, /card-\$\{card\.id\}/);
  assert.match(client, /joker: 'Jk'/);
  assert.match(css, /\.card-center-suit\s*\{[^}]*max-width:\s*calc\(100% - 18px\);/);
  assert.match(css, /\.card-center-suit\s*\{[^}]*font-family:\s*"Palatino Linotype", "Book Antiqua", Georgia, serif;/);
  assert.match(css, /\.card-rank-mark\s*\{[^}]*font-family:\s*inherit;[^}]*font-size:\s*clamp\(34px, 4\.5vw, 52px\);/);
  assert.doesNotMatch(css, /\.card-joker \.card-/);
  assert.match(css, /\.card-top\s*\{[^}]*font-family:\s*var\(--serif\);/);
  assert.match(css, /\.card-corner-pip\s*\{[^}]*font-family:\s*var\(--serif\);/);
});

test('この部屋のルールは対局盤を占有せず、操作ボタンの後ろに配置する', () => {
  const html = read('index.html');
  const css = read('style.css');

  assert.ok(
    html.indexOf('id="player-controls"') < html.indexOf('id="room-rules-panel"'),
    'ルール欄は自分の手札・選択中のカード・対局操作の後ろに置く'
  );
  assert.match(css, /\.my-zone > \.room-rules-panel\s*\{\s*margin-top:\s*24px;/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.my-zone > \.room-rules-panel\s*\{\s*margin-top:\s*16px;/);
});

test('モバイルPvPは画面全体を横に広げず、ヘッダーと手札を明示的に収める', () => {
  const css = read('style.css');

  assert.doesNotMatch(css, /body\s*\{\s*min-width:\s*320px;/);
  assert.match(css, /\.game-header\s*\{\s*grid-template-areas:\s*"brand actions" "room room";/);
  assert.match(css, /\.table-center\s*\{\s*margin-inline:\s*0;\s*padding-inline:\s*0;/);
  assert.match(css, /\.card-row\s*\{[^}]*inline-size:\s*100%;/);
  assert.match(css, /\.card\s*\{[\s\S]*?flex:\s*0 0 clamp\(100px, 12\.5%, 124px\);/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.card\s*\{\s*flex:\s*0 0 100px;/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.deck-count-button\s*\{\s*min-height:\s*44px;/);
  assert.match(css, /@media \(max-width: 390px\) \{[\s\S]*?\.card\s*\{\s*flex-basis:\s*94px;/);
});

test('ランダム再検索は検索世代を保持し、古い部屋更新を受理しない', () => {
  const client = read('main.js');
  const server = read('server.js');

  assert.match(client, /randomSearchSourceRoomId/);
  assert.match(client, /function requestNextRandomMatch\(/);
  assert.match(client, /isStaleRandomRoomUpdate\(room\)/);
  assert.match(client, /elements\.homeButton\.addEventListener\('click', \(\) => \{\s*if \(nextRandomMatchPending\)/);
  assert.match(server, /function acknowledgeKnownRandomSearch\(/);
  assert.match(server, /function cancelPendingRandomSearch\(/);
});

test('ランダムマッチは相手退出時に自動で再検索し、観戦者への切替を許可しない', () => {
  const client = read('main.js');
  const server = read('server.js');

  assert.match(client, /function handleRandomMatchInterrupted\(/);
  assert.match(client, /socket\.on\('random_match_interrupted'/);
  assert.match(client, /switchSpectatorButton\.classList\.toggle\('hidden', !playerCanAct \|\| isRandomMatch\)/);
  assert.match(server, /function requeueRemainingRandomPlayer\(/);
  assert.match(server, /random_match_interrupted/);
  assert.match(server, /room\.matchType === 'random'\) \{\s*emitError\(socket, 'ランダムマッチでは観戦者に切り替えられません。'\)/);
});

test('GitHub PagesのPvP読み込みチェーンは同じキャッシュ版を使い、効果・表示イベント基盤を先に読む', () => {
  const html = read('index.html');
  const loader = read('socket-loader.js');
  const redirect = read('page-redirect.js');

  assert.match(html, /style\.css\?v=pvp-v44/);
  assert.match(html, /effect-language\.js\?v=effect-language-v1/);
  assert.match(html, /presentation-events\.js\?v=presentation-v1/);
  assert.match(html, /socket-loader\.js\?v=pvp-v44/);
  assert.match(html, /page-redirect\.js\?v=security-v4/);
  assert.match(html, /id="legacy-startup-gate"/);
  assert.match(html, /id="connection-notice"/);
  assert.match(loader, /main\.js\?v=pvp-v44/);
  assert.match(loader, /__overthinkingLegacyStartup/);
  assert.match(redirect, /play\.html/);
  assert.match(redirect, /window\.location\.replace\(gateway\.toString\(\)\)/);
  assert.match(redirect, /startup-preview/);
  assert.match(redirect, /起動待ち画面の表示プレビューです/);
  const gatewayHtml = read('play.html');
  const gatewayScript = read('play-gateway.js');
  assert.match(gatewayHtml, /対戦サーバーを起動しています/);
  assert.match(gatewayScript, /window\.fetch\(healthUrl/);
  assert.match(gatewayScript, /credentials: 'omit'/);
});

test('拡張効果は紫の説明帯と短い種別キューを保ち、生成・複製の✦を共通化する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /effect-language\.js\?v=effect-language-v1/);
  assert.match(client, /function getExpandedEffectPresentation\(/);
  assert.match(client, /function createPublicEffectCue\(/);
  assert.match(client, /getExpandedEffectPresentation\(lastRound\.effects\)/);
  assert.match(client, /getExpandedEffectPresentation\(round\.effects\)/);
  assert.match(client, /return getExpandedEffectPresentation\(effects\)\.primary\?\.id \|\| '';/);
  assert.match(css, /\.round-outcome \.round-effect-detail\s*\{[^}]*background:\s*rgba\(103, 79, 164, \.2\);/);
  assert.match(css, /\.effect-token-generate\s*\{[^}]*color:\s*#b9efff;/);
  assert.match(css, /\.round-effect-detail\.effect-kind-generate\s*\{[^}]*border-inline-start-color:\s*#9be4f4;/);
  assert.match(css, /\.history-detail \.history-effect\.effect-kind-generate/);
});

test('観戦を選んだ入口は観戦CTAと役割説明へ切り替わる', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="entry-mode-description"[^>]*role="status"/);
  assert.match(html, /id="spectator-entry-note"[^>]*role="status"/);
  assert.match(client, /const isSpectatorEntry = !isRandomMode && elements\.spectateModeInput\.checked;/);
  assert.match(client, /isSpectatorEntry \? '観戦する' : '入室する'/);
  assert.match(client, /観戦者として入室する/);
  assert.match(client, /function syncSpectatorJoinOptions\([\s\S]*?renderEntryMode\(\);/);
  assert.match(css, /\.join-form-spectator \.join-options/);
  assert.match(css, /\.spectator-entry-note/);
});

test('対局状態は文言だけでなく意味別の状態バナーとして表示する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="status-message"[^>]*data-state="waiting"/);
  assert.match(client, /function setGameStatus\(value, state = 'neutral'\)/);
  assert.match(client, /let lastGameStatusKey = '';/);
  assert.match(client, /const statusKey = `\$\{normalizedState\}\|\$\{text\}`;/);
  assert.match(client, /if \(statusKey === lastGameStatusKey\) return;/);
  assert.match(client, /lastGameStatusKey = '';/);
  assert.match(client, /カードを伏せました。相手の選択を待っています…/);
  assert.match(client, /room\.viewer\.hasConfirmedSelection \? 'waiting' : 'decision'/);
  assert.match(client, /setGameStatus\('対戦相手の再接続を待っています。', 'reconnecting'\)/);
  assert.match(css, /\.status-msg\[data-state="decision"\]/);
  assert.match(css, /\.status-msg\[data-state="reconnecting"\], \.status-msg\[data-state="error"\]/);
});

test('主ボタンはカード未選択・確定可能・伏せ札済みを区別し、現在の次操作を示す', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="confirmBtn"[^>]*aria-describedby="status-message"[^>]*data-state="selection-needed"/);
  assert.match(html, /id="confirm-button-label">カードを選んでください/);
  assert.match(html, /id="confirm-button-icon" class="hidden"/);
  assert.match(client, /confirmButtonLabel: document\.getElementById\('confirm-button-label'\)/);
  assert.match(client, /confirmButtonIcon: document\.getElementById\('confirm-button-icon'\)/);
  assert.match(client, /function updateConfirmButton\(\) \{/);
  assert.match(client, /let label = '対局の開始を待っています';/);
  assert.match(client, /label = 'カードを選んでください';/);
  assert.match(client, /label = 'この一枚で勝負する';/);
  assert.match(client, /label = 'カードを伏せました';/);
  assert.match(client, /elements\.confirmButton\.dataset\.state = state;/);
  assert.match(client, /elements\.confirmButtonIcon\?\.classList\.toggle\('hidden', !showIcon\);/);
  assert.match(css, /\.confirm-button\[data-state="selection-needed"\]:disabled/);
  assert.match(css, /\.confirm-button\[data-state="committed"\]:disabled/);
});

test('クラシックの公開結果はサーバー確定の比較理由を表示し、クライアントで勝敗を推測しない', () => {
  const client = read('main.js');
  const server = read('server.js');
  const rules = read('game-rules.js');
  const css = read('style.css');

  assert.match(rules, /function resolveRoundDetails\(/);
  assert.match(server, /const roundDetails = resolveRoundDetails\(firstCard, secondCard\);/);
  assert.match(server, /comparison: roundDetails\.comparison/);
  assert.match(client, /function formatPublicRoundComparison\(round\)/);
  assert.match(client, /ROUND_COMPARISON_LABELS\[comparison\]/);
  assert.match(client, /comparison\.className = 'round-comparison';/);
  assert.match(client, /comparisonDetail\.className = 'history-comparison';/);
  assert.match(css, /\.round-outcome \.round-comparison/);
  assert.match(css, /\.history-detail \.history-comparison/);
});

test('観戦中は空席参加予約の順番を部屋内で変更でき、席と勝敗の色・名前を対応させる', () => {
  const html = read('index.html');
  const client = read('main.js');
  const server = read('server.js');
  const css = read('style.css');

  assert.match(html, /id="spectator-seat-panel"/);
  assert.match(html, /id="spectator-auto-join-toggle"/);
  assert.match(html, /id="spectator-seat-queue"/);
  assert.match(client, /function renderSpectatorSeatPanel\(/);
  assert.match(client, /set_spectator_auto_join/);
  assert.match(client, /getSeatOwnerLabel\(currentRoom, 'p1'/);
  assert.match(client, /getSeatOwnerLabel\(currentRoom, 'p2'/);
  assert.match(client, /観戦者 \$\{roomView\.spectatorCount\}人/);
  assert.match(server, /function getSpectatorSeatQueue\(/);
  assert.match(server, /function normalizePlayerSeats\(/);
  // Socket handlers run through the shared guarded registration boundary so
  // malformed transport payloads cannot terminate the server process.
  assert.match(server, /onSocketEvent\('set_spectator_auto_join'/);
  assert.match(css, /\.reveal-card\.reveal-spade/);
  assert.match(css, /\.reveal-card\.reveal-heart/);
  assert.match(css, /\.history-item\.winner-p1/);
  assert.match(css, /\.history-item\.winner-p2/);
});

test('Private対戦のルール概要と制限時間設定は、現在の設定担当者だけが開始前に変更できる', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="room-rules-panel"/);
  assert.match(html, /id="round-limit"/);
  assert.match(html, /id="private-turn-time-select"/);
  assert.match(html, /id="begin-private-settings-edit-btn"/);
  assert.match(html, /id="finish-private-settings-edit-btn"/);
  assert.match(html, /id="start-agreement-status"[^>]*role="status"/);
  assert.match(html, /value="60000">60秒/);
  assert.match(html, /value="90000">90秒/);
  assert.match(html, /value="120000">120秒/);
  assert.match(html, /現在の設定担当者/);
  assert.match(client, /function getRoomRules\(/);
  assert.match(client, /function applyPrivateSettingsAcknowledgement\(/);
  assert.match(client, /let isPending = privateSettingsPending\?\.roomId === room\?\.id;/);
  assert.match(client, /clearPrivateSettingsPending\(\);\s*privateSettingsFeedback = '設定を反映しました。両者の開始同意はリセットされています。';\s*isPending = false;/);
  assert.match(client, /function renderRoomRules\(/);
  assert.match(client, /function requestPrivateSettingsEditMode\(editing\)/);
  assert.match(client, /begin_private_settings_edit/);
  assert.match(client, /finish_private_settings_edit/);
  assert.match(client, /const canAgreeToStart = canShowStartAgreement && !settingsEditing;/);
  assert.match(client, /開始に同意済み：\$\{agreedNames\.join\('・'\)\}/);
  assert.match(client, /function isRoomHost\(room\) \{\s*return \(room\?\.viewer\?\.isRoomHost \?\? room\?\.viewer\?\.isHost\)/);
  assert.match(client, /socket\.emit\('update_private_settings'/);
  assert.match(client, /room\.matchType === 'random'/);
  assert.match(client, /const timerLimitMs = pendingAction \? 30_000 : getRoomRules\(room\)\.turnTimeLimitMs;/);
  assert.match(client, /\(remainingMs \/ timerLimitMs\) \* 100/);
  assert.match(css, /\.room-rules-panel\s*\{/);
  assert.match(css, /\.private-settings-controls\s*\{/);
  assert.match(html, /id="room-rules-concepts"/);
  assert.match(html, /id="room-rules-concepts-list"/);
  assert.match(client, /activeConcepts/);
  assert.match(client, /room-rule-concept/);
  assert.match(css, /\.room-rules-concepts\s*\{/);
});

test('Private拡張では共通デッキ・終了条件・Blankを待機中だけ編集し、Blankを選択札として描画する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const server = read('server.js');
  const css = read('style.css');

  assert.match(html, /id="private-ruleset-select"/);
  assert.match(html, /id="expanded-deck-list"/);
  assert.match(html, /id="expanded-round-limit-input"/);
  assert.match(html, /id="expanded-score-target-enabled"/);
  assert.match(html, /規定の獲得枚数で早期決着にする/);
  assert.match(html, /指定枚数を先取した時点で総ラウンドを待たずに終了します/);
  assert.match(html, /id="expanded-blank-enabled"/);
  assert.match(client, /function renderExpandedDeckEditor\(/);
  assert.match(client, /function requestPrivateSettingsChange\(/);
  assert.match(client, /const nextDeck = entry\s*\? deck[\s\S]*?: \[\{ definitionId, copies: nextCopies \}, \.\.\.deck\];/);
  assert.match(client, /VIRTUAL_BLANK_CARD_ID/);
  assert.match(client, /getSelectableDisplayHand\(/);
  assert.match(client, /random-legal-with-blank/);
  assert.match(server, /function getSelectableCardIds\(/);
  assert.match(server, /crypto\.randomInt\(options\.length\)/);
  assert.match(server, /function processExpandedPrivateTurn\(/);
  assert.match(server, /publicExpandedCardForViewer/);
  assert.match(css, /\.expanded-private-settings\s*\{/);
  assert.match(css, /\.card-virtual-blank\s*\{/);
});

test('Private拡張デッキの枚数操作は対象カードを含むアクセシブル名を持つ', () => {
  const client = read('main.js');

  assert.match(client, /const cardDisplayName = formatCardDisplayName\(card\);/);
  assert.match(client, /controls\.setAttribute\('aria-label', `\$\{cardDisplayName\} の枚数`\);/);
  assert.match(client, /minus\.setAttribute\('aria-label', `\$\{cardDisplayName\} を1枚減らす`\);/);
  assert.match(client, /plus\.setAttribute\('aria-label', `\$\{cardDisplayName\} を1枚増やす`\);/);
});

test('Privateの設定担当は対戦者へ安全に譲れ、受け取った側へ編集可能な通知を出す', () => {
  const html = read('index.html');
  const client = read('main.js');
  const server = read('server.js');
  const css = read('style.css');

  assert.match(html, /id="transfer-private-settings-owner-btn"/);
  assert.match(html, /設定を変えずに編集権限を相手へ渡せます。/);
  assert.match(html, /id="room-rules-owner-actions"/);
  assert.match(html, /設定担当を譲る/);
  assert.match(client, /function requestPrivateSettingsOwnershipTransfer\(/);
  assert.match(client, /transfer_private_settings_owner/);
  assert.match(client, /socket\.on\('settings_owner_changed'/);
  assert.match(client, /highlightPrivateSettingsOwnership/);
  assert.match(server, /function transferPrivateRoomSettingsOwner\(/);
  assert.match(server, /function isPrivateSettingsOwnerTransferPayload\(/);
  assert.match(server, /player\.clientId !== clientId && player\.connected/);
  assert.match(server, /settings_owner_changed/);
  assert.match(css, /\.transfer-private-settings-owner-button\s*\{/);
  assert.match(css, /\.private-settings-controls\.settings-owner-arrived/);
});

test('導入済みTarotは選択時・公開済み履歴でだけ現在ラウンドの強さを確認できる', () => {
  const client = read('main.js');
  const css = read('style.css');

  assert.match(client, /death: 'α'/);
  assert.match(client, /temperance: 'β'/);
  assert.match(client, /'the-chariot': 'ε'/);
  assert.match(client, /strength: 'ζ'/);
  assert.match(client, /'the-magician': 'η'/);
  assert.match(client, /'the-lovers': 'θ'/);
  assert.match(client, /'wheel-of-fortune': 'ι'/);
  assert.match(client, /function formatRoundCardLabel\(/);
  assert.match(client, /createRevealCard\(lastRound\.p1Card, firstOwner, 'p1', lastRound\.p1Strength\)/);
  assert.match(client, /round\.p1Strength/);
  assert.match(css, /\.card-tarot\s*\{/);
  assert.match(css, /\.selected-card-strength\s*\{/);
  assert.match(css, /\.expanded-deck-card-tarot\s*\{/);
});

test('生成・総ラウンドTarotの効果は結果と履歴へ表示し、対局中の有効ラウンド数を優先する', () => {
  const client = read('main.js');
  const server = read('server.js');
  const css = read('style.css');

  assert.match(client, /function getDisplayedRoundLimit\(/);
  assert.match(client, /effectiveRoundLimit/);
  assert.match(client, /function formatExpandedRoundEffects\(/);
  assert.match(client, /function getExpandedEffectBurstKind\(/);
  assert.match(client, /function getExpandedEffectBurstId\(/);
  assert.match(client, /hasNewExpandedEffect/);
  assert.match(client, /function scheduleExpandedRoundEffects\(/);
  assert.match(client, /function playExpandedRoundEffects\(/);
  assert.match(client, /scheduleExpandedRoundEffects\(lastRound\.effects\)/);
  assert.match(client, /round-effect-detail/);
  assert.match(client, /history-effect/);
  assert.match(server, /function publicExpandedRoundEffect\(/);
  assert.match(server, /createdCopies: effect\.cardInstanceIds\.length/);
  assert.match(server, /effectiveRoundLimit: runtimeRoundLimit/);
  assert.match(css, /\.round-outcome \.round-effect-detail\s*\{/);
  assert.match(css, /\.history-detail \.history-effect\s*\{/);
  assert.match(css, /\.reveal-area\.effect-burst-generate::before/);
  assert.match(css, /\.reveal-area\.effect-burst-noise::before/);
});

test('Tarotはギリシャ文字で表示し、対局者・観戦者とも役割色で使用中の能力を確認できる', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(client, /death: 'α'/);
  assert.match(client, /temperance: 'β'/);
  assert.doesNotMatch(client, /death: 'XIII'/);
  assert.match(html, /id="spectator-tarot-guide"/);
  assert.match(html, />使用中のタロット</);
  assert.doesNotMatch(html, /観戦者用・使用中のタロット/);
  assert.match(html, /id="spectator-tarot-list"/);
  assert.match(html, /class="spectator-utilities"/);
  assert.ok(html.indexOf('id="spectator-seat-panel"') > html.indexOf('id="my-zone"'));
  assert.ok(html.indexOf('id="spectator-tarot-guide"') > html.indexOf('id="my-zone"'));
  assert.match(client, /function renderSpectatorTarotGuide\(/);
  assert.match(client, /getActiveSpectatorTarotCards/);
  assert.match(client, /spectator-tarot-card tarot-role-\$\{visualRole\}/);
  assert.match(client, /spectatorTarotGuide\.classList\.add\(`tarot-role-\$\{selectedVisualRole\}`\)/);
  assert.doesNotMatch(client, /room\?\.viewer\?\.isSpectator \? getActiveSpectatorTarotCards/);
  assert.match(client, /selected-card-no-ability/);
  assert.match(client, /hasNonTarotAbilityCard/);
  assert.match(css, /\.spectator-tarot-guide\s*\{/);
  assert.match(css, /\.spectator-tarot-guide\.tarot-role-conditional\s*\{/);
  assert.match(css, /\.spectator-tarot-guide\.tarot-role-other\s*\{[^}]*#b9f6ef/);
  assert.match(css, /\.spectator-tarot-card\.tarot-role-other\s*\{/);
  assert.match(css, /\.spectator-utilities\s*\{/);
  assert.match(css, /\.card-no-ability\s*\{/);
  assert.match(css, /\.card-has-ability\s*\{/);
});

test('Private設定プリセットは任意ログインで保存し、適用時は既存のサーバー権威設定経路を使う', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="private-preset-panel"/);
  assert.match(html, /id="private-preset-login-google"/);
  assert.match(html, /ログインしなくても、これまでどおり対戦できます/);
  assert.match(html, /id="private-preset-select"/);
  assert.match(html, /id="private-preset-save-btn"/);
  assert.match(html, /id="private-preset-load-btn"/);
  assert.match(client, /function loadPrivatePresetAccount\(/);
  assert.match(client, /function privatePresetApi\(/);
  assert.match(client, /credentials: 'same-origin'/);
  assert.match(client, /requestPrivateSettingsChange\(selectedPreset\.config\)/);
  assert.match(client, /returnTo', '\/'/);
  assert.match(css, /\.private-preset-panel\s*\{/);
  assert.match(css, /\.private-preset-actions button\s*\{/);
});

test('Joker・2・3の能力カードは青い通常札に半透明の緑を重ね、枠線で区別する', () => {
  const css = read('style.css');

  assert.match(css, /\.card-has-ability\s*\{[^}]*border-color:\s*#8ccbb7;[^}]*rgba\(57, 70, 108/);
  assert.match(css, /\.card-has-ability::after\s*\{[^}]*rgba\(94, 174, 149, \.13\)/);
  assert.match(css, /\.selected-card-panel\.selected-card-has-ability\s*\{[^}]*border-color:\s*#8ccbb7;[^}]*rgba\(84, 189, 151, \.18\)/);
  assert.match(css, /\.expanded-deck-card-has-ability\s*\{[^}]*border-color:\s*#8ccbb7;[^}]*rgba\(94, 174, 149, \.1\)/);
});

test('拡張デッキ一覧は、続きがあるときにフェードとスクロール案内を出し、コンパクトな上下ボタンで高さを調整できる', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="expanded-deck-scroll"/);
  assert.match(html, /id="expanded-deck-scroll-hint"/);
  assert.match(html, /id="expanded-deck-scroll-description"/);
  assert.match(html, /id="expanded-deck-height-decrease"[^>]*aria-label="一覧を40px低くする"/);
  assert.match(html, /id="expanded-deck-height-increase"[^>]*aria-label="一覧を40px高くする"/);
  assert.match(html, /id="expanded-deck-height-value"/);
  assert.match(html, /一覧の高さは180pxから440pxまで、40pxずつ調整できます。/);
  assert.match(html, /aria-describedby="expanded-deck-scroll-description"/);
  assert.match(html, /下へスクロールして、すべてのカードを見る/);
  assert.match(client, /function updateExpandedDeckScrollCue\(/);
  assert.match(client, /function normalizeExpandedDeckListHeight\(/);
  assert.match(client, /function applyExpandedDeckListHeight\(/);
  assert.match(client, /EXPANDED_DECK_HEIGHT_MIN_PX = 180/);
  assert.match(client, /EXPANDED_DECK_HEIGHT_MAX_PX = 440/);
  assert.match(client, /EXPANDED_DECK_HEIGHT_STEP_PX = 40/);
  assert.match(client, /EXPANDED_DECK_HEIGHT_STOPS = Object\.freeze\(\[180, 220, 260, 300, 340, 380, 420, 440\]\)/);
  assert.match(client, /function adjustExpandedDeckListHeight\(direction\)/);
  assert.match(client, /expandedDeckHeightDecrease\?\.addEventListener\('click'/);
  assert.match(client, /expandedDeckHeightIncrease\?\.addEventListener\('click'/);
  assert.match(client, /elements\.expandedDeckList\.addEventListener\('scroll', updateExpandedDeckScrollCue/);
  assert.match(client, /window\.addEventListener\('resize', \(\) => \{[\s\S]*?updateExpandedDeckScrollCue\(\);/);
  assert.match(css, /\.expanded-deck-scroll\.has-more-below::after\s*\{\s*opacity:\s*1;/);
  assert.match(css, /\.expanded-deck-scroll\.has-more-below \.expanded-deck-scroll-hint\s*\{\s*opacity:\s*1;/);
  assert.match(css, /\.expanded-deck-list\s*\{[^}]*max-height:\s*var\(--expanded-deck-list-height, 270px\)/);
  assert.match(css, /\.expanded-deck-height-control\s*\{/);
  assert.match(css, /\.deck-height-stepper\s*\{/);
});

test('拡張デッキの作業台はローカル表示だけを、採用状況とカード種別で絞り込める', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="expanded-deck-filters"[^>]*aria-label="表示するカードを絞り込む"/);
  assert.match(html, /data-deck-filter="all"[^>]*aria-pressed="true"/);
  assert.match(html, /data-deck-filter="included"/);
  assert.match(html, /data-deck-filter="tarot"/);
  assert.match(html, /data-deck-filter="normal"/);
  assert.match(html, /id="expanded-deck-filter-summary"[^>]*aria-live="polite"/);
  assert.match(client, /const EXPANDED_DECK_FILTERS = Object\.freeze\(\['all', 'included', 'tarot', 'normal'\]\)/);
  assert.match(client, /function cardMatchesExpandedDeckFilter\(card, copies\)/);
  assert.match(client, /catalog\.filter\(\(card\) => cardMatchesExpandedDeckFilter\(card, copiesById\.get\(card\.id\) \|\| 0\)\)/);
  assert.match(client, /Filters are a local reading aid only/);
  assert.match(client, /elements\.expandedDeckFilters\?\.addEventListener\('click'/);
  assert.match(css, /\.expanded-deck-toolbar\s*\{/);
  assert.match(css, /\.expanded-deck-filter\.is-active\s*\{/);
  assert.match(css, /\.expanded-deck-filter-summary\s*\{/);
});

test('モバイルの手札と組み合わせ早見表は、横に続きがある側だけをフェードで示す', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="matchup-table-scroll" class="matchup-table-scroll horizontal-scroll-cue"/);
  assert.match(html, /id="matchup-table-wrap"[^>]*aria-describedby="matchup-table-scroll-description"/);
  assert.match(html, /id="opp-hand-scroll" class="card-scroll horizontal-scroll-cue"/);
  assert.match(html, /id="my-hand-scroll" class="card-scroll horizontal-scroll-cue"/);
  assert.match(html, /id="opp-hand"[^>]*aria-describedby="opp-hand-scroll-description"/);
  assert.match(html, /id="my-hand"[^>]*aria-describedby="my-hand-scroll-description"/);
  assert.match(client, /function updateHorizontalScrollCue\(scroller, wrapper\)/);
  assert.match(client, /wrapper\.classList\.toggle\('has-more-left', hasMoreLeft\);/);
  assert.match(client, /wrapper\.classList\.toggle\('has-more-right', hasMoreRight\);/);
  assert.match(client, /elements\.myHand\.addEventListener\('scroll'/);
  assert.match(client, /elements\.opponentHand\.addEventListener\('scroll'/);
  assert.match(client, /elements\.matchupTableWrap\.addEventListener\('scroll'/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.horizontal-scroll-cue::before, \.horizontal-scroll-cue::after/);
  assert.match(css, /\.horizontal-scroll-cue\.has-more-left::before, \.horizontal-scroll-cue\.has-more-right::after\s*\{\s*opacity:\s*1;/);
});

test('切断中の対局は10秒間停止し、復帰期限を参加者へ明示する', () => {
  const client = read('main.js');
  const server = read('server.js');

  assert.match(client, /const RECONNECT_GRACE_MS = 10_000;/);
  assert.match(client, /room\.gameState === 'reconnecting'/);
  assert.match(client, /対戦相手の再接続を待っています。あと \$\{remainingSeconds\} 秒で対局を終了します。制限時間は停止中です。/);
  assert.match(server, /const RECONNECT_GRACE_MS = 10_000;/);
  assert.match(server, /reconnectDeadline: room\.gameState === 'reconnecting'/);
  assert.match(server, /pauseForReconnect\(room\);/);
  assert.match(server, /resumeAfterReconnect\(room\);/);
});

test('チャットとゲーム案内には個人情報・差別的表現の注意、および通信中断の案内を明示する', () => {
  const html = read('index.html');

  assert.match(html, /chat-safety-note/);
  assert.match(html, /個人情報/);
  assert.match(html, /差別・侮辱・脅迫/);
  assert.match(html, /通信障害、サービスの再起動・中断等/);
});
