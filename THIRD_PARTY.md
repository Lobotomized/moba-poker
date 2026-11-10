# Globby provenance

Source: https://github.com/Lobotomized/Globby

Vendored file: `vendor/globby.js`

Upstream revision: `95d010e72aa14e72d23a4ee23defbcba8730bb6b`

The upstream package manifest identifies its license as ISC. The repository at
this revision does not include a separate license text or copyright attribution.
This project records that provenance without inventing an upstream copyright.

Local fixes to the vendored file:

- `gamesNum()` reads the instance's `games` array.
- Move callbacks propagate their return values and reject unknown players.
- State presentation recognizes an authenticated reconnect ID as well as its
  socket ID. Unknown viewers receive an error rather than the raw state.
- Reconnected players use the original player reference in `connectFunction`.
- Player references increase monotonically, so leaving a lobby cannot create
  duplicate references.

The game uses the upstream `newGame` interface. Its Socket.IO adapter in
`server/index.js` manages room invitations and reconnect sessions rather than
using upstream `newIOServer`, whose original handshake exposes a caller-supplied
player identifier.
