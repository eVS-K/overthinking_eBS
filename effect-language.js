'use strict';

// The effect language only classifies already-public effect *types*.  It is
// intentionally unable to retain card names, target IDs, action nonces, or
// any other state that could cross a recipient-specific visibility boundary.
// The result is shared by the static effect band and its short stage burst so
// future cards can add one semantic mapping instead of independent visuals.
(function exposeEffectLanguage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OverthinkingEffectLanguage = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  const EFFECT_CATEGORIES = Object.freeze({
    destroy: Object.freeze({
      id: 'destroy',
      symbol: '×',
      label: '破壊・移動',
      priority: 60,
      types: Object.freeze(['destroy-card', 'discard-won-cards', 'transfer-won-card'])
    }),
    lock: Object.freeze({
      id: 'lock',
      symbol: '⌁',
      label: 'ロック',
      priority: 50,
      types: Object.freeze(['lock-card', 'lock-cards'])
    }),
    noise: Object.freeze({
      id: 'noise',
      symbol: '?',
      label: 'ノイズ',
      priority: 40,
      types: Object.freeze(['add-noise-card'])
    }),
    generate: Object.freeze({
      id: 'generate',
      symbol: '✦',
      label: '追加・複製',
      priority: 30,
      types: Object.freeze(['add-card-copy', 'add-cards', 'copy-played-history'])
    }),
    round: Object.freeze({
      id: 'round',
      symbol: '↺',
      label: 'ラウンド変化',
      priority: 20,
      types: Object.freeze(['round-limit-adjustment'])
    }),
    skipped: Object.freeze({
      id: 'skipped',
      symbol: '—',
      label: '発動なし',
      priority: 10,
      types: Object.freeze(['skipped-target-action'])
    })
  });

  const TYPE_TO_CATEGORY = new Map(
    Object.values(EFFECT_CATEGORIES).flatMap((category) => category.types.map((type) => [type, category]))
  );

  function getPublicEffectPresentation(effects) {
    if (!Array.isArray(effects)) return Object.freeze({ primary: null, categories: Object.freeze([]) });
    const observed = new Set();
    for (const effect of effects) {
      const category = TYPE_TO_CATEGORY.get(effect?.type);
      if (category) observed.add(category);
    }
    const categories = [...observed].sort((first, second) => second.priority - first.priority || first.id.localeCompare(second.id));
    return Object.freeze({
      primary: categories[0] || null,
      categories: Object.freeze(categories)
    });
  }

  return Object.freeze({ EFFECT_CATEGORIES, getPublicEffectPresentation });
}));
