# Dicebound

A runnable Globby multiplayer dice poker game for up to four people, with four
progressing characters, strategic bots, and a mobile HTML/CSS interface. The
browser uses vanilla JavaScript for Socket.IO and interactions; there is no
frontend framework, bundler, or build step.

During play, four seats surround an oval felt poker table with the pot and chip
stacks in the center. Your seat stays at the bottom. Dealer, small blind, and big
blind chips sit on the felt next to their seats and rotate each hand. The white
Dealer, gold BB, and green SB chips remain separate, including when the dealer
also posts the small blind with two players. Wagers show raise amounts and whose raise
was called. Turn highlights, winner badges, public ability effects, and expandable
betting activity keep the hand readable. Phone betting controls stay at the bottom
of the screen, with character skills directly below the table. The compact phone
layout places your dice beside your identity, keeps position chips on the felt,
and adapts to short screens. Tap any player identity to inspect their skills.

## Run

Requires Node.js 20 or newer.

```powershell
npm install
npm start
```

Open **http://localhost:3016**. To use another port:

```powershell
$env:PORT = "3020"
npm start
```

Choose a character, enter a name, and press **Play** to join a shared matchmaking
table. While waiting for people, a bot joins one empty seat every randomly chosen
4–8 seconds. People can join the remaining seats throughout the search.
Four ready players start immediately. Cancel search to leave; reconnecting preserves
your seat and the scheduled bot arrival. There is no start countdown.
Bot names are randomly chosen from varied first names, full names, and usernames,
without duplicating another name at the table. Bots use the same legal actions as people.

Choose **Open a table for friends** in the role dialog to create a separate private
table. Share its invitation link or six-character code before play starts. The host
can deal immediately; otherwise, after a 12-second invitation window and once
everyone has selected a character, bots join one at a time with the same random
delays. Tune arrivals with `botJoinMinMs` / `botJoinMaxMs`, and the private invitation
window with `matchmakingMs` in `server/config.js`.

For a phone on the same network, open `http://<your-computer-LAN-IP>:3016`.
The server listens on all interfaces. Use your network's normal access rules.

## Rules

- Chips, gold, and coins are one currency. Every character starts with 10.
- Roles can repeat freely at a table. Each bot chooses a role independently,
  including roles already chosen by humans or other bots.
- Every hand has rotating small and big blinds, starting at 1/2 chips, with no ante.
  Both increase by 1 after every 5 completed hands: 1/2 on hands 1–5,
  2/3 on hands 6–10, 3/4 on hands 11–15, and so on, even at maximum character level.
  Only blind seats post automatically. The dealer and blinds skip eliminated
  players; betting starts after the big blind, with unlocked Fighters moved last.
  Heads-up, the dealer posts the small blind and acts first (before Fighter ordering).
  Short stacks post only their remaining chips and remain eligible for side pots.
  One betting round follows: check, call, raise, fold.
  There are at most three raises. A raise amount means the increase over the
  current table bet, not the total wager.
- Dice are d6. Each player gets one hidden and one visible die. Hidden dice are
  private to their owner, except the level 4 Hunter's target inspection. The
  highest combined total, including character bonuses, wins.
- Folding rolls no additional dice and awards no chips. Opposing character
  penalties still apply. Folded players cannot win the pot, and their hidden
  dice stay private, including in history.
- Open **Skills** in the table header or on any player's card to see everyone's
  five abilities, current level, and unlocked versus locked skills. This is
  available in both the lobby and during play and updates as players level up.
- All-ins use contribution-based side pots. Uncalled excess and any layer with
  no eligible contender return to their contributors. Ties split; integer
  remainder chips follow seat order.
- Completing hands 5, 10, 15, and 20 unlocks levels 2, 3, 4, and 5 respectively.
  Only players who still have chips and are not eliminated progress. Folding
  does not exclude a surviving player from progression.
- Zero-chip all-ins remain eligible until settlement. Bankruptcy is resolved
  as a simultaneous batch. Resurrection does not count as final elimination.
  Simultaneously eliminated characters cannot collect rewards to rescue
  themselves. Unlock effects are applied before their bankruptcy batch resolves.
- Investor dividends pay immediately when a level 2 or higher Investor becomes
  big blind, only while more than two players remain. The reward is their balance before posting the
  blind divided by 10, rounded down: 22 coins gives 2; 30 gives 3.
- Settlement order is pots, bankruptcy and elimination rewards, hand count and
  unlock effects, then further bankruptcies and rewards.
  Invest stays locked to one player and pays 4 coins each time that player
  eliminates someone other than the Investor. It remains active after payouts;
  the target's final elimination allows a new investment. Resurrection does not
  trigger a payout or clear an investment. Eliminated Investors cannot collect.
  Fatal fold pressure, strikes, and blasts credit their source. Pot losses credit
  winners of contested layers funded by the victim, including tied winners;
  unrelated side pots and refunds give no credit. Each investment pays once per
  victim, including kills credited to a target eliminated in the same batch.
- One survivor wins the game. Disconnected seats become bot controlled after
  10 seconds; reconnecting in the same browser restores the seat.
- The acting player has a highlighted seat and countdown bar. Bots pause for
  3–6 seconds before each action, including when a human hands over the turn.
  Tune the minimum with `botThinkMs` and the added variation with `botThinkJitterMs`.

## Character abilities

Abilities remain unlocked. Level-triggered chip grants and blasts happen once
when the level is reached, with Kamikaze's level 5 refresh as the stated exception.

| Level | Камикадзе / Kamikaze | Investor | Bounty Hunter | Fighter |
| --- | --- | --- | --- | --- |
| 1 | Resurrect with 10 chips once | Invest in another player; earn 4 each time they eliminate someone except you; choose again when the target dies | Tag another player; their final elimination earns 5; then tag again | Folding loses your pot contribution plus 1 extra against any Fighters (blinds count) |
| 2 | On final elimination, winners receive none of your contributed chips | When you become big blind with more than 2 players remaining, immediately gain 1 per 10 coins held before posting the blind, rounded down | +2 dice total when competing against the tagged target | Last in initial betting order |
| 3 | Gain 2 for every other player's final elimination | Immediately gain 5 | Tagged target folding against you loses 2 | Win tied totals |
| 4 | Immediately take 2 chips from every other active player | Once per hand, spend 3 chips for +1 dice total | See the target's hidden die | +1 dice total against an opponent with more chips |
| 5 | Refresh resurrection and repeat the level 4 blast; passive abilities remain active | Immediately gain 10 | Once, take 5 chips from any other active player | Permanent +1 dice total |

Conflict rules:

- Kamikaze level 2 burns only their own contribution to won pot layers. Other
  players' chips and uncalled returns are unaffected. The condition requires a
  final bankruptcy, with no remaining resurrection.
- Fighter fold pressure applies only when the folding player has contributed chips
  to the current pot, including small and big blinds. It costs 1 extra coin on top
  of those already committed chips (3 in the pot + 1 extra = 4 lost), even
  against multiple still-competing Fighters. Folded or eliminated Fighters exert
  no pressure. Tagged Hunter penalties apply per still-competing Hunter in addition
  to Fighter pressure.
  A tag cannot change while its target survives.
- Dice bonuses are evaluated separately against eligible opponents in each pot.
  Hunter gets +2 only if the tagged target is eligible for that pot. Fighter's
  level 4 grants one +1 if any such opponent holds more chips.
- A tied level 3 Fighter beats tied non-Fighters. Multiple tied Fighters split.
  Level 2 Fighters act after everyone else in the initial betting order,
  preserving their relative order; if every contender is a Fighter, order is unchanged.
- Kamikaze refresh applies to its own abilities: restore one resurrection charge
  and repeat the blast. Its passive elimination effects remain active and do not
  fabricate new elimination events.
- Bonuses add to the dice total; they do not modify the displayed natural face.
  Investor can boost only on their turn and only once that hand.

## Architecture

```text
server/
  config.js       Balance, pacing, precision ceiling
  characters.js   Character definitions, modular classes, Bulgarian translations
  engine.js       Authoritative rules, dice, betting, pots, progression, presentation
  bots.js         Exact hidden-die enumeration, odds and bankroll decisions
  index.js        Globby hooks, rooms, sessions, Socket.IO, timers, static server
public/
  index.html      Semantic HTML shell
  style.css       Shared theme, dialogs, lobby, tactile transitions
  poker.css       Felt poker table, seats, chips, responsive betting dock
  app.js          Vanilla browser UI, dialogs, synchronization
vendor/
  globby.js       Upstream Globby with documented compatibility fixes
test/
  engine.test.js  Abilities, progression, conflicts, pots, bot tournaments
  network.test.js Live Socket.IO multiplayer, permissions, reconnect, matchmaking
```

The server uses Globby's `newGame` lobby, `connectFunction`, `disconnectFunction`,
`moveFunction`, `timeFunction`, and `statePresenter` hooks. A small Socket.IO
adapter supplies room codes, acknowledgments, opaque reconnect credentials, and
connection limits. `statePresenter` strips all transport metadata and redacts
hidden dice before any state reaches a browser or a bot.

Moves have `{ type, revision, ...parameters }`. The server binds moves to the
authenticated connection, checks the latest state revision, validates phase,
turn, character, level, chip balance and usage limits, and acknowledges either
`{ ok: true }` or `{ ok: false, error }`. Dice use Node's cryptographic random
number generator. Bots enumerate only the hidden faces legally possible from
their own presented state.

Extend `Character` and register an instance and UI definition in `characters.js`
to add a character. Tune numbers in `config.js`. There is a numerical precision
ceiling far above practical play to keep JavaScript chip and pot arithmetic exact.

Rooms and reconnect sessions are held in memory. Restarting the server clears
them. Abandoned rooms expire after 30 minutes. Google Fonts are optional; local
Georgia/Arial fallbacks keep the interface playable without external font access.

## Verification

```powershell
npm test
```

Tests cover every character's unlock gates, 45 completed hands of progression,
folded survivors, all-ins and side pots, simultaneous eliminations, resurrection
and bounty conflicts, repeated investment returns, elimination credit, timing,
dice privacy, invalid and repeated actions,
numerical precision, and 12 seeded bot tournaments. Integration tests use real
Socket.IO clients and isolated servers for multiplayer, host permissions,
reconnecting to the same character and dice or an eliminated spectator seat, leaving lobby seats, automatic
matchmaking, and disconnected-seat takeover.

Browser verification also exercised desktop, 390px, and 320px layouts, character
selection, creation, everyone's skills, ability dialogs and tagging, betting controls, folding,
results, and history, with no horizontal overflow or JavaScript errors.
Invest selection, public target labels, and repeated payouts were verified at
1440px, 390px, and 320px. Eliminated spectators followed three, two, and one
survivor, including page reloads. Full browser games as all four roles reached
a champion through natural eliminations without disconnects or JavaScript errors.

See `THIRD_PARTY.md` for the vendored Globby source and local fixes.
