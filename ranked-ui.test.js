'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HANDLE_PATTERN, errorKind, errorMessage } = require('./ranked-ui');

test('公開ハンドルは英大文字・英小文字・数字・_・- の3〜20文字だけを許可する', () => {
  for (const value of ['abc', 'ABC', 'Abc_9-', 'a'.repeat(20)]) assert.equal(HANDLE_PATTERN.test(value), true, value);
  for (const value of ['ab', 'a'.repeat(21), 'valid handle', 'valid\nhandle', 'valid\u200Bhandle', '日本語']) {
    assert.equal(HANDLE_PATTERN.test(value), false, value);
  }
});

test('Rankedのエラーは実装詳細ではなく日本語の利用者向け文言に変換する', () => {
  assert.match(errorMessage('HANDLE_COOLDOWN'), /30日/);
  assert.match(errorMessage('GAME_VERSION_MISMATCH'), /投了/);
  assert.match(errorMessage('IDENTITY_PROVIDER_UNAVAILABLE'), /認証サービス/);
  assert.match(errorMessage('INVALID_PROFILE_UPDATE'), /プロフィール/);
  assert.match(errorMessage('RANKED_REQUEST_FAILED'), /ランク戦/);
  assert.match(errorMessage('RANKED_PROFILE_UNAVAILABLE'), /サインインは完了/);
  assert.equal(errorKind('HANDLE_COOLDOWN'), 'warning');
  assert.equal(errorKind('INVALID_HANDLE'), 'error');
});

test('認証エラーはサインインボタンから十分に離れ、支援技術にもエラーとして伝わる', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ranked.css'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, 'ranked-client.js'), 'utf8');

  // `.ranked-auth > p` より詳細な指定にして、共通段落の margin: 0
  // に再び上書きされないようにする。
  assert.match(css, /\.ranked-auth > \.ranked-auth-notice\s*\{[^}]*margin:\s*32px auto 0;/);
  assert.match(css, /\.ranked-auth-notice\[data-kind="error"\][^}]*border-left:\s*4px solid/);
  assert.match(client, /setAttribute\('role', kind === 'error' \? 'alert' : 'status'\)/);
  assert.match(client, /window\.history\?\.replaceState/);
  assert.match(client, /サインイン操作から再試行/);
});
