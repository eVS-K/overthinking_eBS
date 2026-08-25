'use strict';

/**
 * Bounded FIFO queue for anonymous random matches.
 *
 * The queue intentionally contains only ephemeral socket/session metadata.
 * Game state continues to live in server.js once a pair is formed.
 */
class RandomMatchQueue {
  constructor({ maxEntries = 200, maxAgeMs = 10 * 60_000 } = {}) {
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  has(clientId) {
    return this.entries.has(clientId);
  }

  enqueue(entry, now = Date.now()) {
    if (!entry || typeof entry.clientId !== 'string' || !entry.clientId) {
      return { ok: false, reason: 'invalid' };
    }

    const existing = this.entries.get(entry.clientId);
    if (!existing && this.entries.size >= this.maxEntries) {
      return { ok: false, reason: 'full' };
    }

    this.entries.set(entry.clientId, {
      ...entry,
      enqueuedAt: existing?.enqueuedAt ?? entry.enqueuedAt ?? now,
      lastSeenAt: now
    });
    return { ok: true, updated: Boolean(existing) };
  }

  remove(clientId) {
    const entry = this.entries.get(clientId) || null;
    if (entry) this.entries.delete(clientId);
    return entry;
  }

  removeBySocket(socketId) {
    for (const [clientId, entry] of this.entries) {
      if (entry.socketId !== socketId) continue;
      this.entries.delete(clientId);
      return entry;
    }
    return null;
  }

  takeNext(isAvailable = () => true) {
    for (const [clientId, entry] of this.entries) {
      this.entries.delete(clientId);
      if (isAvailable(entry)) return entry;
    }
    return null;
  }

  countByIp(ip) {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.ip === ip) count += 1;
    }
    return count;
  }

  // A queue entry is a short-lived lease, not a permanent reservation.  An
  // optional availability predicate additionally reclaims disconnected or
  // superseded sockets.  Callers can notify a still-connected user when an
  // otherwise valid lease expires instead of leaving their UI stuck.
  prune(isAvailableOrNow = Date.now(), suppliedNow = Date.now(), onRemove = null) {
    const hasAvailabilityCheck = typeof isAvailableOrNow === 'function';
    const isAvailable = hasAvailabilityCheck ? isAvailableOrNow : null;
    const now = hasAvailabilityCheck ? suppliedNow : isAvailableOrNow;
    let removed = 0;
    for (const [clientId, entry] of this.entries) {
      const unavailable = hasAvailabilityCheck && !isAvailable(entry);
      const expired = now - entry.lastSeenAt > this.maxAgeMs;
      if (!unavailable && !expired) continue;
      this.entries.delete(clientId);
      if (typeof onRemove === 'function') onRemove(entry, unavailable ? 'unavailable' : 'expired');
      removed += 1;
    }
    return removed;
  }
}

module.exports = { RandomMatchQueue };
