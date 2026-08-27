(() => {
  'use strict';

  // The GitHub Pages legacy URL is now only a safe, static startup screen.
  // page-redirect.js wakes the backend first, avoiding an empty Render cold
  // start page and preventing a second Socket.IO bootstrap during that wait.
  if (window.__overthinkingLegacyStartup === true) return;

  let mainLoaded = false;
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const socketScript = document.createElement('script');
  socketScript.src = isLocalHost
    ? '/socket.io/socket.io.js'
    : 'https://overthinking-ebs.onrender.com/socket.io/socket.io.js';
  socketScript.defer = true;

  function loadMain() {
    if (mainLoaded) return;
    mainLoaded = true;
    const mainScript = document.createElement('script');
    mainScript.src = 'main.js?v=pvp-v19';
    mainScript.defer = true;
    document.head.append(mainScript);
  }

  socketScript.addEventListener('load', loadMain, { once: true });
  // Keep the landing page usable and show main.js's connection guidance if an
  // external game server is temporarily unavailable.
  socketScript.addEventListener('error', loadMain, { once: true });
  document.head.append(socketScript);
})();
