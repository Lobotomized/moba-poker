'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');
const { Server } = require('socket.io');
const { newGame } = require('../vendor/globby');
const { GameEngine, RuleError } = require('./engine');
const { BotBrain, identities, chooseBotName } = require('./bots');
const { definitions } = require('./characters');
const defaults = require('./config');

function createServer(options = {}) {
  const rules = { ...defaults, ...options.rules };
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 4096, serveClient: true });
  const rooms = new Map();
  const sessions = new Map();
  const brain = new BotBrain(rules);
  app.disable('x-powered-by');
  app.get('/api/characters', (req, res) => res.json(definitions));
  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.use(express.static(path.join(__dirname, '../public')));

  function makeRoom(matchmaking = false) {
    if (rooms.size >= 200) throw new RuleError('All tables are busy. Try again shortly.');
    let code;
    do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
    const engine = new GameEngine({ rules });
    const room = { code, engine, touched: Date.now(), nextBotAt: 0, nextBotJoinAt: null, botSeatSerial: 0, botActionKey: null, lobby: null, game: null, state: null };
    const Lobby = newGame({
      baseState: { ...engine.createState(code), matchmaking },
      minPlayers: 1, maxPlayers: rules.maxPlayers,
      startBlockerFunction: () => undefined,
      joinBlockerFunction: () => true,
      connectFunction(state, ref) {
        room.state = state;
        engine.addPlayer(state, ref);
      },
      disconnectFunction(state, ref) {
        const p = state.players.find(player => player.id === ref);
        if (p) { p.connected = false; p.disconnectedAt = Date.now(); state.revision++; }
      },
      moveFunction: (player, move, state) => engine.apply(state, player.ref, move),
      timeFunction: state => engine.tick(state),
      statePresenter: (state, ref) => engine.view(state, ref)
    });
    room.lobby = new Lobby();
    rooms.set(code, room);
    return room;
  }

  function addBot(room) {
    if (room.state.players.length >= rules.maxPlayers) return;
    const identity = identities[randomInt(identities.length)];
    room.game.joinBot(`${room.code}-${room.botSeatSerial++}`);
    const p = room.state.players.at(-1);
    p.bot = true; p.name = chooseBotName(room.state.players.filter(other => other !== p).map(other => other.name)); p.character = identity.character;
    p.resurrections = p.character === 'kamikaze' ? 1 : 0;
    const joined = room.state.events.at(-1);
    if (joined?.type === 'join' && joined.playerId === p.id) joined.message = `${p.name} takes a seat.`;
    room.state.revision++;
  }

  function fillBots(room) {
    while (room.state.players.length < rules.maxPlayers) addBot(room);
  }

  function scheduleBotJoin(room, now = Date.now()) {
    room.nextBotJoinAt = now + randomInt(rules.botJoinMinMs, rules.botJoinMaxMs + 1);
  }

  function publish(room) {
    for (const player of room.game.players) {
      if (!player.socketId.startsWith('thisisabot')) {
        io.to(player.socketId).emit('returnState', room.game.returnState(player.socketId));
      }
    }
  }

  function attach(socket, session, room, broadcast = true) {
    const returning = session.room === room.code;
    if (!returning && (room.state && (room.state.phase !== 'lobby' || room.state.players.length >= rules.maxPlayers))) {
      throw new RuleError('This table is full or already playing.');
    }
    room.lobby.joinGame(socket.id, session.token);
    room.game = room.lobby.games[0];
    const config = room.game.players.find(p => p.socketId === socket.id);
    const player = room.state.players.find(p => p.id === config.ref);
    player.connected = true; player.disconnectedAt = null;
    session.room = room.code; session.player = player.id;
    room.touched = Date.now();
    if (broadcast) publish(room);
    return room;
  }

  function removeWaitingPlayer(room, player) {
    room.state.players = room.state.players.filter(p => p !== player);
    room.game.disconnected = room.game.disconnected.filter(p => p.ref !== player.id);
    room.state.host = room.state.players.find(p => !p.bot)?.id || null;
    room.state.revision++;
    for (const session of sessions.values()) {
      if (session.room === room.code && session.player === player.id) {
        session.room = null; session.player = null;
      }
    }
  }

  function startMatch(room) {
    room.nextBotJoinAt = null;
    room.state.startAt = null;
    room.engine.beginHand(room.state);
    room.state.revision++;
  }

  io.on('connection', socket => {
    const requested = socket.handshake.auth?.token;
    let session = typeof requested === 'string' ? sessions.get(requested) : null;
    if (!session) {
      const token = randomBytes(32).toString('hex');
      session = { token, room: null, player: null, socket: null, touched: Date.now() };
      sessions.set(token, session);
    }
    // A token controls one seat and one connection; a newer tab replaces the old one.
    if (session.socket && session.socket !== socket.id) io.sockets.sockets.get(session.socket)?.disconnect(true);
    session.socket = socket.id; session.touched = Date.now();
    socket.emit('session', { token: session.token });
    if (session.room && rooms.has(session.room)) attach(socket, session, rooms.get(session.room));
    let windowAt = Date.now(), messages = 0;
    function guarded(callback, ack) {
      try {
        if (Date.now() - windowAt > 1000) { windowAt = Date.now(); messages = 0; }
        if (++messages > 15) throw new RuleError('Please slow down.');
        session.touched = Date.now();
        const result = callback();
        if (typeof ack === 'function') ack(result || { ok: true });
      } catch (error) {
        if (!(error instanceof RuleError)) console.error(error);
        if (typeof ack === 'function') ack({ ok: false, error: error instanceof RuleError ? error.message : 'The action could not be completed.' });
      }
    }
    socket.on('createRoom', (_, ack) => guarded(() => {
      if (session.room && rooms.has(session.room)) throw new RuleError('Leave your current table first.');
      const room = attach(socket, session, makeRoom());
      return { ok: true, code: room.code };
    }, ack));
    socket.on('matchmake', (data, ack) => guarded(() => {
      if (session.room && rooms.has(session.room)) throw new RuleError('Leave your current table first.');
      if (typeof data?.character !== 'string' || !Object.hasOwn(definitions, data.character)) throw new RuleError('Unknown character.');
      if (typeof data?.name !== 'string' || !data.name.trim() || data.name.trim().length > 20) throw new RuleError('Use a name of 1–20 characters.');
      const now = Date.now();
      const waiting = [...rooms.values()].find(room => room.state?.matchmaking && room.state.phase === 'lobby'
        && room.state.players.length < rules.maxPlayers
        && room.state.players.some(p => !p.bot && p.connected));
      const room = attach(socket, session, waiting || makeRoom(true), false);
      const result = room.engine.apply(room.state, session.player, {
        type: 'select', character: data.character, name: data.name, revision: room.state.revision
      });
      room.state.startAt = null;
      if (room.nextBotJoinAt === null) scheduleBotJoin(room, now);
      if (room.state.players.length === rules.maxPlayers && room.state.players.every(p => p.connected)) startMatch(room);
      publish(room);
      return { ...result, code: room.code };
    }, ack));
    socket.on('joinRoom', (data, ack) => guarded(() => {
      if (session.room && rooms.has(session.room)) throw new RuleError('Leave your current table first.');
      if (typeof data?.code !== 'string' || !/^[A-F0-9]{6}$/i.test(data.code)) throw new RuleError('Enter a six-character table code.');
      const room = rooms.get(data.code.toUpperCase());
      if (!room) throw new RuleError('This table does not exist or has expired.');
      if (room.state.matchmaking) throw new RuleError('This is a matchmaking table. Use Play to find an open table.');
      attach(socket, session, room);
      return { ok: true, code: room.code };
    }, ack));
    socket.on('move', (move, ack) => guarded(() => {
      const room = rooms.get(session.room);
      if (!room) throw new RuleError('Join a table first.');
      if (room.state.matchmaking && room.state.phase === 'lobby' && ['start', 'select'].includes(move?.type)) {
        throw new RuleError('Waiting for players. The table starts automatically.');
      }
      // Fill bots only after a valid, current host request.
      if (move?.type === 'start' && move.revision === room.state.revision && room.state.phase === 'lobby' && session.player === room.state.host) {
        if (!room.state.players.every(p => p.character)) throw new RuleError('Everyone must choose a character first.');
        fillBots(room);
        move = { ...move, revision: room.state.revision };
      }
      const result = room.lobby.move(socket.id, move);
      room.touched = Date.now();
      publish(room);
      return result || { ok: false, error: 'Your seat is disconnected.' };
    }, ack));
    socket.on('leaveRoom', (_, ack) => guarded(() => {
      const room = rooms.get(session.room);
      if (room) {
        room.game.disconnect(socket.id);
        const p = room.state.players.find(p => p.id === session.player);
        if (room.state.phase === 'lobby') {
          removeWaitingPlayer(room, p);
          if (!room.state.matchmaking) room.state.startAt = room.state.players.length ? Date.now() + rules.matchmakingMs : null;
        }
        publish(room);
        if (room.state.matchmaking && !room.state.players.length) rooms.delete(room.code);
      }
      session.room = null; session.player = null;
      return { ok: true };
    }, ack));
    socket.on('disconnect', () => {
      if (session.socket !== socket.id) return;
      const room = rooms.get(session.room);
      if (room) { room.game.disconnect(socket.id); publish(room); }
      session.socket = null; session.touched = Date.now();
    });
  });

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (!room.game) { rooms.delete(code); continue; }
      const state = room.state;
      const hasHumans = state.players.some(p => !p.bot && p.connected);
      if (!hasHumans && now - room.touched > rules.roomExpiryMs) { rooms.delete(code); continue; }
      const revision = state.revision;
      if (state.phase === 'lobby') {
        if (state.matchmaking) {
          for (const p of [...state.players]) {
            if (!p.bot && !p.connected && now - p.disconnectedAt >= rules.disconnectGraceMs) removeWaitingPlayer(room, p);
          }
          if (!state.players.some(p => !p.bot)) { rooms.delete(code); continue; }
        }
        const ready = state.players.every(p => p.character && p.connected) && hasHumans;
        const recruiting = state.matchmaking || (state.startAt && now >= state.startAt);
        if (ready && state.players.length === rules.maxPlayers) {
          startMatch(room);
        } else if (ready && recruiting) {
          if (state.players.length < rules.maxPlayers) {
            if (room.nextBotJoinAt === null) scheduleBotJoin(room, now);
            if (now >= room.nextBotJoinAt) {
              addBot(room);
              scheduleBotJoin(room, now);
            }
          }
          if (state.players.length === rules.maxPlayers) startMatch(room);
        }
      } else {
        room.game.timeFunction();
      }
      const controlled = p => !p.eliminated && (p.bot || (!p.connected && p.disconnectedAt && now - p.disconnectedAt >= rules.disconnectGraceMs));
      const between = state.phase === 'result';
      const actor = state.phase === 'betting'
        ? state.players.find(p => p.id === state.turn && controlled(p))
        : between ? state.players.find(p => controlled(p) && brain.choose(room.engine.view(state, p.id), p.id)) : null;
      if (!actor) {
        room.botActionKey = null;
      } else {
        const key = `${state.phase}:${state.handNumber}:${actor.id}:${state.revision}`;
        // Each action gets its own thinking pause, including the first bot to act
        // after a human. A room-wide cooldown can already have expired by then.
        if (room.botActionKey !== key) {
          room.botActionKey = key;
          room.nextBotAt = now + rules.botThinkMs + Math.floor(Math.random() * (rules.botThinkJitterMs + 1));
        }
        if (now >= room.nextBotAt) {
          const move = brain.choose(room.engine.view(state, actor.id), actor.id);
          if (move) room.engine.apply(state, actor.id, { ...move, revision: state.revision });
          room.botActionKey = null;
        }
      }
      if (state.revision !== revision || state.phase === 'lobby') publish(room);
    }
    for (const [token, session] of sessions) {
      if (!session.socket && now - session.touched > rules.roomExpiryMs) sessions.delete(token);
    }
  }, rules.tickMs);

  async function close() {
    clearInterval(interval);
    await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  return { app, io, server, rooms, close };
}

if (require.main === module) {
  const instance = createServer();
  const port = Number(process.env.PORT) || 3016;
  instance.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Set PORT to another port.` : error.message);
    instance.close().then(() => process.exit(1));
  });
  instance.server.listen(port, '0.0.0.0', () => console.log(`Dicebound · http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => instance.close().then(() => process.exit(0)));
}

module.exports = { createServer };
