'use strict';

const app = document.querySelector('#app');
const dialog = document.querySelector('#sheet');
const content = document.querySelector('#sheet-content');
const connection = document.querySelector('#connection');
let storedToken;
try { storedToken = localStorage.getItem('dicebound-token'); } catch {}
const socket = io({ auth: { token: storedToken } });
let definitions = {};
let state = null;
let selected = 'fighter';
let busy = false;
let toastTimer;
let nameValue = 'Traveler';
let dialogKind = null;
let lastAnnounced = 0;
let expandedSkills = new Set();
let pendingAbility = null;
let lastStateSignature = '';
let bettingExpanded = false;

const skillTitles = {
  kamikaze: ['Resurrection', 'Last spark', 'Scavenger', 'Blast', 'Rekindle'],
  investor: ['Invest', 'Dividends', 'Windfall', 'Dice boost', 'Fortune'],
  hunter: ['Tag target', 'Bounty bonus', 'Fold penalty', 'Reveal quarry', 'Final bounty'],
  fighter: ['Fold pressure', 'Last to act', 'Win ties', 'Underdog', 'Veteran']
};
const activeSkills = {
  hunter: { 1: { type: 'tag', targeted: true }, 5: { type: 'strike', targeted: true } },
  investor: { 1: { type: 'invest', targeted: true }, 4: { type: 'boost', targeted: false } }
};

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const definition = p => definitions[p.character] || { name: 'Choosing…', symbol: '◇', color: '#94a198', abilities: [] };
const you = () => state?.players.find(p => p.id === state.you);
const playerName = id => state?.players.find(p => p.id === id)?.name || 'Traveler';
const initials = name => escape(name);
const chip = amount => `<span class="coin" aria-hidden="true">◈</span> ${amount}`;

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 3500);
}

function request(event, data = {}) {
  return new Promise(resolve => {
    if (!socket.connected) { toast('Reconnecting to the table…'); resolve({ ok: false }); return; }
    busy = true; document.body.classList.add('busy');
    socket.timeout(7000).emit(event, data, (error, result) => {
      busy = false; document.body.classList.remove('busy');
      if (error) { toast('The server did not respond. Please try again.'); resolve({ ok: false }); return; }
      if (!result?.ok) toast(result?.error || 'The action could not be completed.');
      resolve(result);
    });
  });
}

async function move(type, data = {}) {
  if (!state || busy) return;
  const result = await request('move', { type, ...data, revision: state.revision });
  if (result.ok && dialogKind === 'abilities') renderAbilities();
  return result;
}

function die(value, label, extra = '') {
  const positions = {
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9]
  };
  const pips = value === null ? '<span aria-hidden="true">◇</span>' :
    `<span class="pips" aria-hidden="true">${(positions[value] || []).map(n => `<i class="pip" style="grid-area:${Math.ceil(n / 3)}/${((n - 1) % 3) + 1}"></i>`).join('')}</span>`;
  return `<div><div class="die ${value === null ? 'hidden' : ''} ${extra}" aria-label="${escape(label)}: ${value === null ? 'concealed' : value}">${pips}</div><div class="die-label">${escape(label)}</div></div>`;
}

function levels(p) {
  return `<div class="level-track" aria-label="Level ${p.level} of 5">${[1, 2, 3, 4, 5].map(n => `<i class="level-dot ${n <= p.level ? 'unlocked' : ''}"></i>`).join('')}<span class="level-note">LVL ${p.level}</span></div>`;
}

function renderWelcome() {
  document.body.classList.remove('playing');
  document.body.classList.remove('poker-view');
  app.innerHTML = `
    <section class="welcome"><span class="eyebrow">WELCOME TO THE VELVET TABLE</span><h1>A little luck.<br><em>A lot to lose.</em></h1><p>Hidden dice. Open wagers. Four paths to power.<br>Take a seat, build your fortune, and be the last one standing.</p></section>
    <div class="section-title"><b class="eyebrow">01 / CHOOSE YOUR CHARACTER</b><span>10 chips · Level 1 · Yours for the game</span></div>
    <div class="character-grid">${Object.entries(definitions).map(([id, d]) => `
      <button class="character-card ${id === selected ? 'selected' : ''}" data-select="${id}" aria-pressed="${id === selected}" aria-haspopup="dialog" style="--accent:${d.color}">
        <span class="character-glyph" aria-hidden="true">${d.symbol}</span><h3>${escape(d.name)}</h3><div class="sub">${escape(d.subtitle)}</div><p>${escape(d.description)}</p>
        <div class="card-foot"><span>View 5 abilities ↗</span><i class="selection-dot" aria-hidden="true"></i></div>
      </button>`).join('')}</div>
    <div class="enter-panel"><div class="field"><label for="player-name">YOUR NAME AT THE TABLE</label><input id="player-name" maxlength="20" autocomplete="nickname" value="${escape(nameValue)}"></div><button class="primary" id="create-button">Review role & play <span aria-hidden="true">↗</span></button></div>
    <div class="welcome-foot"><span>Invite friends or play with cunning rivals.</span><button class="text-button" id="join-button">Join a friend's table →</button></div>
    <div class="ornament" aria-hidden="true">✧</div>`;
  app.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => {
    nameValue = app.querySelector('#player-name').value;
    selected = button.dataset.select; renderWelcome(); showCharacter(selected, 1);
  }));
  app.querySelector('#create-button').onclick = () => showCharacter(selected, 1);
  app.querySelector('#join-button').onclick = showJoin;
  app.querySelector('#player-name').oninput = event => { nameValue = event.target.value; };
}

async function enterTable(code, matchmaking = false) {
  if (busy) return;
  nameValue = nameValue.trim() || 'Traveler';
  if (state?.phase === 'lobby' && !you()?.character && typeof code !== 'string') {
    const result = await move('select', { character: selected, name: nameValue });
    if (result?.ok) closeSheet();
    return result;
  }
  if (matchmaking) {
    closeSheet();
    renderMatchConnecting();
    window.scrollTo({ top: 0, behavior: 'instant' });
    const result = await request('matchmake', { character: selected, name: nameValue });
    if (!result.ok) {
      if (state) { state.phase === 'lobby' ? renderLobby() : renderGame(); }
      else { renderWelcome(); showCharacter(selected, 1); }
    }
    return result;
  }
  const result = await request(typeof code === 'string' ? 'joinRoom' : 'createRoom', typeof code === 'string' ? { code } : {});
  if (result.ok) {
    closeSheet();
    return move('select', { character: selected, name: nameValue });
  }
  return result;
}

function renderMatchConnecting() {
  document.body.classList.remove('playing');
  document.body.classList.remove('poker-view');
  app.innerHTML = `<section class="matchmaking-status connecting-search" role="status" aria-label="Finding a game">
    <span class="search-spinner" aria-hidden="true"></span><span class="eyebrow">MATCHMAKING</span>
    <h2>Finding a game…</h2><p>Joining the search as <strong>${escape(definitions[selected]?.name || selected)}</strong>.</p>
    <p class="muted">Connecting you to a table. Your search will appear here.</p>
  </section>`;
}

function renderLobby() {
  document.body.classList.remove('poker-view');
  const self = you();
  if (!self.character) {
    const cached = state; renderWelcome(); state = cached;
    app.querySelector('#create-button').textContent = 'Review role & get ready';
    app.querySelector('#join-button').hidden = true;
    return;
  }
  document.body.classList.remove('playing');
  const host = self.id === state.host;
  const matching = state.matchmaking;
  app.innerHTML = `${tableHeader(matching ? 'FINDING YOUR TABLE' : 'THE SEATS ARE FILLING')}
    ${matching
      ? `<section class="matchmaking-status lobby-note" aria-label="Waiting for a game">
        <div class="search-heading" role="status"><span class="search-spinner" aria-hidden="true"></span><span class="eyebrow">WAITING FOR PLAYERS</span></div>
        <h2>Waiting for players</h2><p>Your seat is saved. The game starts when all seats are ready.</p>
        <strong class="search-player-count">${state.players.filter(p => p.connected && p.character).length} / ${state.rules.maxPlayers} players ready</strong>
        <div class="matchmaking-track" aria-hidden="true"><i style="width:${state.players.filter(p => p.connected && p.character).length / state.rules.maxPlayers * 100}%"></i></div>
        <p class="search-detail">Players appear here as they join your table.</p>
        <button class="secondary" id="leave-button">Cancel search</button>
      </section>`
      : `<div class="lobby-note"><span class="eyebrow">WAITING FOR PLAYERS</span><br>Invite friends with table code <button class="pill-button table-code" id="lobby-copy-code" aria-label="Copy table code">${state.roomCode} ⧉</button>.<br><span class="muted small">Waiting for everyone to choose a character. The game starts when all seats are ready.</span></div>`}
    <div class="lobby-seats">${[0, 1, 2, 3].map(index => {
      const p = state.players[index];
      return p ? `<div class="waiting-seat filled" style="--accent:${definition(p).color}" data-player-id="${p.id}" data-bot="${p.bot}"><span class="seat-symbol">${definition(p).symbol}</span><strong>${escape(p.name)}${p.id === self.id ? ' · you' : ''}</strong><span class="small">${escape(definition(p).name)} · ${chip(p.chips)}</span><span class="small muted">${!p.connected ? 'Reconnecting…' : p.character ? 'Ready to play' : 'Choosing a character'}</span>${targetStatus(p)}${p.character ? `<button class="player-skills-button" data-player-skills="${p.id}" aria-label="View skills for ${escape(p.name)}">View skills ↗</button>` : ''}</div>`
        : `<div class="waiting-seat"><span class="seat-symbol">${matching ? '◇' : '+'}</span><span>${matching ? 'Looking for a player…' : 'Open seat'}</span><span class="small">Waiting for a player</span></div>`;
    }).join('')}</div>
    ${matching ? '' : `<div class="lobby-controls"><button class="secondary" id="invite-button">Copy invitation</button>${host ? '<button class="primary" id="start-button">Deal the first hand →</button>' : '<span class="muted">Waiting for the host</span>'}</div>`}
    <div class="welcome-foot"><button class="text-button" id="abilities-button">Your character abilities</button>${matching ? '' : '<button class="text-button" id="leave-button">Leave table</button>'}</div>`;
  bindTableTools();
  app.querySelector('#invite-button')?.addEventListener('click', copyInvitation);
  app.querySelector('#start-button')?.addEventListener('click', () => move('start'));
  app.querySelector('#abilities-button').onclick = showAbilities;
  app.querySelector('#leave-button').onclick = leaveTable;
  updateTimers();
}

function tableHeader(kicker = 'THE VELVET TABLE') {
  const interval = state.rules.handsPerLevel;
  const next = state.completedHands % interval;
  return `<div class="table-top"><div><span class="eyebrow">${kicker}</span><h2>${state.phase === 'lobby' ? state.matchmaking ? 'Your game is on its way.' : 'A seat awaits you.' : `Hand ${String(state.handNumber).padStart(2, '0')}`}</h2></div>
    <div class="table-tools">${state.matchmaking ? '' : `<button class="pill-button table-code" id="copy-code" aria-label="Copy table code">${state.roomCode} ⧉</button>`}<button class="pill-button" id="history-button">History</button><button class="pill-button" id="table-skills-button">Skills</button>
    ${state.phase !== 'lobby' ? `<div class="hand-progress"><span>${you().eliminated ? 'SPECTATING' : you().level >= 5 ? 'MAX LEVEL' : `${interval - next} ${interval - next === 1 ? 'hand' : 'hands'} to level up`}</span>${you().eliminated ? '' : `<div class="progress-bar"><i style="width:${you().level >= 5 ? 100 : next / interval * 100}%"></i></div>`}</div>` : ''}</div></div>`;
}

function huntersTargeting(player) {
  if (player.eliminated) return [];
  return state.players.filter(p => p.character === 'hunter' && !p.eliminated && p.target === player.id);
}

function bountyStatus(player) {
  const hunters = huntersTargeting(player);
  const incoming = hunters.length
    ? `<div class="bounty-marker">⌖ Targeted by <strong>${hunters.map(p => escape(p.name)).join(', ')}</strong></div>`
    : '';
  const outgoing = player.character === 'hunter' && !player.eliminated && player.target
    ? `<div class="bounty-quarry">⌖ Target: <strong>${escape(playerName(player.target))}</strong></div>`
    : '';
  return incoming + outgoing;
}

function hasInvestment(player) {
  return player.character === 'investor' && !player.eliminated && !!player.investment?.target;
}

function investorsTargeting(player) {
  if (player.eliminated) return [];
  return state.players.filter(p => hasInvestment(p) && p.investment.target === player.id);
}

function targetStatus(player) {
  const incoming = investorsTargeting(player).map(p =>
    `<div class="investment-marker">◈ Invested in by <strong>${escape(p.name)}</strong></div>`
  ).join('');
  const outgoing = hasInvestment(player)
    ? `<div class="investment-quarry">◈ Investment: <strong>${escape(playerName(player.investment.target))}</strong> · +4 per elimination</div>`
    : '';
  return bountyStatus(player) + incoming + outgoing;
}

function abilityTargets() {
  return state.players.filter(p => p.id !== state.you && !p.eliminated && p.chips > 0);
}

function skillStatus(level) {
  const self = you();
  const action = activeSkills[self.character]?.[level];
  let reason = '';
  if (level > self.level) reason = `Unlocks at level ${level}`;
  else if (state.phase === 'finished') reason = 'Game over';
  else if (self.eliminated) reason = 'Eliminated · spectating';
  else if (!action) reason = 'Automatic';
  else if (!socket.connected) reason = 'Reconnecting…';
  else if (action.type === 'tag' && self.target) reason = `Bounty: ${playerName(self.target)}`;
  else if (action.type === 'invest' && self.investment) reason = `Invested in ${playerName(self.investment.target)} · +4 per elimination`;
  else if (action.type === 'strike' && !self.strikeAvailable) reason = 'Already used';
  else if (action.type === 'boost' && self.boosted) reason = 'Used this hand';
  else {
    const between = state.phase === 'lobby' || state.phase === 'result';
    const myTurn = state.phase === 'betting' && state.turn === self.id;
    if (action.type === 'invest' && !between) reason = 'Use between hands';
    else if (action.type === 'boost' && (!myTurn || !self.inHand || self.folded || self.chips <= 0)) reason = 'Use on your turn';
    else if (action.type === 'boost' && self.chips < 3) reason = 'Needs 3 chips';
    else if (action.type !== 'invest' && action.type !== 'boost' && !between && !myTurn) reason = 'Use on your turn';
    else if (action.targeted && !abilityTargets().length) reason = 'No eligible players';
  }
  return { action, available: !!action && !reason, label: reason || (action.targeted ? 'Click, then choose a player' : 'Spend 3 chips · +1 to dice') };
}

function personalSkills() {
  const self = you(), d = definition(self);
  return `<section class="personal-skills" aria-label="Your skills"><div class="personal-skills-heading"><span class="eyebrow">YOUR SKILLS · LEVEL ${self.level}</span><button class="text-button" data-player-skills="${self.id}">View abilities ↗</button></div>
    <div class="personal-skills-grid">${d.abilities.map((text, index) => {
      const level = index + 1, skill = skillStatus(level);
      const selected = !!pendingAbility && pendingAbility.type === skill.action?.type;
      const body = `<span class="skill-level">L${level}</span><span class="personal-skill-body"><strong>${escape(skillTitles[self.character]?.[index] || `Level ${level}`)}</strong><span class="personal-skill-description">${escape(text)}</span><span class="personal-skill-status">${escape(selected ? 'Choose a player · click again to cancel' : skill.label)}</span></span>`;
      return skill.action
        ? `<button class="personal-skill active-skill ${selected ? 'selected-skill' : ''}" data-skill="${level}" aria-pressed="${selected}" ${!skill.available ? 'disabled' : ''}>${body}</button>`
        : `<div class="personal-skill ${level > self.level ? 'locked-skill' : ''}">${body}</div>`;
    }).join('')}</div></section>`;
}

function cancelTargeting() {
  if (!pendingAbility || busy) return;
  pendingAbility = null; renderGame();
}

async function useSkill(level) {
  if (busy) return;
  const skill = skillStatus(level);
  if (!skill.available) return;
  if (!skill.action.targeted) {
    const result = await move(skill.action.type);
    if (result?.ok) toast('Dice boosted · +1 to your total.');
    return;
  }
  if (pendingAbility?.type === skill.action.type) { cancelTargeting(); return; }
  pendingAbility = { ...skill.action, level, hand: state.handNumber, phase: state.phase, room: state.roomCode };
  renderGame();
  app.querySelector('.target-prompt')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  app.querySelector('[data-target-player]')?.focus({ preventScroll: true });
}

async function chooseAbilityTarget(id) {
  if (busy || !pendingAbility || !skillStatus(pendingAbility.level).available || !abilityTargets().some(p => p.id === id)) return;
  const { type } = pendingAbility;
  const name = playerName(id);
  pendingAbility = null; renderGame();
  const result = await move(type, { target: id });
  if (result?.ok && type !== 'tag') toast(type === 'invest' ? `Invested in ${name}.` : `Final bounty used on ${name}.`);
}

function turnIndicator(p) {
  if (state.phase !== 'betting' || state.turn !== p.id) return '';
  return `<div class="seat-turn" data-turn-indicator aria-label="${escape(p.name)}'s turn"><div class="seat-turn-label"><span class="turn-light" aria-hidden="true"></span><strong>${p.id === state.you ? 'YOUR TURN' : 'TO ACT'}</strong><span class="seat-turn-seconds" aria-hidden="true"><b class="timer-value" data-countdown="turn">—</b>s</span></div><div class="seat-timer-track" aria-hidden="true"><i data-turn-progress></i></div></div>`;
}

function handBets() {
  return state.events.filter(e => e.hand === state.handNumber && (e.type === 'bet' || e.type === 'fold'));
}

function wagerStatus(p) {
  if (!p.inHand) return '';
  const action = handBets().filter(e => e.playerId === p.id).at(-1);
  const blind = state.blinds?.small === p.id ? `Small blind ${state.blinds.smallAmount}`
    : state.blinds?.big === p.id ? `Big blind ${state.blinds.bigAmount}` : 'Waiting to act';
  let label = action?.action === 'raise' ? `Raised +${action.raiseBy} → ${action.total}`
    : action?.action === 'call' ? `Called ${action.amount}` : action?.action === 'fold' ? `Folded${action.penalty ? ` · ${action.penalty} extra lost` : ''}`
    : action?.action === 'check' ? 'Checked' : blind;
  if (action?.allIn || (!p.folded && !p.eliminated && p.chips === 0)) label += ' · All in';
  const detail = action?.action === 'call'
    ? `${action.target ? `On ${playerName(action.target)}’s raise to ${action.betTo}` : `Table bet ${action.betTo}`}${action.partial ? ' · partial call' : ' · matched'}`
    : '';
  const owed = state.phase === 'betting' && !p.folded && !p.eliminated && p.chips > 0 ? Math.max(0, state.betTo - p.committed) : 0;
  return `<div class="wager-status ${action?.action === 'raise' ? 'wager-raise' : action?.action === 'call' ? 'wager-call' : ''} ${!action && blind === 'Waiting to act' ? 'wager-waiting' : ''}" aria-label="${escape(p.name)}'s wager"><strong>${escape(label)}</strong>${action && blind !== 'Waiting to act' ? `<span>${escape(blind)}</span>` : ''}${detail ? `<span>${escape(detail)}</span>` : ''}<span>In pot: <b>${p.committed}</b> chips${owed ? ` · ${owed} to call` : ''}</span><span class="mobile-wager-summary">${p.committed} in pot${owed ? ` · ${owed} to call` : ''}</span></div>`;
}

function bettingActivity() {
  const bets = state.events.filter(e => e.hand === state.handNumber && ['bet', 'fold', 'blind'].includes(e.type));
  if (!bets.length) return '';
  return `<details class="betting-activity" ${bettingExpanded ? 'open' : ''}><summary><span class="eyebrow">BETTING ACTIVITY</span><span>${escape(bets.at(-1).message)}</span><span class="activity-chevron" aria-hidden="true">⌄</span></summary><ol aria-label="This hand's betting">${[...bets].reverse().map(e => `<li class="${e.action === 'raise' ? 'activity-raise' : ''}">${escape(e.message)}</li>`).join('')}</ol></details>`;
}

function tablePositionChips(p) {
  if (!state.blinds) return '';
  const roles = [
    ['dealer', 'dealer', 'Dealer', 'DEALER'],
    ['big', 'big-blind', 'Big blind', 'BB'],
    ['small', 'small-blind', 'Small blind', 'SB']
  ];
  return `<div class="position-chip-lane">${roles.filter(([key]) => state.blinds[key] === p.id).map(([key, style, label, text]) =>
    `<span class="position-chip ${style}-chip" data-position-chip="${key}" data-owner="${p.id}" role="img" aria-label="${label} chip · ${escape(p.name)}" title="${label} · ${escape(p.name)}"><span>${text}</span></span>`
  ).join('')}</div>`;
}

function tableSeat(p, position) {
  const d = definition(p);
  const self = you();
  const mine = p.id === self.id;
  const isTarget = huntersTargeting(p).length > 0;
  const isInvested = investorsTargeting(p).length > 0;
  const status = p.eliminated ? 'Eliminated' : p.folded ? 'Folded' : p.chips === 0 && p.inHand ? 'All in' : p.id === state.turn ? 'Thinking…' : '';
  const canTarget = !mine && pendingAbility && !p.eliminated && p.chips > 0;
  const award = state.result?.revealed.find(entry => entry.id === p.id);
  const winner = state.result?.winners.includes(p.id);
  return `<div class="table-seat seat-${position}" data-seat="${position}">${tablePositionChips(p)}<article data-player-id="${p.id}" class="player-card ${mine ? 'you-area' : ''} ${canTarget ? 'targetable' : ''} ${state.turn === p.id ? 'turn' : ''} ${p.folded ? 'folded' : ''} ${p.eliminated ? 'eliminated' : ''} ${winner ? 'winning-seat' : ''}" style="--accent:${d.color}" aria-label="${escape(p.name)}${mine ? ', you' : ''}, ${escape(d.name)}, ${p.chips} chips">
    ${winner ? `<div class="seat-result">WINNER${award?.award ? ` · +${award.award}` : ''}</div>` : ''}
    ${isTarget || isInvested ? `<div class="target-badges">${isTarget ? `<span class="target-badge">${self.target === p.id ? 'YOUR BOUNTY' : 'BOUNTY TARGET'}</span>` : ''}${isInvested ? `<span class="target-badge investment-badge">${hasInvestment(self) && self.investment.target === p.id ? 'YOUR INVESTMENT' : 'INVESTMENT TARGET'}</span>` : ''}</div>` : ''}
    <div class="player-head" role="button" tabindex="0" data-player-skills="${p.id}" aria-label="View skills for ${escape(p.name)}"><span class="avatar" aria-hidden="true">${d.symbol}</span><div class="name-block ${mine ? 'you-identity' : ''}"><div class="player-role">${escape(d.name)}</div><div class="player-name" title="${escape(p.name)}">${initials(p.name)}${mine ? '<span class="self-label">YOU</span>' : ''}</div><span class="chip-count">${chip(p.chips)} <small>chips</small><span class="seat-level">L${p.level}</span></span></div></div>
    ${turnIndicator(p)}
    ${status && state.turn !== p.id ? `<div class="player-sub">${escape(status)}</div>` : ''}
    ${!p.connected ? '<div class="player-sub">Away · auto play</div>' : ''}
    ${p.dice ? `<div class="dice-row">${die(p.dice.hidden, mine ? 'Your secret' : p.peeked ? 'Revealed to you' : 'Hidden', p.peeked ? 'peek' : '')}${die(p.dice.visible, 'Visible')}${award ? `<span class="dice-total" aria-label="Dice total ${award.total}">${award.total}</span>` : ''}</div>` : '<div class="empty-dice">Out of the game</div>'}
    ${wagerStatus(p)}
    ${targetStatus(p)}
    <button class="player-skills-button" data-player-skills="${p.id}" aria-label="View skills for ${escape(p.name)}">${mine ? 'Your' : 'View'} skills ↗</button>
    ${canTarget ? `<button class="target-player" data-target-player="${p.id}" aria-label="${escape(skillTitles[self.character][pendingAbility.level - 1])}: choose ${escape(p.name)}"><span>Choose ${escape(p.name)} ↗</span></button>` : ''}
  </article></div>`;
}

function pokerChips(amount) {
  return `<div class="poker-chips" aria-hidden="true">${[0, 1, 2].map((stack, index) => `<span class="chip-tower tower-${index}">${Array.from({ length: Math.min(5, Math.max(1, Math.ceil(amount / (3 + stack * 3)))) }, (_, i) => `<i style="--chip-index:${i}"></i>`).join('')}</span>`).join('')}</div>`;
}

function tableCenter(pot, myTurn) {
  const result = state.result;
  if (state.phase === 'finished') {
    return `<div class="table-center"><div class="result-ribbon champion"><div class="champion-symbol">♔</div><span class="eyebrow">${state.champion ? 'LAST ONE STANDING' : 'THE TABLE FALLS SILENT'}</span><h3>${state.champion ? escape(playerName(state.champion)) : 'No survivors'}</h3><p>${state.completedHands} hands played</p><button class="primary" id="again-button">Play again ↗</button></div></div>`;
  }
  return `<div class="table-center"><div class="felt-brand" aria-hidden="true">◈<span>DICEBOUND</span><small>THE VELVET TABLE</small></div>
    <div class="pot-area">${pokerChips(pot)}<span class="eyebrow">${state.phase === 'betting' ? 'TOTAL POT' : 'CHIPS IN PLAY'}</span><div class="pot-value">${pot}<small>chips</small></div>
    <div class="pot-caption">${state.phase === 'betting' ? `Bet ${state.betTo} · Blinds ${state.rules.smallBlind}/${state.rules.bigBlind}` : 'Hand settled'}</div></div>
    ${state.phase === 'betting' ? `<div class="turn-status"><i class="turn-light"></i><span>${myTurn ? 'Your move' : escape(playerName(state.turn))}<small>${myTurn ? `${Math.max(0, state.betTo - you().committed)} to call` : 'To act'}</small></span></div>` : ''}
    ${state.phase === 'result' ? `<div class="result-ribbon"><span class="eyebrow">${result.winners.includes(state.you) ? 'YOU WIN' : 'THE WINNING HAND'}</span><h3>${result.winners.map(playerName).map(escape).join(' & ') || 'Chips returned'}</h3><p>${result.pots.length > 1 ? 'Side pots settled' : 'The pot is awarded'}</p><div class="result-timer">Next hand <b class="timer-value" data-countdown="result">—</b>s</div></div>` : ''}</div>`;
}

function renderGame() {
  const self = you(), d = definition(self);
  document.body.classList.add('poker-view');
  document.body.classList.toggle('playing', state.phase === 'betting' && !self.eliminated);
  if (pendingAbility && (pendingAbility.room !== state.roomCode || pendingAbility.hand !== state.handNumber || pendingAbility.phase !== state.phase || !skillStatus(pendingAbility.level).available)) pendingAbility = null;
  const myTurn = state.turn === self.id && !self.eliminated;
  const owed = Math.max(0, state.betTo - self.committed);
  const pot = state.phase === 'betting' ? state.players.reduce((sum, p) => sum + p.committed, 0) : state.result?.pot || 0;
  const bonus = self.dice ? self.dice.hidden + self.dice.visible + self.rollBonus : null;
  const selfIndex = state.players.findIndex(p => p.id === self.id);
  const seats = [...state.players.slice(selfIndex), ...state.players.slice(0, selfIndex)];
  const positions = ['south', 'west', 'north', 'east'];
  app.innerHTML = `${tableHeader()}
    ${self.eliminated && state.phase !== 'finished' ? `<div class="spectator-note" role="status">You’re eliminated and watching the table. <strong>${state.players.filter(p => !p.eliminated).length} players remain</strong> · Play continues until one is left.</div>` : ''}
    ${pendingAbility ? `<div class="target-prompt" role="status"><span><strong>${escape(skillTitles[self.character][pendingAbility.level - 1])}</strong> · Choose a highlighted player</span><button class="text-button" id="cancel-target">Cancel ×</button></div>` : ''}
    <section class="arena poker-table" aria-label="Poker table"><div class="table-felt" aria-hidden="true"></div>${seats.map((p, i) => tableSeat(p, positions[i])).join('')}${tableCenter(pot, myTurn)}</section>
    ${state.phase === 'betting' && !self.eliminated ? `<div class="action-bar"><div class="action-context"><span>${myTurn ? 'YOUR MOVE' : `WAITING FOR ${escape(playerName(state.turn))}`}</span><span>${myTurn ? owed ? `${Math.min(owed, self.chips)} chips to call${owed > self.chips ? ' · all in' : ''}` : 'You can check' : 'Your controls unlock on your turn'}</span></div><button class="danger" id="fold-button" ${!myTurn ? 'disabled' : ''}>Fold${self.foldCost ? ` · +${self.foldCost}` : ''}</button><button class="secondary" id="call-button" ${!myTurn ? 'disabled' : ''}>${owed ? `Call ${Math.min(owed, self.chips)}` : 'Check'}</button><div class="raise-controls"><label class="raise-field"><span>Raise by</span><input id="raise-amount" type="number" inputmode="numeric" min="1" max="${Math.max(1, self.chips - owed)}" value="1" aria-label="Raise amount" ${!myTurn || self.chips <= owed ? 'disabled' : ''}></label><button class="primary" id="raise-button" ${!myTurn || self.chips <= owed || state.raises >= state.rules.maxRaises ? 'disabled' : ''}>Raise ↗</button></div></div>` : ''}
    ${personalSkills()}
    <div class="ability-strip"><span>${self.eliminated ? 'You can watch the remaining hands.' : self.target ? `⌖ Bounty: ${escape(playerName(self.target))}` : self.investment ? `◈ Investment: ${escape(playerName(self.investment.target))} · +4 per elimination` : self.character === 'kamikaze' ? `✦ Resurrection ${self.resurrections ? 'ready' : 'spent'}` : bonus !== null ? `Dice ${bonus}${self.rollBonus ? ' · boosted' : ''} · character bonuses at showdown` : 'Your abilities are ready.'}</span></div>
    ${bettingActivity()}
    <div class="footer-info"><span>ONE SECRET DIE · ONE VISIBLE DIE</span><span><button class="text-button" id="leave-button">Leave table</button></span></div>`;
  bindTableTools();
  app.querySelectorAll('[data-skill]').forEach(button => button.onclick = () => useSkill(Number(button.dataset.skill)));
  app.querySelectorAll('[data-target-player]').forEach(button => button.onclick = () => chooseAbilityTarget(button.dataset.targetPlayer));
  app.querySelector('#cancel-target')?.addEventListener('click', cancelTargeting);
  app.querySelector('#fold-button')?.addEventListener('click', () => move('fold'));
  app.querySelector('#call-button')?.addEventListener('click', () => move(owed ? 'call' : 'check'));
  app.querySelector('#raise-button')?.addEventListener('click', () => move('raise', { amount: Number(app.querySelector('#raise-amount').value) }));
  app.querySelector('#leave-button').onclick = leaveTable;
  app.querySelector('#again-button')?.addEventListener('click', leaveTable);
  app.querySelector('.betting-activity')?.addEventListener('toggle', event => { bettingExpanded = event.target.open; });
  updateTimers();
}

function bindTableTools() {
  app.querySelector('#copy-code')?.addEventListener('click', copyTableCode);
  app.querySelector('#lobby-copy-code')?.addEventListener('click', copyTableCode);
  app.querySelector('#history-button')?.addEventListener('click', showHistory);
  app.querySelector('#table-skills-button')?.addEventListener('click', () => showTableSkills());
  app.querySelectorAll('[data-player-skills]').forEach(button => {
    button.addEventListener('click', () => showTableSkills(button.dataset.playerSkills));
    if (button.getAttribute('role') === 'button') button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showTableSkills(button.dataset.playerSkills);
      }
    });
  });
}

async function copyInvitation() {
  const url = `${location.origin}/?table=${state.roomCode}`;
  try { await navigator.clipboard.writeText(url); toast('Invitation copied. Send it to your friends.'); }
  catch { showInvitationFields('invitation-link'); }
}

async function copyTableCode() {
  const code = state.roomCode;
  try { await navigator.clipboard.writeText(code); toast(`Table code ${code} copied.`); }
  catch { showInvitationFields('invitation-code'); }
}

function showInvitationFields(selectedField) {
  const url = `${location.origin}/?table=${state.roomCode}`;
  openSheet('INVITE A FRIEND', `<h2>Save them a seat.</h2><p>Tap either field to select it, then copy.</p>
    <div class="field"><label for="invitation-code">TABLE CODE</label><input id="invitation-code" readonly value="${state.roomCode}" aria-label="Table code"></div>
    <div class="field" style="margin-top:16px"><label for="invitation-link">INVITATION LINK</label><input id="invitation-link" readonly value="${escape(url)}" aria-label="Invitation link"></div>`);
  content.querySelectorAll('input').forEach(input => { input.onclick = () => input.select(); });
  const input = content.querySelector(`#${selectedField}`);
  input.focus(); input.select();
}

async function leaveTable() {
  if (busy) return;
  const result = await request('leaveRoom');
  if (result.ok) {
    state = null; pendingAbility = null; closeSheet(); history.replaceState(null, '', '/'); renderWelcome();
  }
}

function openSheet(kicker, html, kind = null) {
  document.querySelector('#sheet-kicker').textContent = kicker;
  content.innerHTML = html; dialogKind = kind; dialog.dataset.kind = kind || '';
  if (!dialog.open) dialog.showModal();
}
function closeSheet() { dialog.close(); dialogKind = null; }
document.querySelector('#close-sheet').onclick = closeSheet;
dialog.addEventListener('click', event => { if (event.target === dialog) closeSheet(); });
dialog.addEventListener('close', () => { dialogKind = null; });

function showCharacter(id, level) {
  const d = definitions[id];
  const joining = state?.phase === 'lobby' && !you()?.character;
  openSheet('FIVE LEVELS. ONE DESTINY.', `<h2>${escape(d.name)}</h2><p>${escape(d.description)}</p>${abilityList(d, level)}<p class="rule-note">Start at level 1 with 10 chips. Gain a level every 5 completed hands. Each unlocked ability stays with you.</p>
    <div class="role-actions"><button class="primary full-width" id="play-role">${joining ? 'Ready' : 'Play'} as ${escape(d.name)} →</button>
    ${joining ? '' : '<button class="text-button full-width" id="invite-role">Open a table for friends</button>'}</div>`, 'character');
  content.querySelector('#play-role').onclick = async () => {
    if (busy) return;
    selected = id;
    await enterTable(undefined, !joining);
  };
  content.querySelector('#invite-role')?.addEventListener('click', () => { selected = id; enterTable(); });
}
function abilityList(d, level) {
  return `<div class="ability-list">${d.abilities.map((text, i) => `<div class="ability-row ${i + 1 > level ? 'locked' : ''}"><span class="level-badge">${i + 1}</span><span>${escape(text)} <span class="skill-state">${i + 1 > level ? 'Locked' : 'Unlocked'}</span></span></div>`).join('')}</div>`;
}
function showTableSkills(playerId = state?.you) {
  if (!state) return;
  expandedSkills = new Set([playerId]);
  openSheet('EVERY CHARACTER AT THE TABLE', '', 'skills');
  renderTableSkills();
}
function renderTableSkills() {
  if (!state) return;
  content.innerHTML = `<h2>Everyone's skills.</h2><p>Open any player to see their character's five abilities and which levels they have unlocked.</p>
    <div class="table-skills">${state.players.map(p => {
      const d = definition(p);
      return `<details class="skills-player" data-skills-id="${p.id}" ${expandedSkills.has(p.id) ? 'open' : ''}>
        <summary style="--accent:${d.color}"><span class="avatar" aria-hidden="true">${d.symbol}</span><span class="skills-identity"><strong>${escape(p.name)}${p.id === state.you ? ' · you' : ''}</strong><span>${escape(d.name)} · Level ${p.level}${p.eliminated ? ' · Eliminated' : ''}</span></span><span class="skills-chevron" aria-hidden="true">⌄</span></summary>
        <div class="skills-body">${p.character ? abilityList(d, p.level) : '<p>Choosing a character.</p>'}</div>
      </details>`;
    }).join('')}</div>`;
  content.querySelectorAll('[data-skills-id]').forEach(details => {
    details.addEventListener('toggle', () => {
      if (details.open) expandedSkills.add(details.dataset.skillsId);
      else expandedSkills.delete(details.dataset.skillsId);
    });
  });
}
function showAbilities() { openSheet('YOUR CHARACTER', '', 'abilities'); renderAbilities(); }
function renderAbilities() {
  const self = you();
  if (!self) return;
  const d = definition(self);
  const between = state.phase === 'lobby' || state.phase === 'result';
  const myTurn = state.phase === 'betting' && state.turn === self.id;
  const active = state.players.filter(p => p.id !== self.id && !p.eliminated && p.chips > 0);
  let commands = [];
  if (!self.eliminated && (between || myTurn) && active.length) {
    if (self.character === 'hunter' && !self.target) commands.push({ type: 'tag', label: 'Tag target' });
    if (self.character === 'hunter' && self.strikeAvailable) commands.push({ type: 'strike', label: 'Take 5 chips' });
    if (self.character === 'investor' && between && !self.investment) commands.push({ type: 'invest', label: 'Invest' });
  }
  content.innerHTML = `<h2>${escape(d.name)} <span class="muted">· L${self.level}</span></h2><p>${escape(d.description)}</p>${abilityList(d, self.level)}
    ${commands.length ? `<div class="ability-action"><select id="ability-target" aria-label="Ability target">${active.map(p => `<option value="${p.id}">${escape(p.name)} · ${p.chips} chips</option>`).join('')}</select>${commands.map(c => `<button class="primary" data-ability="${c.type}">${c.label}</button>`).join('')}</div>` : ''}
    ${self.character === 'investor' && self.level >= 4 && myTurn && !self.eliminated ? `<button class="primary full-width" id="boost-button" style="margin-top:16px" ${self.boosted || self.chips < 3 ? 'disabled' : ''}>${self.boosted ? 'Boost used this hand' : 'Spend 3 chips · +1 to dice'}</button>` : ''}
    <p class="rule-note">${self.target ? `Your bounty: ${escape(playerName(self.target))}. ` : ''}${self.investment ? `Invested in ${escape(playerName(self.investment.target))}. Gain 4 coins for each player they eliminate except you. Choose again when your target dies. ` : ''}Abilities and dice are validated by the server.</p>`;
  content.querySelectorAll('[data-ability]').forEach(button => button.onclick = () => move(button.dataset.ability, { target: content.querySelector('#ability-target').value }));
  content.querySelector('#boost-button')?.addEventListener('click', () => move('boost'));
}
function showHistory() {
  openSheet('THE LEDGER', '', 'history'); renderHistory();
}
function renderHistory() {
  if (!state) return;
  content.innerHTML = `<h2>Every hand leaves a mark.</h2>${state.history.length ? state.history.map(hand => `<div class="history-row"><h3>Hand ${hand.hand} · ${escape(hand.names.join(' & '))}</h3><p>${hand.pot} chips in play · ${hand.revealed.map(p => `${escape(p.name)}: ${p.hidden} + ${p.visible}`).join(' / ')}</p>${hand.pots.map((pot, i) => `<p>${pot.refund ? 'Uncalled return' : i === 0 ? 'Main pot' : 'Side pot'}: ${pot.amount} → ${pot.winners.map(playerName).map(escape).join(' & ')}</p>`).join('')}</div>`).join('') : '<p>Your first hand has yet to be written.</p>'}<h3 style="margin-top:20px">At the table</h3>${state.events.slice(-15).reverse().map(e => `<div class="history-row"><p>${escape(e.message)}</p></div>`).join('')}`;
}

function showJoin() {
  const code = new URLSearchParams(location.search).get('table') || '';
  openSheet('AN INVITATION TO FORTUNE', `<h2>Join their table.</h2><p>Choose your character on the main screen, then enter your friend's six-character table code.</p><div class="field"><label for="join-code">TABLE CODE</label><input id="join-code" maxlength="6" autocomplete="off" autocapitalize="characters" value="${escape(code)}" placeholder="A1B2C3"></div><button class="primary full-width" id="confirm-join" style="margin-top:15px">Take the open seat →</button>`);
  content.querySelector('#confirm-join').onclick = () => enterTable(content.querySelector('#join-code').value.trim().toUpperCase());
}

document.querySelector('#rules-button').onclick = () => openSheet('THE HOUSE RULES', `<h2>Fortune favors the bold.</h2><ol class="rules-list">
  <li><strong>Take a character and 10 chips.</strong> Play finds a table for you. Four ready players start immediately. Use “Open a table for friends” for invitations.</li>
  <li><strong>Small blind ${state?.rules.smallBlind || 1} · Big blind ${state?.rules.bigBlind || 2}.</strong> Both blinds increase by 1 after every 5 completed hands: 1/2 on hands 1–5, 2/3 on hands 6–10, 3/4 on hands 11–15, and so on. Only the two blind seats post chips automatically; the dealer and blinds rotate past eliminated players. Betting starts after the big blind. With two players, the dealer posts the small blind and acts first. Unlocked Fighters act last.</li>
  <li><strong>Roll two dice.</strong> Every hand gives you a secret d6 and a visible d6. Highest combined total wins, including unlocked character bonuses. Play continues until one player remains; eliminated players can keep watching.</li>
  <li><strong>Check, call, raise, or fold.</strong> There is one betting round and up to three raises. All-ins use side pots; uncalled wagers return to their owner.</li>
  <li><strong>Folding leaves the hand.</strong> You lose your chips already in the pot. Against any Fighters, you also lose 1 extra coin if you contributed (blinds count). For example, 3 chips in the pot + 1 extra = 4 lost. Multiple Fighters still charge only 1 extra. Tagged Hunter penalties also apply. You cannot win the pot after folding. No additional dice are rolled.</li>
  <li><strong>Every 5 hands, rise a level.</strong> Players still holding chips unlock their next ability, to level 5. Folded players also progress.</li>
  <li><strong>Bankruptcy is resolved together.</strong> Kamikaze resurrects once, refreshed at level 5. Bounty and scavenger rewards go to surviving characters.</li>
  <li><strong>One currency.</strong> Gold, coins, and chips mean the same thing. While more than two players remain, a level 2 Investor receives dividends immediately when becoming big blind: 1 coin per 10 held before posting the blind, rounded down (22 gives 2; 30 gives 3). Dividends stop with only two players left.</li>
  <li><strong>Stay at the table.</strong> A disconnected seat is played automatically after 10 seconds. Reconnect in the same browser to reclaim it.</li>
  </ol><p class="rule-note">Tied Fighters split; other ties split when no level 3 Fighter is tied. Hunter and Fighter combat bonuses are evaluated against eligible opponents in each pot. Use Skills at the table or on any player's card to inspect everyone's abilities.</p>`);

function updateTimers() {
  if (!state) return;
  const offset = state.serverNow - (state.receivedAt || Date.now());
  const now = Date.now() + offset;
  document.querySelectorAll('[data-countdown]').forEach(node => {
    const deadline = node.dataset.countdown === 'start' ? state.startAt : state.deadline;
    node.textContent = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : '—';
  });
  const remaining = Math.max(0, (state.deadline || 0) - now);
  document.querySelectorAll('[data-turn-progress]').forEach(node => {
    node.style.width = `${Math.min(100, remaining / (state.rules.turnMs || 25000) * 100)}%`;
  });
  document.querySelectorAll('[data-turn-indicator]').forEach(node => node.classList.toggle('urgent', remaining <= 5000));
}
setInterval(updateTimers, 250);

document.addEventListener('keydown', event => { if (event.key === 'Escape' && !dialog.open) cancelTargeting(); });
socket.on('connect', () => {
  connection.textContent = 'At the table'; connection.classList.add('online');
  if (state && state.phase !== 'lobby') renderGame();
});
socket.on('disconnect', reason => {
  connection.textContent = reason === 'io server disconnect' ? 'Seat opened in another tab' : 'Reconnecting…';
  connection.classList.remove('online');
  pendingAbility = null;
  if (state && state.phase !== 'lobby') renderGame();
  document.querySelectorAll('.action-bar button').forEach(button => { button.disabled = true; });
});
socket.on('session', data => {
  try { localStorage.setItem('dicebound-token', data.token); } catch {}
  socket.auth = { token: data.token };
});
socket.on('returnState', next => {
  if (!next?.you) return;
  const enteringTable = !state || state.roomCode !== next.roomCode;
  const startingGame = state?.phase === 'lobby' && next.phase !== 'lobby';
  // Heartbeats refresh the server clock, but should not replace selectable text,
  // focused controls, or open skills when the game itself has not changed.
  const signature = JSON.stringify({ ...next, serverNow: undefined, receivedAt: undefined });
  const unchanged = !!state && signature === lastStateSignature;
  lastStateSignature = signature;
  const activeInput = document.activeElement;
  const preserveRaise = activeInput?.id === 'raise-amount' ? { value: activeInput.value, turn: state?.turn, hand: state?.handNumber } : null;
  state = next; state.receivedAt = Date.now();
  if (unchanged) { updateTimers(); return; }
  if (state.phase === 'lobby') { pendingAbility = null; renderLobby(); } else renderGame();
  if (enteringTable && state.matchmaking) {
    if (dialogKind === 'character') closeSheet();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  if (startingGame) window.scrollTo({ top: 0, behavior: 'instant' });
  if (preserveRaise && preserveRaise.turn === state.turn && preserveRaise.hand === state.handNumber) {
    const input = app.querySelector('#raise-amount');
    if (input && !input.disabled) { input.value = preserveRaise.value; input.focus(); }
  }
  if (dialog.open && dialogKind === 'abilities') renderAbilities();
  if (dialog.open && dialogKind === 'skills') renderTableSkills();
  if (dialog.open && dialogKind === 'history') renderHistory();
  const announcements = state.events.filter(e => e.id > lastAnnounced && e.playerId === state.you && ['level', 'elimination'].includes(e.type));
  announcements.forEach(e => toast(e.message));
  state.events.filter(e => e.id > lastAnnounced && e.type === 'ability' && e.target)
    .forEach(e => toast(e.message));
  lastAnnounced = state.eventSeq;
});

fetch('/api/characters').then(res => res.json()).then(data => {
  definitions = data;
  if (state) { state.phase === 'lobby' ? renderLobby() : renderGame(); } else {
    renderWelcome();
    if (new URLSearchParams(location.search).has('table')) showJoin();
  }
}).catch(() => { app.innerHTML = '<section class="welcome"><h2>The table is unavailable.</h2><p>Refresh the page when the server is running.</p></section>'; });
