(() => {
  'use strict';

  // Supabase normally returns directly to Render's /auth/callback. If its
  // redirect allow-list temporarily falls back to GitHub Pages, preserve the
  // normal secure flow by immediately forwarding the short-lived code and
  // opaque state to that same callback. The backend still verifies the
  // HttpOnly state cookie, PKCE, expiry, and one-time database transaction.
  const backendOrigin = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? window.location.origin
    : 'https://overthinking-ebs.onrender.com';

  let current;
  try {
    current = new URL(window.location.href);
  } catch {
    return;
  }
  const code = current.searchParams.get('code');
  const state = current.searchParams.get('state');
  if (typeof code !== 'string' || code.length < 1 || code.length > 2_048
    || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    return;
  }

  const callback = new URL('/auth/callback', backendOrigin);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);
  window.location.replace(callback.toString());
})();
