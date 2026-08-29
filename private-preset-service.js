'use strict';

const crypto = require('crypto');
const { RankedError } = require('./ranked-service');
const { createPrivateRoomConfig } = require('./private-room-config');
const {
  CLASSIC_PRIVATE_RULESET_ID,
  EXPANDED_PRIVATE_RULESET_ID,
  isSupportedPrivateTurnTimeLimit
} = require('./private-ruleset');

const MAX_PRIVATE_PRESETS = 10;
const MAX_PRIVATE_PRESET_NAME_LENGTH = 32;
const PRESET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, code = 'INVALID_PRIVATE_PRESET') {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new RankedError(400, code, 'Preset contains unsupported fields.');
  }
}

function normalizePresetName(value) {
  if (typeof value !== 'string') {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset name must be text.');
  }
  const name = value.normalize('NFKC').trim();
  // Controls, format characters (including zero-width characters), surrogates
  // and unassigned code points make names hard to review or distinguish.
  if (!name || /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}]/u.test(name)) {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset name contains unsupported characters.');
  }
  const normalizedName = name.toLocaleLowerCase('en-US');
  // Case-folding can very occasionally expand a Unicode sequence.  Validate
  // the value that is actually persisted as well as the display value, so it
  // always fits the database column and a duplicate lookup remains stable.
  if ([...name].length > MAX_PRIVATE_PRESET_NAME_LENGTH
    || [...normalizedName].length > MAX_PRIVATE_PRESET_NAME_LENGTH) {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', `Preset name must be ${MAX_PRIVATE_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  return { name, normalizedName };
}

function normalizePresetConfig(value) {
  if (!isPlainObject(value)) {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset settings must be an object.');
  }
  const ruleset = value.ruleset;
  if (ruleset === CLASSIC_PRIVATE_RULESET_ID) {
    assertExactKeys(value, ['ruleset', 'turnTimeLimitMs']);
    if (!isSupportedPrivateTurnTimeLimit(value.turnTimeLimitMs)) {
      throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset has an unsupported turn time.');
    }
  } else if (ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    assertExactKeys(value, ['ruleset', 'turnTimeLimitMs', 'roundLimit', 'scoreTarget', 'blankEnabled', 'deck']);
    if (!isSupportedPrivateTurnTimeLimit(value.turnTimeLimitMs)
      || !Number.isSafeInteger(value.roundLimit)
      || (value.scoreTarget !== null && !Number.isSafeInteger(value.scoreTarget))
      || typeof value.blankEnabled !== 'boolean'
      || !Array.isArray(value.deck)) {
      throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset settings have invalid values.');
    }
  } else {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset has an unsupported ruleset.');
  }

  let config;
  try {
    config = createPrivateRoomConfig(value);
  } catch {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset settings are not supported by the current Private rules.');
  }

  // Store a deliberately small replayable snapshot.  Server-only derived
  // values (catalogue, lock state, revision, timeout policy) are recalculated
  // by the authoritative Private-room update path when the user applies it.
  if (config.ruleset === CLASSIC_PRIVATE_RULESET_ID) {
    return { ruleset: config.ruleset, turnTimeLimitMs: config.turnTimeLimitMs };
  }
  return {
    ruleset: config.ruleset,
    turnTimeLimitMs: config.turnTimeLimitMs,
    roundLimit: config.roundLimit,
    scoreTarget: config.scoreTarget,
    blankEnabled: config.blankEnabled,
    deck: config.deck.map(({ definitionId, copies }) => ({ definitionId, copies }))
  };
}

function normalizePresetPayload(payload) {
  assertExactKeys(payload, ['name', 'config']);
  return {
    ...normalizePresetName(payload.name),
    config: normalizePresetConfig(payload.config)
  };
}

function assertPresetId(value) {
  if (typeof value !== 'string' || !PRESET_ID_PATTERN.test(value)) {
    throw new RankedError(400, 'INVALID_PRIVATE_PRESET', 'Preset identifier is invalid.');
  }
  return value.toLowerCase();
}

function publicPreset(preset) {
  if (!preset) return null;
  return {
    id: preset.id,
    name: preset.name,
    config: preset.config,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt
  };
}

function profileIsActive(profile) {
  if (!profile || profile.status !== 'active') {
    throw new RankedError(403, 'PROFILE_UNAVAILABLE', 'This account cannot use saved Private settings.');
  }
  return profile;
}

function duplicateNameError(error) {
  if (error?.code === '23505') {
    return new RankedError(409, 'PRIVATE_PRESET_NAME_TAKEN', 'A preset with this name already exists.');
  }
  return error;
}

class PrivatePresetService {
  constructor({ repository }) {
    if (!repository) throw new TypeError('private preset repository is required');
    this.repository = repository;
  }

  async listPresets(userId) {
    return this.repository.transaction(async (tx) => {
      profileIsActive(await tx.getProfile(userId));
      return (await tx.listPrivatePresets(userId)).map(publicPreset);
    });
  }

  async createPreset(userId, payload) {
    const value = normalizePresetPayload(payload);
    try {
      return await this.repository.transaction(async (tx) => {
        profileIsActive(await tx.getProfile(userId, { forUpdate: true }));
        const count = await tx.countPrivatePresets(userId);
        if (count >= MAX_PRIVATE_PRESETS) {
          throw new RankedError(409, 'PRIVATE_PRESET_LIMIT', `You can save up to ${MAX_PRIVATE_PRESETS} Private presets.`);
        }
        if (await tx.findPrivatePresetByNormalizedName(userId, value.normalizedName)) {
          throw new RankedError(409, 'PRIVATE_PRESET_NAME_TAKEN', 'A preset with this name already exists.');
        }
        const slot = await tx.findAvailablePrivatePresetSlot(userId);
        if (!Number.isSafeInteger(slot)) {
          throw new RankedError(409, 'PRIVATE_PRESET_LIMIT', `You can save up to ${MAX_PRIVATE_PRESETS} Private presets.`);
        }
        const preset = await tx.createPrivatePreset({
          id: crypto.randomUUID(),
          userId,
          slot,
          ...value
        });
        return publicPreset(preset);
      });
    } catch (error) {
      throw duplicateNameError(error);
    }
  }

  async updatePreset(userId, id, payload) {
    const presetId = assertPresetId(id);
    const value = normalizePresetPayload(payload);
    try {
      return await this.repository.transaction(async (tx) => {
        profileIsActive(await tx.getProfile(userId, { forUpdate: true }));
        const existing = await tx.findPrivatePresetById(userId, presetId);
        if (!existing) {
          throw new RankedError(404, 'PRIVATE_PRESET_NOT_FOUND', 'Saved Private preset was not found.');
        }
        const sameName = await tx.findPrivatePresetByNormalizedName(userId, value.normalizedName);
        if (sameName && sameName.id !== presetId) {
          throw new RankedError(409, 'PRIVATE_PRESET_NAME_TAKEN', 'A preset with this name already exists.');
        }
        const updated = await tx.updatePrivatePreset(userId, presetId, value);
        if (!updated) {
          throw new RankedError(404, 'PRIVATE_PRESET_NOT_FOUND', 'Saved Private preset was not found.');
        }
        return publicPreset(updated);
      });
    } catch (error) {
      throw duplicateNameError(error);
    }
  }

  async deletePreset(userId, id) {
    const presetId = assertPresetId(id);
    return this.repository.transaction(async (tx) => {
      profileIsActive(await tx.getProfile(userId, { forUpdate: true }));
      const deleted = await tx.deletePrivatePreset(userId, presetId);
      if (!deleted) {
        throw new RankedError(404, 'PRIVATE_PRESET_NOT_FOUND', 'Saved Private preset was not found.');
      }
      return publicPreset(deleted);
    });
  }
}

module.exports = {
  MAX_PRIVATE_PRESETS,
  MAX_PRIVATE_PRESET_NAME_LENGTH,
  PrivatePresetService,
  assertPresetId,
  normalizePresetConfig,
  normalizePresetName,
  normalizePresetPayload,
  publicPreset
};
