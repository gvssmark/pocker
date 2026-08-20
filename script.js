/* ==========================================================================
   Family Hold'em — game engine + UI
   Single-device pass-and-play Texas Hold'em for up to 10 players.
   No backend: roster/photos/settings persist in this browser's localStorage.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_ROSTER = 'familyHoldem.roster.v1';
  const STORAGE_SETTINGS = 'familyHoldem.settings.v1';

  const RANK_ORDER = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
  const SUITS = ['s','h','d','c'];
  const SUIT_SYMBOL = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };
  const RED_SUITS = ['h', 'd'];
  const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];

  function rankLabel(rank) {
    if (rank === 14) return 'A';
    if (rank === 13) return 'K';
    if (rank === 12) return 'Q';
    if (rank === 11) return 'J';
    if (rank === 10) return 'T';
    return String(rank);
  }

  // ---------------------------------------------------------------- deck --
  function freshDeck() {
    const deck = [];
    for (const s of SUITS) {
      for (const r of RANK_ORDER) {
        deck.push({ rank: RANK_VALUES[r], suit: s, label: r });
      }
    }
    return deck;
  }
  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // -------------------------------------------------------- hand ranking --
  function combinations(arr, k) {
    const results = [];
    (function helper(start, combo) {
      if (combo.length === k) { results.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) {
        combo.push(arr[i]);
        helper(i + 1, combo);
        combo.pop();
      }
    })(0, []);
    return results;
  }

  function evaluate5(cards) {
    const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    const counts = {};
    ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
    const groups = Object.entries(counts)
      .map(([r, c]) => ({ rank: Number(r), count: c }))
      .sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

    const uniqueRanks = [...new Set(ranks)];
    let straightHigh = null;
    if (uniqueRanks.length === 5) {
      if (uniqueRanks[0] - uniqueRanks[4] === 4) straightHigh = uniqueRanks[0];
      else if (uniqueRanks.join(',') === '14,5,4,3,2') straightHigh = 5;
    }

    if (straightHigh && isFlush) return [8, straightHigh];
    if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
    if (groups[0].count === 3 && groups[1].count === 2) return [6, groups[0].rank, groups[1].rank];
    if (isFlush) return [5, ...ranks];
    if (straightHigh) return [4, straightHigh];
    if (groups[0].count === 3) return [3, groups[0].rank, ...groups.slice(1).map(g => g.rank)];
    if (groups[0].count === 2 && groups[1].count === 2) {
      const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
      return [2, ...pairRanks, groups[2].rank];
    }
    if (groups[0].count === 2) return [1, groups[0].rank, ...groups.slice(1).map(g => g.rank)];
    return [0, ...ranks];
  }

  function compareScores(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] || 0, bv = b[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function bestOf7(cards7) {
    let best = null;
    for (const combo of combinations(cards7, 5)) {
      const score = evaluate5(combo);
      if (!best || compareScores(score, best) > 0) best = score;
    }
    return best;
  }

  // ------------------------------------------------------------ side pots --
  // players: [{id, totalBet, folded}]
  function computePots(players) {
    const contributors = players.filter(p => p.totalBet > 0);
    const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prevLevel = 0;
    for (const level of levels) {
      const layer = level - prevLevel;
      const payers = contributors.filter(p => p.totalBet >= level);
      const amount = layer * payers.length;
      if (amount > 0) {
        pots.push({ amount, eligible: payers.filter(p => !p.folded).map(p => p.id) });
      }
      prevLevel = level;
    }
    return pots;
  }

  // ================================================================== //
  //  GAME STATE
  // ================================================================== //
  const G = {
    players: [],       // seat order, fixed for the sitting: {id,name,photo,chips,out}
    dealerSeat: -1,     // index into G.players
    handNumber: 0,
    smallBlind: 5,
    bigBlind: 10,
    raiseBlinds: false,
    hand: null,          // per-hand transient state, see startHand()
  };

  function loadRoster() {
    try {
      const raw = localStorage.getItem(STORAGE_ROSTER);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return [
      { name: 'Player 1', photo: null },
      { name: 'Player 2', photo: null },
    ];
  }
  function saveRoster(roster) {
    try { localStorage.setItem(STORAGE_ROSTER, JSON.stringify(roster)); } catch (e) { /* ignore */ }
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { startingChips: 500, smallBlind: 5, bigBlind: 10, raiseBlinds: false };
  }
  function saveSettings(s) {
    try { localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ================================================================== //
  //  SETUP SCREEN
  // ================================================================== //
  let roster = loadRoster();

  function initialsFor(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  }

  function renderRoster() {
    const list = $('roster-list');
    list.innerHTML = '';
    roster.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'roster-row';

      const avatar = document.createElement('div');
      avatar.className = 'roster-avatar';
      avatar.innerHTML = p.photo ? `<img src="${p.photo}" alt="">` : initialsFor(p.name);
      avatar.title = 'Tap to add a photo';
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { roster[i].photo = reader.result; saveRoster(roster); renderRoster(); };
        reader.readAsDataURL(file);
      });
      avatar.addEventListener('click', () => fileInput.click());

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.name;
      nameInput.maxLength = 18;
      nameInput.placeholder = 'Name';
      nameInput.addEventListener('input', () => {
        roster[i].name = nameInput.value;
        avatar.innerHTML = roster[i].photo ? `<img src="${roster[i].photo}" alt="">` : initialsFor(nameInput.value);
        saveRoster(roster);
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'roster-remove';
      removeBtn.type = 'button';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove player';
      removeBtn.addEventListener('click', () => {
        roster.splice(i, 1);
        saveRoster(roster);
        renderRoster();
      });

      row.append(avatar, fileInput, nameInput, removeBtn);
      list.appendChild(row);
    });
    $('btn-add-player').disabled = roster.length >= 10;
  }

  $('btn-add-player').addEventListener('click', () => {
    if (roster.length >= 10) return;
    roster.push({ name: `Player ${roster.length + 1}`, photo: null });
    saveRoster(roster);
    renderRoster();
  });

  function applySettingsToInputs() {
    const s = loadSettings();
    $('input-starting-chips').value = s.startingChips;
    $('input-small-blind').value = s.smallBlind;
    $('input-big-blind').value = s.bigBlind;
    $('input-raise-blinds').checked = !!s.raiseBlinds;
  }

  $('btn-start-game').addEventListener('click', () => {
    const names = roster.map(p => (p.name || '').trim()).filter(Boolean);
    const err = $('setup-error');
    if (roster.length < 2) { err.textContent = 'Add at least 2 players.'; return; }
    if (names.length !== roster.length) { err.textContent = 'Every player needs a name.'; return; }
    const startingChips = Math.max(10, parseInt($('input-starting-chips').value, 10) || 500);
    const smallBlind = Math.max(1, parseInt($('input-small-blind').value, 10) || 5);
    const bigBlind = Math.max(smallBlind + 1, parseInt($('input-big-blind').value, 10) || smallBlind * 2);
    const raiseBlinds = $('input-raise-blinds').checked;
    err.textContent = '';

    saveSettings({ startingChips, smallBlind, bigBlind, raiseBlinds });

    G.players = roster.map((p, i) => ({
      id: 'p' + i,
      name: p.name.trim(),
      photo: p.photo,
      chips: startingChips,
      out: false,
    }));
    G.dealerSeat = -1;
    G.handNumber = 0;
    G.smallBlind = smallBlind;
    G.bigBlind = bigBlind;
    G.raiseBlinds = raiseBlinds;

    showScreen('table');
    startHand();
  });

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('screen-' + name).classList.add('active');
  }

  // ================================================================== //
  //  HAND FLOW
  // ================================================================== //

  function activePlayersForNewHand() {
    return G.players.filter(p => p.chips > 0);
  }

  function nextIndexInSeats(fromSeatIdx) {
    // next seat (by G.players index) with chips > 0, wrapping
    const n = G.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromSeatIdx + step) % n;
      if (G.players[idx].chips > 0) return idx;
    }
    return fromSeatIdx;
  }

  function startHand() {
    const contenders = activePlayersForNewHand();
    if (contenders.length < 2) { endGame(); return; }

    G.handNumber += 1;
    if (G.raiseBlinds && G.handNumber > 1 && (G.handNumber - 1) % 4 === 0) {
      G.smallBlind = Math.ceil(G.smallBlind * 1.5 / 5) * 5 || G.smallBlind + 5;
      G.bigBlind = G.smallBlind * 2;
    }

    // rotate dealer to next seat with chips
    G.dealerSeat = G.dealerSeat === -1
      ? G.players.findIndex(p => p.chips > 0)
      : nextIndexInSeats(G.dealerSeat);

    const deck = shuffle(freshDeck());

    const handPlayerIds = contenders.map(p => p.id);
    const state = {
      deck,
      community: [],
      phase: 'preflop', // preflop, flop, turn, river, showdown
      pot: 0,
      players: {}, // id -> {hole, folded, allIn, totalBet, betThisRound, hasActed}
      order: [],   // seat indices (into G.players) of players dealt into this hand, in seat order
      currentBet: 0,
      minRaise: G.bigBlind,
      actingSeat: null,
      lastAggressorSeat: null,
      revealQueue: [],
      log: [],
    };

    // build seat order starting at dealer
    const n = G.players.length;
    for (let step = 0; step < n; step++) {
      const idx = (G.dealerSeat + step) % n;
      if (handPlayerIds.includes(G.players[idx].id)) state.order.push(idx);
    }

    state.order.forEach(seatIdx => {
      const pl = G.players[seatIdx];
      state.players[pl.id] = {
        hole: [deck.pop(), deck.pop()],
        folded: false,
        allIn: false,
        totalBet: 0,
        betThisRound: 0,
        hasActed: false,
      };
    });

    G.hand = state;

    // blinds
    const twoPlayers = state.order.length === 2;
    let sbSeat, bbSeat;
    if (twoPlayers) {
      sbSeat = G.dealerSeat;
      bbSeat = state.order.find(s => s !== G.dealerSeat);
    } else {
      sbSeat = state.order[1];
      bbSeat = state.order[2];
    }
    postBet(sbSeat, G.smallBlind, true);
    postBet(bbSeat, G.bigBlind, true);
    state.currentBet = G.bigBlind;
    state.minRaise = G.bigBlind;
    state.lastAggressorSeat = bbSeat;

    // first to act preflop
    state.actingSeat = twoPlayers ? sbSeat : seatAfter(bbSeat);

    // build peek queue: everyone in hand, in seat order, sees their cards once before betting
    state.revealQueue = state.order.slice();

    renderTable();
    advanceRevealQueue();
  }

  function seatAfter(seatIdx) {
    const order = G.hand.order;
    const pos = order.indexOf(seatIdx);
    for (let step = 1; step <= order.length; step++) {
      const candidate = order[(pos + step) % order.length];
      const ps = G.hand.players[G.players[candidate].id];
      if (!ps.folded && !ps.allIn) return candidate;
    }
    return null; // nobody left to act
  }

  function postBet(seatIdx, amount, isBlind) {
    const pl = G.players[seatIdx];
    const ps = G.hand.players[pl.id];
    const actual = Math.min(amount, pl.chips);
    pl.chips -= actual;
    ps.totalBet += actual;
    ps.betThisRound += actual;
    if (pl.chips === 0) ps.allIn = true;
    G.hand.pot += actual;
  }

  // ---------------------------------------------------- pass & peek flow --
  function advanceRevealQueue() {
    if (G.hand.revealQueue.length === 0) {
      beginBettingUI();
      return;
    }
    const seatIdx = G.hand.revealQueue[0];
    const pl = G.players[seatIdx];
    showPassOverlay(pl, () => {
      showPeekOverlay(pl, () => {
        G.hand.revealQueue.shift();
        advanceRevealQueue();
      });
    });
  }

  function showPassOverlay(player, onReady) {
    $('pass-name').textContent = player.name;
    $('pass-avatar').innerHTML = player.photo ? `<img src="${player.photo}" alt="">` : initialsFor(player.name);
    $('pass-hint').textContent = 'Make sure no one else can see the screen.';
    $('overlay-pass').classList.remove('hidden');
    const btn = $('btn-reveal');
    const handler = () => {
      $('overlay-pass').classList.add('hidden');
      btn.removeEventListener('click', handler);
      onReady();
    };
    btn.addEventListener('click', handler);
  }

  function showPeekOverlay(player, onDone) {
    const ps = G.hand.players[player.id];
    $('peek-name').textContent = player.name + '\u2019s cards';
    $('peek-cards').innerHTML = ps.hole.map(c => cardHTML(c)).join('');
    $('overlay-peek').classList.remove('hidden');
    const btn = $('btn-hide-peek');
    const handler = () => {
      $('overlay-peek').classList.add('hidden');
      btn.removeEventListener('click', handler);
      onDone();
    };
    btn.addEventListener('click', handler);
  }

  function cardHTML(card, small) {
    const red = RED_SUITS.includes(card.suit);
    return `<div class="card${red ? ' red' : ''}">${rankLabel(card.rank)}<span class="suit">${SUIT_SYMBOL[card.suit]}</span></div>`;
  }
  function cardBackHTML() {
    return `<div class="card back"></div>`;
  }

  // ------------------------------------------------------------- betting --
  function beginBettingUI() {
    renderTable();
    promptActor();
  }

  function activeUnfoldedSeats() {
    return G.hand.order.filter(s => !G.hand.players[G.players[s].id].folded);
  }
  function seatsStillToAct() {
    return G.hand.order.filter(s => {
      const ps = G.hand.players[G.players[s].id];
      return !ps.folded && !ps.allIn;
    });
  }

  function promptActor() {
    const unfolded = activeUnfoldedSeats();
    if (unfolded.length === 1) { awardUncontested(unfolded[0]); return; }

    const toAct = seatsStillToAct().filter(s => !G.hand.players[G.players[s].id].hasActed);
    if (toAct.length === 0) { advanceStreet(); return; }

    const seatIdx = G.hand.actingSeat;
    if (seatIdx === null || seatIdx === undefined) { advanceStreet(); return; }
    const pl = G.players[seatIdx];
    const ps = G.hand.players[pl.id];
    if (ps.folded || ps.allIn) { moveToNextActor(); return; }

    showPassOverlay(pl, () => {
      renderActionBar(seatIdx);
    });
  }

  function allOthersAllInOrFolded(exceptSeat) {
    return G.hand.order.every(s => {
      if (s === exceptSeat) return true;
      const ps = G.hand.players[G.players[s].id];
      return ps.folded || ps.allIn;
    });
  }

  function renderActionBar(seatIdx) {
    G.hand.actingSeat = seatIdx;
    renderTable();
    const pl = G.players[seatIdx];
    const ps = G.hand.players[pl.id];
    $('turn-banner').textContent = `${pl.name}\u2019s move`;

    const toCall = G.hand.currentBet - ps.betThisRound;
    const btns = $('action-buttons');
    btns.innerHTML = '';
    $('raise-controls').classList.add('hidden');

    const myCardsBtn = document.createElement('button');
    myCardsBtn.className = 'btn btn-ghost';
    myCardsBtn.type = 'button';
    myCardsBtn.textContent = 'My cards';
    myCardsBtn.addEventListener('click', () => showPeekOverlay(pl, () => {}));
    btns.appendChild(myCardsBtn);

    if (toCall <= 0) {
      addActionButton(btns, 'Check', () => doAction(seatIdx, 'check'));
    } else {
      addActionButton(btns, `Fold`, () => doAction(seatIdx, 'fold'));
      const callLabel = toCall >= pl.chips ? `Call ${pl.chips} (all in)` : `Call ${toCall}`;
      addActionButton(btns, callLabel, () => doAction(seatIdx, 'call'));
    }

    if (pl.chips > toCall) {
      const raiseLabel = G.hand.currentBet > 0 ? 'Raise' : 'Bet';
      addActionButton(btns, raiseLabel, () => showRaiseControls(seatIdx));
    }
  }

  function addActionButton(container, label, handler) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', handler);
    container.appendChild(b);
  }

  function showRaiseControls(seatIdx) {
    const pl = G.players[seatIdx];
    const ps = G.hand.players[pl.id];
    const toCall = Math.max(0, G.hand.currentBet - ps.betThisRound);
    const maxTotal = ps.betThisRound + pl.chips; // total bet-this-round if shoving all in
    const minTotal = Math.min(maxTotal, G.hand.currentBet + G.hand.minRaise);

    const controls = $('raise-controls');
    controls.classList.remove('hidden');
    const slider = $('raise-slider');
    slider.min = minTotal;
    slider.max = maxTotal;
    slider.step = Math.max(1, Math.min(G.smallBlind, 5));
    slider.value = minTotal;
    $('raise-amount-label').textContent = minTotal;

    slider.oninput = () => { $('raise-amount-label').textContent = slider.value; };

    $('btn-cancel-raise').onclick = () => { controls.classList.add('hidden'); };
    $('btn-confirm-raise').onclick = () => {
      const amountTotal = parseInt(slider.value, 10);
      controls.classList.add('hidden');
      doAction(seatIdx, 'raise', amountTotal);
    };
  }

  function doAction(seatIdx, action, raiseToTotal) {
    const pl = G.players[seatIdx];
    const ps = G.hand.players[pl.id];

    if (action === 'fold') {
      ps.folded = true;
      ps.hasActed = true;
    } else if (action === 'check') {
      ps.hasActed = true;
    } else if (action === 'call') {
      const toCall = Math.min(G.hand.currentBet - ps.betThisRound, pl.chips);
      pl.chips -= toCall;
      ps.betThisRound += toCall;
      ps.totalBet += toCall;
      G.hand.pot += toCall;
      if (pl.chips === 0) ps.allIn = true;
      ps.hasActed = true;
    } else if (action === 'raise') {
      const addAmount = Math.min(raiseToTotal - ps.betThisRound, pl.chips);
      const newRaiseSize = (ps.betThisRound + addAmount) - G.hand.currentBet;
      pl.chips -= addAmount;
      ps.betThisRound += addAmount;
      ps.totalBet += addAmount;
      G.hand.pot += addAmount;
      if (pl.chips === 0) ps.allIn = true;
      if (ps.betThisRound > G.hand.currentBet) {
        G.hand.minRaise = Math.max(G.hand.minRaise, newRaiseSize);
        G.hand.currentBet = ps.betThisRound;
        G.hand.lastAggressorSeat = seatIdx;
        // reopen action: everyone else who's still in must act again
        G.hand.order.forEach(s => {
          const other = G.hand.players[G.players[s].id];
          if (s !== seatIdx && !other.folded && !other.allIn) other.hasActed = false;
        });
      }
      ps.hasActed = true;
    }

    moveToNextActor();
  }

  function moveToNextActor() {
    const unfolded = activeUnfoldedSeats();
    if (unfolded.length === 1) { renderTable(); awardUncontested(unfolded[0]); return; }

    const toAct = G.hand.order.filter(s => {
      const ps = G.hand.players[G.players[s].id];
      return !ps.folded && !ps.allIn && !ps.hasActed;
    });

    if (toAct.length === 0) { advanceStreet(); return; }

    const cur = G.hand.actingSeat;
    let next = seatAfter(cur);
    // seatAfter finds next not-folded/not-allin seat, but we also want one that hasn't acted this round when possible
    if (next !== null) {
      const nextPs = G.hand.players[G.players[next].id];
      if (nextPs.hasActed && toAct.length > 0) {
        // find the actual next seat that still needs to act, in order
        const order = G.hand.order;
        const pos = order.indexOf(cur);
        for (let step = 1; step <= order.length; step++) {
          const candidate = order[(pos + step) % order.length];
          const cps = G.hand.players[G.players[candidate].id];
          if (!cps.folded && !cps.allIn && !cps.hasActed) { next = candidate; break; }
        }
      }
    }
    G.hand.actingSeat = next;
    renderTable();
    promptActor();
  }

  function advanceStreet() {
    // reset per-round state
    G.hand.order.forEach(s => {
      const ps = G.hand.players[G.players[s].id];
      ps.betThisRound = 0;
      ps.hasActed = false;
    });
    G.hand.currentBet = 0;
    G.hand.minRaise = G.bigBlind;

    const unfolded = activeUnfoldedSeats();
    if (unfolded.length === 1) { renderTable(); awardUncontested(unfolded[0]); return; }

    if (G.hand.phase === 'preflop') {
      G.hand.deck.pop(); // burn
      G.hand.community.push(G.hand.deck.pop(), G.hand.deck.pop(), G.hand.deck.pop());
      G.hand.phase = 'flop';
    } else if (G.hand.phase === 'flop') {
      G.hand.deck.pop();
      G.hand.community.push(G.hand.deck.pop());
      G.hand.phase = 'turn';
    } else if (G.hand.phase === 'turn') {
      G.hand.deck.pop();
      G.hand.community.push(G.hand.deck.pop());
      G.hand.phase = 'river';
    } else if (G.hand.phase === 'river') {
      renderTable();
      runShowdown();
      return;
    }

    renderTable();

    const canAct = seatsStillToAct();
    if (canAct.length < 2) {
      // everyone (or all but one) all-in: pause briefly then keep dealing
      G.hand.actingSeat = null;
      setTimeout(advanceStreet, 900);
      return;
    }

    G.hand.actingSeat = seatAfter(G.dealerSeat);
    if (G.hand.actingSeat === null) { setTimeout(advanceStreet, 900); return; }
    promptActor();
  }

  function awardUncontested(seatIdx) {
    const pl = G.players[seatIdx];
    pl.chips += G.hand.pot;
    showResult({
      title: `${pl.name} wins the hand`,
      lines: [{ name: pl.name, amount: G.hand.pot, handName: 'Everyone else folded', winner: true }],
    });
  }

  function runShowdown() {
    const contenders = activeUnfoldedSeats();
    const scored = contenders.map(seatIdx => {
      const pl = G.players[seatIdx];
      const ps = G.hand.players[pl.id];
      const score = bestOf7(ps.hole.concat(G.hand.community));
      return { seatIdx, pl, ps, score };
    });

    const potPlayers = G.hand.order.map(s => {
      const pl = G.players[s];
      const ps = G.hand.players[pl.id];
      return { id: pl.id, totalBet: ps.totalBet, folded: ps.folded };
    });
    const pots = computePots(potPlayers);

    const payouts = {}; // id -> amount
    const potSummaries = [];

    pots.forEach((pot, potIdx) => {
      const eligibleScored = scored.filter(e => pot.eligible.includes(e.pl.id));
      if (eligibleScored.length === 0) return;
      let best = eligibleScored[0].score;
      eligibleScored.forEach(e => { if (compareScores(e.score, best) > 0) best = e.score; });
      const winners = eligibleScored.filter(e => compareScores(e.score, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      winners.forEach((w, i) => {
        const extra = i < remainder ? 1 : 0;
        payouts[w.pl.id] = (payouts[w.pl.id] || 0) + share + extra;
      });
      potSummaries.push({
        label: pots.length > 1 ? (potIdx === 0 ? 'Main pot' : `Side pot ${potIdx}`) : 'Pot',
        amount: pot.amount,
        winners: winners.map(w => w.pl.name),
        handName: HAND_NAMES[best[0]],
      });
    });

    Object.entries(payouts).forEach(([id, amount]) => {
      const pl = G.players.find(p => p.id === id);
      pl.chips += amount;
    });

    const lines = scored
      .sort((a, b) => compareScores(b.score, a.score))
      .map(e => ({
        name: e.pl.name,
        amount: payouts[e.pl.id] || 0,
        handName: HAND_NAMES[e.score[0]],
        winner: !!payouts[e.pl.id],
        hole: e.ps.hole,
      }));

    showResult({ title: 'Showdown', lines, potSummaries });
  }

  function showResult({ title, lines, potSummaries }) {
    $('result-title').textContent = title;
    const body = $('result-body');
    body.innerHTML = '';

    if (potSummaries && potSummaries.length > 1) {
      const potsDiv = document.createElement('div');
      potsDiv.className = 'result-hand-name';
      potsDiv.textContent = potSummaries.map(p => `${p.label}: ${p.amount} \u2192 ${p.winners.join(', ')}`).join(' \u00b7 ');
      body.appendChild(potsDiv);
    }

    lines.forEach(line => {
      const row = document.createElement('div');
      row.className = 'result-row' + (line.winner ? ' winner' : '');
      const holeStr = line.hole ? ' (' + line.hole.map(c => rankLabel(c.rank) + SUIT_SYMBOL[c.suit]).join(' ') + ')' : '';
      row.innerHTML = `<span>${line.winner ? '\u2605 ' : ''}${line.name}${holeStr}<div class="result-hand-name">${line.handName}</div></span><span>${line.winner ? '+' + line.amount : ''}</span>`;
      body.appendChild(row);
    });

    $('overlay-result').classList.remove('hidden');
  }

  $('btn-next-hand').addEventListener('click', () => {
    $('overlay-result').classList.add('hidden');
    G.players.forEach(p => { if (p.chips <= 0) p.out = true; });
    const remaining = G.players.filter(p => p.chips > 0);
    if (remaining.length < 2) { endGame(); return; }
    startHand();
  });

  function endGame() {
    const ranked = [...G.players].sort((a, b) => b.chips - a.chips);
    const body = $('gameover-body');
    body.innerHTML = ranked.map((p, i) => `<div class="result-row${i === 0 ? ' winner' : ''}"><span>${i === 0 ? '\u2605 ' : ''}${p.name}</span><span>${p.chips}</span></div>`).join('');
    $('overlay-result').classList.add('hidden');
    $('overlay-gameover').classList.remove('hidden');
  }
  $('btn-new-game').addEventListener('click', () => {
    $('overlay-gameover').classList.add('hidden');
    showScreen('setup');
  });

  // ================================================================== //
  //  RENDERING
  // ================================================================== //
  function renderTable() {
    $('hand-number').textContent = 'Hand ' + G.handNumber;
    $('blind-level').textContent = `${G.smallBlind} / ${G.bigBlind}`;
    $('pot-amount').textContent = G.hand ? G.hand.pot : 0;

    $('community-cards').innerHTML = (G.hand ? G.hand.community : []).map(c => cardHTML(c)).join('')
      + Array(5 - (G.hand ? G.hand.community.length : 0)).fill(0).map(() => '').join('');

    renderSeats();
  }

  function renderSeats() {
    const layer = $('seats-layer');
    layer.innerHTML = '';
    const n = G.players.length;
    const radiusX = 43, radiusY = 40;
    G.players.forEach((pl, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const left = 50 + radiusX * Math.cos(angle);
      const top = 50 + radiusY * Math.sin(angle);

      const ps = G.hand ? G.hand.players[pl.id] : null;
      const seat = document.createElement('div');
      seat.className = 'seat' + (ps && ps.folded ? ' folded' : '') + (G.hand && G.hand.actingSeat === i ? ' acting' : '');
      seat.style.left = left + '%';
      seat.style.top = top + '%';

      const showBack = ps && !ps.folded && G.hand.phase !== 'result';
      const cardsHTML = ps ? `<div class="seat-cards">${showBack ? cardBackHTML() + cardBackHTML() : ''}</div>` : '';

      seat.innerHTML = `
        ${cardsHTML}
        <div class="seat-avatar-wrap">
          <div class="seat-avatar">${pl.photo ? `<img src="${pl.photo}" alt="">` : initialsFor(pl.name)}</div>
          ${G.dealerSeat === i ? '<div class="dealer-chip">D</div>' : ''}
        </div>
        <div class="seat-name-pill">${pl.name}</div>
        <div class="seat-chips">${pl.chips}${pl.out ? ' \u2014 out' : ''}</div>
        ${ps && ps.betThisRound > 0 ? `<div class="seat-bet">${ps.betThisRound}</div>` : ''}
      `;
      layer.appendChild(seat);
    });
  }

  // ================================================================== //
  //  MENU
  // ================================================================== //
  $('btn-menu').addEventListener('click', () => $('overlay-menu').classList.remove('hidden'));
  $('btn-resume').addEventListener('click', () => $('overlay-menu').classList.add('hidden'));
  $('btn-view-standings').addEventListener('click', () => {
    $('overlay-menu').classList.add('hidden');
    const ranked = [...G.players].sort((a, b) => b.chips - a.chips);
    showResult({ title: 'Chip standings', lines: ranked.map(p => ({ name: p.name, amount: p.chips, handName: p.out ? 'Out' : '', winner: false })) });
    $('btn-next-hand').textContent = 'Close';
    const restore = () => { $('btn-next-hand').textContent = 'Next hand'; $('btn-next-hand').removeEventListener('click', restoreOnce); };
    const restoreOnce = () => { restore(); };
    $('btn-next-hand').addEventListener('click', restoreOnce, { once: true });
  });
  $('btn-quit-game').addEventListener('click', () => {
    $('overlay-menu').classList.add('hidden');
    showScreen('setup');
  });
  $('btn-end-game').addEventListener('click', () => {
    if (confirm('End this game now and show final standings?')) endGame();
  });

  // ================================================================== //
  //  INIT
  // ================================================================== //
  renderRoster();
  applySettingsToInputs();

  window.__G = G; // read-only debug hook, e.g. for automated tests
})();
