'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine } = require('../server/engine');
const { characters, foldPenalties } = require('../server/characters');
const { BotBrain } = require('../server/bots');
const { newGame } = require('../vendor/globby');

function table(types = ['kamikaze', 'investor', 'hunter', 'fighter'], options = {}) {
  const engine = new GameEngine({ now: () => 1000, roll: () => 3, ...options });
  const state = engine.createState('ABC123');
  const players = types.map((type, i) => {
    const p = engine.addPlayer(state, `p${i}`, { name: `Seat ${i}` });
    assert.equal(engine.apply(state, p.id, { type: 'select', character: type, name: p.name, revision: state.revision }).ok, true);
    return p;
  });
  const act = (p, type, data = {}) => engine.apply(state, p.id, { type, ...data, revision: state.revision });
  return { engine, state, players, act };
}

function stagedHand(t, commitments, chips, totals) {
  t.engine.beginHand(t.state);
  t.players.forEach((p, i) => {
    p.committed = commitments[i]; p.chips = chips[i];
    p.dice = { hidden: totals[i] - 1, visible: 1 };
  });
}

test('only rotating blind seats post chips and the big blind keeps its checking option', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  for (const [dealer, small, big, first] of [[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]]) {
    t.players.forEach(p => { p.chips = 10; });
    t.engine.beginHand(t.state);
    assert.deepEqual(t.state.blinds, { dealer: `p${dealer}`, small: `p${small}`, big: `p${big}`, smallAmount: 1, bigAmount: 2 });
    assert.equal(t.state.betTo, 2);
    assert.equal(t.state.turn, `p${first}`);
    assert.deepEqual(t.players.map(p => p.committed), t.players.map((p, i) => i === small ? 1 : i === big ? 2 : 0));
    assert.equal(t.players[dealer].chips, 10);
    for (let i = 0; i < 3; i++) {
      const p = t.players.find(p => p.id === t.state.turn);
      assert.equal(t.act(p, 'call').ok, true);
    }
    assert.equal(t.state.turn, `p${big}`);
    assert.equal(t.act(t.players[big], 'check').ok, true);
    assert.equal(t.state.phase, 'result');
  }
});

test('both blinds rise every five completed hands and keep the settled hand stakes until the next hand', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  assert.equal(t.engine.view(t.state, 'p0').rules.smallBlind, 1);
  assert.equal(t.engine.view(t.state, 'p0').rules.bigBlind, 2);
  for (let hand = 1; hand <= 31; hand++) {
    t.players.forEach(p => { p.chips = 1000; });
    t.engine.beginHand(t.state);
    const small = 1 + Math.floor((hand - 1) / 5), big = small + 1;
    assert.equal(t.state.handNumber, hand);
    assert.equal(t.state.blinds.smallAmount, small);
    assert.equal(t.state.blinds.bigAmount, big);
    assert.equal(t.state.betTo, big);
    assert.equal(t.players.reduce((sum, p) => sum + p.committed, 0), small + big);
    const assertView = () => {
      const view = t.engine.view(t.state, 'p0');
      assert.equal(view.rules.smallBlind, small);
      assert.equal(view.rules.bigBlind, big);
    };
    assertView();
    while (t.state.phase === 'betting') {
      const p = t.players.find(p => p.id === t.state.turn);
      assert.equal(t.act(p, p.committed < t.state.betTo ? 'call' : 'check').ok, true);
    }
    assert.equal(t.state.completedHands, hand);
    assertView();
  }
  assert.ok(t.players.every(p => p.level === 5), 'blinds keep increasing beyond the level cap');
});

test('increased heads-up blinds keep full call stakes while short stacks post only their remaining chips', () => {
  const t = table(['investor', 'investor']);
  t.state.completedHands = 5;
  t.players[0].chips = 5;
  t.players[1].chips = 1;
  t.engine.beginHand(t.state);
  assert.deepEqual(t.state.blinds, { dealer: 'p0', small: 'p0', big: 'p1', smallAmount: 2, bigAmount: 1 });
  assert.equal(t.state.betTo, 3);
  assert.equal(t.engine.view(t.state, 'p0').rules.bigBlind, 3);
  assert.equal(t.players[1].eliminated, false);
  assert.equal(t.act(t.players[0], 'call').ok, true);
  assert.equal(t.state.phase, 'result');
  assert.equal(t.players.reduce((sum, p) => sum + p.chips, 0), 6);
});

test('blinds skip eliminated seats; heads-up dealer posts small, short big blind remains all-in', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  t.players[1].eliminated = true; t.players[1].chips = 0;
  t.engine.beginHand(t.state);
  assert.equal(t.state.blinds.small, 'p2');
  assert.equal(t.state.blinds.big, 'p3');
  assert.deepEqual(t.state.order, ['p0', 'p2', 'p3']);
  t.players[2].eliminated = true; t.players[2].chips = 0;
  t.players[0].chips = 1;
  t.engine.beginHand(t.state);
  assert.deepEqual(t.state.blinds, { dealer: 'p3', small: 'p3', big: 'p0', smallAmount: 1, bigAmount: 1 });
  assert.equal(t.state.turn, 'p3');
  assert.equal(t.players[0].inHand, true);
  assert.equal(t.players[0].eliminated, false);
  assert.equal(t.act(t.players[3], 'call').ok, true);
  assert.equal(t.state.phase, 'result');
  assert.deepEqual(t.players.map(p => p.chips), [1, 0, 0, 8]);
});

test('a player who has not paid yet wins the blinds when everyone else folds', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  t.engine.beginHand(t.state);
  for (const id of ['p3', 'p1', 'p2']) {
    t.state.pending = [id, ...t.state.pending.filter(p => p !== id)];
    t.engine.advance(t.state);
    assert.equal(t.act(t.players.find(p => p.id === id), 'fold').ok, true);
  }
  assert.equal(t.state.phase, 'result');
  assert.deepEqual(t.state.result.winners, ['p0']);
  assert.deepEqual(t.players.map(p => p.chips), [13, 9, 8, 10]);
});

test('eliminations continue automatically through three and two players, ending with one champion', () => {
  let now = 1000;
  const t = table(['investor', 'investor', 'investor', 'investor'], { now: () => now });
  for (const victim of [1, 2, 3]) {
    t.engine.beginHand(t.state);
    for (const p of t.players.filter(p => p.inHand)) {
      p.committed = 1; p.chips = p.id === `p${victim}` ? 0 : 10;
      p.dice = { hidden: p.id === 'p0' ? 6 : 1, visible: p.id === 'p0' ? 6 : 1 };
    }
    t.engine.settle(t.state);
    assert.equal(t.players[victim].eliminated, true);
    const view = t.engine.view(t.state, t.players[1].id);
    assert.equal(view.you, 'p1', 'eliminated viewers retain their seat');
    if (victim < 3) {
      assert.equal(t.state.phase, 'result');
      now = t.state.deadline;
      t.engine.tick(t.state);
      assert.equal(t.state.phase, 'betting');
      assert.equal(t.engine.active(t.state).length, 4 - victim);
      assert.ok(t.state.pending.every(id => !t.players.find(p => p.id === id).eliminated));
      assert.equal(t.engine.view(t.state, 'p1').players[1].dice, null);
    } else {
      assert.equal(t.state.phase, 'finished');
      assert.equal(t.state.champion, 'p0');
      assert.equal(t.state.deadline, null);
    }
  }
});

test('setup, character locking, and server-authoritative action validation', () => {
  const t = table();
  assert.deepEqual(t.players.map(p => p.chips), [10, 10, 10, 10]);
  assert.deepEqual(t.players.map(p => p.level), [1, 1, 1, 1]);
  assert.equal(t.act(t.players[1], 'start').ok, false);
  t.engine.beginHand(t.state);
  assert.equal(t.act(t.players[0], 'select', { character: 'hunter', name: 'Exploit' }).ok, false);
  const turn = t.players.find(p => p.id === t.state.turn);
  assert.equal(t.act(turn, 'raise', { amount: -1 }).ok, false);
  assert.equal(t.act(turn, 'raise', { amount: 0.2 }).ok, false);
  assert.equal(t.act(turn, 'raise', { amount: Infinity }).ok, false);
  assert.equal(t.act(turn, 'raise', { amount: 1000 }).ok, false);
  const old = t.state.revision;
  assert.equal(t.act(turn, 'call').ok, true);
  assert.equal(t.engine.apply(t.state, turn.id, { type: 'check', revision: old }).ok, false);
  assert.equal(t.act(turn, 'check').ok, false);
});

test('folding keeps exactly two dice, consumes no extra roll and never reveals secrets', () => {
  let rolls = 0;
  const t = table(['investor', 'hunter', 'fighter'], { roll: () => (++rolls % 6) + 1 });
  t.engine.beginHand(t.state);
  assert.equal(rolls, 6);
  const turn = t.players.find(p => p.id === t.state.turn);
  const secret = turn.dice.hidden;
  assert.equal(t.act(turn, 'fold').ok, true);
  assert.equal(rolls, 6);
  assert.equal(Object.hasOwn(turn, 'foldDie'), false);
  assert.equal(turn.dice.hidden, secret);
  assert.equal(t.act(turn, 'fold').ok, false);
  const other = t.players.find(p => p !== turn);
  assert.equal(t.engine.view(t.state, other.id).players.find(p => p.id === turn.id).dice.hidden, null);
  while (t.state.phase === 'betting') {
    const p = t.players.find(p => p.id === t.state.turn);
    t.act(p, p.committed >= t.state.betTo ? 'check' : 'call');
  }
  assert.equal(t.engine.view(t.state, other.id).players.find(p => p.id === turn.id).dice.hidden, null);
  assert.equal(t.state.history[0].revealed.some(p => p.id === turn.id), false);
});

test('funded folds apply one Fighter penalty plus tagged Hunter penalties without a reward', () => {
  const t = table(['investor', 'hunter', 'fighter', 'fighter']);
  t.players[1].level = 3; t.players[1].target = t.players[0].id;
  t.engine.beginHand(t.state);
  t.engine.pay(t.players[0], 2);
  t.state.turn = t.players[0].id;
  t.state.pending = t.players.map(p => p.id);
  assert.equal(t.act(t.players[0], 'fold').ok, true);
  assert.equal(t.players[0].chips, 10 - 2 - 2 - 1);
  assert.equal(t.state.events.filter(e => e.type === 'ability' && e.playerId === 'p0' && e.amount === -1).length, 1);
});

test('Fighter fold pressure requires a current contribution, counts both blinds, and never stacks', () => {
  for (const [seat, extraContribution, expected] of [[0, 0, 0], [1, 0, 1], [2, 0, 1], [0, 4, 1]]) {
    const t = table(['investor', 'investor', 'fighter', 'fighter']);
    t.engine.beginHand(t.state);
    const p = t.players[seat];
    if (extraContribution) t.engine.pay(p, extraContribution);
    t.state.pending = [p.id, ...t.state.pending.filter(id => id !== p.id)];
    t.engine.advance(t.state);
    const before = t.players.map(p => p.chips), committed = p.committed;
    const estimates = foldPenalties(t.players, p, t.engine.rules);
    assert.equal(estimates.reduce((sum, entry) => sum + entry.amount, 0), expected);
    assert.equal(t.act(p, 'fold').ok, true);
    assert.equal(p.chips, before[seat] - expected);
    assert.equal(10 - p.chips, committed + expected, 'the total loss is the pot contribution plus the extra penalty');
    assert.equal(t.state.events.findLast(e => e.type === 'fold').penalty, expected);
    assert.equal(p.committed, committed, 'pressure does not add to the pot');
    assert.ok(t.players.every((other, i) => other === p || other.chips === before[i]), 'no Fighter receives the lost chip');
  }
});

test('Fighter pressure excludes folded and eliminated opponents but includes competing all-ins', () => {
  const t = table(['investor', 'fighter', 'fighter', 'investor']);
  t.engine.beginHand(t.state);
  const [p, folded, eliminated] = t.players;
  t.engine.pay(p, 1);
  folded.folded = true;
  eliminated.eliminated = true;
  assert.deepEqual(foldPenalties(t.players, p, t.engine.rules), []);
  eliminated.eliminated = false; eliminated.chips = 0;
  assert.equal(foldPenalties(t.players, p, t.engine.rules).length, 1);
});

test('timeout folds pay Fighter pressure only once and never beyond the remaining bankroll', () => {
  let now = 1000;
  const t = table(['investor', 'investor', 'fighter', 'fighter'], { now: () => now });
  t.engine.beginHand(t.state);
  const p = t.players[1]; // Small blind: already contributed, still owes a chip.
  p.chips = 1;
  t.state.pending = [p.id, ...t.state.pending.filter(id => id !== p.id)];
  t.engine.advance(t.state);
  now = t.state.deadline;
  t.engine.tick(t.state);
  assert.equal(p.folded, true);
  assert.equal(p.chips, 0);
  assert.equal(t.state.events.filter(e => e.type === 'ability' && e.playerId === p.id && e.amount === -1).length, 1);
});

test('all-ins receive only eligible main/side pots and uncalled excess returns', () => {
  const t = table(['investor', 'investor', 'investor']);
  stagedHand(t, [2, 5, 8], [0, 0, 2], [12, 10, 4]);
  const pots = t.engine.buildPots(t.state);
  assert.deepEqual(pots.map(p => p.amount), [6, 6, 3]);
  t.engine.settle(t.state);
  assert.deepEqual(t.players.map(p => p.chips), [6, 6, 5]);
  assert.equal(t.state.result.pots[2].refund, true);
});

test('the sole remaining contender wins the whole pot when everyone else folds', () => {
  const t = table(['investor', 'investor', 'investor']);
  stagedHand(t, [2, 5, 5], [0, 5, 5], [12, 5, 5]);
  t.players[1].folded = true; t.players[2].folded = true;
  t.engine.settle(t.state);
  assert.deepEqual(t.players.map(p => p.chips), [12, 5, 5]);
  assert.equal(t.state.result.pots[1].refund, false);
});

test('Fighter bonuses unlock at levels 2 through 5 and ties prefer eligible Fighters', () => {
  const t = table(['investor', 'fighter', 'hunter']);
  const fighter = t.players[1], investor = t.players[0];
  fighter.level = 2;
  t.engine.beginHand(t.state);
  assert.equal(t.state.order.at(-1), fighter.id);
  fighter.dice = investor.dice = { hidden: 3, visible: 3 };
  assert.equal(t.engine.winners([fighter, investor]).length, 2);
  fighter.level = 3;
  assert.deepEqual(t.engine.winners([fighter, investor]).map(p => p.id), [fighter.id]);
  fighter.chips = 3; investor.chips = 8;
  assert.equal(characters.fighter.bonus(fighter, [investor]), 0);
  fighter.level = 4;
  assert.equal(characters.fighter.bonus(fighter, [investor]), 1);
  fighter.level = 5;
  assert.equal(characters.fighter.bonus(fighter, [investor]), 2);
  investor.chips = 1;
  assert.equal(characters.fighter.bonus(fighter, [investor]), 1);
});

test('multiple tied Fighters split, and additional Fighters use stable order', () => {
  const t = table(['fighter', 'fighter', 'investor']);
  t.players[0].level = t.players[1].level = 3;
  t.engine.beginHand(t.state);
  assert.deepEqual(t.state.order, ['p2', 'p0', 'p1']);
  assert.equal(t.engine.winners(t.players).length, 2);
});

test('Fighters move last stably across dealer rotations; level 1 keeps ordinary order', () => {
  const t = table(['fighter', 'hunter', 'fighter', 'investor']);
  t.players[0].level = t.players[2].level = 2;
  for (const expected of [
    ['p3', 'p1', 'p0', 'p2'], ['p1', 'p3', 'p0', 'p2'],
    ['p1', 'p3', 'p2', 'p0'], ['p3', 'p1', 'p2', 'p0']
  ]) {
    t.engine.beginHand(t.state);
    assert.deepEqual(t.state.order, expected);
    assert.deepEqual(t.state.pending, expected);
    assert.equal(t.state.turn, expected[0]);
  }
  const all = table(['fighter', 'fighter', 'fighter']);
  all.players.forEach(p => { p.level = 2; });
  all.engine.beginHand(all.state);
  assert.deepEqual(all.state.order, ['p0', 'p1', 'p2']);
  const locked = table(['fighter', 'hunter', 'fighter']);
  locked.engine.beginHand(locked.state);
  assert.deepEqual(locked.state.order, ['p0', 'p1', 'p2']);
});

test('raise and call records identify increments, totals, raiser and partial all-ins', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  t.engine.beginHand(t.state);
  const [caller, next, fourth, first] = t.players;
  assert.equal(t.act(first, 'raise', { amount: 2 }).ok, true);
  assert.equal(t.state.betLeader, first.id);
  let event = t.state.events.at(-1);
  assert.equal(event.raiseBy, 2);
  assert.equal(event.total, 4);
  assert.equal(event.amount, 4);
  assert.equal(t.act(caller, 'call').ok, true);
  event = t.engine.view(t.state, next.id).events.at(-1);
  assert.equal(event.target, first.id);
  assert.equal(event.amount, 4);
  assert.equal(event.betTo, 4);
  assert.equal(event.partial, false);
  assert.match(event.message, /Seat 0 calls 4 chips on Seat 3's raise to 4/);
  assert.equal(t.act(next, 'raise', { amount: 2 }).ok, true);
  assert.equal(t.state.betLeader, next.id);
  assert.equal(t.act(fourth, 'call').ok, true);
  first.chips = 1;
  assert.equal(t.act(first, 'call').ok, true);
  event = t.state.events.at(-1);
  assert.equal(event.target, next.id);
  assert.equal(event.amount, 1);
  assert.equal(event.total, 5);
  assert.equal(event.betTo, 6);
  assert.equal(event.allIn, true);
  assert.equal(event.partial, true);
  assert.match(event.message, /5 of 6 matched/);
  t.engine.beginHand(t.state);
  assert.equal(t.state.betLeader, null);
});

test('Invest stays locked across hands and pays repeatedly for the target’s eliminations', () => {
  const t = table(['investor', 'hunter', 'fighter', 'fighter']);
  const [investor, target] = t.players;
  assert.equal(t.act(investor, 'invest', { target: investor.id }).ok, false);
  assert.equal(t.act(investor, 'invest', { target: target.id }).ok, true);
  assert.deepEqual(investor.investment, { target: target.id });
  assert.equal(t.act(investor, 'invest', { target: t.players[2].id }).ok, false);
  assert.equal(t.act(investor, 'select', { character: 'investor', name: investor.name }).ok, false);
  stagedHand(t, [1, 1, 1, 1], [9, 9, 0, 9], [2, 12, 3, 4]);
  assert.equal(t.act(investor, 'invest', { target: target.id }).ok, false);
  t.engine.settle(t.state);
  assert.equal(investor.chips, 13);
  assert.deepEqual(investor.investment, { target: target.id });
  t.engine.beginHand(t.state);
  for (const p of t.players.filter(p => p.inHand)) {
    p.committed = 1; p.chips = p === t.players[3] ? 0 : 9;
    p.dice = { hidden: p === target ? 6 : 1, visible: p === target ? 6 : 1 };
  }
  t.engine.settle(t.state);
  assert.equal(investor.chips, 13);
  assert.equal(t.state.events.filter(e => e.message.includes('Investment return')).length, 2);
  assert.deepEqual(investor.investment, { target: target.id });
});

test('Invest ignores resurrection and clears without paying when the investment target dies', () => {
  const t = table(['investor', 'hunter', 'kamikaze', 'fighter']);
  const [investor, target, victim] = t.players;
  t.act(investor, 'invest', { target: target.id });
  t.engine.lose(t.state, victim, 10, 'test strike', target.id);
  assert.deepEqual(t.engine.resolveBankruptcies(t.state), []);
  assert.equal(victim.chips, 10);
  assert.equal(investor.chips, 10);
  t.engine.lose(t.state, victim, 10, 'test strike', target.id);
  t.engine.resolveBankruptcies(t.state);
  assert.equal(investor.chips, 14);
  t.engine.lose(t.state, target, 10, 'test strike', t.players[3].id);
  assert.deepEqual(t.engine.resolveBankruptcies(t.state), [target.id]);
  assert.equal(investor.chips, 14);
  assert.equal(investor.investment, null);
  t.engine.resolveBankruptcies(t.state);
  assert.equal(investor.chips, 14, 'the reward is paid once');
  assert.equal(t.act(investor, 'invest', { target: target.id }).ok, false);
  assert.equal(t.act(investor, 'invest', { target: t.players[3].id }).ok, true);
});

test('Invest credits a fatal strike between hands', () => {
  const t = table(['investor', 'hunter', 'fighter']);
  const [investor, hunter, target] = t.players;
  t.act(investor, 'invest', { target: hunter.id });
  hunter.level = 5; hunter.strikeAvailable = true; target.chips = 4;
  assert.equal(t.act(hunter, 'strike', { target: target.id }).ok, true);
  assert.equal(target.eliminated, true);
  assert.equal(investor.chips, 14);
  assert.deepEqual(target.eliminationSources, [hunter.id]);
  assert.deepEqual(investor.investment, { target: hunter.id });
});

test('multiple Investors earn returns; eliminating an Investor cannot rescue them', () => {
  const t = table(['investor', 'investor', 'hunter', 'fighter']);
  const [first, second, target, victim] = t.players;
  t.act(first, 'invest', { target: target.id });
  t.act(second, 'invest', { target: target.id });
  t.engine.lose(t.state, victim, 10, 'test strike', target.id);
  t.engine.resolveBankruptcies(t.state);
  assert.equal(first.chips, 14); assert.equal(second.chips, 14);
  assert.deepEqual(first.investment, { target: target.id });
  const batch = table(['investor', 'hunter', 'fighter', 'fighter']);
  const [investor, killer] = batch.players;
  batch.act(investor, 'invest', { target: killer.id });
  stagedHand(batch, [1, 1, 1, 1], [0, 9, 0, 9], [2, 12, 3, 4]);
  batch.engine.settle(batch.state);
  assert.equal(investor.eliminated, true);
  assert.equal(investor.chips, 0);
  assert.equal(batch.state.events.some(e => e.playerId === investor.id && e.message.includes('Investment return')), false);
});

test('Invest credits only funded pot layers, pays tied winners once per victim, and ignores refunds', () => {
  const side = table(['investor', 'hunter', 'hunter', 'fighter']);
  side.act(side.players[0], 'invest', { target: side.players[2].id });
  stagedHand(side, [1, 2, 1, 2], [9, 0, 9, 9], [2, 3, 12, 10]);
  side.engine.settle(side.state);
  assert.deepEqual(side.players[1].eliminationSources, ['p2', 'p3']);
  assert.equal(side.players[0].chips, 13);

  const unrelated = table(['investor', 'hunter', 'hunter', 'fighter']);
  unrelated.act(unrelated.players[0], 'invest', { target: unrelated.players[3].id });
  stagedHand(unrelated, [1, 1, 2, 2], [9, 0, 9, 9], [2, 3, 12, 10]);
  unrelated.engine.settle(unrelated.state);
  assert.deepEqual(unrelated.players[1].eliminationSources, ['p2']);
  assert.equal(unrelated.players[0].chips, 9, 'a winner only in an unrelated side pot earns no return');

  const tied = table(['investor', 'hunter', 'hunter', 'fighter']);
  tied.act(tied.players[0], 'invest', { target: tied.players[1].id });
  stagedHand(tied, [1, 2, 2, 2], [9, 9, 9, 0], [2, 12, 12, 3]);
  tied.engine.settle(tied.state);
  assert.deepEqual(tied.players[3].eliminationSources, ['p1', 'p2']);
  assert.equal(tied.players[0].chips, 13, 'winning two layers still pays only once for one victim');

  const refund = table(['investor', 'hunter', 'fighter']);
  refund.act(refund.players[0], 'invest', { target: refund.players[1].id });
  stagedHand(refund, [1, 1, 3], [9, 9, 0], [2, 12, 3]);
  refund.engine.settle(refund.state);
  assert.equal(refund.players[2].chips, 2);
  assert.equal(refund.players[2].eliminated, false);
  assert.equal(refund.players[0].chips, 9);
});

test('fatal fold pressure credits its source rather than the pot winner', () => {
  const t = table(['investor', 'fighter', 'hunter', 'hunter']);
  const [investor, fighter, victim, winner] = t.players;
  t.act(investor, 'invest', { target: fighter.id });
  stagedHand(t, [1, 1, 1, 1], [9, 9, 1, 9], [2, 3, 4, 12]);
  t.state.pending = [victim.id, investor.id, fighter.id, winner.id];
  t.engine.advance(t.state);
  assert.equal(t.act(victim, 'fold').ok, true);
  t.engine.settle(t.state);
  assert.equal(victim.eliminated, true);
  assert.deepEqual(victim.eliminationSources, [fighter.id]);
  assert.equal(investor.chips, 13);
});

test('winning after a fatal strike clears the source; a later bankruptcy does not reuse it', () => {
  const t = table(['investor', 'hunter', 'fighter']);
  const [investor, hunter, victim] = t.players;
  t.act(investor, 'invest', { target: hunter.id });
  stagedHand(t, [1, 1, 1], [9, 9, 3], [2, 3, 12]);
  hunter.level = 5; hunter.strikeAvailable = true;
  t.state.pending = [hunter.id, investor.id, victim.id];
  t.engine.advance(t.state);
  assert.equal(t.act(hunter, 'strike', { target: victim.id }).ok, true);
  assert.equal(victim.eliminated, false, 'all-ins still reach showdown');
  t.engine.settle(t.state);
  assert.equal(victim.chips, 3);
  assert.deepEqual(victim.eliminationSources, []);
  assert.equal(investor.chips, 9);
  t.engine.lose(t.state, victim, 3, 'another source', investor.id);
  t.engine.resolveBankruptcies(t.state);
  assert.equal(investor.chips, 9);
});

test('Invest pays per victim in a simultaneous blast even when its target also dies', () => {
  const t = table(['investor', 'kamikaze', 'fighter', 'hunter']);
  const [investor, target, victim, other] = t.players;
  t.act(investor, 'invest', { target: target.id });
  target.resurrections = 0;
  t.engine.lose(t.state, target, 10, 'another blast', other.id);
  t.engine.lose(t.state, victim, 10, 'target blast', target.id);
  t.engine.lose(t.state, other, 10, 'target blast', target.id);
  t.engine.resolveBankruptcies(t.state);
  assert.equal(investor.chips, 18);
  assert.equal(investor.investment, null);
});

test('Invest validates role, phase, and active targets; old Predict action is unavailable', () => {
  const t = table(['investor', 'hunter', 'fighter']);
  const [investor, other, victim] = t.players;
  assert.equal(t.act(other, 'invest', { target: investor.id }).ok, false);
  assert.equal(t.act(investor, 'predict', { target: other.id }).ok, false);
  t.engine.beginHand(t.state);
  assert.equal(t.act(investor, 'invest', { target: other.id }).ok, false);
  t.engine.settle(t.state);
  victim.eliminated = true; victim.chips = 0;
  assert.equal(t.act(investor, 'invest', { target: victim.id }).ok, false);
  assert.equal(t.act(investor, 'invest', { target: other.id }).ok, true);
});

test('Investor dividends pay immediately on each big blind using the pre-blind balance', () => {
  const t = table(['investor', 'investor', 'investor', 'investor']);
  t.players.forEach(p => { p.level = 2; });
  for (let hand = 0; hand < 4; hand++) {
    t.players.forEach(p => { p.chips = 30; });
    t.engine.beginHand(t.state);
    const bigBlind = t.state.blinds.big;
    for (const p of t.players) {
      assert.equal(p.chips, 30 - p.committed + (p.id === bigBlind ? 3 : 0));
    }
    assert.equal(t.state.events.filter(e => e.hand === t.state.handNumber && e.message.includes('Dividend')).length, 1);
    t.engine.settle(t.state);
    assert.equal(t.state.events.filter(e => e.hand === t.state.handNumber && e.message.includes('Dividend')).length, 1, 'settlement must not pay a second dividend');
  }
});

test('big-blind dividends round down, respect level 2, and stop with two survivors', () => {
  for (const [count, seats] of [[2, 2], [2, 4], [3, 4], [4, 4]]) {
    for (const [level, chips, reward] of [[1, 30, 0], [2, 9, 0], [2, 10, 1], [2, 19, 1], [2, 20, 2], [2, 22, 2], [2, 30, 3]]) {
      const types = Array(seats).fill('hunter');
      const bigIndex = count === 2 ? 1 : 2;
      types[bigIndex] = 'investor';
      const t = table(types);
      t.players.slice(count).forEach(p => { p.eliminated = true; p.chips = 0; });
      const investor = t.players[bigIndex];
      investor.level = level; investor.chips = chips;
      t.engine.beginHand(t.state);
      assert.equal(t.state.blinds.big, investor.id);
      const expectedReward = count > 2 ? reward : 0;
      assert.equal(investor.chips, chips - 2 + expectedReward);
      const events = t.state.events.filter(e => e.playerId === investor.id && e.message.includes('Dividend'));
      assert.equal(events.length, expectedReward ? 1 : 0);
      if (expectedReward) assert.equal(events[0].amount, expectedReward);
    }
  }
});

test('folding does not cancel or duplicate a dividend already paid on becoming BB', () => {
  const t = table(['hunter', 'hunter', 'investor']);
  const investor = t.players[2];
  investor.level = 2; investor.chips = 22;
  t.engine.beginHand(t.state);
  assert.equal(t.state.blinds.big, investor.id);
  assert.equal(investor.chips, 22);
  for (const p of t.players.filter(p => p !== investor)) t.engine.pay(p, 2 - p.committed);
  investor.folded = true;
  const before = investor.chips;
  t.engine.settle(t.state);
  assert.equal(investor.chips, before);
  assert.equal(t.state.events.filter(e => e.playerId === investor.id && e.message.includes('Dividend')).length, 1);
});

test('Investor instant grants unlock exactly once; boost costs 3, once per hand, level gated', () => {
  const t = table(['investor', 'hunter', 'fighter']);
  const p = t.players[0];
  t.state.completedHands = 10; t.engine.levelUp(t.state);
  assert.equal(p.level, 3); assert.equal(p.chips, 15);
  t.engine.levelUp(t.state); assert.equal(p.chips, 15);
  t.engine.beginHand(t.state); t.state.turn = p.id;
  assert.equal(t.act(p, 'boost').ok, false);
  p.level = 4; assert.equal(t.act(p, 'boost').ok, true);
  assert.equal(p.chips, 12); assert.equal(p.rollBonus, 1);
  assert.equal(t.act(p, 'boost').ok, false);
  t.state.phase = 'result'; t.state.completedHands = 20; t.engine.levelUp(t.state);
  assert.equal(p.level, 5); assert.equal(p.chips, 22);
  t.engine.levelUp(t.state); assert.equal(p.chips, 22);
});

test('Bounty target locking, level-gated duel bonus, fold penalty and hidden-die visibility', () => {
  const t = table(['hunter', 'investor', 'fighter']);
  const [hunter, target, other] = t.players;
  assert.equal(t.act(hunter, 'tag', { target: hunter.id }).ok, false);
  assert.equal(t.act(hunter, 'tag', { target: target.id }).ok, true);
  assert.equal(t.act(hunter, 'tag', { target: other.id }).ok, false);
  t.engine.beginHand(t.state);
  assert.equal(characters.hunter.bonus(hunter, [target], t.engine.rules), 0);
  hunter.level = 2;
  assert.equal(characters.hunter.bonus(hunter, [target], t.engine.rules), 2);
  assert.equal(characters.hunter.bonus(hunter, [other], t.engine.rules), 0);
  assert.equal(characters.hunter.onFoldAgainst(hunter, target, t.engine.rules), 0);
  hunter.level = 3;
  assert.equal(characters.hunter.onFoldAgainst(hunter, target, t.engine.rules), 2);
  assert.equal(t.engine.view(t.state, hunter.id).players[1].dice.hidden, null);
  hunter.level = 4;
  assert.equal(t.engine.view(t.state, hunter.id).players[1].dice.hidden, 3);
  assert.equal(t.engine.view(t.state, hunter.id).players[2].dice.hidden, null);
  assert.equal(t.engine.view(t.state, target.id).players[0].dice.hidden, null);
  hunter.eliminated = true;
  assert.equal(t.engine.view(t.state, hunter.id).players[1].dice.hidden, null);
});

test('Hunter collects 5 on final elimination, retags next target, and strikes once at level 5', () => {
  const t = table(['hunter', 'investor', 'fighter']);
  const [hunter, target, other] = t.players;
  t.act(hunter, 'tag', { target: target.id });
  target.chips = 0;
  t.engine.resolveBankruptcies(t.state);
  assert.equal(hunter.chips, 15); assert.equal(hunter.target, null);
  assert.equal(t.act(hunter, 'tag', { target: other.id }).ok, true);
  assert.equal(t.act(hunter, 'strike', { target: other.id }).ok, false);
  hunter.level = 5; characters.hunter.onUnlock(hunter, 5);
  assert.equal(t.act(hunter, 'strike', { target: other.id }).ok, true);
  assert.equal(other.chips, 5);
  assert.equal(t.act(hunter, 'strike', { target: other.id }).ok, false);
});

test('Kamikaze resurrects once; resurrection is not a bounty elimination', () => {
  const t = table(['kamikaze', 'hunter', 'investor']);
  const [kami, hunter] = t.players;
  hunter.target = kami.id; kami.chips = 0;
  assert.deepEqual(t.engine.resolveBankruptcies(t.state), []);
  assert.equal(kami.chips, 10); assert.equal(kami.resurrections, 0);
  assert.equal(hunter.chips, 10);
  kami.chips = 0;
  assert.deepEqual(t.engine.resolveBankruptcies(t.state), [kami.id]);
  assert.equal(hunter.chips, 15);
});

test('Kamikaze level 2 denies only its contribution when finally eliminated', () => {
  const t = table(['kamikaze', 'investor', 'hunter']);
  t.players[0].level = 2; t.players[0].resurrections = 0;
  stagedHand(t, [4, 4, 4], [0, 6, 6], [2, 12, 4]);
  t.engine.settle(t.state);
  assert.equal(t.players[1].chips, 14);
  assert.equal(t.players[0].eliminated, true);
  assert.equal(t.state.result.pots[0].amount, 8);
});

test('Kamikaze level 3 reward, level 4 blast, level 5 refresh have exact unlock timing', () => {
  const t = table();
  const kami = t.players[0];
  t.players[1].chips = 0; t.engine.resolveBankruptcies(t.state);
  assert.equal(kami.chips, 10);
  t.state.completedHands = 10; t.engine.levelUp(t.state);
  t.players[2].chips = 0; t.engine.resolveBankruptcies(t.state);
  assert.equal(kami.chips, 12);
  const fighter = t.players[3], before = fighter.chips;
  t.state.completedHands = 15; t.engine.levelUp(t.state);
  assert.equal(fighter.chips, before - 2);
  kami.resurrections = 0;
  t.state.completedHands = 20; t.engine.levelUp(t.state);
  assert.equal(kami.resurrections, 1);
  assert.equal(fighter.chips, before - 4);
  t.engine.levelUp(t.state);
  assert.equal(fighter.chips, before - 4);
});

test('progression is at hands 5/10/15/20, caps at 5, excludes bankrupt and eliminated players', () => {
  const t = table();
  for (const hands of [0, 4, 5, 9, 10, 14, 15, 19, 20, 99]) {
    t.state.completedHands = hands;
    t.players.forEach(p => { if (!p.eliminated) p.chips = 100; });
    t.engine.levelUp(t.state);
    assert.equal(t.players[0].level, Math.min(5, 1 + Math.floor(hands / 5)));
  }
  const other = table();
  other.state.completedHands = 5;
  other.players[1].chips = 0; other.players[2].eliminated = true;
  other.engine.levelUp(other.state);
  assert.equal(other.players[1].level, 1); assert.equal(other.players[2].level, 1);
});

test('simultaneous eliminations cannot earn rewards to rescue dead characters', () => {
  const t = table(['kamikaze', 'hunter', 'fighter', 'investor']);
  const [kami, hunter, fighter, investor] = t.players;
  kami.level = 3; kami.resurrections = 0; hunter.target = fighter.id;
  kami.chips = hunter.chips = fighter.chips = 0;
  const eliminated = t.engine.resolveBankruptcies(t.state);
  assert.equal(eliminated.length, 3);
  assert.equal(kami.chips, 0); assert.equal(hunter.chips, 0);
  assert.equal(investor.chips, 10);
});

test('surviving Kamikaze gains for each simultaneous victim; multiple blasts resolve together', () => {
  const t = table(['kamikaze', 'kamikaze', 'hunter', 'investor']);
  t.players[0].level = t.players[1].level = 3;
  t.players[2].chips = t.players[3].chips = 2;
  t.state.completedHands = 15;
  t.engine.levelUp(t.state);
  assert.equal(t.players[2].eliminated, true);
  // Investor unlocks its instant +5 before the batch resolves.
  assert.equal(t.players[3].eliminated, false);
  assert.equal(t.players[0].chips, 10 - 2 + 2);
  assert.equal(t.players[1].chips, 10 - 2 + 2);
});

test('betting timeout checks for free or folds; result deadline starts exactly one next hand', () => {
  let now = 1000;
  const t = table(['investor', 'hunter', 'fighter'], { now: () => now });
  t.engine.beginHand(t.state);
  const p = t.players.find(p => p.id === t.state.turn);
  t.engine.pay(p, t.state.betTo - p.committed);
  now = t.state.deadline; t.engine.tick(t.state);
  assert.equal(p.lastAction, 'Check');
  t.state.betTo = 4;
  const next = t.players.find(p => p.id === t.state.turn);
  now = t.state.deadline; t.engine.tick(t.state);
  assert.equal(next.folded, true);
  while (t.state.phase === 'betting') {
    const turn = t.players.find(p => p.id === t.state.turn);
    t.act(turn, 'call');
  }
  now = t.state.deadline; t.engine.tick(t.state);
  assert.equal(t.state.handNumber, 2);
  t.engine.tick(t.state); assert.equal(t.state.handNumber, 2);
});

test('Globby never returns raw metadata or secrets to unknown or authenticated viewers', () => {
  const engine = new GameEngine({ roll: () => 5 });
  let state;
  const Lobby = newGame({
    baseState: engine.createState('ABC123'), startBlockerFunction: () => undefined,
    joinBlockerFunction: () => true,
    connectFunction(s, ref) { state = s; engine.addPlayer(s, ref); },
    statePresenter: (s, ref) => engine.view(s, ref)
  });
  const lobby = new Lobby();
  lobby.joinGame('socket1', 'secret-token1'); lobby.joinGame('socket2', 'secret-token2');
  const game = lobby.games[0];
  state.players.forEach(p => { p.character = 'investor'; });
  engine.beginHand(state);
  const json = JSON.stringify(game.returnState('socket1'));
  assert.equal(json.includes('secret-token'), false);
  assert.equal(json.includes('socket2'), false);
  assert.equal(game.returnState('socket1').players[1].dice.hidden, null);
  assert.deepEqual(game.returnState('unknown'), { error: 'Unknown player.' });
  game.disconnect('socket1');
  lobby.joinGame('socket3', 'secret-token1');
  assert.equal(game.returnState('socket3').you, 'player1');
  assert.equal(state.players.length, 2);
  assert.equal(lobby.gamesNum(), 1);
});

test('bot equity uses only legal information, includes bonuses, and handles ties', () => {
  const t = table(['investor', 'hunter']);
  t.engine.beginHand(t.state);
  const brain = new BotBrain(t.engine.rules, () => 0.5);
  t.players[0].dice = { hidden: 6, visible: 6 };
  t.players[1].dice = { hidden: 1, visible: 1 };
  const view = t.engine.view(t.state, t.players[0].id);
  assert.equal(brain.equity(view, view.players[0]), 1);
  t.players[1].dice.hidden = 6;
  assert.equal(brain.equity(t.engine.view(t.state, t.players[0].id), view.players[0]), 1);
  t.players[0].dice = { hidden: 1, visible: 1 };
  const weak = t.engine.view(t.state, t.players[0].id);
  assert.ok(brain.equity(weak, weak.players[0]) < 0.1);
});

test('seeded bot tournaments produce valid actions, finite balances and complete games', () => {
  let finished = 0;
  for (let seed = 1; seed <= 12; seed++) {
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
    const t = table(undefined, { roll: () => 1 + Math.floor(random() * 6) });
    const brain = new BotBrain(t.engine.rules, random);
    t.engine.beginHand(t.state);
    for (let step = 0; step < 3000 && t.state.phase !== 'finished'; step++) {
      if (t.state.phase === 'result') {
        for (const p of t.engine.active(t.state)) {
          const action = brain.choose(t.engine.view(t.state, p.id), p.id);
          if (action) assert.equal(t.act(p, action.type, action).ok, true);
        }
        t.engine.beginHand(t.state); t.state.revision++;
      } else {
        const p = t.players.find(p => p.id === t.state.turn);
        const action = brain.choose(t.engine.view(t.state, p.id), p.id);
        assert.ok(action);
        assert.equal(t.act(p, action.type, action).ok, true);
      }
      for (const p of t.players) assert.ok(Number.isSafeInteger(p.chips) && p.chips >= 0, `Seed ${seed}, hand ${t.state.handNumber}: ${JSON.stringify(t.players.map(x => [x.character, x.chips, x.eliminated]))}`);
    }
    if (t.state.phase === 'finished') finished++;
  }
  assert.equal(finished, 12);
});

test('45 actual completed hands unlock sequentially and folded survivors also level', () => {
  const t = table();
  t.players.forEach(p => { p.chips = 1000; });
  for (let hand = 1; hand <= 45; hand++) {
    t.engine.beginHand(t.state);
    t.players.forEach(p => { p.dice = { hidden: p.character === 'kamikaze' ? 6 : 1, visible: p.character === 'kamikaze' ? 6 : 1 }; });
    while (t.state.phase === 'betting') {
      const p = t.players.find(other => other.id === t.state.turn);
      assert.equal(t.act(p, p.character === 'hunter' ? 'fold' : p.committed < t.state.betTo ? 'call' : 'check').ok, true);
    }
    assert.equal(t.state.completedHands, hand);
    assert.ok(t.players.every(p => p.level === Math.min(5, 1 + Math.floor(hand / 5))));
    assert.ok(t.players.every(p => !p.eliminated));
  }
});

test('Invest credits eliminations by level-up blasts', () => {
  const t = table();
  const [kami, investor, target, fighter] = t.players;
  t.players.forEach(p => { p.level = 3; p.chips = 10; });
  t.state.phase = 'result'; t.state.completedHands = 14;
  assert.equal(t.act(investor, 'invest', { target: kami.id }).ok, true);
  stagedHand(t, [1, 1, 1, 1], [10, 10, 1, 10], [12, 2, 3, 4]);
  t.engine.settle(t.state);
  assert.equal(target.eliminated, true);
  assert.ok(t.state.result.eliminated.includes(target.id));
  assert.equal(investor.chips, 10 - 2 + 4); // Small blind: no dividend; blast, investment.
  assert.equal(kami.level, 4); assert.equal(fighter.level, 4);
});

test('the numerical ceiling keeps chip growth and raises exact', () => {
  const t = table();
  const p = t.players[1];
  p.chips = t.engine.rules.maxChips - 1;
  t.engine.gain(t.state, p, 10, 'Precision check');
  assert.equal(p.chips, t.engine.rules.maxChips);
  t.engine.beginHand(t.state); t.state.turn = p.id; t.state.betTo = 2;
  assert.equal(t.act(p, 'raise', { amount: Number.MAX_SAFE_INTEGER }).ok, false);
});
