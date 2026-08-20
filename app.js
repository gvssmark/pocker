import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, remove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const E = window.PokerEngine;
const $ = (id) => document.getElementById(id);

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);

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
onAuthStateChanged(auth, (user) => {
  if (user) { myUid = user.uid; }
});
signInAnonymously(auth).catch((err) => {
  $('landing-error').textContent = 'Could not connect (sign-in failed): ' + err.message;
});

// ====================================================================
// LANDING SCREEN
// ====================================================================
$('me-avatar').addEventListener('click', () => $('me-photo-input').click());
$('me-photo-input').addEventListener('change', () => {
  const file = $('me-photo-input').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    myPhoto = reader.result;
    $('me-avatar').innerHTML = `<img src="${myPhoto}" alt="">`;
  };
  reader.readAsDataURL(file);
});
$('me-name').addEventListener('input', () => {
  myName = $('me-name').value;
  if (!myPhoto) $('me-avatar').textContent = initialsFor(myName);
});

$('btn-create-room').addEventListener('click', async () => {
  const err = $('landing-error');
  err.textContent = '';
  if (!myUid) { err.textContent = 'Still connecting — try again in a second.'; return; }
  if (!myName.trim()) { err.textContent = 'Enter your name first.'; return; }

  const startingChips = Math.max(10, parseInt($('input-starting-chips').value, 10) || 500);
  const smallBlind = Math.max(1, parseInt($('input-small-blind').value, 10) || 5);
  const bigBlind = Math.max(smallBlind + 1, parseInt($('input-big-blind').value, 10) || smallBlind * 2);
  const raiseBlinds = $('input-raise-blinds').checked;

  roomCode = makeRoomCode();
  isHost = true;

  await set(ref(db, `rooms/${roomCode}/meta`), {
    hostUid: myUid,
    started: false,
    handNumber: 0,
    smallBlind, bigBlind, raiseBlinds,
    startingChips,
    buttonUid: null,
    createdAt: Date.now(),
  });
  await set(ref(db, `rooms/${roomCode}/players/${myUid}`), {
    name: myName.trim(), photo: myPhoto, chips: startingChips, seatIndex: 0, out: false,
  });

  enterLobby();
});

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
  if (meta.started) { err.textContent = 'That table already started — ask the host for a new code, or wait for the next game.'; return; }

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const existing = playersSnap.exists() ? playersSnap.val() : {};
  if (Object.keys(existing).length >= 10) { err.textContent = 'That table is full (10 players max).'; return; }

  roomCode = code;
  isHost = (meta.hostUid === myUid);

  await set(ref(db, `rooms/${roomCode}/players/${myUid}`), {
    name: myName.trim(), photo: myPhoto, chips: meta.startingChips, seatIndex: Object.keys(existing).length, out: false,
  });

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
    if (metaCache.started) {
      showScreen('table');
      attachTableListeners();
    }
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
  ordered.forEach(([uid, p]) => {
    const row = document.createElement('div');
    row.className = 'lobby-player-row';
    row.innerHTML = `
      <div class="roster-avatar">${p.photo ? `<img src="${p.photo}" alt="">` : initialsFor(p.name)}</div>
      <div class="lobby-player-name">${p.name}</div>
      ${metaCache && metaCache.hostUid === uid ? '<span class="lobby-host-tag">Host</span>' : ''}
    `;
    list.appendChild(row);
  });
  const count = ordered.length;
  $('lobby-start-hint').textContent = count < 2 ? 'Need at least 2 players.' : `${count} players ready.`;
  if ($('btn-start-game')) $('btn-start-game').disabled = count < 2;
}

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
}

// ====================================================================
// HOST: dealing
// ====================================================================
function seatOrderedRoster() {
  return Object.entries(playersCache)
    .sort((a, b) => a[1].seatIndex - b[1].seatIndex)
    .map(([uid, p]) => ({ id: uid, chips: p.chips }));
}

async function dealNewHand() {
  if (!isHost) return;
  const roster = seatOrderedRoster().filter(p => p.chips > 0);
  if (roster.length < 2) { await settleGameOver(); return; }

  const prevButton = metaCache && metaCache.buttonUid;
  let buttonUid = roster[0].id;
  if (prevButton) {
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
}

// ---- host reacts to state transitions (street deals, showdown, uncontested) ----
async function hostReact() {
  if (!handCache || hostSettling) return;
  const phase = handCache.phase;

  if (phase && phase.endsWith('-pending')) {
    if (!hostDeck) return; // lost the deck (e.g. host reloaded) — cannot continue this hand
    hostSettling = true;
    try {
      await runTransaction(ref(db, `rooms/${roomCode}/hand`), (current) => {
        if (!current || !current.phase || !current.phase.endsWith('-pending')) return current;
        const updated = E.dealNextStreet(current, hostDeck);
        return updated;
      });
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
  await update(ref(db, `rooms/${roomCode}/hand`), {
    phase: 'result',
    result: { lines: outcome.lines, potSummaries: outcome.potSummaries },
  });

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

function reactToShowdown() {
  if (!handCache || handCache.phase !== 'showdown' || !myHole) return;
  const unfolded = E.activeUnfolded(handCache);
  if (!unfolded.includes(myUid)) return;
  if (handCache.revealed && handCache.revealed[myUid]) return;
  update(ref(db, `rooms/${roomCode}/hand/revealed`), { [myUid]: myHole });
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
  if (handCache.phase === 'result') renderResult();
}

function renderSeatsIfOnTable() {
  if (document.getElementById('screen-table').classList.contains('active')) renderSeats();
}

function renderSeats() {
  const layer = $('seats-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const ordered = Object.entries(playersCache).sort((a, b) => a[1].seatIndex - b[1].seatIndex);
  const n = ordered.length;
  if (n === 0) return;

  ordered.forEach(([uid, pl], i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const left = 50 + 43 * Math.cos(angle);
    const top = 50 + 40 * Math.sin(angle);
    const ps = handCache && handCache.players ? handCache.players[uid] : null;

    const seat = document.createElement('div');
    seat.className = 'seat' + (ps && ps.folded ? ' folded' : '') + (handCache && handCache.actingUid === uid ? ' acting' : '');
    seat.style.left = left + '%';
    seat.style.top = top + '%';

    const showBack = ps && !ps.folded;
    const cardsHTML = ps ? `<div class="seat-cards">${showBack ? cardBackHTML() + cardBackHTML() : ''}</div>` : '';
    const isButton = metaCache && metaCache.buttonUid === uid;

    seat.innerHTML = `
      ${cardsHTML}
      <div class="seat-avatar-wrap">
        <div class="seat-avatar">${pl.photo ? `<img src="${pl.photo}" alt="">` : initialsFor(pl.name)}</div>
        ${isButton ? '<div class="dealer-chip">D</div>' : ''}
      </div>
      <div class="seat-name-pill">${pl.name}${uid === myUid ? ' (you)' : ''}</div>
      <div class="seat-chips">${pl.chips}${pl.out ? ' \u2014 out' : ''}</div>
      ${ps && ps.betThisRound > 0 ? `<div class="seat-bet">${ps.betThisRound}</div>` : ''}
    `;
    layer.appendChild(seat);
  });
}

function renderActionBar() {
  const btns = $('action-buttons');
  $('raise-controls').classList.add('hidden');
  const banner = $('turn-banner');

  const bettingPhases = ['preflop', 'flop', 'turn', 'river'];
  if (!bettingPhases.includes(handCache.phase)) {
    btns.innerHTML = '';
    banner.textContent = phaseWaitingLabel();
    return;
  }

  const actingUid = handCache.actingUid;
  const actingName = playersCache[actingUid] ? playersCache[actingUid].name : '';
  if (actingUid !== myUid) {
    btns.innerHTML = '';
    banner.textContent = `Waiting on ${actingName}\u2026`;
    return;
  }

  banner.textContent = 'Your move';
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
  location.reload();
});

// ====================================================================
// MENU
// ====================================================================
$('btn-menu').addEventListener('click', () => $('overlay-menu').classList.remove('hidden'));
$('btn-resume').addEventListener('click', () => $('overlay-menu').classList.add('hidden'));
$('btn-view-standings').addEventListener('click', () => {
  $('overlay-menu').classList.add('hidden');
  const ranked = Object.entries(playersCache).sort((a, b) => b[1].chips - a[1].chips);
  $('result-title').textContent = 'Chip standings';
  $('result-body').innerHTML = ranked.map(([uid, p]) =>
    `<div class="result-row"><span>${p.name}${p.out ? ' \u2014 out' : ''}</span><span>${p.chips}</span></div>`
  ).join('');
  $('btn-next-hand').classList.add('hidden');
  $('result-wait-note').classList.add('hidden');
  $('overlay-result').classList.remove('hidden');
});
$('btn-leave-game').addEventListener('click', () => { location.reload(); });
$('btn-end-game').addEventListener('click', () => {
  if (confirm('Leave this table?')) location.reload();
});
