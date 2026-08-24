'use strict';

// Browser and Node both use this small, dependency-free module. Keeping
// user-facing error wording here prevents backend implementation messages
// from leaking into the Japanese UI.
(function exposeRankedUi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OverthinkingRankedUi = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

  const ERROR_MESSAGES = Object.freeze({
    AUTH_REQUIRED: 'ランク対戦を利用するにはサインインが必要です。',
    AUTH_UNAVAILABLE: 'サインインは現在利用できません。時間をおいて再試行してください。',
    AUTH_RUNTIME_UNAVAILABLE: '認証機能を利用できません。時間をおいて再試行してください。',
    IDENTITY_PROVIDER_UNAVAILABLE: '認証サービスに接続できません。少し時間をおいて再試行してください。',
    IDENTITY_PROVIDER_RESPONSE_INVALID: '認証サービスから正しい応答を受け取れませんでした。もう一度お試しください。',
    CSRF_REJECTED: '安全確認に失敗しました。画面を再読み込みして、もう一度お試しください。',
    ORIGIN_REJECTED: 'このページからの操作は許可されていません。',
    GAME_NOT_FOUND: 'この対局は見つからないか、操作する権限がありません。',
    GAME_FINISHED: 'この対局はすでに終了しています。',
    GAME_VERSION_MISMATCH: 'この対局は安全のため続行できません。投了して終了してください。',
    ROUND_EXPIRED: '制限時間が過ぎたため、この手は受け付けられませんでした。',
    ROUND_MISMATCH: '対局の状態が更新されています。表示を更新しました。',
    ILLEGAL_CARD: 'そのカードは現在の手札にありません。',
    INVALID_CARD: '選択したカードを確認してください。',
    INVALID_MOVE: '送信内容を確認してください。',
    INVALID_ROUND: 'ラウンド情報を確認できませんでした。画面を更新してください。',
    INVALID_REQUEST_ID: '安全な送信IDを確認できませんでした。もう一度お試しください。',
    INVALID_HANDLE: '公開ハンドルは3〜20文字の半角英字・数字・_・-のみ使用できます。',
    HANDLE_TAKEN: 'その公開ハンドルはすでに使われています。',
    HANDLE_COOLDOWN: '公開ハンドルは30日に一度だけ変更できます。次に変更できるまでお待ちください。',
    PROFILE_UNAVAILABLE: 'このアカウントではランク対戦を利用できません。',
    RATE_LIMITED: '操作が集中しています。少し時間をおいてからもう一度お試しください。',
    PAYLOAD_TOO_LARGE: '送信内容が大きすぎます。',
    INVALID_JSON: '送信内容を読み取れませんでした。',
    INVALID_REQUEST: 'この操作には追加の入力を送信できません。',
    RANKED_UNAVAILABLE: 'ランク対戦は現在、準備中または一時停止中です。',
    SEASON_VERSION_MISMATCH: 'シーズンの更新中です。しばらくしてからもう一度お試しください。',
    OAUTH_EXCHANGE_FAILED: 'サインインを完了できませんでした。もう一度お試しください。',
    OAUTH_USER_LOOKUP_FAILED: 'サインインを完了できませんでした。もう一度お試しください。',
    OAUTH_TRANSACTION_INVALID: 'サインインの有効時間が切れたか、安全確認に失敗しました。もう一度お試しください。',
    INVALID_OAUTH_CALLBACK: 'サインインを完了できませんでした。もう一度お試しください。'
  });

  function errorMessage(code) {
    return ERROR_MESSAGES[code] || '操作を完了できませんでした。通信状態を確認して、もう一度お試しください。';
  }

  function errorKind(code) {
    return ['HANDLE_COOLDOWN', 'RATE_LIMITED', 'ROUND_EXPIRED', 'ROUND_MISMATCH', 'GAME_FINISHED'].includes(code)
      ? 'warning'
      : 'error';
  }

  return Object.freeze({ HANDLE_PATTERN, errorKind, errorMessage });
}));
