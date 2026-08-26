(() => {
  'use strict';

  const current = new URL(window.location.href);
  const target = new URL('https://overthinking-ebs.onrender.com/');
  const healthUrl = new URL('/health', target.origin);
  const status = document.getElementById('play-gateway-status');
  let attempts = 0;

  // Preserve harmless navigation state, but never forward a gateway-only
  // cache-busting value or an OAuth response to the application origin.
  for (const [key, value] of current.searchParams) {
    if (key !== 'gateway' && key !== 'code' && key !== 'error') target.searchParams.set(key, value);
  }
  target.hash = current.hash;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  async function waitForBackend() {
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
      // The request itself wakes a sleeping Render service. The static page
      // remains visible until the next probe succeeds.
    } finally {
      window.clearTimeout(timeout);
    }
    setStatus(attempts >= 2 ? 'サーバーを準備しています。もう少しお待ちください…' : 'サーバーへ接続しています…');
    window.setTimeout(waitForBackend, 3_000);
  }

  waitForBackend();
})();
