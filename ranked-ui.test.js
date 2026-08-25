'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(errorKind('HANDLE_COOLDOWN'), 'warning');
  assert.equal(errorKind('INVALID_HANDLE'), 'error');
});
