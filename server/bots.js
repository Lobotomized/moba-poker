'use strict';

const { characters, foldPenalties } = require('./characters');
const { randomInt } = require('node:crypto');

const identities = [
  { character: 'hunter' },
  { character: 'kamikaze' },
  { character: 'investor' },
  { character: 'fighter' }
];

const botNames = [
  'Alex', 'Maya', 'Nikolai', 'Sofia', 'Daniel', 'Elena', 'Tomas', 'Nadia',
  'Oliver', 'Mila', 'Stefan', 'Clara', 'Leo', 'Iris', 'Martin', 'Anya',
  'Sam Rivera', 'Nina Petrova', 'Luca Rossi', 'Emma Reed', 'Theo Morgan',
  'Sara Ahmed', 'Victor Chen', 'Eva Novak', 'Noah Brooks', 'Lena Fischer',
  'Anton Ivanov', 'Alice Martin', 'Ivan K.', 'Daria S.', 'Ben W.', 'Julia M.',
  'milo_87', 'katya21', 'robin_w', 'maxwell', 'ellie_r', 'andrei92',
  'chris_t', 'miaRose', 'dannyG', 'sasha_v', 'lilyMae', 'nico_23',
  'petar88', 'jules', 'marta_k', 'tommyLee', 'ava_b', 'george77'
];

function chooseBotName(usedNames) {
  const used = new Set(usedNames.map(name => name.trim().toLowerCase()));
  const available = botNames.filter(name => !used.has(name.toLowerCase()));
  if (available.length) return available[randomInt(available.length)];
  let suffix = 1;
  while (used.has(`alex_${suffix}`)) suffix++;
  return `alex_${suffix}`;
}

class BotBrain {
  constructor(rules, random = Math.random) { this.rules = rules; this.random = random; }

  // Enumerate possible hidden dice. This method accepts only the same redacted
  // state a human receives; even the server-side bot cannot inspect secret rolls.
  equity(view, self) {
    const opponents = view.players.filter(p => p.inHand && !p.folded && !p.eliminated && p.id !== self.id);
    if (!opponents.length) return 1;
    const mine = self.dice.hidden + self.dice.visible + self.rollBonus
      + characters[self.character].bonus(self, opponents, this.rules);
    let total = 0, wins = 0;
    const enumerate = (index, values) => {
      if (index < opponents.length) {
        const p = opponents[index];
        const options = p.dice.hidden === null ? [1, 2, 3, 4, 5, 6] : [p.dice.hidden];
        for (const value of options) enumerate(index + 1, [...values, value]);
        return;
      }
      total++;
      const entries = [{ p: self, score: mine }, ...opponents.map((p, i) => ({
        p, score: values[i] + p.dice.visible + p.rollBonus
          + characters[p.character].bonus(p, [self, ...opponents.filter(other => other !== p)], this.rules)
      }))];
      const best = Math.max(...entries.map(e => e.score));
      let tied = entries.filter(e => e.score === best);
      const fighters = tied.filter(e => e.p.character === 'fighter' && e.p.level >= 3);
      if (fighters.length) tied = fighters;
      if (tied.some(e => e.p.id === self.id)) wins += 1 / tied.length;
    };
    enumerate(0, []);
    return wins / total;
  }

  choose(view, id) {
    const self = view.players.find(p => p.id === id);
    if (!self || self.eliminated || !self.character) return null;
    const others = view.players.filter(p => p.id !== id && !p.eliminated && p.chips > 0);
    const between = view.phase === 'lobby' || view.phase === 'result';
    const myTurn = view.phase === 'betting' && view.turn === id;
    if (!between && !myTurn) return null;
    const weak = [...others].sort((a, b) => a.chips - b.chips);
    if (self.character === 'hunter' && !self.target && weak.length) {
      // Avoid wasting a bounty on a fresh resurrection charge.
      const target = weak.find(p => p.character !== 'kamikaze' || !p.resurrections) || weak[0];
      return { type: 'tag', target: target.id };
    }
    if (self.character === 'hunter' && self.strikeAvailable && weak.length) {
      const target = others.find(p => p.id === self.target && p.chips <= 5) || weak[0];
      return { type: 'strike', target: target.id };
    }
    if (self.character === 'investor' && between && !self.investment && others.length) {
      const target = [...others].sort((a, b) => b.chips - a.chips)[0];
      return { type: 'invest', target: target.id };
    }
    if (!myTurn) return null;
    const equity = this.equity(view, self);
    const owed = Math.max(0, view.betTo - self.committed);
    const call = Math.min(owed, self.chips);
    const pot = view.players.reduce((sum, p) => sum + p.committed, 0);
    const opponents = view.players.filter(p => p.inHand && !p.folded && p.id !== id);
    const pressure = foldPenalties(opponents, self, this.rules).reduce((sum, penalty) => sum + penalty.amount, 0);
    const foldValue = -Math.min(self.chips, pressure);
    // Discount inaccessible side-pot chips when the bot has a short stack.
    const ceiling = self.committed + call;
    const accessiblePot = view.players.reduce((sum, p) => sum + Math.min(p.committed, ceiling || p.committed), 0);
    const callValue = equity * (accessiblePot + call) - call;
    if (self.character === 'investor' && self.level >= 4 && !self.boosted && self.chips > this.rules.investorBoostCost + call) {
      const boosted = { ...self, rollBonus: self.rollBonus + 1 };
      const gain = (this.equity(view, boosted) - equity) * (pot + call);
      if (gain > this.rules.investorBoostCost) return { type: 'boost' };
    }
    const canRaise = view.raises < this.rules.maxRaises && self.chips > owed && opponents.some(p => p.chips > 0);
    if (canRaise) {
      // Strong value raises, occasional cheap bluffs with a convincing visible die.
      const bluff = self.dice.visible >= 5 && this.random() < 0.08 && pressure >= 1;
      if ((equity > 0.72 && callValue >= foldValue) || bluff) {
        const available = self.chips - owed;
        const liveStacks = opponents.filter(p => p.chips > 0).map(p => p.chips);
        const vulnerableStack = Math.min(...liveStacks);
        const pressureBet = equity > 0.9 ? vulnerableStack : Math.ceil(vulnerableStack * 0.5);
        const amount = Math.min(available, Math.max(1, pressureBet, Math.floor(pot * (equity > 0.9 ? 0.65 : 0.35))));
        return { type: 'raise', amount };
      }
    }
    if (owed === 0) return { type: 'check' };
    const survivalBuffer = self.character === 'kamikaze' && self.resurrections ? -1.5 : 0.3;
    return callValue + survivalBuffer >= foldValue ? { type: 'call' } : { type: 'fold' };
  }
}

module.exports = { BotBrain, identities, botNames, chooseBotName };
