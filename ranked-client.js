(() => {
  'use strict';

  const CARD_INFO = Object.freeze({
    ace: ['Ace', '能力なし'], king: ['King', '能力なし'], queen: ['Queen', '能力なし'], jack: ['Jack', '能力なし'],
    joker: ['Joker', '相手の強さをコピー'], three: ['Three', 'Jokerに勝利'], two: ['Two', 'Aceに勝利']
  });
  const state = {
    profile: null,
    game: null,
    selectedCardId: null,
    pendingMove: null,
    retryMove: null,
    timer: null,
    timeoutRefreshInFlight: false,
    csrfCookieName: '__Host-overthinking-csrf',
    presentation: { gameId: null, status: null, roundKey: null, playerScore: null, aiScore: null }
  };
  const elements = Object.fromEntries([
    'ranked-loading', 'ranked-auth', 'ranked-auth-actions', 'ranked-auth-notice', 'ranked-dashboard', 'ranked-logout', 'ranked-auth-status', 'ranked-auth-status-label', 'ranked-start', 'ranked-empty-state', 'ranked-board',
    'ranked-postgame', 'ranked-game-status', 'ranked-round', 'ranked-timer', 'ranked-player-score', 'ranked-ai-score',
    'ranked-ai-remaining', 'ranked-stack', 'ranked-opponent-hand', 'ranked-player-hand', 'ranked-confirm', 'ranked-forfeit', 'ranked-instruction',
    'ranked-round-result', 'ranked-history-list', 'ranked-message', 'ranked-rating', 'ranked-rank', 'ranked-decision-ev',
    'ranked-games', 'ranked-record', 'ranked-provisional', 'ranked-provisional-note', 'ranked-handle-form', 'ranked-handle-input',
    'ranked-postgame-result', 'ranked-postgame-score', 'ranked-postgame-performance', 'ranked-postgame-regret', 'ranked-postgame-rating',
    'ranked-postgame-luck', 'ranked-seed-reveal', 'ranked-play-again', 'leaderboard-list', 'leaderboard-season', 'ranked-game-panel'
  ].map((id) => [id, document.getElementById(id)]));

  function setMessage(message = '') {
    elements['ranked-message'].textContent = message;
    elements['ranked-message'].classList.toggle('has-message', Boolean(message));
  }
  function setHidden(element, hidden) { element.classList.toggle('hidden', hidden); }
  function setAuthNotice(message = '', { blockSignIn = false } = {}) {
    elements['ranked-auth-notice'].textContent = message;
    setHidden(elements['ranked-auth-notice'], !message);
    setHidden(elements['ranked-auth-actions'], Boolean(message) && blockSignIn);
  }
  function cookies() {
    const result = {};
    for (const part of document.cookie.split(';')) {
      const index = part.indexOf('=');
      if (index < 1) continue;
      const name = part.slice(0, index).trim();
      try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* Ignore malformed third-party cookies. */ }
    }
    return result;
  }
  function csrfToken() { return cookies()[state.csrfCookieName] || ''; }
  function formatNumber(value, digits = 0) { return Number.isFinite(value) ? Number(value).toFixed(digits) : '—'; }
  function requestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) return '';
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function api(url, { method = 'GET', body, stateChanging = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (stateChanging) headers['X-CSRF-Token'] = csrfToken();
    const response = await fetch(url, {
      method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'リクエストを完了できませんでした。');
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function renderProfile(profile) {
    state.profile = profile;
    document.querySelectorAll('[data-profile-handle]').forEach((node) => { node.textContent = profile.handle; });
    elements['ranked-handle-input'].value = profile.handle;
    elements['ranked-rating'].textContent = profile.rating === null ? '—' : String(Math.round(profile.rating));
    elements['ranked-rank'].textContent = profile.rank ? `#${profile.rank}` : '—';
    elements['ranked-decision-ev'].textContent = profile.decisionEv === null ? '—' : formatNumber(profile.decisionEv, 4);
    elements['ranked-games'].textContent = String(profile.ratedGames);
    elements['ranked-record'].textContent = `W ${profile.wins} · D ${profile.draws} · L ${profile.losses}${profile.forfeits ? ` · F ${profile.forfeits}` : ''}`;
    elements['ranked-provisional'].textContent = profile.provisional ? 'PROVISIONAL' : `RANK #${profile.rank || '—'}`;
    elements['ranked-provisional-note'].textContent = profile.provisional
      ? `PROVISIONAL — ${profile.provisionalProgress} / 50`
      : `LEADERBOARD ELIGIBLE · N_eff ${formatNumber(profile.effectiveSampleSize, 1)}`;
    elements['ranked-auth-status-label'].textContent = `SIGNED IN · ${profile.handle}`;
    setHidden(elements['ranked-auth-status'], false);
  }

  function createCard(cardId) {
    const [name, description] = CARD_INFO[cardId] || [cardId, ''];
    const button = document.createElement('button');
    button.type = 'button';
    const committing = state.pendingMove?.cardId === cardId;
    button.className = `ranked-card${state.selectedCardId === cardId ? ' selected' : ''}${committing ? ' committing' : ''}`;
    button.setAttribute('aria-pressed', String(state.selectedCardId === cardId));
    button.disabled = Boolean(state.pendingMove);
    const top = document.createElement('span'); top.className = 'ranked-card-name'; top.textContent = name;
    const mark = document.createElement('span'); mark.className = 'ranked-card-mark'; mark.textContent = state.selectedCardId === cardId ? '✓' : '♠';
    const desc = document.createElement('small'); desc.textContent = description;
    button.append(top, mark, desc);
    button.addEventListener('click', () => {
      if (state.pendingMove || state.game?.status !== 'active') return;
      if (state.retryMove && state.retryMove.cardId !== cardId) state.retryMove = null;
      state.selectedCardId = state.selectedCardId === cardId ? null : cardId;
      if (!state.selectedCardId) state.retryMove = null;
      renderGame(state.game);
    });
    return button;
  }

  function createOpponentCard(cardId) {
    const [name, description] = CARD_INFO[cardId] || [cardId, ''];
    const card = document.createElement('span');
    card.className = 'ranked-opponent-card';
    card.textContent = name;
    card.title = description ? `${name} — ${description}` : name;
    return card;
  }

  function renderHistory(history = []) {
    const container = elements['ranked-history-list'];
    container.replaceChildren();
    if (!history.length) {
      const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '最初の勝負を待っています。'; container.append(empty); return;
    }
    [...history].reverse().forEach((round) => {
      const row = document.createElement('article'); row.className = `history-item${round.winner === 'draw' ? ' draw' : ''}`;
      const number = document.createElement('span'); number.className = 'history-round'; number.textContent = `R${round.round}`;
      const detail = document.createElement('div'); detail.className = 'history-detail';
      const title = document.createElement('strong');
      title.textContent = round.winner === 'player' ? 'YOU WIN' : round.winner === 'ai' ? 'RANDOM OPPONENT WINS' : 'DRAW · STACK';
      const cards = document.createElement('span');
      cards.textContent = `${CARD_INFO[round.playerCardId]?.[0] || round.playerCardId}  vs  ${CARD_INFO[round.aiCardId]?.[0] || round.aiCardId}${round.timeout ? ' · TIMEOUT' : ''}`;
      detail.append(title, cards); row.append(number, detail); container.append(row);
    });
  }

  function roundKey(game, lastRound) {
    return lastRound ? `${game.id}:${lastRound.round}:${lastRound.playerCardId}:${lastRound.aiCardId}` : null;
  }

  function updatePresentation(game) {
    if (!game) {
      state.presentation = { gameId: null, status: null, roundKey: null, playerScore: null, aiScore: null };
      return { isNewRound: false, isNewFinale: false, playerGain: 0, aiGain: 0 };
    }
    const last = game.history?.[game.history.length - 1];
    const nextRoundKey = roundKey(game, last);
    if (state.presentation.gameId !== game.id) {
      state.presentation = { gameId: game.id, status: game.status, roundKey: nextRoundKey, playerScore: game.playerScore, aiScore: game.aiScore };
      return { isNewRound: false, isNewFinale: false, playerGain: 0, aiGain: 0 };
    }
    const isNewRound = Boolean(last && state.presentation.roundKey !== nextRoundKey);
    const isNewFinale = state.presentation.status === 'active' && game.status !== 'active';
    const playerGain = isNewRound ? Math.max(0, game.playerScore - state.presentation.playerScore) : 0;
    const aiGain = isNewRound ? Math.max(0, game.aiScore - state.presentation.aiScore) : 0;
    state.presentation = { gameId: game.id, status: game.status, roundKey: nextRoundKey, playerScore: game.playerScore, aiScore: game.aiScore };
    return { isNewRound, isNewFinale, playerGain, aiGain };
  }

  function showScoreAward(scoreElement, gainedCards) {
    if (!gainedCards) return;
    const holder = scoreElement.parentElement;
    if (!holder) return;
    const award = document.createElement('span');
    award.className = 'ranked-score-award';
    award.textContent = `+${gainedCards}`;
    award.setAttribute('aria-hidden', 'true');
    holder.append(award);
    window.setTimeout(() => award.remove(), 1_100);
  }

  function updateScore(scoreElement, score, gainedCards) {
    scoreElement.textContent = String(score);
    if (!gainedCards) return;
    scoreElement.classList.remove('score-bump');
    window.requestAnimationFrame(() => scoreElement.classList.add('score-bump'));
    showScoreAward(scoreElement, gainedCards);
  }

  function triggerRoundImpact(winner) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const panel = elements['ranked-game-panel'];
    const impactClass = winner === 'player' ? 'round-impact-win' : winner === 'ai' ? 'round-impact-loss' : 'round-impact-draw';
    panel.classList.remove('round-impact-win', 'round-impact-loss', 'round-impact-draw');
    window.requestAnimationFrame(() => panel.classList.add(impactClass));
    window.setTimeout(() => panel.classList.remove(impactClass), 720);
  }

  function renderRoundResult(game, isNewRound) {
    const target = elements['ranked-round-result'];
    const last = game.history?.[game.history.length - 1];
    if (!last) {
      target.className = 'ranked-round-result hidden';
      target.replaceChildren();
      return;
    }
    const outcome = last.winner === 'player' ? 'won' : last.winner === 'ai' ? 'lost' : 'draw';
    target.className = `ranked-round-result round-${outcome}${isNewRound ? ' round-new' : ''}`;
    const line = document.createElement('strong');
    line.textContent = last.winner === 'player' ? 'YOU WIN THE ROUND' : last.winner === 'ai' ? 'RANDOM OPPONENT WINS THE ROUND' : 'DRAW — STACK GROWS';
    const duel = document.createElement('div');
    duel.className = 'ranked-duel';
    const playerCard = document.createElement('span');
    playerCard.className = 'ranked-duel-card ranked-duel-you';
    const playerLabel = document.createElement('small'); playerLabel.textContent = 'YOU';
    const playerName = document.createElement('b'); playerName.textContent = CARD_INFO[last.playerCardId]?.[0] || last.playerCardId;
    playerCard.append(playerLabel, playerName);
    const versus = document.createElement('i'); versus.textContent = 'VS'; versus.setAttribute('aria-hidden', 'true');
    const aiCard = document.createElement('span');
    aiCard.className = 'ranked-duel-card ranked-duel-ai';
    const aiLabel = document.createElement('small'); aiLabel.textContent = 'RANDOM OPPONENT';
    const aiName = document.createElement('b'); aiName.textContent = CARD_INFO[last.aiCardId]?.[0] || last.aiCardId;
    aiCard.append(aiLabel, aiName);
    duel.append(playerCard, versus, aiCard);
    const detail = document.createElement('span');
    detail.textContent = last.awardedCards
      ? `${last.awardedCards} CARDS AWARDED${last.timeout ? ' · TIMEOUT AUTO PICK' : ''}`
      : `STACK +2${last.timeout ? ' · TIMEOUT AUTO PICK' : ''}`;
    target.replaceChildren(line, duel, detail);
  }

  function renderGame(game) {
    state.game = game;
    clearTimer();
    const presentation = updatePresentation(game);
    const active = game?.status === 'active';
    setHidden(elements['ranked-empty-state'], Boolean(game));
    setHidden(elements['ranked-board'], !active);
    setHidden(elements['ranked-postgame'], !game || active);
    if (!game) { renderHistory([]); return; }
    renderHistory(game.history);
    renderRoundResult(game, presentation.isNewRound);
    if (presentation.isNewRound) triggerRoundImpact(game.history[game.history.length - 1].winner);
    if (active) {
      if (!game.playerHand.includes(state.selectedCardId)) state.selectedCardId = null;
      elements['ranked-game-status'].textContent = state.pendingMove ? 'SUBMITTING' : game.currentRound === 7 ? 'FINAL · 15 SEC' : 'IN PROGRESS';
      elements['ranked-round'].textContent = String(game.currentRound);
      updateScore(elements['ranked-player-score'], game.playerScore, presentation.playerGain);
      updateScore(elements['ranked-ai-score'], game.aiScore, presentation.aiGain);
      elements['ranked-ai-remaining'].textContent = String(game.aiRemainingCards);
      elements['ranked-stack'].textContent = String(game.stackCount);
      elements['ranked-opponent-hand'].replaceChildren(...(game.opponentHand || []).map(createOpponentCard));
      elements['ranked-player-hand'].replaceChildren(...game.playerHand.map(createCard));
      elements['ranked-confirm'].disabled = !state.selectedCardId || Boolean(state.pendingMove);
      elements['ranked-forfeit'].disabled = Boolean(state.pendingMove);
      elements['ranked-instruction'].textContent = state.pendingMove
        ? 'サーバーが勝負を確定しています…'
        : game.currentRound === 7
          ? 'FINAL ROUND — 残りの一枚で勝負します。15秒以内に確定してください。'
          : '一枚を選び、ランダムの相手に挑んでください。';
      startTimer(game.deadline); return;
    }
    const finalOutcome = game.actualResult === 'win' ? 'win' : game.actualResult === 'draw' ? 'draw' : game.actualResult === 'forfeit' ? 'forfeit' : 'loss';
    elements['ranked-postgame'].className = `ranked-postgame match-${finalOutcome}${presentation.isNewFinale ? ' match-new' : ''}`;
    elements['ranked-game-status'].textContent = game.status === 'forfeited' ? 'FORFEITED' : 'MATCH COMPLETE';
    elements['ranked-postgame-result'].textContent = finalOutcome === 'win' ? 'MATCH WON' : finalOutcome === 'draw' ? 'MATCH DRAW' : finalOutcome === 'forfeit' ? 'MATCH FORFEITED' : 'MATCH LOST';
    elements['ranked-postgame-score'].textContent = `${game.playerScore} — ${game.aiScore}`;
    elements['ranked-postgame-performance'].textContent = formatNumber(game.decisionPerformance, 4);
    elements['ranked-postgame-regret'].textContent = formatNumber(game.totalRegret, 4);
    elements['ranked-postgame-rating'].textContent = `${Math.round(game.ratingBefore ?? 1000)} → ${Math.round(game.ratingAfter ?? 1000)}`;
    elements['ranked-postgame-luck'].textContent = `${game.luck >= 0 ? '+' : ''}${formatNumber(game.luck, 4)}`;
    elements['ranked-seed-reveal'].textContent = game.seed ? `Random seed revealed for replay verification: ${game.seed}` : '';
  }

  function clearTimer() { if (state.timer) window.clearInterval(state.timer); state.timer = null; }
  function startTimer(deadline) {
    const update = () => {
      const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1_000));
      elements['ranked-timer'].textContent = String(seconds);
      if (seconds === 0 && !state.timeoutRefreshInFlight) {
        state.timeoutRefreshInFlight = true;
        refreshActiveGame().finally(() => { state.timeoutRefreshInFlight = false; });
      }
    };
    update(); state.timer = window.setInterval(update, 500);
  }

  async function refreshActiveGame() {
    try { const result = await api('/api/ranked/games/active'); renderGame(result.game); if (result.game?.status !== 'active') await refreshProfile(); } catch (error) { setMessage(error.message); }
  }
  async function refreshProfile() {
    const result = await api('/api/profile'); renderProfile(result.profile);
  }
  async function refreshLeaderboard() {
    try {
      const leaderboard = await api('/api/leaderboard?limit=25&offset=0');
      elements['leaderboard-season'].textContent = leaderboard.season?.id ? 'CURRENT SEASON' : 'UNAVAILABLE';
      const list = elements['leaderboard-list']; list.replaceChildren();
      if (!leaderboard.entries?.length) {
        const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = 'まだeligibleなプロフィールがありません。'; list.append(empty); return;
      }
      leaderboard.entries.forEach((entry) => {
        const row = document.createElement('article'); row.className = 'leaderboard-row';
        const rank = document.createElement('strong'); rank.textContent = `#${entry.rank}`;
        const handle = document.createElement('span'); handle.textContent = entry.handle;
        const rating = document.createElement('span'); rating.textContent = String(Math.round(entry.rating));
        const ev = document.createElement('small'); ev.textContent = `EV ${formatNumber(entry.decisionEv, 4)} · ${entry.ratedGames} GAMES`;
        row.append(rank, handle, rating, ev); list.append(row);
      });
    } catch (error) { elements['leaderboard-list'].textContent = error.message; }
  }

  async function startGame() {
    try { setMessage('Ranked gameを準備しています…'); const result = await api('/api/ranked/games', { method: 'POST', body: {}, stateChanging: true }); state.selectedCardId = null; state.retryMove = null; renderGame(result.game); setMessage(''); } catch (error) { setMessage(error.message); }
  }
  async function submitMove() {
    if (!state.game || !state.selectedCardId || state.pendingMove) return;
    const retry = state.retryMove;
    const proposal = retry && retry.gameId === state.game.id && retry.expectedRound === state.game.currentRound && retry.cardId === state.selectedCardId
      ? retry
      : { gameId: state.game.id, expectedRound: state.game.currentRound, cardId: state.selectedCardId, requestId: requestId() };
    if (!proposal.requestId) { setMessage('このブラウザでは安全な送信IDを作成できません。最新のブラウザでお試しください。'); return; }
    state.retryMove = null;
    state.pendingMove = proposal;
    renderGame(state.game);
    try {
      // gameId belongs exclusively in the URL.  The Ranked API deliberately
      // accepts only the three decision fields in the JSON body, so never
      // leak this local retry bookkeeping field into the request payload.
      const moveBody = {
        expectedRound: state.pendingMove.expectedRound,
        cardId: state.pendingMove.cardId,
        requestId: state.pendingMove.requestId
      };
      const result = await api(`/api/ranked/games/${state.pendingMove.gameId}/moves`, { method: 'POST', body: moveBody, stateChanging: true });
      state.pendingMove = null; state.retryMove = null; state.selectedCardId = null; renderGame(result.game); await refreshProfile(); await refreshLeaderboard();
    } catch (error) {
      if (error.details?.game) {
        state.pendingMove = null; state.retryMove = null; state.selectedCardId = null; renderGame(error.details.game);
      } else {
        // Retain the exact idempotency key so a transport failure can be retried
        // without risking a second server-side decision.
        state.retryMove = state.pendingMove;
        state.pendingMove = null;
        renderGame(state.game);
      }
      setMessage(error.message);
    }
  }
  async function forfeit() {
    if (!state.game || state.pendingMove || !window.confirm('このRanked gameをforfeitしますか？ Ratingには0として記録されます。')) return;
    try { const result = await api(`/api/ranked/games/${state.game.id}/forfeit`, { method: 'POST', body: {}, stateChanging: true }); state.pendingMove = null; state.retryMove = null; renderGame(result.game); await refreshProfile(); await refreshLeaderboard(); } catch (error) { setMessage(error.message); }
  }
  async function updateHandle(event) {
    event.preventDefault();
    const handle = elements['ranked-handle-input'].value;
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(handle)) {
      setMessage('PUBLIC HANDLEは3〜20文字の半角英数字、_、-のみです。空白・改行・不可視文字は使用できません。');
      return;
    }
    try { const result = await api('/api/profile', { method: 'PATCH', body: { handle }, stateChanging: true }); renderProfile(result.profile); setMessage('公開handleを更新しました。'); } catch (error) { setMessage(error.message); }
  }
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST', body: {}, stateChanging: true }); window.location.assign('/ranked'); } catch (error) { setMessage(error.message); }
  }
  async function boot() {
    try {
      const me = await api('/api/auth/me');
      state.csrfCookieName = me.csrfCookieName || state.csrfCookieName;
      setAuthNotice(''); renderProfile(me.profile); setHidden(elements['ranked-loading'], true); setHidden(elements['ranked-dashboard'], false); setHidden(elements['ranked-logout'], false);
      await refreshActiveGame(); await refreshLeaderboard();
    } catch (error) {
      setHidden(elements['ranked-loading'], true);
      setHidden(elements['ranked-auth'], false);
      setHidden(elements['ranked-auth-status'], true);
      const loginFailed = new URL(window.location.href).searchParams.get('login') === 'failed';
      if (error.code === 'RANKED_UNAVAILABLE') {
        setAuthNotice('Rankedは現在、準備中または一時停止中です。Guest PvPは通常どおり利用できます。', { blockSignIn: true });
      } else if (loginFailed) {
        setAuthNotice('サインインを完了できませんでした。もう一度GoogleまたはGitHubでお試しください。');
      } else if (error.status !== 401) {
        setAuthNotice('認証状態を確認できませんでした。時間をおいて再試行してください。');
        setMessage(error.message);
      }
      await refreshLeaderboard();
    }
  }
  elements['ranked-start'].addEventListener('click', startGame);
  elements['ranked-play-again'].addEventListener('click', startGame);
  elements['ranked-confirm'].addEventListener('click', submitMove);
  elements['ranked-forfeit'].addEventListener('click', forfeit);
  elements['ranked-handle-form'].addEventListener('submit', updateHandle);
  elements['ranked-logout'].addEventListener('click', logout);
  window.addEventListener('beforeunload', clearTimer);
  boot();
})();
