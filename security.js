'use strict';

function readPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().slice(0, 64);
  return /^[0-9a-f:.]+$/i.test(candidate) ? candidate.toLowerCase() : '';
}

function getClientIp(request = {}) {
  const forwarded = request.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedIp = typeof forwardedValue === 'string'
    ? normalizeIp(forwardedValue.split(',')[0])
    : '';
  if (forwardedIp) return forwardedIp;

  return normalizeIp(request.socket?.remoteAddress)
    || normalizeIp(request.connection?.remoteAddress)
    || normalizeIp(request.address)
    || 'unknown';
}

function createFixedWindowLimiter({ limit, windowMs, maxEntries = 5_000, now = () => Date.now() }) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('windowMs must be a positive integer');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');

  const entries = new Map();

  function prune(currentTime = now()) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= currentTime) entries.delete(key);
    }
  }

  function consume(key) {
    const currentTime = now();
    let entry = entries.get(key);

    if (entry && entry.resetAt <= currentTime) {
      entries.delete(key);
      entry = undefined;
    }

    if (!entry) {
      if (entries.size >= maxEntries) {
        prune(currentTime);
        if (entries.size >= maxEntries) return false;
      }
      entry = { count: 0, resetAt: currentTime + windowMs };
      entries.set(key, entry);
    }

    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  return {
    consume,
    prune,
    get size() { return entries.size; }
  };
}

module.exports = { createFixedWindowLimiter, getClientIp, readPositiveInteger };
