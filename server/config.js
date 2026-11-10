'use strict';

// Balance and pacing live here; no character code needs editing to tune a table.
module.exports = Object.freeze({
  startingChips: 10,
  // Numerical precision ceiling, far beyond practical play. Four funded seats
  // and their combined pots remain exact JavaScript integers.
  maxChips: Math.floor(Number.MAX_SAFE_INTEGER / 8),
  maxPlayers: 4,
  smallBlind: 1,
  bigBlind: 2,
  handsPerBlind: 5,
  dieSides: 6,
  handsPerLevel: 5,
  maxLevel: 5,
  maxRaises: 3,
  turnMs: 25000,
  resultMs: 8500,
  matchmakingMs: 12000,
  botJoinMinMs: 4000,
  botJoinMaxMs: 8000,
  botThinkMs: 3000,
  botThinkJitterMs: 3000,
  disconnectGraceMs: 10000,
  tickMs: 250,
  roomExpiryMs: 30 * 60 * 1000,
  resurrectionChips: 10,
  kamikazeScavenge: 2,
  kamikazeBlast: 2,
  investmentReward: 4,
  investorDividendDivisor: 10,
  investorGrant3: 5,
  investorBoostCost: 3,
  investorGrant5: 10,
  bountyReward: 5,
  bountyRollBonus: 2,
  bountyFoldPenalty: 2,
  bountyStrike: 5,
  fighterFoldPenalty: 1
});
