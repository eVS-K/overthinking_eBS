(() => {
  'use strict';

  // GitHub Pages cannot attach project-controlled response headers. Keep it
  // as a stable legacy URL, but run the interactive guest client only from
  // the backend origin, where CSP, anti-framing, HSTS and other headers are
  // enforced by server.js.
  if (window.location.hostname !== 'evs-k.github.io') return;

  let current;
  try {
    current = new URL(window.location.href);
  } catch {
    return;
  }

  // OAuth recovery must remain immediate. oauth-recovery.js, which follows
  // this file in index.html, forwards the short-lived code to /auth/callback.
  if (current.searchParams.has('code') || current.searchParams.has('error')) return;

  window.__overthinkingLegacyStartup = true;
  document.documentElement.classList.add('legacy-startup-pending');

  // A read-only preview makes this otherwise short-lived screen inspectable
  // without intentionally letting the production service fall asleep.
  if (current.searchParams.get('startup-preview') === '1') {
    const showPreview = () => setStatus('起動待ち画面の表示プレビューです。');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showPreview, { once: true });
    } else {
      showPreview();
    }
    return;
  }

  const target = new URL('https://overthinking-ebs.onrender.com/');
  target.search = current.search;
  target.hash = current.hash;
  const healthUrl = new URL('/health', target.origin);
  healthUrl.searchParams.set('legacyStartup', '1');

  function setStatus(message) {
    const status = document.getElementById('legacy-startup-status');
    if (status) status.textContent = message;
  }

  async function waitForBackend() {
    let attempts = 0;
    while (true) {
      attempts += 1;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await window.fetch(healthUrl, {
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          signal: controller.signal
        });
        if (response.ok) {
          window.location.replace(target.toString());
          return;
        }
      } catch {
        // The first request wakes a sleeping Render service. Retry quietly;
        // the visible page remains static and does not need the backend.
      } finally {
        window.clearTimeout(timeout);
      }
      setStatus(attempts >= 2 ? 'サーバーを準備しています。もう少しお待ちください…' : 'サーバーへ接続しています…');
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForBackend, { once: true });
  } else {
    waitForBackend();
  }
})();
