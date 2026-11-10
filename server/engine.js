'use strict';

const { randomInt } = require('node:crypto');
const defaultRules = require('./config');
const { characters, foldPenalties } = require('./characters');

class RuleError extends Error {}

class GameEngine {
  constructor(options = {}) {
    this.rules = { ...defaultRules, ...options.rules };
    this.roll = options.roll || (() => randomInt(1, this.rules.dieSides + 1));
    this.now = options.now || Date.now;
  }

  createState(roomCode) {
    return {
      roomCode, phase: 'lobby', players: [], host: null, revision: 0,
      completedHands: 0, handNumber: 0, dealerIndex: -1, blinds: null,
      order: [], pending: [], turn: null, betTo: 0, raises: 0, betLeader: null,
      events: [], eventSeq: 0, history: [], result: null,
      deadline: null, startAt: null
    };
  }

  log(state, type, message, playerId = null, details = {}) {
    state.events.push({ id: ++state.eventSeq, type, message, playerId, hand: state.handNumber, ...details });
    state.events = state.events.slice(-60);
  }

  addPlayer(state, id, { name = 'Traveler', bot = false } = {}) {
    let player = state.players.find(p => p.id === id);
    if (player) {
      player.connected = true;
      player.disconnectedAt = null;
      state.revision++;
      return player;
    }
    if (state.phase !== 'lobby' || state.players.length >= this.rules.maxPlayers) throw new RuleError('This table is full or already playing.');
    player = {
      id, name, bot, connected: true, character: null, level: 1,
      chips: this.rules.startingChips, eliminated: false,
      resurrections: 0, target: null, investment: null, strikeAvailable: false,
      eliminationSources: [],
      dice: null, folded: false, inHand: false,
      committed: 0, rollBonus: 0, boosted: false, acted: false,
      lastAction: '', disconnectedAt: null
    };
    state.players.push(player);
    state.host ||= id;
    this.log(state, 'join', `${player.name} takes a seat.`, id);
    state.revision++;
    return player;
  }

  active(state) { return state.players.filter(p => !p.eliminated && p.chips > 0); }
  contenders(state) { return state.players.filter(p => p.inHand && !p.folded && !p.eliminated); }
  context(state) {
    return {
      rules: this.rules,
      log: (...args) => this.log(state, ...args),
      gain: (p, amount, reason) => this.gain(state, p, amount, reason),
      blast: source => {
        // Apply every loss first, then resolve bankruptcies as one batch.
        for (const p of this.active(state)) {
          if (p.id !== source.id) this.lose(state, p, this.rules.kamikazeBlast, `${source.name}'s blast`, source.id);
        }
      }
    };
  }

  gain(state, player, amount, reason) {
    if (player.eliminated) return;
    const actual = Math.min(amount, this.rules.maxChips - player.chips);
    player.chips += actual;
    if (player.chips > 0) player.eliminationSources = [];
    this.log(state, 'ability', `${player.name} gains ${actual} chips · ${reason}.`, player.id, { amount: actual });
  }

  lose(state, player, amount, reason, sourceId = null) {
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    if (actual > 0 && player.chips === 0) player.eliminationSources = sourceId ? [sourceId] : [];
    this.log(state, 'ability', `${player.name} loses ${actual} chips · ${reason}.`, player.id, { amount: -actual });
  }

  require(condition, message) { if (!condition) throw new RuleError(message); }

  apply(state, id, move) {
    try {
      this.require(move && typeof move === 'object' && !Array.isArray(move), 'Invalid action.');
      this.require(move.revision === state.revision, 'The table changed. Please try again.');
      const p = state.players.find(player => player.id === id);
      this.require(p && !p.eliminated, 'You are not an active player.');
      this.require(typeof move.type === 'string', 'Invalid action.');
      this.action(state, p, move);
      state.revision++;
      return { ok: true, revision: state.revision };
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      return { ok: false, error: error.message, revision: state.revision };
    }
  }

  action(state, p, move) {
    const between = state.phase === 'lobby' || state.phase === 'result';
    if (move.type === 'select') {
      this.require(state.phase === 'lobby', 'Characters are locked for this game.');
      this.require(!p.investment, 'Your investment is locked until its target is eliminated.');
      this.require(Object.hasOwn(characters, move.character), 'Unknown character.');
      this.require(typeof move.name === 'string' && move.name.trim().length > 0 && move.name.trim().length <= 20, 'Use a name of 1–20 characters.');
      p.name = move.name.trim();
      p.character = move.character;
      p.resurrections = move.character === 'kamikaze' ? 1 : 0;
      p.target = null;
      p.investment = null;
      if (p.id === state.host) state.startAt = this.now() + this.rules.matchmakingMs;
      return;
    }
    if (move.type === 'start') {
      this.require(state.phase === 'lobby' && p.id === state.host, 'Only the host can start the table.');
      this.require(state.players.length >= 2 && state.players.every(other => other.character), 'Every player must select a character.');
      this.beginHand(state);
      return;
    }
    this.require(p.character, 'Choose your character first.');
    if (move.type === 'tag') {
      this.require(p.character === 'hunter' && p.level >= 1, 'Bounty Hunter ability required.');
      this.require(between || (state.phase === 'betting' && state.turn === p.id), 'Tag between hands or on your turn.');
      this.require(!p.target, 'Your existing bounty must be collected first.');
      const target = this.validTarget(state, p, move.target);
      p.target = target.id;
      this.log(state, 'ability', `${p.name} tags ${target.name}.`, p.id, { target: target.id });
      return;
    }
    if (move.type === 'invest') {
      this.require(p.character === 'investor' && between, 'Invest between hands.');
      this.require(!p.investment, 'Your investment is locked until its target is eliminated.');
      const target = this.validTarget(state, p, move.target);
      p.investment = { target: target.id };
      this.log(state, 'ability', `${p.name} invests in ${target.name}.`, p.id, { target: target.id });
      return;
    }
    if (move.type === 'strike') {
      this.require(p.character === 'hunter' && p.level >= 5 && p.strikeAvailable, 'Your level 5 strike is unavailable.');
      this.require(between || (state.phase === 'betting' && state.turn === p.id), 'Use this ability between hands or on your turn.');
      const target = this.validTarget(state, p, move.target);
      p.strikeAvailable = false;
      this.lose(state, target, this.rules.bountyStrike, `${p.name}'s final bounty`, p.id);
      // Zero-chip all-ins are settled at showdown, never prematurely removed.
      if (between) { this.resolveBankruptcies(state); this.checkFinished(state); }
      return;
    }
    this.require(state.phase === 'betting' && state.turn === p.id && p.inHand && !p.folded && p.chips > 0, 'It is not your betting turn.');
    if (move.type === 'boost') {
      this.require(p.character === 'investor' && p.level >= 4 && !p.boosted, 'This boost is unavailable.');
      this.require(p.chips >= this.rules.investorBoostCost, 'You need 3 chips.');
      p.chips -= this.rules.investorBoostCost;
      p.rollBonus++;
      p.boosted = true;
      this.log(state, 'ability', `${p.name} spends 3 chips for +1 to their dice total.`, p.id);
      if (p.chips === 0) { this.removePending(state, p.id); this.advance(state); }
      return;
    }
    const owed = Math.max(0, state.betTo - p.committed);
    if (move.type === 'fold') {
      p.folded = true;
      p.lastAction = 'Fold';
      const opponents = this.contenders(state);
      const chipsBeforePressure = p.chips;
      for (const { source, amount } of foldPenalties(opponents, p, this.rules)) {
        this.lose(state, p, amount, `${source.name}'s fold pressure`, source.id);
      }
      const penalty = chipsBeforePressure - p.chips;
      this.log(state, 'fold', `${p.name} folds · leaves ${p.committed} chips in the pot${penalty ? ` and loses ${penalty} extra` : ''}.`, p.id,
        { action: 'fold', committed: p.committed, penalty });
    } else if (move.type === 'check') {
      this.require(owed === 0, 'Call the outstanding bet or fold.');
      p.lastAction = 'Check';
      this.log(state, 'bet', `${p.name} checks.`, p.id, { action: 'check', total: p.committed });
    } else if (move.type === 'call') {
      this.require(owed > 0, 'There is no bet to call.');
      const amount = this.pay(p, owed);
      const raiser = state.players.find(other => other.id === state.betLeader);
      const partial = p.committed < state.betTo;
      p.lastAction = `Call ${amount}${p.chips === 0 ? ' · all in' : ''}`;
      this.log(state, 'bet', `${p.name} calls ${amount} chips${raiser ? ` on ${raiser.name}'s raise to ${state.betTo}` : ''}${p.chips === 0 ? ' · all in' : ''}${partial ? ` · ${p.committed} of ${state.betTo} matched` : ''}.`, p.id,
        { action: 'call', amount, total: p.committed, betTo: state.betTo, target: state.betLeader, allIn: p.chips === 0, partial });
    } else if (move.type === 'raise') {
      this.require(state.raises < this.rules.maxRaises, 'The raise limit has been reached.');
      this.require(Number.isSafeInteger(move.amount) && move.amount >= 1, 'Raise by a positive whole number.');
      const desired = state.betTo + move.amount;
      this.require(Number.isSafeInteger(desired), 'That raise exceeds the table limit.');
      this.require(desired <= p.committed + p.chips, 'You do not have enough chips for that raise.');
      const amount = this.pay(p, desired - p.committed);
      state.betTo = desired;
      state.betLeader = p.id;
      state.raises++;
      p.lastAction = `Raise +${move.amount} to ${desired}${p.chips === 0 ? ' · all in' : ''}`;
      // A raise reopens action in the original order, starting after this seat.
      const index = state.order.indexOf(p.id);
      const cyclic = [...state.order.slice(index + 1), ...state.order.slice(0, index)];
      state.pending = cyclic.filter(otherId => {
        const other = state.players.find(x => x.id === otherId);
        return other.inHand && !other.folded && !other.eliminated && other.chips > 0;
      });
      this.log(state, 'bet', `${p.name} raises +${move.amount} to ${desired} chips${p.chips === 0 ? ' · all in' : ''}.`, p.id,
        { action: 'raise', amount, raiseBy: move.amount, total: desired, allIn: p.chips === 0 });
    } else {
      throw new RuleError('Unknown action.');
    }
    p.acted = true;
    this.removePending(state, p.id);
    this.advance(state);
  }

  validTarget(state, p, id) {
    const target = state.players.find(other => other.id === id);
    this.require(target && target.id !== p.id && !target.eliminated && target.chips > 0, 'Choose another active player with chips.');
    return target;
  }

  pay(p, amount) {
    const paid = Math.min(amount, p.chips);
    p.chips -= paid;
    p.committed += paid;
    return paid;
  }

  removePending(state, id) { state.pending = state.pending.filter(other => other !== id); }

  blindStakes(state) {
    const increase = Math.floor(Math.max(0, state.handNumber - 1) / this.rules.handsPerBlind);
    return { smallBlind: this.rules.smallBlind + increase, bigBlind: this.rules.bigBlind + increase };
  }

  beginHand(state) {
    if (this.checkFinished(state)) return;
    state.phase = 'betting';
    state.handNumber = state.completedHands + 1;
    state.result = null;
    const stakes = this.blindStakes(state);
    state.betTo = stakes.bigBlind;
    state.betLeader = null;
    state.raises = 0;
    const active = this.active(state);
    for (const p of state.players) {
      p.inHand = active.includes(p);
      p.folded = false; p.committed = 0;
      p.boosted = false; p.rollBonus = 0; p.acted = false; p.lastAction = '';
      p.eliminationSources = [];
      p.dice = p.inHand ? { hidden: this.roll(), visible: this.roll() } : null;
    }
    do { state.dealerIndex = (state.dealerIndex + 1) % state.players.length; }
    while (!state.players[state.dealerIndex].inHand);
    const seats = [...state.players.slice(state.dealerIndex + 1), ...state.players.slice(0, state.dealerIndex + 1)]
      .filter(p => p.inHand);
    const dealer = state.players[state.dealerIndex];
    // Heads-up: the dealer posts small blind and acts first.
    const small = active.length === 2 ? dealer : seats[0];
    const big = active.length === 2 ? seats[0] : seats[1];
    const dividend = active.length > 2 && big.character === 'investor' && big.level >= 2
      ? Math.floor(big.chips / this.rules.investorDividendDivisor) : 0;
    const smallAmount = this.pay(small, stakes.smallBlind);
    const bigAmount = this.pay(big, stakes.bigBlind);
    state.blinds = { dealer: dealer.id, small: small.id, big: big.id, smallAmount, bigAmount };
    this.log(state, 'blind', `${small.name} posts small blind ${smallAmount} chips.`, small.id, { action: 'smallBlind', amount: smallAmount });
    this.log(state, 'blind', `${big.name} posts big blind ${bigAmount} chips.`, big.id, { action: 'bigBlind', amount: bigAmount });
    if (dividend) this.gain(state, big, dividend, 'Dividend');
    const bettingSeats = active.length === 2 ? [dealer, big] : [...seats.slice(2), ...seats.slice(0, 2)];
    // Move unlocked Fighters last without changing either group's relative order.
    const fighters = bettingSeats.filter(p => p.character === 'fighter' && p.level >= 2);
    const ordinary = bettingSeats.filter(p => !fighters.includes(p));
    const ordered = [...ordinary, ...fighters];
    state.order = ordered.map(p => p.id);
    state.pending = ordered.filter(p => p.chips > 0).map(p => p.id);
    this.log(state, 'hand', `Hand ${state.handNumber} · the dice are cast.`);
    this.advance(state);
  }

  advance(state) {
    state.pending = state.pending.filter(id => {
      const p = state.players.find(other => other.id === id);
      return p.inHand && !p.folded && !p.eliminated && p.chips > 0;
    });
    if (this.contenders(state).length <= 1 || !state.pending.length) return this.settle(state);
    // A sole remaining chip-holder need not bet into already matched all-ins.
    if (state.pending.length === 1) {
      const p = state.players.find(other => other.id === state.pending[0]);
      const withChips = this.contenders(state).filter(other => other.chips > 0);
      if (withChips.length === 1 && p.committed >= state.betTo) return this.settle(state);
    }
    state.turn = state.pending[0];
    state.deadline = this.now() + this.rules.turnMs;
  }

  score(p, opponents) {
    return p.dice.hidden + p.dice.visible + p.rollBonus
      + characters[p.character].bonus(p, opponents, this.rules);
  }

  winners(eligible) {
    if (eligible.length <= 1) return eligible;
    const scored = eligible.map(p => ({ p, score: this.score(p, eligible.filter(other => other !== p)) }));
    const best = Math.max(...scored.map(entry => entry.score));
    let tied = scored.filter(entry => entry.score === best).map(entry => entry.p);
    const fighters = tied.filter(p => p.character === 'fighter' && p.level >= 3);
    if (fighters.length) tied = fighters;
    return tied;
  }

  buildPots(state) {
    const contributors = state.players.filter(p => p.inHand && p.committed > 0);
    const contenders = this.contenders(state);
    const levels = [...new Set(contributors.map(p => p.committed))].sort((a, b) => a - b);
    let previous = 0;
    return levels.map(level => {
      const funded = contributors.filter(p => p.committed >= level);
      const layer = level - previous;
      previous = level;
      const eligible = funded.filter(p => !p.folded && !p.eliminated);
      // The last player standing wins the blinds even before putting chips in.
      if (contenders.length === 1) {
        return { amount: layer * funded.length, layer, contributors: funded, winners: contenders, refund: false };
      }
      // Uncalled excess is returned even if its owner is not eligible to win.
      const refund = funded.length === 1 || !eligible.length;
      const winners = refund ? funded : this.winners(eligible);
      return { amount: layer * funded.length, layer, contributors: funded, winners, refund };
    });
  }

  payouts(pots, denied = new Set()) {
    const payouts = new Map();
    for (const pot of pots) {
      const burned = pot.refund ? 0 : pot.contributors.filter(p => denied.has(p.id)).length * pot.layer;
      const amount = pot.amount - burned;
      if (!pot.winners.length) continue;
      const share = Math.floor(amount / pot.winners.length);
      let remainder = amount % pot.winners.length;
      for (const p of pot.winners) {
        payouts.set(p.id, (payouts.get(p.id) || 0) + share + (remainder-- > 0 ? 1 : 0));
      }
    }
    return payouts;
  }

  settle(state) {
    state.phase = 'result';
    state.turn = null; state.pending = [];
    const pots = this.buildPots(state);
    // Record showdown scores before winnings change chip-based Fighter bonuses.
    const revealed = state.players.filter(p => p.inHand && !p.folded).map(p => ({
      id: p.id, name: p.name, hidden: p.dice.hidden, visible: p.dice.visible,
      total: this.score(p, this.contenders(state).filter(other => other !== p)),
      award: 0
    }));
    const provisional = this.payouts(pots);
    const denied = new Set(state.players.filter(p =>
      p.inHand && p.chips + (provisional.get(p.id) || 0) === 0
      && p.character === 'kamikaze' && p.level >= 2 && p.resurrections === 0
    ).map(p => p.id));
    const awards = this.payouts(pots, denied);
    for (const p of state.players) {
      p.chips = Math.min(this.rules.maxChips, p.chips + (awards.get(p.id) || 0));
      if (p.chips > 0) p.eliminationSources = [];
      else if (p.inHand && !p.eliminationSources.length) {
        // Credit winners only in contested pot layers funded by this victim.
        // Refunds and unrelated side pots cannot earn elimination credit.
        p.eliminationSources = [...new Set(pots.filter(pot =>
          !pot.refund && pot.contributors.includes(p)
        ).flatMap(pot => pot.winners.filter(winner => winner.id !== p.id).map(winner => winner.id)))];
      }
    }
    for (const id of denied) this.log(state, 'ability', 'Kamikaze denies their contributed chips to the winners.', id);
    const publicPots = pots.map(pot => ({
      amount: pot.amount - (pot.refund ? 0 : pot.contributors.filter(p => denied.has(p.id)).length * pot.layer),
      winners: pot.winners.map(p => p.id), refund: pot.refund
    }));
    for (const p of revealed) p.award = awards.get(p.id) || 0;
    const potTotal = pots.reduce((sum, pot) => sum + pot.amount, 0);
    const winnerIds = [...new Set(pots.filter(pot => !pot.refund).flatMap(pot => pot.winners.map(p => p.id)))];
    const winnerNames = winnerIds.map(id => state.players.find(p => p.id === id).name);
    this.log(state, 'result', `${winnerNames.join(' & ') || 'No one'} wins · ${potTotal} chips in play.`);
    const eliminated = this.resolveBankruptcies(state);
    state.completedHands++;
    eliminated.push(...this.levelUp(state));
    state.result = { hand: state.handNumber, pot: potTotal, winners: winnerIds, pots: publicPots, revealed, eliminated };
    state.history.unshift({ ...state.result, names: winnerNames, events: state.events.filter(e => e.hand === state.handNumber) });
    state.history = state.history.slice(0, 40);
    state.deadline = this.now() + this.rules.resultMs;
    this.checkFinished(state);
  }

  resolveBankruptcies(state) {
    const candidates = state.players.filter(p => !p.eliminated && p.chips === 0);
    const eliminated = [];
    // Snapshot the whole batch before rewards: simultaneous losers cannot rescue
    // themselves with bounty/scavenger rewards earned in the same elimination.
    for (const p of candidates) {
      if (p.character === 'kamikaze' && p.level >= 1 && p.resurrections > 0) {
        p.resurrections--;
        this.gain(state, p, this.rules.resurrectionChips, 'Resurrection');
      } else {
        p.eliminated = true;
        p.inHand = false;
        eliminated.push(p.id);
        this.log(state, 'elimination', `${p.name} is eliminated.`, p.id, { sources: [...p.eliminationSources] });
      }
    }
    const survivors = this.active(state);
    for (const victimId of eliminated) {
      const victim = state.players.find(p => p.id === victimId);
      for (const survivor of survivors) {
        characters[survivor.character].onElimination(survivor, victim, this.context(state));
      }
    }
    // Keep investments through this entire batch, including kills credited to
    // a target that also dies in the batch. Their final death unlocks retargeting.
    for (const survivor of survivors) {
      if (eliminated.includes(survivor.investment?.target)) survivor.investment = null;
    }
    return eliminated;
  }

  levelUp(state) {
    const level = Math.min(this.rules.maxLevel, 1 + Math.floor(state.completedHands / this.rules.handsPerLevel));
    const players = this.active(state).filter(p => p.level < level);
    // All eligible characters unlock before any unlock effect is resolved.
    const unlocks = players.map(p => ({ p, from: p.level + 1 }));
    for (const { p } of unlocks) p.level = level;
    for (const { p, from } of unlocks) {
      for (let unlocked = from; unlocked <= level; unlocked++) characters[p.character].onUnlock(p, unlocked, this.context(state));
      this.log(state, 'level', `${p.name} reaches level ${level}.`, p.id, { level });
    }
    return this.resolveBankruptcies(state);
  }

  checkFinished(state) {
    if (state.phase === 'lobby') return false;
    const remaining = this.active(state);
    if (remaining.length > 1) return false;
    state.phase = 'finished';
    state.champion = remaining[0]?.id || null;
    state.turn = null; state.deadline = null;
    return true;
  }

  tick(state) {
    const now = this.now();
    if (state.phase === 'result' && now >= state.deadline) {
      this.beginHand(state); state.revision++;
    } else if (state.phase === 'betting' && now >= state.deadline) {
      const p = state.players.find(other => other.id === state.turn);
      if (p) {
        const type = p.committed >= state.betTo ? 'check' : 'fold';
        this.apply(state, p.id, { type, revision: state.revision });
      }
    }
  }

  view(state, viewerId) {
    const viewer = state.players.find(p => p.id === viewerId);
    if (!viewer) throw new RuleError('Unknown viewer.');
    const view = structuredClone(state);
    // Globby transport metadata contains reconnect credentials. Never broadcast it.
    delete view.playersConfigArray;
    view.you = viewerId;
    view.serverNow = this.now();
    view.rules = { maxRaises: this.rules.maxRaises, handsPerLevel: this.rules.handsPerLevel, handsPerBlind: this.rules.handsPerBlind, turnMs: this.rules.turnMs, maxPlayers: this.rules.maxPlayers, matchmakingMs: this.rules.matchmakingMs, ...this.blindStakes(state) };
    for (const p of view.players) {
      p.foldCost = state.phase === 'betting' && p.inHand && !p.folded && !p.eliminated
        ? Math.min(p.chips, foldPenalties(state.players, p, this.rules).reduce((sum, entry) => sum + entry.amount, 0))
        : 0;
      const canPeek = viewer.character === 'hunter' && viewer.level >= 4 && viewer.target === p.id && !viewer.eliminated;
      const revealed = (state.phase === 'result' || state.phase === 'finished') && p.inHand && !p.folded;
      if (p.dice && p.id !== viewerId && !canPeek && !revealed) p.dice.hidden = null;
      p.peeked = p.id !== viewerId && canPeek && !!p.dice;
      delete p.disconnectedAt;
    }
    // History contains only showdown dice; folded hidden dice never enter it.
    return view;
  }
}

module.exports = { GameEngine, RuleError };
