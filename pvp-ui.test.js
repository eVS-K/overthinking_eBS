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

test('モバイルPvPは画面全体を横に広げず、ヘッダーと手札を明示的に収める', () => {
  const css = read('style.css');

  assert.doesNotMatch(css, /body\s*\{\s*min-width:\s*320px;/);
  assert.match(css, /\.game-header\s*\{\s*grid-template-areas:\s*"brand actions" "room room";/);
  assert.match(css, /\.table-center\s*\{\s*margin-inline:\s*0;\s*padding-inline:\s*0;/);
  assert.match(css, /\.card-row\s*\{[^}]*inline-size:\s*100%;/);
  assert.match(css, /\.card\s*\{[\s\S]*?flex:\s*0 0 clamp\(94px, 12%, 118px\);/);
  assert.match(css, /@media \(max-width: 660px\) \{[\s\S]*?\.card\s*\{\s*flex:\s*0 0 96px;/);
  assert.match(css, /@media \(max-width: 390px\) \{[\s\S]*?\.card\s*\{\s*flex-basis:\s*88px;/);
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

test('GitHub PagesのPvP読み込みチェーンは同じキャッシュ版を使う', () => {
  const html = read('index.html');
  const loader = read('socket-loader.js');

  assert.match(html, /style\.css\?v=pvp-v11/);
  assert.match(html, /socket-loader\.js\?v=pvp-v11/);
  assert.match(loader, /main\.js\?v=pvp-v11/);
});
