(() => {
  'use strict';

  // GitHub Pages cannot attach project-controlled response headers. Keep it
  // as a stable legacy URL, but run the interactive guest client only from
  // the backend origin, where CSP, anti-framing, HSTS and other headers are
  // enforced by server.js.
  if (window.location.hostname !== 'evs-k.github.io') return;

  const target = new URL('https://overthinking-ebs.onrender.com/');
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.toString());
})();
