(() => {
  'use strict';

  // Supabase normally returns directly to Render's /auth/callback. If its
  // redirect allow-list temporarily falls back to GitHub Pages, preserve the
  // normal secure flow by immediately forwarding the short-lived code to that
  // same callback. The backend still verifies its HttpOnly transaction cookie,
  // PKCE, expiry, and one-time database transaction.
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
  if (typeof code !== 'string' || code.length < 1 || code.length > 2_048) {
    // Do not leave an OAuth provider error looking like a Private PvP page.
    if (current.searchParams.has('error')) {
      window.location.replace(new URL('/ranked?login=failed', backendOrigin).toString());
    }
    return;
  }

  const callback = new URL('/auth/callback', backendOrigin);
  callback.searchParams.set('code', code);
  window.location.replace(callback.toString());
})();
