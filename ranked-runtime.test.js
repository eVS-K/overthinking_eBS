'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRankedRuntime } = require('./ranked-runtime');

test('Ranked設定がない場合はruntimeだけfail closedし、PvP起動を妨げない', () => {
  const notices = [];
  const runtime = createRankedRuntime({ environment: { NODE_ENV: 'test' }, logger: { warn: (message) => notices.push(message) } });
  assert.equal(runtime.available, false);
  assert.match(runtime.reason, /DATABASE_URL/);
  assert.deepEqual(notices, []);
});

test('value tableが検証不能ならRankedだけfail closedする', () => {
  const notices = [];
  const runtime = createRankedRuntime({
    environment: {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://ranked.test/database',
      APP_ORIGIN: 'https://ranked.test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'public',
      RANKED_SEED_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      RANKED_VALUES_FILE: 'C:/definitely-missing-ranked-values.json'
    },
    logger: { warn: (message) => notices.push(message) }
  });
  assert.equal(runtime.available, false);
  assert.match(runtime.reason, /value table/);
  assert.equal(notices.length, 1);
});
