import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, remove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const E = window.PokerEngine;
const $ = (id) => document.getElementById(id);

// ====================================================================
// DEBUG LOG
// A per-device trace from "room created" through "cards showing," kept in
// localStorage so it survives a reload. It resets to a fresh, empty log
// every time a hand completes successfully — so if the game ever gets
// stuck, whatever's in this log at that moment is exactly (and only) the
// sequence of events that led to the stuck state, not noise from many
// past successful hands. Accessible via Menu -> Copy debug log.
// ====================================================================
const DEBUG_LOG_KEY = 'familyHoldem.debugLog.v1';
let debugLog = [];
try {
  const raw = localStorage.getItem(DEBUG_LOG_KEY);
  if (raw) debugLog = JSON.parse(raw);
} catch (e) { /* ignore */ }

function logEvent(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugLog.push(line);
  if (debugLog.length > 300) debugLog = debugLog.slice(-300);
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); } catch (e) { /* ignore */ }
}
function resetDebugLog(reason) {
  debugLog = [`[${new Date().toLocaleTimeString()}] --- log reset: ${reason} ---`];
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); } catch (e) { /* ignore */ }
}

// Best-effort orientation lock. Supported on Android Chrome (typically only
// while running installed/standalone, which is exactly our PWA case) — not
// supported at all on iOS Safari, where the CSS rotate-overlay is the real
// fallback. Wrapped defensively since this API is inconsistent across
// browsers and throws in several unsupported configurations.
if (screen.orientation && screen.orientation.lock) {
  screen.orientation.lock('portrait').catch(() => { /* not supported here — the CSS overlay covers it */ });
}

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);

const SESSION_KEY = 'familyHoldem.session.v1';
const PROFILE_KEY = 'familyHoldem.profile.v1';
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ myName, myPhoto })); } catch (e) { /* ignore */ }
}
function loadProfile() {
  try { const raw = localStorage.getItem(PROFILE_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, myName, myPhoto, isHost }));
  } catch (e) { /* ignore */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

let myUid = null;
let roomCode = null;
let isHost = false;
let myName = '';
let myPhoto = null;
let myHole = null;

let playersCache = {};     // uid -> {name, photo, chips, seatIndex, out}
let metaCache = null;
let handCache = null;

let hostDeck = null;       // only populated on the host's device, per active hand
let hostSettling = false;  // guards against re-entrant settlement work
let breakRequestsCache = {};

function initialsFor(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}
function cardHTML(card) {
  const red = E.RED_SUITS.includes(card.suit);
  return `<div class="card${red ? ' red' : ''}">${E.rankLabel(card.rank)}<span class="suit">${E.SUIT_SYMBOL[card.suit]}</span></div>`;
}
function cardBackHTML() { return `<div class="card back"></div>`; }
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}
function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ====================================================================
// AUTH
// ====================================================================
// Room creation needs a real, verified identity (Google sign-in), checked
// against the family allowlist. This uses a popup, not a redirect —
// modern Chrome and Safari now block the background storage check that
// Firebase's redirect flow depends on (a broad privacy restriction, not
// specific to us), which made redirect unreliable across the board, not
// just here. Popup is the solid choice for a normal browser tab.
//
// The one case popup can't fix: iOS's "Add to Home Screen" mode runs the
// page in an isolated standalone container that Google's sign-in refuses
// to run inside at all — this is a deliberate Google/Apple platform
// restriction, not a bug, and there's no reliable client-side workaround.
// So for that specific case, we detect it up front and tell the person
// plainly to use regular Safari instead, rather than let them hit a
// confusing silent failure.
function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

onAuthStateChanged(auth, (user) => { if (user) myUid = user.uid; });

async function bootstrapAuth() {
  logEvent('App loaded, checking auth state');
  if (auth.currentUser) {
    myUid = auth.currentUser.uid;
    await tryAutoRejoin();
  } else {
    try {
      await signInAnonymously(auth);
    } catch (e) {
      $('landing-error').textContent = 'Could not connect (sign-in failed): ' + e.message;
    }
  }
}
bootstrapAuth();

async function tryAutoRejoin() {
  const saved = loadSession();
  if (!saved || !saved.roomCode) return;
  try {
    const metaSnap = await get(ref(db, `rooms/${saved.roomCode}/meta`));
    const playerSnap = await get(ref(db, `rooms/${saved.roomCode}/players/${myUid}`));
    if (!metaSnap.exists() || !playerSnap.exists()) { clearSession(); return; }

    roomCode = saved.roomCode;
    myName = saved.myName;
    myPhoto = saved.myPhoto;
    isHost = metaSnap.val().hostUid === myUid;
    logEvent('Auto-rejoined room ' + roomCode);
    enterLobby();
  } catch (e) {
    // couldn't confirm the room still exists — fall back to the landing screen
    clearSession();
  }
}

// ====================================================================
// LANDING SCREEN
// ====================================================================
(function prefillProfile() {
  const saved = loadProfile();
  if (!saved) return;
  if (saved.myName) { myName = saved.myName; $('me-name').value = myName; }
  if (saved.myPhoto) { myPhoto = saved.myPhoto; }
  $('me-avatar').innerHTML = myPhoto ? `<img src="${myPhoto}" alt="">` : initialsFor(myName);
})();

$('me-avatar').addEventListener('click', () => $('me-photo-input').click());
$('me-photo-input').addEventListener('change', () => {
  const file = $('me-photo-input').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    myPhoto = reader.result;
    $('me-avatar').innerHTML = `<img src="${myPhoto}" alt="">`;
    saveProfile();
  };
  reader.readAsDataURL(file);
});
$('me-name').addEventListener('input', () => {
  myName = $('me-name').value;
  if (!myPhoto) $('me-avatar').textContent = initialsFor(myName);
  saveProfile();
});

$('btn-create-room').addEventListener('click', async () => {
  const err = $('landing-error');
  err.textContent = '';
  if (!myName.trim()) { err.textContent = 'Enter your name first.'; return; }

  if (isStandalonePwa() && !(auth.currentUser && !auth.currentUser.isAnonymous)) {
    err.textContent = 'Google sign-in can\u2019t run from the home-screen icon (an Apple/Google restriction, not a bug). Open this same link in regular Safari or Chrome to create a table \u2014 you can switch back to the home-screen icon afterward to actually play.';
    return;
  }

  const params = {
    startingChips: Math.max(10, parseInt($('input-starting-chips').value, 10) || 500),
    smallBlind: Math.max(1, parseInt($('input-small-blind').value, 10) || 5),
    bigBlind: 0,
    raiseBlinds: $('input-raise-blinds').checked,
    myName: myName.trim(),
    myPhoto,
  };
  params.bigBlind = Math.max(params.smallBlind + 1, parseInt($('input-big-blind').value, 10) || params.smallBlind * 2);

  let googleUser;
  if (auth.currentUser && !auth.currentUser.isAnonymous) {
    googleUser = auth.currentUser; // already verified earlier this session — no need to prompt again
  } else {
    err.textContent = 'Confirming you\u2019re on the family hosting list\u2026';
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      googleUser = result.user;
    } catch (e) {
      logEvent('ERROR: popup sign-in failed — ' + (e.code || e.message));
      err.textContent = 'Google sign-in didn\u2019t go through. (' + (e.code || e.message) + ')';
      return;
    }
  }

  myUid = googleUser.uid;
  await actuallyCreateRoom(googleUser, params);
});

async function actuallyCreateRoom(googleUser, params) {
  const err = $('landing-error');
  myName = params.myName;
  myPhoto = params.myPhoto;
  roomCode = makeRoomCode();
  isHost = true;
  myUid = googleUser.uid;

  try {
    await set(ref(db, `rooms/${roomCode}/meta`), {
      hostUid: myUid,
      started: false,
      handNumber: 0,
      smallBlind: params.smallBlind, bigBlind: params.bigBlind, raiseBlinds: params.raiseBlinds,
      startingChips: params.startingChips,
      buttonUid: null,
      createdAt: Date.now(),
    });
  } catch (e) {
    logEvent('Room creation REJECTED for ' + googleUser.email + ' — not on allowlist');
    err.textContent = `${googleUser.email} isn\u2019t on the approved hosting list — ask whoever manages the family list to add it.`;
    await signOut(auth);
    await signInAnonymously(auth); // restore a normal identity so this device can still join as a player
    return;
  }

  await set(ref(db, `rooms/${roomCode}/players/${myUid}`), {
    name: myName.trim(), photo: myPhoto, chips: params.startingChips, seatIndex: 0, out: false,
  });

  logEvent('Room ' + roomCode + ' created, I am host');
  err.textContent = '';
  saveSession();
  enterLobby();
}

$('btn-join-room').addEventListener('click', async () => {
  const err = $('landing-error');
  err.textContent = '';
  if (!myUid) { err.textContent = 'Still connecting — try again in a second.'; return; }
  if (!myName.trim()) { err.textContent = 'Enter your name first.'; return; }
  const code = $('input-join-code').value.trim().toUpperCase();
  if (!code) { err.textContent = 'Enter a room code.'; return; }

  const metaSnap = await get(ref(db, `rooms/${code}/meta`));
  if (!metaSnap.exists()) { err.textContent = 'No table found with that code.'; return; }
  const meta = metaSnap.val();

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const existing = playersSnap.exists() ? playersSnap.val() : {};
  if (Object.keys(existing).length >= 10) { err.textContent = 'That table is full (10 players max).'; return; }
  // Note: no block on meta.started here — joining mid-game is allowed. The
  // new player is added to the room now but won't be part of any hand
  // already in progress (seats for the current hand were fixed at deal
  // time); they're picked up automatically starting with the next hand,
  // since dealNewHand() re-reads the live player list every time it runs.

  roomCode = code;
  isHost = (meta.hostUid === myUid);

  await set(ref(db, `rooms/${roomCode}/players/${myUid}`), {
    name: myName.trim(), photo: myPhoto, chips: meta.startingChips, seatIndex: Object.keys(existing).length, out: false,
  });

  saveSession();
  logEvent('Joined room ' + roomCode);
  enterLobby();
});

// ====================================================================
// LOBBY
// ====================================================================
function enterLobby() {
  showScreen('lobby');
  $('lobby-code').textContent = roomCode;
  $('lobby-link-hint').textContent = `Share this page's link + code "${roomCode}" with the family.`;
  $('lobby-host-controls').classList.toggle('hidden', !isHost);
  $('lobby-guest-note').classList.toggle('hidden', isHost);

  onValue(ref(db, `rooms/${roomCode}/meta`), (snap) => {
    metaCache = snap.val();
    if (!metaCache) return;
    const wasHost = isHost;
    isHost = metaCache.hostUid === myUid;
    if (metaCache.started) {
      showScreen('table');
      attachTableListeners();
    } else {
      $('lobby-host-controls').classList.toggle('hidden', !isHost);
      $('lobby-guest-note').classList.toggle('hidden', isHost);
    }
    if (wasHost !== isHost) logEvent(isHost ? 'This device is now the host' : 'Host duties transferred away from this device');
    renderTable();
  });

  onValue(ref(db, `rooms/${roomCode}/players`), (snap) => {
    playersCache = snap.val() || {};
    renderLobbyPlayers();
    renderSeatsIfOnTable();
  });
}

function renderLobbyPlayers() {
  const list = $('lobby-players');
  list.innerHTML = '';
  const ordered = Object.entries(playersCache).sort((a, b) => a[1].seatIndex - b[1].seatIndex);
  const canTransfer = isHost && ordered.length >= 2;

  ordered.forEach(([uid, p]) => {
    const row = document.createElement('div');
    row.className = 'lobby-player-row';
    const isMe = uid === myUid;
    const nameClickable = canTransfer && !isMe;
    row.innerHTML = `
      <div class="roster-avatar">${p.photo ? `<img src="${p.photo}" alt="">` : initialsFor(p.name)}</div>
      <div class="lobby-player-name${nameClickable ? ' name-clickable' : ''}">${p.name}${nameClickable ? '<span class="tap-hint">tap to make host</span>' : ''}</div>
      ${metaCache && metaCache.hostUid === uid ? '<span class="lobby-host-tag">Host</span>' : ''}
    `;
    if (nameClickable) {
      row.querySelector('.lobby-player-name').addEventListener('click', () => {
        if (confirm(`Make ${p.name} the host? You'll lose host controls, and they'll take over dealing.`)) {
          transferHost(uid);
        }
      });
    }
    list.appendChild(row);
  });
  const count = ordered.length;
  $('lobby-start-hint').textContent = count < 2 ? 'Need at least 2 players.' : `${count} players ready.`;
  if ($('btn-start-game')) $('btn-start-game').disabled = count < 2;
}

$('btn-share-whatsapp').addEventListener('click', () => {
  const message = `Join our poker table \u2014 ${window.location.href}\nRoom code: ${roomCode}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
});

$('btn-start-game').addEventListener('click', async () => {
  await update(ref(db, `rooms/${roomCode}/meta`), { started: true });
  showScreen('table');
  attachTableListeners();
  dealNewHand();
});

// ====================================================================
// TABLE: listeners
// ====================================================================
let listenersAttached = false;
function attachTableListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  $('table-room-code').textContent = roomCode;

  setInterval(() => {
    if (!isHost || !handCache || !handCache.actionDeadline) return;
    if (Date.now() < handCache.actionDeadline) return;
    const bettingPhases = ['preflop', 'flop', 'turn', 'river'];
    if (!bettingPhases.includes(handCache.phase) || !handCache.actingUid) return;
    const uid = handCache.actingUid;
    runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
      if (!current || current.actingUid !== uid || !current.actionDeadline || Date.now() < current.actionDeadline) return current;
      try {
        const ps = current.players[uid];
        const toCall = current.currentBet - ps.betThisRound;
        return E.applyAction(current, current.startChips, uid, toCall <= 0 ? 'check' : 'fold');
      } catch (e) { return current; }
    });
  }, 3000);

  onValue(ref(db, `rooms/${roomCode}/players`), (snap) => {
    playersCache = snap.val() || {};
    renderSeatsIfOnTable();
  });

  onValue(ref(db, `rooms/${roomCode}/hand`), (snap) => {
    handCache = snap.val();
    renderTable();
    if (isHost) hostReact();
    reactToShowdown();
  });

  onValue(ref(db, `private/${roomCode}/${myUid}`), (snap) => {
    myHole = snap.exists() ? snap.val() : null;
    renderMyHand();
  });

  onValue(ref(db, `rooms/${roomCode}/breakRequests`), (snap) => {
    breakRequestsCache = snap.val() || {};
  });
}

// ====================================================================
// HOST: dealing
// ====================================================================
function seatOrderedRoster() {
  return Object.entries(playersCache)
    .sort((a, b) => a[1].seatIndex - b[1].seatIndex)
    .map(([uid, p]) => ({ id: uid, chips: p.chips }));
}

async function dealNewHand(opts) {
  if (!isHost) return;
  const keepButton = opts && opts.keepButton;
  const roster = seatOrderedRoster().filter(p => p.chips > 0 && !(playersCache[p.id] && playersCache[p.id].onBreak));
  if (roster.length < 2) { await settleGameOver(); return; }
  resetDebugLog('starting a new hand');
  logEvent(`Dealing hand ${(metaCache.handNumber || 0) + 1} with ${roster.length} players`);

  const prevButton = metaCache && metaCache.buttonUid;
  let buttonUid = roster[0].id;
  if (keepButton && prevButton && roster.some(p => p.id === prevButton)) {
    buttonUid = prevButton;
  } else if (prevButton) {
    const idx = roster.findIndex(p => p.id === prevButton);
    buttonUid = idx === -1 ? roster[0].id : roster[(idx + 1) % roster.length].id;
  }
  const startIdx = roster.findIndex(p => p.id === buttonUid);
  const rotated = roster.slice(startIdx).concat(roster.slice(0, startIdx));

  let sb = metaCache.smallBlind, bb = metaCache.bigBlind;
  const nextHandNumber = (metaCache.handNumber || 0) + 1;
  if (metaCache.raiseBlinds && nextHandNumber > 1 && (nextHandNumber - 1) % 4 === 0) {
    sb = Math.ceil(sb * 1.5 / 5) * 5 || sb + 5;
    bb = sb * 2;
  }

  const { hand, deck, chipsById, hole } = E.startHand(rotated, buttonUid, sb, bb);
  hand.startChips = chipsById;
  hostDeck = deck;

  const updates = {
    [`rooms/${roomCode}/hand`]: hand,
    [`rooms/${roomCode}/meta/handNumber`]: nextHandNumber,
    [`rooms/${roomCode}/meta/buttonUid`]: buttonUid,
    [`rooms/${roomCode}/meta/smallBlind`]: sb,
    [`rooms/${roomCode}/meta/bigBlind`]: bb,
  };
  rotated.forEach(p => { updates[`private/${roomCode}/${p.id}`] = hole[p.id]; });

  await update(ref(db), updates);
  logEvent('Hole cards dealt and hand written to Firebase — waiting for betting to begin');
}

// ---- host reacts to state transitions (street deals, showdown, uncontested) ----
async function hostReact() {
  if (!handCache || hostSettling) return;
  const phase = handCache.phase;

  if (phase && phase.endsWith('-pending')) {
    if (!hostDeck) {
      logEvent(`STUCK: phase is "${phase}" but hostDeck is missing on this device — showing redeal option`);
      renderHostRecovery(true);
      return;
    }
    renderHostRecovery(false);
    hostSettling = true;
    try {
      await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
        if (!current || !current.phase || !current.phase.endsWith('-pending')) return current;
        const updated = E.dealNextStreet(current, hostDeck);
        return updated;
      });
      logEvent(`Dealt next street (from "${phase}")`);
    } catch (e) {
      logEvent(`ERROR dealing next street: ${e.code || '(no code)'} — ${e.message}`);
    } finally { hostSettling = false; }
    return;
  }

  if (phase === 'uncontested') {
    hostSettling = true;
    try { await settleHand(E.resolveUncontested(handCache)); }
    finally { hostSettling = false; }
    return;
  }

  if (phase === 'showdown' && !handCache.result) {
    const unfolded = E.activeUnfolded(handCache);
    const allRevealed = unfolded.every(uid => handCache.revealed && handCache.revealed[uid]);
    if (allRevealed) {
      hostSettling = true;
      try { await settleHand(E.resolveShowdown(handCache)); }
      finally { hostSettling = false; }
    }
  }
}

async function settleHand(outcome) {
  const chipUpdates = {};
  Object.keys(handCache.chipDelta || {}).forEach(uid => {
    const current = (playersCache[uid] && playersCache[uid].chips) || 0;
    chipUpdates[`rooms/${roomCode}/players/${uid}/chips`] = current + handCache.chipDelta[uid];
  });
  Object.entries(outcome.payouts).forEach(([uid, amt]) => {
    const base = chipUpdates[`rooms/${roomCode}/players/${uid}/chips`] ?? ((playersCache[uid] && playersCache[uid].chips) || 0);
    chipUpdates[`rooms/${roomCode}/players/${uid}/chips`] = base + amt;
  });

  await update(ref(db), chipUpdates);
  const settleResult = await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
    if (!current || current.result) return current; // already settled — don't double-write
    current.phase = 'result';
    current.result = { lines: outcome.lines, potSummaries: outcome.potSummaries };
    return current;
  });
  logEvent(settleResult.committed ? 'Hand settled successfully, chips paid out, result shown' : 'Settlement transaction did not commit (already settled?)');

  // mark anyone at 0 chips as out
  const outUpdates = {};
  Object.entries(chipUpdates).forEach(([path, chips]) => {
    if (chips <= 0) {
      const uid = path.split('/')[3];
      outUpdates[`rooms/${roomCode}/players/${uid}/out`] = true;
    }
  });
  if (Object.keys(outUpdates).length) await update(ref(db), outUpdates);
}

async function settleGameOver() {
  await update(ref(db, `rooms/${roomCode}/meta`), { gameOver: true });
}

async function reactToShowdown() {
  if (!myHole) return;
  let didReveal = false;
  await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
    if (!current || current.phase !== 'showdown') return current;
    const unfolded = E.activeUnfolded(current);
    if (!unfolded.includes(myUid)) return current;
    if (current.revealed && current.revealed[myUid]) return current;
    if (!current.revealed) current.revealed = {};
    current.revealed[myUid] = myHole;
    didReveal = true; // for logging only — harmless if a retry sets it more than once
    return current;
  });
  if (didReveal) logEvent('Revealed my hole cards for showdown');
}

// ====================================================================
// TABLE: rendering
// ====================================================================
function renderMyHand() {
  const wrap = $('my-hand-cards');
  if (!myHole) { wrap.innerHTML = ''; $('my-hand-name').textContent = ''; return; }
  wrap.innerHTML = myHole.map(c => cardHTML(c)).join('');
  if (handCache && handCache.community && handCache.community.length >= 3 && !isFolded(myUid)) {
    const score = E.bestOf7(myHole.concat(handCache.community));
    $('my-hand-name').textContent = E.HAND_NAMES[score[0]];
  } else {
    $('my-hand-name').textContent = '';
  }
}
function isFolded(uid) {
  return !!(handCache && handCache.players && handCache.players[uid] && handCache.players[uid].folded);
}

function renderTable() {
  if (!handCache) return;
  $('hand-number').textContent = 'Hand ' + (metaCache ? metaCache.handNumber : 1);
  $('blind-level').textContent = metaCache ? `${metaCache.smallBlind} / ${metaCache.bigBlind}` : '';
  $('pot-amount').textContent = handCache.pot || 0;
  $('community-cards').innerHTML = (handCache.community || []).map(c => cardHTML(c)).join('');
  renderSeats();
  renderMyHand();
  renderActionBar();
  if (handCache.phase === 'result') {
    renderResult();
  } else if (!showingStandings) {
    // a new hand has begun (or is dealing) — make sure everyone's result
    // overlay from the previous hand is dismissed, not just the host's
    $('overlay-result').classList.add('hidden');
  }
}

function renderSeatsIfOnTable() {
  if (document.getElementById('screen-table').classList.contains('active')) renderSeats();
}

function renderSeats() {
  const grid = $('seats-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const ordered = Object.entries(playersCache).sort((a, b) => a[1].seatIndex - b[1].seatIndex);
  if (ordered.length === 0) return;

  ordered.forEach(([uid, pl]) => {
    const ps = handCache && handCache.players ? handCache.players[uid] : null;
    const isActing = handCache && handCache.actingUid === uid;
    const handInProgress = handCache && !['result', undefined, null].includes(handCache.phase);
    const canTransfer = isHost && !handInProgress && ordered.length >= 2 && uid !== myUid;

    const seat = document.createElement('div');
    seat.className = 'seat' + (ps && ps.folded ? ' folded' : '') + (isActing ? ' acting' : '') + (pl.onBreak ? ' on-break' : '');

    const isButton = metaCache && metaCache.buttonUid === uid;

    seat.innerHTML = `
      <div class="seat-avatar-wrap">
        <div class="seat-avatar">${pl.photo ? `<img src="${pl.photo}" alt="">` : initialsFor(pl.name)}</div>
        ${isButton ? '<div class="dealer-chip">D</div>' : ''}
      </div>
      <div class="seat-name-pill${canTransfer ? ' name-clickable' : ''}">${pl.name}${uid === myUid ? ' (you)' : ''}</div>
      <div class="seat-chips">${pl.chips}${pl.out ? ' \u2014 out' : ''}</div>
      ${pl.onBreak ? '<div class="seat-break-tag">On break</div>' : ''}
      ${ps && ps.betThisRound > 0 ? `<div class="seat-bet">${ps.betThisRound}</div>` : ''}
    `;
    if (canTransfer) {
      seat.querySelector('.seat-name-pill').addEventListener('click', () => {
        if (confirm(`Make ${pl.name} the host? You'll lose host controls, and they'll take over dealing.`)) {
          transferHost(uid);
        }
      });
    }
    grid.appendChild(seat);
  });
}

let turnTimerInterval = null;
function stopTurnTimer() {
  if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  $('turn-timer').classList.add('hidden');
}
function startTurnTimer(deadline) {
  stopTurnTimer();
  const el = $('turn-timer');
  el.classList.remove('hidden');
  const tick = () => {
    const msLeft = deadline - Date.now();
    if (msLeft <= 0) { el.textContent = '0:00'; el.classList.add('urgent'); return; }
    const totalSec = Math.ceil(msLeft / 1000);
    const m = Math.floor(totalSec / 60), s = totalSec % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('urgent', msLeft <= 20000);
  };
  tick();
  turnTimerInterval = setInterval(tick, 1000);
}

function renderActionBar() {
  const btns = $('action-buttons');
  $('raise-controls').classList.add('hidden');
  const banner = $('turn-banner');
  const bettingPhases = ['preflop', 'flop', 'turn', 'river'];

  const myPlayer = playersCache[myUid];
  if (myPlayer && myPlayer.onBreak) {
    stopTurnTimer();
    btns.innerHTML = '';
    banner.textContent = "You're on a break \u2014 tap the menu to return whenever you're ready";
    return;
  }

  if (!handCache.order || !handCache.order.includes(myUid)) {
    // joined mid-game — not part of the hand in progress, waiting for the next deal
    stopTurnTimer();
    btns.innerHTML = '';
    banner.textContent = "You're in — you'll be dealt into the next hand";
    return;
  }

  if (!bettingPhases.includes(handCache.phase)) {
    stopTurnTimer();
    btns.innerHTML = '';
    banner.textContent = phaseWaitingLabel();
    return;
  }

  const actingUid = handCache.actingUid;
  const actingName = playersCache[actingUid] ? playersCache[actingUid].name : '';
  if (actingUid !== myUid) {
    stopTurnTimer();
    btns.innerHTML = '';
    banner.textContent = `Waiting on ${actingName}\u2026`;
    return;
  }

  banner.textContent = 'Your move';
  if (handCache.actionDeadline) startTurnTimer(handCache.actionDeadline); else stopTurnTimer();

  const ps = handCache.players[myUid];
  const myChips = handCache.startChips[myUid] + handCache.chipDelta[myUid];
  const toCall = handCache.currentBet - ps.betThisRound;

  btns.innerHTML = '';
  if (toCall <= 0) {
    addActionButton(btns, 'Check', () => submitAction('check'));
  } else {
    addActionButton(btns, 'Fold', () => submitAction('fold'));
    const label = toCall >= myChips ? `Call ${myChips} (all in)` : `Call ${toCall}`;
    addActionButton(btns, label, () => submitAction('call'));
  }
  if (myChips > toCall) {
    addActionButton(btns, handCache.currentBet > 0 ? 'Raise' : 'Bet', () => showRaiseControls());
  }
}

function phaseWaitingLabel() {
  if (handCache.phase === 'showdown') return 'Showdown\u2026';
  if (handCache.phase === 'result') return 'Hand over';
  if (handCache.phase && handCache.phase.endsWith('-pending')) return 'Dealing\u2026';
  return 'Waiting\u2026';
}

// Runs after renderActionBar(): overrides the action bar on the host's own
// device only, when the host's in-memory deck is gone (e.g. they reloaded
// mid-hand) and the game would otherwise sit stuck forever waiting for
// cards nobody can deal anymore.
function renderHostRecovery(stuck) {
  if (!isHost || !stuck) return;
  $('turn-banner').textContent = "Lost the deck (this device reloaded mid-hand)";
  const btns = $('action-buttons');
  btns.innerHTML = '';
  addActionButton(btns, 'Redeal this hand', () => dealNewHand({ keepButton: true }));
}

function addActionButton(container, label, handler) {
  const b = document.createElement('button');
  b.className = 'btn btn-primary';
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', handler);
  container.appendChild(b);
}

function showRaiseControls() {
  const ps = handCache.players[myUid];
  const myChips = handCache.startChips[myUid] + handCache.chipDelta[myUid];
  const maxTotal = ps.betThisRound + myChips;
  const minTotal = Math.min(maxTotal, handCache.currentBet + handCache.minRaise);

  const controls = $('raise-controls');
  controls.classList.remove('hidden');
  const slider = $('raise-slider');
  slider.min = minTotal; slider.max = maxTotal;
  slider.step = Math.max(1, Math.min(metaCache.smallBlind, 5));
  slider.value = minTotal;
  $('raise-amount-label').textContent = minTotal;
  slider.oninput = () => { $('raise-amount-label').textContent = slider.value; };

  $('btn-cancel-raise').onclick = () => controls.classList.add('hidden');
  $('btn-confirm-raise').onclick = () => {
    const amount = parseInt(slider.value, 10);
    controls.classList.add('hidden');
    submitAction('raise', amount);
  };
}

async function submitAction(action, raiseTotal) {
  logEvent(`Submitting action: ${action}${raiseTotal ? ' to ' + raiseTotal : ''}`);
  await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
    if (!current || current.actingUid !== myUid) return current;
    try {
      return E.applyAction(current, current.startChips, myUid, action, raiseTotal);
    } catch (e) {
      return current; // stale/invalid — leave untouched, UI will resync
    }
  });
}

// ====================================================================
// RESULT / GAME OVER
// ====================================================================
let lastRenderedResultHandNumber = null;
function renderResult() {
  if (!handCache.result) return;
  showingStandings = false;
  const handNum = metaCache.handNumber;
  if (lastRenderedResultHandNumber === handNum) { /* keep showing, just ensure visible */ }
  lastRenderedResultHandNumber = handNum;

  $('result-title').textContent = handCache.result.potSummaries && handCache.result.potSummaries.length ? 'Showdown' : 'Hand result';
  const body = $('result-body');
  body.innerHTML = '';
  (handCache.result.potSummaries || []).forEach(p => {
    const div = document.createElement('div');
    div.className = 'result-hand-name';
    const winnerNames = p.winners.map(uid => (playersCache[uid] || {}).name || uid).join(', ');
    div.textContent = `${p.label}: ${p.amount} \u2192 ${winnerNames}`;
    body.appendChild(div);
  });
  handCache.result.lines.forEach(line => {
    const pl = playersCache[line.uid] || { name: line.uid };
    const row = document.createElement('div');
    row.className = 'result-row' + (line.winner ? ' winner' : '');
    row.innerHTML = `<span>${line.winner ? '\u2605 ' : ''}${pl.name}<div class="result-hand-name">${line.handName}</div></span><span>${line.winner ? '+' + line.amount : ''}</span>`;
    body.appendChild(row);
  });

  $('btn-next-hand').classList.toggle('hidden', !isHost);
  $('result-wait-note').classList.toggle('hidden', isHost);
  $('btn-close-result').classList.add('hidden');
  $('overlay-result').classList.remove('hidden');

  const remaining = Object.values(playersCache).filter(p => p.chips > 0).length;
  if (remaining < 2) {
    $('overlay-result').classList.add('hidden');
    renderGameOver();
  }
}

$('btn-next-hand').addEventListener('click', () => {
  $('overlay-result').classList.add('hidden');
  dealNewHand();
});

function renderGameOver() {
  const ranked = Object.entries(playersCache).sort((a, b) => b[1].chips - a[1].chips);
  $('gameover-body').innerHTML = ranked.map(([uid, p], i) =>
    `<div class="result-row${i === 0 ? ' winner' : ''}"><span>${i === 0 ? '\u2605 ' : ''}${p.name}</span><span>${p.chips}</span></div>`
  ).join('');
  $('overlay-gameover').classList.remove('hidden');
}
$('btn-new-game').addEventListener('click', () => {
  $('overlay-gameover').classList.add('hidden');
  clearSession();
  location.reload();
});

window.addEventListener('beforeunload', (e) => {
  if (!isHost || !handCache) return;
  const activePhases = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const midHand = activePhases.includes(handCache.phase) || (handCache.phase || '').endsWith('-pending');
  if (midHand) {
    e.preventDefault();
    e.returnValue = ''; // modern browsers show their own generic confirmation text
  }
});

// ====================================================================
// MENU
// ====================================================================
$('btn-menu').addEventListener('click', () => {
  renderBreakMenu();
  $('overlay-menu').classList.remove('hidden');
});
$('btn-resume').addEventListener('click', () => $('overlay-menu').classList.add('hidden'));

function renderBreakMenu() {
  const myPlayer = playersCache[myUid] || {};
  const iRequested = !!breakRequestsCache[myUid];

  $('btn-request-break').classList.toggle('hidden', !!myPlayer.onBreak || iRequested);
  $('btn-request-break').textContent = 'Take a break';
  $('btn-return-from-break').classList.toggle('hidden', !myPlayer.onBreak);

  const hostPanel = $('host-break-requests');
  if (isHost && Object.keys(breakRequestsCache).length > 0) {
    hostPanel.classList.remove('hidden');
    hostPanel.innerHTML = Object.keys(breakRequestsCache).map(uid => {
      const name = (playersCache[uid] || {}).name || uid;
      return `<div class="break-request-row"><span>${name} requested a break</span><button class="btn btn-primary" data-approve-uid="${uid}">Approve</button></div>`;
    }).join('');
    hostPanel.querySelectorAll('[data-approve-uid]').forEach(btn => {
      btn.addEventListener('click', () => approveBreak(btn.getAttribute('data-approve-uid')));
    });
  } else {
    hostPanel.classList.add('hidden');
    hostPanel.innerHTML = '';
  }
}

async function transferHost(newHostUid) {
  await update(ref(db, `rooms/${roomCode}/meta`), { hostUid: newHostUid, buttonUid: null });
  logEvent('Transferred host to ' + ((playersCache[newHostUid] || {}).name || newHostUid));
  $('overlay-menu').classList.add('hidden');
}

$('btn-request-break').addEventListener('click', async () => {
  await set(ref(db, `rooms/${roomCode}/breakRequests/${myUid}`), true);
  renderBreakMenu();
});

$('btn-return-from-break').addEventListener('click', async () => {
  await update(ref(db, `rooms/${roomCode}/players/${myUid}`), { onBreak: false });
  $('overlay-menu').classList.add('hidden');
});

async function approveBreak(uid) {
  await update(ref(db, `rooms/${roomCode}/players/${uid}`), { onBreak: true });
  await remove(ref(db, `rooms/${roomCode}/breakRequests/${uid}`));

  // if they're live in the hand currently being played, fold them out of it now
  await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
    if (!current || !current.order || !current.order.includes(uid)) return current;
    const ps = current.players[uid];
    if (!ps || ps.folded || ps.allIn) return current;
    return E.forceFold(current, uid);
  });

  renderBreakMenu();
}
let showingStandings = false;
$('btn-view-standings').addEventListener('click', () => {
  $('overlay-menu').classList.add('hidden');
  const ranked = Object.entries(playersCache).sort((a, b) => b[1].chips - a[1].chips);
  $('result-title').textContent = 'Chip standings';
  $('result-body').innerHTML = ranked.map(([uid, p]) =>
    `<div class="result-row"><span>${p.name}${p.out ? ' \u2014 out' : ''}</span><span>${p.chips}</span></div>`
  ).join('');
  $('btn-next-hand').classList.add('hidden');
  $('result-wait-note').classList.add('hidden');
  $('btn-close-result').classList.remove('hidden');
  showingStandings = true;
  $('overlay-result').classList.remove('hidden');
});
$('btn-close-result').addEventListener('click', () => {
  showingStandings = false;
  $('btn-close-result').classList.add('hidden');
  $('overlay-result').classList.add('hidden');
});
$('btn-copy-log').addEventListener('click', async () => {
  const text = debugLog.join('\n') || '(log is empty)';
  const btn = $('btn-copy-log');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
  } catch (e) {
    // clipboard API can be finicky on iOS Safari — fall back to a selectable prompt
    window.prompt('Copy this text and send it over:', text);
  }
  setTimeout(() => { btn.textContent = 'Copy debug log'; }, 1500);
});

$('btn-leave-game').addEventListener('click', () => {
  if (confirm('Leave this table?')) { clearSession(); location.reload(); }
});
