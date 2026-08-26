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

  function setStatus(message) {
    const status = document.getElementById('legacy-startup-status');
    if (status) status.textContent = message;
  }

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

  // The root Page used to own the probe itself. A narrow standalone gateway
  // has no game bundle, socket loader, or hidden screen state, so it remains
  // visibly available during a Render cold start even on cached deployments.
  const gateway = new URL('play.html', current.href);
  gateway.search = current.search;
  gateway.hash = current.hash;
  window.location.replace(gateway.toString());
})();
