'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryRankedRepository } = require('./ranked-repository');
const {
  MAX_PRIVATE_PRESETS,
  PrivatePresetService,
  normalizePresetConfig,
  normalizePresetName
} = require('./private-preset-service');
const { RankedError } = require('./ranked-service');

const USER_A = '00000000-0000-4000-8000-000000000111';
const USER_B = '00000000-0000-4000-8000-000000000222';

const classicConfig = Object.freeze({ ruleset: 'classic-v1', turnTimeLimitMs: 90_000 });
const expandedConfig = Object.freeze({
  ruleset: 'private-expanded-v1',
  turnTimeLimitMs: 60_000,
  roundLimit: 7,
  scoreTarget: 9,
  blankEnabled: false,
  deck: [
    { definitionId: 'ace', copies: 1 },
    { definitionId: 'king', copies: 1 },
    { definitionId: 'queen', copies: 1 },
    { definitionId: 'jack', copies: 1 },
    { definitionId: 'joker', copies: 1 },
    { definitionId: 'three', copies: 1 },
    { definitionId: 'two', copies: 1 }
  ]
});

async function createService() {
  const repository = new MemoryRankedRepository();
  await repository.ensureProfile(USER_A);
  await repository.ensureProfile(USER_B);
  return { repository, service: new PrivatePresetService({ repository }) };
}

function assertCode(code) {
  return (error) => error instanceof RankedError && error.code === code;
}

test('Private設定プリセットは正規化済みの設定だけを最大10件まで本人に保存する', async () => {
  const { service } = await createService();
  const savedClassic = await service.createPreset(USER_A, { name: '  標準  ', config: classicConfig });
  const savedExpanded = await service.createPreset(USER_A, { name: 'Tarot練習', config: expandedConfig });

  assert.deepEqual(savedClassic.config, classicConfig);
  assert.deepEqual(savedExpanded.config, expandedConfig);
  assert.equal(Object.hasOwn(savedClassic, 'userId'), false);
  assert.equal(Object.hasOwn(savedClassic, 'slot'), false);
  assert.equal(Object.hasOwn(savedClassic, 'normalizedName'), false);
  assert.equal((await service.listPresets(USER_A)).length, 2);
  assert.deepEqual(await service.listPresets(USER_B), []);

  await assert.rejects(
    service.createPreset(USER_A, { name: '標準', config: classicConfig }),
    assertCode('PRIVATE_PRESET_NAME_TAKEN')
  );
  await assert.rejects(
    service.createPreset(USER_A, { name: 'zero\u200Bwidth', config: classicConfig }),
    assertCode('INVALID_PRIVATE_PRESET')
  );
  await assert.rejects(
    service.createPreset(USER_A, { name: 'bad', config: { ...classicConfig, serverOnly: true } }),
    assertCode('INVALID_PRIVATE_PRESET')
  );
  await assert.rejects(
    service.createPreset(USER_A, { name: 'bad deck', config: { ...expandedConfig, deck: [{ definitionId: 'unknown', copies: 1 }] } }),
    assertCode('INVALID_PRIVATE_PRESET')
  );
});

test('プリセットの上限、所有権、更新と削除はtransaction境界で保護される', async () => {
  const { repository, service } = await createService();
  const created = await Promise.all(Array.from({ length: MAX_PRIVATE_PRESETS }, (_unused, index) => (
    service.createPreset(USER_A, { name: `設定 ${index + 1}`, config: classicConfig })
  )));
  assert.equal((await service.listPresets(USER_A)).length, MAX_PRIVATE_PRESETS);
  await assert.rejects(
    service.createPreset(USER_A, { name: '11件目', config: classicConfig }),
    assertCode('PRIVATE_PRESET_LIMIT')
  );

  await assert.rejects(
    service.updatePreset(USER_B, created[0].id, { name: '奪取', config: classicConfig }),
    assertCode('PRIVATE_PRESET_NOT_FOUND')
  );
  await assert.rejects(service.deletePreset(USER_B, created[0].id), assertCode('PRIVATE_PRESET_NOT_FOUND'));

  const updated = await service.updatePreset(USER_A, created[0].id, { name: '更新済み', config: expandedConfig });
  assert.equal(updated.name, '更新済み');
  assert.deepEqual(updated.config, expandedConfig);
  await service.deletePreset(USER_A, created[1].id);
  assert.equal((await service.listPresets(USER_A)).length, MAX_PRIVATE_PRESETS - 1);
  const replacement = await service.createPreset(USER_A, { name: '空いた枠', config: classicConfig });
  assert.ok(replacement.id);

  repository.profiles.get(USER_A).status = 'banned';
  await assert.rejects(service.listPresets(USER_A), assertCode('PROFILE_UNAVAILABLE'));
});

test('プリセット名と設定は見えない文字・不正な既定値への丸めを許可しない', () => {
  assert.deepEqual(normalizePresetName('ＡＢＣ'), { name: 'ABC', normalizedName: 'abc' });
  assert.throws(() => normalizePresetName(' '.repeat(4)), assertCode('INVALID_PRIVATE_PRESET'));
  assert.throws(() => normalizePresetName('x'.repeat(33)), assertCode('INVALID_PRIVATE_PRESET'));
  assert.throws(() => normalizePresetConfig({ ruleset: 'classic-v1', turnTimeLimitMs: 15_000 }), assertCode('INVALID_PRIVATE_PRESET'));
  assert.throws(() => normalizePresetConfig({ ruleset: 'private-expanded-v1', turnTimeLimitMs: 90_000 }), assertCode('INVALID_PRIVATE_PRESET'));
});
