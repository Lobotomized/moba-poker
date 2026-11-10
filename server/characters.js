'use strict';

// Bulgarian translations: Камикадзе = Kamikaze; Инвеститор = Investor;
// Ловец на глави = Bounty Hunter; Боец = Fighter.
const definitions = {
  kamikaze: {
    name: 'Камикадзе', subtitle: 'The last spark', symbol: '✦', color: '#e7a57e',
    description: 'Fall. Rise. Take the whole table with you.',
    abilities: [
      'Resurrect with 10 chips once when bankrupt.',
      'On final elimination, your contributed chips are denied to the winners.',
      'Gain 2 chips whenever another player is eliminated.',
      'Immediately take 2 chips from every other active player.',
      'Refresh resurrection and trigger your 2-chip blast again.'
    ]
  },
  investor: {
    name: 'Investor', subtitle: 'Fortune favors foresight', symbol: '◈', color: '#e2c77b',
    description: 'Read the room. Make your fortune compound.',
    abilities: [
      'Invest in a player; gain 4 coins every time they eliminate someone other than you. Choose again when your target dies.',
      'When you become big blind, gain 1 coin per 10 held before posting the blind, rounded down. Only while more than 2 players remain.',
      'Immediately gain 5 chips.',
      'Once per hand, spend 3 chips to add 1 to your dice total.',
      'Immediately gain 10 chips.'
    ]
  },
  hunter: {
    name: 'Bounty Hunter', subtitle: 'Every debt has a name', symbol: '⌖', color: '#9dbfae',
    description: 'Choose your quarry. Collect what you are owed.',
    abilities: [
      'Tag a player; earn 5 chips on their elimination, then tag again.',
      'Add 2 to your dice total when competing against your target.',
      'Your target loses 2 chips if they fold against you.',
      'See your target’s hidden die.',
      'Once, take 5 chips from any other active player.'
    ]
  },
  fighter: {
    name: 'Fighter', subtitle: 'Never yield', symbol: '⚔', color: '#b4a2d3',
    description: 'Pressure the weak. Win the closest fight.',
    abilities: [
      'Folding against any Fighter costs 1 extra coin on top of your chips already in the pot (blinds count). Multiple Fighters still charge only 1 extra.',
      'Last to act in the betting order. Multiple Fighters keep their relative order.',
      'Win tied dice totals. Tied Fighters split the pot.',
      'Add 1 to your total against opponents holding more chips.',
      'Permanently add 1 to every dice total.'
    ]
  }
};

class Character {
  has(player, level) { return player.level >= level; }
  onUnlock() {}
  bonus() { return 0; }
  onFoldAgainst() { return 0; }
  onElimination() {}
}

class Kamikaze extends Character {
  onUnlock(player, level, context) {
    if (level === 1) player.resurrections = 1;
    if (level === 4) context.blast(player);
    if (level === 5) {
      player.resurrections = 1;
      context.blast(player);
      context.log('ability', `${player.name} rekindles their abilities.`, player.id);
    }
  }
  onElimination(player, victim, context) {
    if (player.id !== victim.id && this.has(player, 3)) {
      context.gain(player, context.rules.kamikazeScavenge, 'Scavenger');
    }
  }
}

class Investor extends Character {
  onElimination(player, victim, context) {
    if (victim.id !== player.id && victim.eliminationSources.includes(player.investment?.target)) {
      context.gain(player, context.rules.investmentReward, 'Investment return');
    }
  }
  onUnlock(player, level, context) {
    if (level === 3) context.gain(player, context.rules.investorGrant3, 'Windfall');
    if (level === 5) context.gain(player, context.rules.investorGrant5, 'Fortune');
  }
}

class BountyHunter extends Character {
  bonus(player, opponents, rules) {
    return this.has(player, 2) && opponents.some(other => other.id === player.target)
      ? rules.bountyRollBonus : 0;
  }
  onFoldAgainst(player, folded, rules) {
    return this.has(player, 3) && player.target === folded.id ? rules.bountyFoldPenalty : 0;
  }
  onElimination(player, victim, context) {
    if (player.target === victim.id) {
      context.gain(player, context.rules.bountyReward, 'Bounty collected');
      player.target = null;
    }
  }
  onUnlock(player, level) {
    if (level === 5) player.strikeAvailable = true;
  }
}

class Fighter extends Character {
  bonus(player, opponents) {
    return (this.has(player, 5) ? 1 : 0)
      + (this.has(player, 4) && opponents.some(other => other.chips > player.chips) ? 1 : 0);
  }
  onFoldAgainst(player, folded, rules) {
    return this.has(player, 1) && folded.committed > 0 ? rules.fighterFoldPenalty : 0;
  }
}

const characters = {
  kamikaze: new Kamikaze(), investor: new Investor(),
  hunter: new BountyHunter(), fighter: new Fighter()
};

// Fighter pressure applies once per fold; Hunter penalties remain per hunter.
// Shared by authoritative actions and the bot's estimate of folding costs.
function foldPenalties(opponents, folded, rules) {
  let fighterApplied = false;
  const penalties = [];
  for (const source of opponents) {
    if (!source.inHand || source.folded || source.eliminated || source.id === folded.id) continue;
    const amount = characters[source.character].onFoldAgainst(source, folded, rules);
    if (!amount || (source.character === 'fighter' && fighterApplied)) continue;
    if (source.character === 'fighter') fighterApplied = true;
    penalties.push({ source, amount });
  }
  return penalties;
}

module.exports = { definitions, characters, foldPenalties, Character, Kamikaze, Investor, BountyHunter, Fighter };
