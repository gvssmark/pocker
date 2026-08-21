/* ==========================================================================
   Family Hold'em — pure game engine (no DOM, no Firebase)
   Operates on a plain "hand" object keyed by player uid, so it can be
   driven either locally or from state synced over the network.
   Exposed as window.PokerEngine (browser) / module.exports (node, for tests).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const RANK_ORDER = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
  const SUITS = ['s','h','d','c'];
  const SUIT_SYMBOL = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };
  const RED_SUITS = ['h', 'd'];
  const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];

  const TURN_TIME_MS = 120000; // 2 minutes to act before an auto-action kicks in

  function rankLabel(rank) {
    if (rank === 14) return 'A';
    if (rank === 13) return 'K';
    if (rank === 12) return 'Q';
    if (rank === 11) return 'J';
    if (rank === 10) return 'T';
    return String(rank);
  }

  function freshDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANK_ORDER) deck.push({ rank: RANK_VALUES[r], suit: s, label: r });
    return deck;
  }
  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function combinations(arr, k) {
    const results = [];
    (function helper(start, combo) {
      if (combo.length === k) { results.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) { combo.push(arr[i]); helper(i + 1, combo); combo.pop(); }
    })(0, []);
    return results;
  }

  function evaluate5(cards) {
    const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = suits.every(s => s === suits[0]);
    const counts = {};
    ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
    const groups = Object.entries(counts).map(([r, c]) => ({ rank: Number(r), count: c }))
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
      if (amount > 0) pots.push({ amount, eligible: payers.filter(p => !p.folded).map(p => p.id) });
      prevLevel = level;
    }
    return pots;
  }

  // ------------------------------------------------------------------
  // Hand lifecycle. `hand` shape:
  // {
  //   phase: 'preflop'|'flop'|'turn'|'river'|'showdown'|'result',
  //   order: [uid,...],              seat order for this hand, starting at dealer
  //   dealerUid, sbUid, bbUid,
  //   community: [card,...],
  //   pot, currentBet, minRaise,
  //   actingUid,
  //   players: { uid: { folded, allIn, totalBet, betThisRound, hasActed, chipsAtStart } },
  //   revealed: { uid: [card,card] },
  //   result: null | { lines, potSummaries, payouts }
  // }
  // Chips are NOT stored in `hand` — the caller reads/writes the room's
  // persistent player chip totals separately and applies `payouts` after
  // showdown/uncontested-win. This keeps the reducer pure and small.
  // ------------------------------------------------------------------

  function startHand(rosterInHand, dealerUid, smallBlind, bigBlind, now) {
    now = now || Date.now();
    // rosterInHand: [{id, chips}] in seat order (any rotation), chips > 0
    const dealerIdx = rosterInHand.findIndex(p => p.id === dealerUid);
    const order = [];
    for (let i = 0; i < rosterInHand.length; i++) order.push(rosterInHand[(dealerIdx + i) % rosterInHand.length].id);

    const deck = shuffle(freshDeck());
    const players = {};
    order.forEach(uid => {
      players[uid] = { folded: false, allIn: false, totalBet: 0, betThisRound: 0, hasActed: false };
    });

    const hole = {};
    order.forEach(uid => { hole[uid] = [deck.pop(), deck.pop()]; });

    const chipsById = {};
    rosterInHand.forEach(p => { chipsById[p.id] = p.chips; });

    const hand = {
      phase: 'preflop',
      order,
      dealerUid,
      community: [],
      pot: 0,
      currentBet: bigBlind,
      minRaise: bigBlind,
      actingUid: null,
      players,
      revealed: {},
      result: null,
      chipDelta: {}, // uid -> running chip change this hand (negative = put into pot)
    };
    order.forEach(uid => { hand.chipDelta[uid] = 0; });

    function postBlind(uid, amount) {
      const actual = Math.min(amount, chipsById[uid] + hand.chipDelta[uid]);
      hand.chipDelta[uid] -= actual;
      players[uid].totalBet += actual;
      players[uid].betThisRound += actual;
      hand.pot += actual;
      if (chipsById[uid] + hand.chipDelta[uid] === 0) players[uid].allIn = true;
    }

    const twoPlayers = order.length === 2;
    const sbUid = twoPlayers ? dealerUid : order[1];
    const bbUid = twoPlayers ? order[1] : order[2];
    postBlind(sbUid, smallBlind);
    postBlind(bbUid, bigBlind);
    hand.sbUid = sbUid;
    hand.bbUid = bbUid;
    hand.actingUid = twoPlayers ? sbUid : seatAfter(hand, bbUid);
    hand.actionDeadline = hand.actingUid ? now + TURN_TIME_MS : null;

    return { hand, deck, chipsById: { ...chipsById }, hole };
  }

  function seatAfter(hand, uid) {
    const order = hand.order;
    const pos = order.indexOf(uid);
    for (let step = 1; step <= order.length; step++) {
      const candidate = order[(pos + step) % order.length];
      const ps = hand.players[candidate];
      if (!ps.folded && !ps.allIn) return candidate;
    }
    return null;
  }

  function activeUnfolded(hand) {
    return hand.order.filter(uid => !hand.players[uid].folded);
  }
  function seatsStillToAct(hand) {
    return hand.order.filter(uid => {
      const ps = hand.players[uid];
      return !ps.folded && !ps.allIn && !ps.hasActed;
    });
  }

  // Applies one action from `actorUid`. Mutates and returns the hand.
  // `chipsById` is the caller's map of persistent chip counts (read-only here).
  // `action` in {fold, check, call, raise}; `raiseToTotal` required for raise.
  function applyAction(hand, chipsById, actorUid, action, raiseToTotal, now) {
    now = now || Date.now();
    if (hand.actingUid !== actorUid) throw new Error('not this player\'s turn');
    const ps = hand.players[actorUid];
    const remaining = chipsById[actorUid] + hand.chipDelta[actorUid];

    if (action === 'fold') {
      ps.folded = true; ps.hasActed = true;
    } else if (action === 'check') {
      if (ps.betThisRound !== hand.currentBet) throw new Error('cannot check facing a bet');
      ps.hasActed = true;
    } else if (action === 'call') {
      const toCall = Math.min(hand.currentBet - ps.betThisRound, remaining);
      hand.chipDelta[actorUid] -= toCall;
      ps.betThisRound += toCall;
      ps.totalBet += toCall;
      hand.pot += toCall;
      if (chipsById[actorUid] + hand.chipDelta[actorUid] === 0) ps.allIn = true;
      ps.hasActed = true;
    } else if (action === 'raise') {
      const addAmount = Math.min(raiseToTotal - ps.betThisRound, remaining);
      const newRaiseSize = (ps.betThisRound + addAmount) - hand.currentBet;
      hand.chipDelta[actorUid] -= addAmount;
      ps.betThisRound += addAmount;
      ps.totalBet += addAmount;
      hand.pot += addAmount;
      if (chipsById[actorUid] + hand.chipDelta[actorUid] === 0) ps.allIn = true;
      if (ps.betThisRound > hand.currentBet) {
        hand.minRaise = Math.max(hand.minRaise, newRaiseSize);
        hand.currentBet = ps.betThisRound;
        hand.order.forEach(uid => {
          const other = hand.players[uid];
          if (uid !== actorUid && !other.folded && !other.allIn) other.hasActed = false;
        });
      }
      ps.hasActed = true;
    } else {
      throw new Error('unknown action ' + action);
    }

    advanceActor(hand, now);
    return hand;
  }

  // Moves actingUid forward, or flags the hand as needing a street/showdown
  // by setting phase to a '-pending' sentinel the dealer client watches for.
  function advanceActor(hand, now) {
    now = now || Date.now();
    const unfolded = activeUnfolded(hand);
    if (unfolded.length === 1) { hand.actingUid = null; hand.actionDeadline = null; hand.phase = 'uncontested'; return; }

    const toAct = seatsStillToAct(hand);
    if (toAct.length === 0) {
      hand.actingUid = null;
      hand.actionDeadline = null;
      hand.phase = hand.phase + '-pending'; // e.g. 'preflop-pending' -> dealer deals flop
      return;
    }
    let next = seatAfter(hand, hand.actingUid);
    if (next !== null && hand.players[next].hasActed) {
      const order = hand.order, pos = order.indexOf(hand.actingUid);
      for (let step = 1; step <= order.length; step++) {
        const candidate = order[(pos + step) % order.length];
        const cps = hand.players[candidate];
        if (!cps.folded && !cps.allIn && !cps.hasActed) { next = candidate; break; }
      }
    }
    hand.actingUid = next;
    hand.actionDeadline = next ? now + TURN_TIME_MS : null;
  }

  // Folds `uid` regardless of whose turn it currently is. Used for both the
  // 2-minute turn timeout and for a player starting a break mid-hand. If it
  // happens to be their turn, advances the actor normally afterward.
  function forceFold(hand, uid, now) {
    now = now || Date.now();
    const ps = hand.players[uid];
    if (!ps || ps.folded || ps.allIn) return hand;
    ps.folded = true;
    ps.hasActed = true;
    if (hand.actingUid === uid) {
      advanceActor(hand, now);
    }
    return hand;
  }

  const STREET_AFTER = { preflop: 'flop', flop: 'turn', turn: 'river' };

  // Called by the dealer client (who holds `deck`) to reveal the next street.
  // Mutates hand.community / phase / betting fields; returns hand.
  //
  // IMPORTANT: this must be a PURE function of (hand, deck) — no side
  // effects on `deck` itself. It's called from inside a Firebase
  // transaction on the app side, and transactions may invoke their update
  // function more than once per logical commit (that's normal, expected
  // behavior, not an error case) — so mutating a shared external `deck`
  // array here (e.g. via .pop()) would deal different cards on each
  // invocation and corrupt the hand. Instead, community cards are derived
  // by fixed position from the untouched post-hole-cards deck:
  //   index 0        = preflop burn
  //   index 1,2,3    = flop
  //   index 4        = flop->turn burn
  //   index 5        = turn
  //   index 6        = turn->river burn
  //   index 7        = river
  function dealNextStreet(hand, deck, now) {
    now = now || Date.now();
    const base = hand.phase.replace('-pending', '');
    hand.order.forEach(uid => {
      const ps = hand.players[uid];
      ps.betThisRound = 0;
      ps.hasActed = false;
    });
    hand.currentBet = 0;

    if (base === 'preflop') {
      hand.community = deck.slice(1, 4);
      hand.phase = 'flop';
    } else if (base === 'flop') {
      hand.community = deck.slice(1, 4).concat([deck[5]]);
      hand.phase = 'turn';
    } else if (base === 'turn') {
      hand.community = deck.slice(1, 4).concat([deck[5], deck[7]]);
      hand.phase = 'river';
    } else if (base === 'river') {
      hand.phase = 'showdown';
      return hand;
    } else {
      return hand; // already past river / unexpected phase — no-op
    }

    const canAct = seatsStillToAct(hand);
    if (canAct.length < 2 && activeUnfolded(hand).length > 1) {
      // still more than one live player but not enough who CAN act (rest all-in) -> keep dealing
      hand.phase = hand.phase + '-pending';
      return hand;
    }
    if (activeUnfolded(hand).length === 1) { hand.phase = 'uncontested'; hand.actionDeadline = null; return hand; }
    hand.actingUid = firstActorPostflop(hand);
    hand.actionDeadline = hand.actingUid ? now + TURN_TIME_MS : null;
    return hand;
  }

  function firstActorPostflop(hand) {
    const order = hand.order;
    const pos = order.indexOf(hand.dealerUid);
    for (let step = 1; step <= order.length; step++) {
      const candidate = order[(pos + step) % order.length];
      const ps = hand.players[candidate];
      if (!ps.folded && !ps.allIn) return candidate;
    }
    return null;
  }

  // Computes showdown result once hand.revealed has an entry for every
  // still-unfolded player. Returns { lines, potSummaries, payouts }.
  function resolveShowdown(hand) {
    const contenders = activeUnfolded(hand);
    const scored = contenders.map(uid => {
      const score = bestOf7(hand.revealed[uid].concat(hand.community));
      return { uid, score };
    });
    const potPlayers = hand.order.map(uid => ({ id: uid, totalBet: hand.players[uid].totalBet, folded: hand.players[uid].folded }));
    const pots = computePots(potPlayers);

    const payouts = {};
    const potSummaries = [];
    pots.forEach((pot, potIdx) => {
      const eligible = scored.filter(e => pot.eligible.includes(e.uid));
      if (eligible.length === 0) return;
      let best = eligible[0].score;
      eligible.forEach(e => { if (compareScores(e.score, best) > 0) best = e.score; });
      const winners = eligible.filter(e => compareScores(e.score, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      winners.forEach((w, i) => { payouts[w.uid] = (payouts[w.uid] || 0) + share + (i < remainder ? 1 : 0); });
      potSummaries.push({
        label: pots.length > 1 ? (potIdx === 0 ? 'Main pot' : `Side pot ${potIdx}`) : 'Pot',
        amount: pot.amount, winners: winners.map(w => w.uid), handName: HAND_NAMES[best[0]],
      });
    });

    const lines = scored.sort((a, b) => compareScores(b.score, a.score)).map(e => ({
      uid: e.uid, handName: HAND_NAMES[e.score[0]], amount: payouts[e.uid] || 0, winner: !!payouts[e.uid],
    }));

    return { lines, potSummaries, payouts };
  }

  function resolveUncontested(hand) {
    const winnerUid = activeUnfolded(hand)[0];
    const payouts = { [winnerUid]: hand.pot };
    return { lines: [{ uid: winnerUid, handName: 'Everyone else folded', amount: hand.pot, winner: true }], potSummaries: [], payouts };
  }

  return {
    HAND_NAMES, SUIT_SYMBOL, RED_SUITS, rankLabel, TURN_TIME_MS,
    freshDeck, shuffle, evaluate5, bestOf7, compareScores, computePots,
    startHand, applyAction, dealNextStreet, resolveShowdown, resolveUncontested, forceFold,
    activeUnfolded, seatsStillToAct,
  };
});
