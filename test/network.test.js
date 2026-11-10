'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createServer } = require('../server/index');
const { botNames, chooseBotName } = require('../server/bots');

function waitState(client, predicate, timeout = 3000) {
  if (client.latest && predicate(client.latest)) return Promise.resolve(client.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('returnState', listener); reject(new Error('State timeout')); }, timeout);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timer); client.off('returnState', listener); resolve(state);
    }
    client.on('returnState', listener);
  });
}
function send(client, event, data = {}) {
  return new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
}
async function connect(url, auth = {}) {
  const client = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'], auth });
  client.on('returnState', state => { client.latest = state; });
  client.on('session', session => { client.token = session.token; });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve); client.once('connect_error', reject); client.connect();
  });
  return client;
}
async function fixture(t, rules = {}) {
  const instance = createServer({ rules: { tickMs: 10, matchmakingMs: 60000, botJoinMinMs: 60000, botJoinMaxMs: 60000, botThinkMs: 60000, botThinkJitterMs: 0, ...rules } });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await instance.close(); });
  const url = `http://127.0.0.1:${instance.server.address().port}`;
  const client = async auth => { const c = await connect(url, auth); clients.push(c); return c; };
  return { instance, client, url };
}
async function select(client, character) {
  return send(client, 'move', { type: 'select', character, name: character, revision: client.latest.revision });
}

test('eliminated sockets keep receiving hands with three and two survivors until one champion', async t => {
  const f = await fixture(t, { resultMs: 50, turnMs: 60000 });
  const viewer = await f.client();
  const { code } = await send(viewer, 'createRoom');
  await select(viewer, 'investor');
  await send(viewer, 'move', { type: 'start', revision: viewer.latest.revision });
  const room = f.instance.rooms.get(code);
  const players = room.state.players;
  players.forEach(p => { p.character = 'investor'; p.level = 1; });
  for (const victimIndex of [0, 2, 3]) {
    for (const p of players.filter(p => p.inHand)) {
      p.committed = 1;
      p.chips = p === players[victimIndex] ? 0 : 10;
      p.dice = { hidden: p === players[1] ? 6 : 1, visible: p === players[1] ? 6 : 1 };
    }
    const hand = room.state.handNumber;
    room.engine.settle(room.state);
    room.state.revision++;
    f.instance.io.to(viewer.id).emit('returnState', room.game.returnState(viewer.id));
    const result = await waitState(viewer, s => s.handNumber === hand && ['result', 'finished'].includes(s.phase));
    assert.equal(result.players[victimIndex].eliminated, true);
    assert.equal(viewer.connected, true);
    if (victimIndex < 3) {
      assert.equal(result.phase, 'result');
      const next = await waitState(viewer, s => s.handNumber === hand + 1 && s.phase === 'betting');
      assert.equal(next.players[0].dice, null);
      assert.ok(!next.players.find(p => p.id === next.turn).eliminated);
      assert.ok(!next.players.find(p => p.id === next.blinds.small).eliminated);
      assert.ok(!next.players.find(p => p.id === next.blinds.big).eliminated);
    } else {
      assert.equal(result.phase, 'finished');
      assert.equal(result.champion, players[1].id);
    }
  }
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
});

test('real sockets synchronize multiplayer, enforce host/turn/revision, and redact every secret', async t => {
  const f = await fixture(t);
  const host = await f.client(), guest = await f.client(), late = await f.client();
  const created = await send(host, 'createRoom');
  assert.equal(created.ok, true);
  assert.equal((await select(host, 'investor')).ok, true);
  assert.equal((await send(guest, 'joinRoom', { code: created.code })).ok, true);
  assert.equal((await select(guest, 'fighter')).ok, true);
  await waitState(host, s => s.players.length === 2 && s.players.every(p => p.character));
  assert.equal((await send(guest, 'move', { type: 'start', player: host.latest.you, revision: guest.latest.revision })).ok, false);
  assert.equal((await send(host, 'move', { type: 'start', revision: host.latest.revision })).ok, true);
  const a = await waitState(host, s => s.phase === 'betting');
  const b = await waitState(guest, s => s.phase === 'betting');
  assert.equal(a.players.length, 4); assert.equal(a.players.filter(p => p.bot).length, 2);
  assert.equal(a.players.find(p => p.id === a.you).dice.hidden !== null, true);
  assert.equal(a.players.find(p => p.id === b.you).dice.hidden, null);
  assert.equal(b.players.find(p => p.id === a.you).dice.hidden, null);
  assert.equal(JSON.stringify(a).includes(host.token), false);
  assert.equal(JSON.stringify(a).includes(guest.id), false);
  assert.equal(a.turn, b.turn);
  assert.equal((await send(late, 'joinRoom', { code: created.code })).ok, false);
  assert.equal((await send(host, 'move', { type: 'raise', amount: 1, revision: a.revision - 1 })).ok, false);
  const actor = a.turn === a.you ? host : a.turn === b.you ? guest : null;
  if (actor) {
    const before = actor.latest.revision;
    assert.equal((await send(actor, 'move', { type: 'check', revision: before })).ok, true);
    await waitState(host, s => s.revision > before);
    await waitState(guest, s => s.revision > before);
    assert.equal(host.latest.turn, guest.latest.turn);
  }
  const response = await fetch(`${f.url}/api/characters`);
  assert.equal(Object.keys(await response.json()).length, 4);
  assert.equal((await fetch(`${f.url}/`)).status, 200);
});

test('an eliminated player reconnects as a spectator and receives subsequent hands', async t => {
  const f = await fixture(t, { resultMs: 200, turnMs: 60000 });
  const viewer = await f.client();
  const { code } = await send(viewer, 'createRoom');
  await select(viewer, 'investor');
  await send(viewer, 'move', { type: 'start', revision: viewer.latest.revision });
  const room = f.instance.rooms.get(code);
  room.state.players.forEach((p, index) => {
    p.character = 'investor'; p.committed = 1; p.chips = index === 0 ? 0 : 10;
    p.dice = { hidden: index === 1 ? 6 : 1, visible: index === 1 ? 6 : 1 };
  });
  room.engine.settle(room.state);
  room.state.revision++;
  viewer.disconnect();
  const restored = await f.client({ token: viewer.token });
  const after = await waitState(restored, s => s.players.find(p => p.id === s.you).eliminated);
  assert.equal(after.you, viewer.latest.you);
  const next = await waitState(restored, s => s.phase === 'betting' && s.handNumber === 2);
  assert.equal(next.players.find(p => p.id === next.you).dice, null);
  assert.equal((await send(restored, 'move', { type: 'check', revision: next.revision })).ok, false);
  assert.equal(restored.connected, true);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
});

test('reconnection restores the same seat, bankroll, dice and character without exposing credentials', async t => {
  const f = await fixture(t);
  const host = await f.client();
  await send(host, 'createRoom'); await select(host, 'kamikaze');
  await send(host, 'move', { type: 'start', revision: host.latest.revision });
  const before = await waitState(host, s => s.phase === 'betting');
  const token = host.token;
  const mine = before.players.find(p => p.id === before.you);
  host.disconnect();
  const rejoined = await f.client({ token });
  const after = await waitState(rejoined, s => s.you === before.you);
  const restored = after.players.find(p => p.id === after.you);
  assert.equal(restored.name, mine.name);
  assert.equal(restored.character, mine.character);
  assert.equal(restored.chips, mine.chips);
  assert.deepEqual(restored.dice, mine.dice);
  assert.equal(after.players.length, 4);
  assert.equal(restored.connected, true);
});

test('leaving lobby seats cannot create duplicate Globby player refs', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client(), c = await f.client();
  const { code } = await send(a, 'createRoom');
  await select(a, 'investor');
  await send(b, 'joinRoom', { code }); await select(b, 'fighter');
  await send(a, 'leaveRoom');
  await send(c, 'joinRoom', { code }); await select(c, 'hunter');
  const view = await waitState(b, s => s.players.length === 2 && s.players.some(p => p.character === 'hunter'));
  assert.equal(new Set(view.players.map(p => p.id)).size, 2);
  assert.equal(view.host, b.latest.you);
});

test('private tables automatically recruit bots and start after the invitation window', async t => {
  const f = await fixture(t, { matchmakingMs: 40, botJoinMinMs: 10, botJoinMaxMs: 20, botThinkMs: 1000 });
  const host = await f.client();
  await send(host, 'createRoom'); await select(host, 'fighter');
  const view = await waitState(host, s => s.phase === 'betting');
  assert.equal(view.players.length, 4);
  assert.equal(view.players.filter(p => p.bot).length, 3);
});

test('private automatic recruitment continues when the original host leaves', async t => {
  const f = await fixture(t, { matchmakingMs: 40, botJoinMinMs: 10, botJoinMaxMs: 20 });
  const host = await f.client(), guest = await f.client();
  const { code } = await send(host, 'createRoom');
  await select(host, 'fighter');
  await send(guest, 'joinRoom', { code });
  await select(guest, 'fighter');
  await send(host, 'leaveRoom');
  const playing = await waitState(guest, s => s.phase === 'betting');
  assert.equal(playing.host, playing.you);
  assert.equal(playing.players.filter(p => p.bot).length, 3);
});

test('disconnected seats receive legal bot actions after grace period', async t => {
  const f = await fixture(t, { disconnectGraceMs: 20, botThinkMs: 20 });
  const a = await f.client(), b = await f.client();
  const { code } = await send(a, 'createRoom'); await select(a, 'fighter');
  await send(b, 'joinRoom', { code }); await select(b, 'investor');
  await waitState(a, s => s.players.every(p => p.character));
  await send(a, 'move', { type: 'start', revision: a.latest.revision });
  const view = await waitState(b, s => s.phase === 'betting');
  const id = view.you;
  const room = f.instance.rooms.get(code);
  room.state.pending = [id, ...room.state.pending.filter(p => p !== id)];
  room.engine.advance(room.state); room.state.revision++;
  b.disconnect();
  const advanced = await waitState(a, s => s.events.some(e => e.playerId === id && ['bet', 'fold'].includes(e.type)), 5000);
  assert.ok(advanced.events.some(e => e.playerId === id));
});

test('each bot waits from the start of its turn even when the previous room cooldown expired', async t => {
  const f = await fixture(t, { botThinkMs: 100, botThinkJitterMs: 40 });
  const host = await f.client();
  await send(host, 'createRoom'); await select(host, 'investor');
  await send(host, 'move', { type: 'start', revision: host.latest.revision });
  const view = await waitState(host, s => s.phase === 'betting');
  const room = [...f.instance.rooms.values()][0];
  // Stage the human immediately before the bots; normal opening seats rotate.
  room.state.order = [view.you, ...room.state.players.filter(p => p.bot).map(p => p.id)];
  room.state.pending = [...room.state.order];
  room.engine.advance(room.state); room.state.revision++;
  for (const config of room.game.players) {
    if (!config.socketId.startsWith('thisisabot')) f.instance.io.to(config.socketId).emit('returnState', room.game.returnState(config.socketId));
  }
  await waitState(host, s => s.turn === s.you);
  room.nextBotAt = Date.now() - 1000;
  const started = Date.now();
  const self = host.latest.players.find(p => p.id === host.latest.you);
  await send(host, 'move', { type: self.committed < host.latest.betTo ? 'call' : 'check', revision: host.latest.revision });
  const firstBot = host.latest.turn;
  assert.ok(host.latest.players.find(p => p.id === firstBot).bot);
  const acted = await waitState(host, s => s.events.some(e => e.playerId === firstBot && ['bet', 'fold'].includes(e.type)));
  const firstAt = Date.now();
  assert.ok(firstAt - started >= 100, 'the first bot must receive a fresh thinking pause');
  const secondBot = acted.turn;
  assert.ok(acted.players.find(p => p.id === secondBot).bot);
  await waitState(host, s => s.events.some(e => e.playerId === secondBot && ['bet', 'fold'].includes(e.type)));
  assert.ok(Date.now() - firstAt >= 100, 'the next bot also waits before playing');
});

test('public matchmaking shares bot arrivals, isolates friend tables and fills one seat at a time', async t => {
  const f = await fixture(t, { botJoinMinMs: 120, botJoinMaxMs: 180 });
  const a = await f.client(), b = await f.client(), friend = await f.client();
  const privateTable = await send(friend, 'createRoom');
  await select(friend, 'fighter');
  const first = await send(a, 'matchmake', { character: 'investor', name: 'Nina Petrova' });
  assert.equal(first.ok, true);
  assert.notEqual(first.code, privateTable.code);
  const room = f.instance.rooms.get(first.code);
  const firstArrival = room.nextBotJoinAt;
  assert.equal(a.latest.startAt, null);
  assert.equal(a.latest.phase, 'lobby');
  assert.equal(a.latest.players.length, 1);
  assert.equal(a.latest.players[0].bot, false);
  assert.equal((await send(a, 'move', { type: 'start', revision: a.latest.revision })).ok, false);
  assert.equal((await send(a, 'move', { type: 'select', character: 'fighter', name: 'Changed', revision: a.latest.revision })).ok, false);
  const second = await send(b, 'matchmake', { character: 'hunter', name: 'Sam Rivera' });
  assert.equal(second.code, first.code);
  const waiting = await waitState(a, s => s.players.length === 2);
  assert.equal(room.nextBotJoinAt, firstArrival);
  assert.ok(waiting.players.every(p => !p.bot && p.character));
  const firstBot = await waitState(a, s => s.players.some(p => p.bot));
  const observedAt = Date.now();
  assert.equal(firstBot.phase, 'lobby');
  assert.equal(firstBot.players.length, 3);
  assert.equal(firstBot.players.filter(p => p.bot).length, 1);
  assert.ok(observedAt >= firstArrival, 'bots must not join before their scheduled arrival');
  const view = await waitState(a, s => s.phase === 'betting');
  assert.ok(Date.now() - observedAt >= 100, 'the second bot gets its own arrival delay');
  assert.equal(view.players.filter(p => p.bot).length, 2);
  assert.deepEqual(view.players.filter(p => !p.bot).map(p => p.name), ['Nina Petrova', 'Sam Rivera']);
  assert.equal(new Set(view.players.map(p => p.name.toLowerCase())).size, 4);
  assert.equal((await waitState(b, s => s.phase === 'betting')).roomCode, view.roomCode);
  assert.deepEqual(friend.latest.players.filter(p => !p.bot).map(p => p.name), ['fighter']);
  assert.equal(friend.latest.matchmaking, false);
});

test('four simultaneous public players start without bots and overflow joins a new queue', async t => {
  const f = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 5 }, () => f.client()));
  const results = await Promise.all(clients.map((c, i) => send(c, 'matchmake', { character: 'fighter', name: `Player ${i}` })));
  assert.ok(results.every(r => r.ok));
  const codes = [...new Set(results.map(r => r.code))];
  assert.equal(codes.length, 2);
  const fullCode = codes.find(code => results.filter(r => r.code === code).length === 4);
  for (let i = 0; i < clients.length; i++) {
    if (results[i].code !== fullCode) continue;
    const view = await waitState(clients[i], s => s.phase === 'betting');
    assert.equal(view.players.length, 4);
    assert.ok(view.players.every(p => !p.bot));
    assert.ok(view.players.every(p => p.character === 'fighter'));
    assert.equal(view.startAt, null);
  }
  const overflow = clients[results.findIndex(r => r.code !== fullCode)].latest;
  assert.equal(overflow.phase, 'lobby');
  assert.equal(overflow.players.length, 1);
});

test('public search cancellation and reconnection preserve the next bot arrival', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client(), c = await f.client();
  const first = await send(a, 'matchmake', { character: 'hunter', name: 'Alex' });
  await send(b, 'matchmake', { character: 'investor', name: 'Maya' });
  const room = f.instance.rooms.get(first.code);
  const scheduled = room.nextBotJoinAt;
  const before = await waitState(b, s => s.players.length === 2);
  const token = b.token;
  const id = before.you;
  b.disconnect();
  const restored = await f.client({ token });
  const rejoined = await waitState(restored, s => s.you === id);
  assert.equal(room.nextBotJoinAt, scheduled);
  assert.equal(rejoined.players.length, 2);
  await send(a, 'leaveRoom');
  const remaining = await waitState(restored, s => s.players.length === 1);
  assert.equal(room.nextBotJoinAt, scheduled);
  assert.equal(remaining.host, id);
  assert.equal((await send(c, 'matchmake', { character: 'fighter', name: 'Leo' })).code, first.code);
  assert.equal((await send(a, 'matchmake', { character: 'kamikaze', name: 'Alex' })).code, first.code);
  const final = await waitState(restored, s => s.players.length === 3);
  assert.equal(room.nextBotJoinAt, scheduled);
  assert.equal(new Set(final.players.map(p => p.id)).size, 3);
});

test('public recruitment replaces disconnected waiting seats and validates before adding seats', async t => {
  const f = await fixture(t, { botJoinMinMs: 60, botJoinMaxMs: 90, disconnectGraceMs: 20 });
  const a = await f.client(), b = await f.client(), invalid = await f.client();
  assert.equal((await send(invalid, 'matchmake', { character: 'bogus', name: 'Alex' })).ok, false);
  assert.equal((await send(invalid, 'matchmake', { character: 'fighter', name: ' ' })).ok, false);
  assert.equal(f.instance.rooms.size, 0);
  const first = await send(a, 'matchmake', { character: 'hunter', name: 'Alex' });
  assert.equal((await send(invalid, 'joinRoom', { code: first.code })).ok, false);
  await send(b, 'matchmake', { character: 'fighter', name: 'Maya' });
  await waitState(a, s => s.players.length === 2);
  const token = b.token;
  b.disconnect();
  const view = await waitState(a, s => s.phase === 'betting');
  assert.equal(view.players.filter(p => !p.bot).length, 1);
  assert.equal(view.players.filter(p => p.bot).length, 3);
  assert.ok(!view.players.some(p => !p.bot && p.name === 'Maya'));
  const returned = await f.client({ token });
  const newSearch = await send(returned, 'matchmake', { character: 'fighter', name: 'Maya' });
  assert.equal(newSearch.ok, true);
  assert.notEqual(newSearch.code, first.code);
});

test('a real player joins a remaining seat after bot recruitment has begun', async t => {
  const f = await fixture(t, { botJoinMinMs: 100, botJoinMaxMs: 180 });
  const a = await f.client(), b = await f.client();
  const first = await send(a, 'matchmake', { character: 'hunter', name: 'Alex' });
  await waitState(a, s => s.players.some(p => p.bot));
  const joined = await send(b, 'matchmake', { character: 'hunter', name: 'Maya' });
  assert.equal(joined.ok, true);
  assert.equal(joined.code, first.code);
  const ready = await waitState(a, s => s.players.some(p => p.name === 'Maya'));
  assert.equal(ready.phase, 'lobby');
  assert.equal(ready.players.filter(p => p.bot).length, 1);
  const playing = await waitState(a, s => s.phase === 'betting');
  assert.equal(playing.players.filter(p => !p.bot).length, 2);
  assert.equal(playing.players.filter(p => p.bot).length, 2);
  assert.equal(new Set(playing.players.map(p => p.id)).size, 4);
  assert.equal(new Set(playing.players.map(p => p.name)).size, 4);
});

test('leaving during staggered bot arrivals cannot duplicate Globby bot socket identifiers', async t => {
  const f = await fixture(t, { botJoinMinMs: 60, botJoinMaxMs: 100 });
  const a = await f.client(), b = await f.client();
  const first = await send(a, 'matchmake', { character: 'fighter', name: 'Alex' });
  await send(b, 'matchmake', { character: 'fighter', name: 'Maya' });
  await waitState(a, s => s.players.some(p => p.bot));
  await send(b, 'leaveRoom');
  const playing = await waitState(a, s => s.phase === 'betting');
  const room = f.instance.rooms.get(first.code);
  assert.equal(playing.players.filter(p => p.bot).length, 3);
  assert.equal(new Set(room.game.players.map(p => p.socketId)).size, 4);
  assert.equal(new Set(playing.players.map(p => p.id)).size, 4);
});

test('varied bot names exclude human and other bot names regardless of letter case', () => {
  assert.ok(botNames.length >= 40);
  for (const allowed of ['Alex', 'Nina Petrova', 'milo_87']) {
    const excluded = botNames.filter(name => name !== allowed).map(name => name.toUpperCase());
    assert.equal(chooseBotName(excluded), allowed);
  }
  const selected = ['Alex', 'Maya'];
  for (let i = 0; i < 4; i++) selected.push(chooseBotName(selected));
  assert.equal(new Set(selected.map(name => name.toLowerCase())).size, selected.length);
});
