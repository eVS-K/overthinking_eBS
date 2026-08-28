'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

test('PvPの最終結果パネルは空いた手札領域を使い、一度だけライブ通知する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="final-result-panel"[^>]*role="status"/);
  assert.ok(
    html.indexOf('id="my-hand"') < html.indexOf('id="final-result-panel"'),
    '最終結果パネルは、終了時に空く自分の手札の直後に置く'
  );
  assert.match(client, /function renderFinalResult\(/);
  assert.match(client, /elements\.myHand\.classList\.toggle\('hidden', finished\);/);
  assert.match(client, /if \(!isNewFinale\) return;/);
  assert.match(client, /winnerSeat/);
  assert.match(client, /forfeitedBySeat/);
  assert.match(css, /\.final-result-panel\s*\{[^}]*min-height:\s*clamp\(190px, 25vw, 265px\);/);
});

test('カード能力は常設せず、選択中の自分のカードだけを手札直下で説明する', () => {
  const html = read('index.html');
  const client = read('main.js');
  const css = read('style.css');

  assert.match(html, /id="selected-card-panel"[^>]*aria-live="polite"/);
  assert.match(html, /id="selected-card-name"/);
  assert.match(html, /id="selected-card-description"/);
  assert.ok(
    html.indexOf('id="my-hand"') < html.indexOf('id="selected-card-panel"')
      && html.indexOf('id="selected-card-panel"') < html.indexOf('id="final-result-panel"'),
    '選択中カードの詳細は、手札の直下かつ最終結果パネルの前に表示する'
  );
  assert.match(client, /function renderSelectedCardDetails\(/);
  assert.match(client, /setText\(elements\.selectedCardDescription, `能力：\$\{selectedCard\.desc\}`\);/);
  assert.match(client, /renderSelectedCardDetails\(displayedBottomHand, \{ isInteractive, suitType: 'spade' \}\);/);
  assert.doesNotMatch(client, /description\.className = 'card-desc'/);
  assert.match(css, /\.selected-card-panel\s*\{/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.selected-card-panel\s*\{/);
  assert.match(css, /\.card-center-suit\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*translate\(-50%, -50%\)/);
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

test('GitHub PagesのPvP読み込みチェーンは同じキャッシュ版を使う', () => {
  const html = read('index.html');
  const loader = read('socket-loader.js');
  const redirect = read('page-redirect.js');

  assert.match(html, /style\.css\?v=pvp-v23/);
  assert.match(html, /socket-loader\.js\?v=pvp-v23/);
  assert.match(html, /page-redirect\.js\?v=security-v4/);
  assert.match(html, /id="legacy-startup-gate"/);
  assert.match(html, /id="connection-notice"/);
  assert.match(loader, /main\.js\?v=pvp-v23/);
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
  assert.match(server, /socket\.on\('set_spectator_auto_join'/);
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
  assert.match(html, /value="60000">60秒/);
  assert.match(html, /value="90000">90秒/);
  assert.match(html, /value="120000">120秒/);
  assert.match(html, /現在の設定担当者/);
  assert.match(client, /function getRoomRules\(/);
  assert.match(client, /function applyPrivateSettingsAcknowledgement\(/);
  assert.match(client, /let isPending = privateSettingsPending\?\.roomId === room\?\.id;/);
  assert.match(client, /clearPrivateSettingsPending\(\);\s*privateSettingsFeedback = '設定を反映しました。両者の開始同意はリセットされています。';\s*isPending = false;/);
  assert.match(client, /function renderRoomRules\(/);
  assert.match(client, /function isRoomHost\(room\) \{\s*return \(room\?\.viewer\?\.isRoomHost \?\? room\?\.viewer\?\.isHost\)/);
  assert.match(client, /socket\.emit\('update_private_settings'/);
  assert.match(client, /room\.matchType === 'random'/);
  assert.match(client, /\(remainingMs \/ turnTimeLimitMs\) \* 100/);
  assert.match(css, /\.room-rules-panel\s*\{/);
  assert.match(css, /\.private-settings-controls\s*\{/);
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
  assert.match(css, /\.expanded-private-settings\s*\{/);
  assert.match(css, /\.card-virtual-blank\s*\{/);
});

test('チャットとゲーム案内には個人情報・差別的表現の注意、および通信中断の案内を明示する', () => {
  const html = read('index.html');

  assert.match(html, /chat-safety-note/);
  assert.match(html, /個人情報/);
  assert.match(html, /差別・侮辱・脅迫/);
  assert.match(html, /通信障害、サービスの再起動・中断等/);
});
