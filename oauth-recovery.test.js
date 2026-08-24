'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'oauth-recovery.js'), 'utf8');

function runRecovery(href) {
  let replacedWith = null;
  vm.runInNewContext(source, {
    URL,
    window: {
      location: {
        href,
        replace(url) { replacedWith = url; }
      }
    }
  });
  return replacedWith;
}

test('GitHub Pagesへ誤って戻ったOAuth callbackをbackend callbackへ安全に戻す', () => {
  const target = runRecovery('https://evs-k.github.io/overthinking_eBS/?code=short-lived-code');
  assert.equal(target, 'https://overthinking-ebs.onrender.com/auth/callback?code=short-lived-code');
});

test('OAuth callback以外のURLはPrivate PvP画面を遷移させず、OAuth errorはRankedへ戻す', () => {
  assert.equal(runRecovery('https://evs-k.github.io/overthinking_eBS/'), null);
  assert.equal(runRecovery('https://evs-k.github.io/overthinking_eBS/?error=invalid_request'), 'https://overthinking-ebs.onrender.com/ranked?login=failed');
});
