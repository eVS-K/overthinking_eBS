'use strict';

// Presentation events are deliberately tiny.  They identify a *publicly
// observable* moment that may be animated, but never carry card contents,
// action candidates, player input, or any other game data.  Game authority
// stays on the server; this module only prevents a harmless UI effect from
// replaying after a redraw, reconnect, or duplicate payload.
(function exposePresentationEvents(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OverthinkingPresentationEvents = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  const DEFAULT_MAX_SEEN = 160;
  const MAX_SCOPE_LENGTH = 160;
  const MAX_EVENT_ID_LENGTH = 240;

  function normalizeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : '';
  }

  function normalizePriority(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 1_000 ? value : 0;
  }

  function normalizeEvent(event) {
    const id = normalizeText(event?.id, MAX_EVENT_ID_LENGTH);
    const kind = normalizeText(event?.kind, 80);
    if (!id || !kind) return null;
    // Do not retain arbitrary event payloads.  A future caller must opt into
    // an explicit, receiver-safe view before it can render any details.
    return Object.freeze({
      id,
      kind,
      priority: normalizePriority(event?.priority),
      exclusive: event?.exclusive === true
    });
  }

  function createPresentationEventQueue({ maxSeen = DEFAULT_MAX_SEEN } = {}) {
    const limit = Number.isSafeInteger(maxSeen) && maxSeen >= 8 && maxSeen <= 2_048
      ? maxSeen
      : DEFAULT_MAX_SEEN;
    let scopeId = '';
    let exclusivePriority = -1;
    const seen = new Map();

    function trimSeen() {
      while (seen.size > limit) {
        const oldest = seen.keys().next().value;
        seen.delete(oldest);
      }
    }

    function beginScope(nextScopeId) {
      const normalized = normalizeText(nextScopeId, MAX_SCOPE_LENGTH);
      if (!normalized) return { changed: false, valid: false, scopeId };
      if (normalized === scopeId) return { changed: false, valid: true, scopeId };
      scopeId = normalized;
      seen.clear();
      exclusivePriority = -1;
      return { changed: true, valid: true, scopeId };
    }

    function isBlocked(priority) {
      return exclusivePriority >= 0 && priority < exclusivePriority;
    }

    function claim(event, { animate = true } = {}) {
      const normalized = normalizeEvent(event);
      if (!normalized || !scopeId) {
        return Object.freeze({ accepted: false, observed: false, reason: 'invalid' });
      }
      if (seen.has(normalized.id)) {
        return Object.freeze({ accepted: false, observed: true, reason: 'duplicate', event: seen.get(normalized.id) });
      }

      const blocked = isBlocked(normalized.priority);
      seen.set(normalized.id, normalized);
      trimSeen();
      if (normalized.exclusive && !blocked) exclusivePriority = Math.max(exclusivePriority, normalized.priority);

      return Object.freeze({
        accepted: Boolean(animate) && !blocked,
        observed: true,
        reason: blocked ? 'suppressed' : (animate ? 'accepted' : 'hydrated'),
        event: normalized
      });
    }

    function inspect() {
      return Object.freeze({
        scopeId,
        exclusivePriority,
        seen: Object.freeze([...seen.values()])
      });
    }

    return Object.freeze({ beginScope, claim, isBlocked, inspect });
  }

  function prefersReducedMotion(win = typeof window === 'undefined' ? null : window) {
    try {
      return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  return Object.freeze({
    createPresentationEventQueue,
    normalizeEvent,
    prefersReducedMotion
  });
}));
