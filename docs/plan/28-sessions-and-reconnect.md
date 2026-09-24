# M28: Sessions: handshake, identity, liveness

Status: not started · After: 27 · Tyler-dependent: no

**Split.** The PLAN.md row "sessions and reconnect" is about 2,700 lines, so it is two briefs. This one: `Hello`/`Welcome`/`Reject`, build-hash equality, secret + join key, `Bye`/`Superseded`, heartbeat, the client link policy. `28b-reconnect-and-lifecycle.md`: resume hint, epochs, grace, idle, pending-action resend.

## Goal
Every connection, in-browser and in the harness, starts with `Hello` and is answered by `Welcome` or `Reject`; identity is a device secret mapped to a `PlayerId` in a persisted host-side session table; a wrong build, wrong key or full world is refused with a frozen-layout `Reject`. The client side has one tested state machine for dead detection, probe and backoff, and the host sends heartbeats so that machine can be tested.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0013-sessions-and-integrity.md` (Identity, Handshake, Join is late join, Client policy, A disconnected player's state: the `Superseded` sentence, Build-hash handshake)
3. `docs/decisions/0009-transport-and-hosting.md` (`Connection.close(code)`, `WorldConfig.joinKey`/`maxPlayers`/`buildHash`)
4. `docs/decisions/0004-action-timing-and-rejection.md` (per-player `seq`; connection events in the log)

Rules that apply: `.claude/rules/determinism.md`.

## Scope
- Codecs with golden bytes: `Hello`, `Welcome`, `Reject`, `Bye { reason: Leave | Superseded }` (layouts: 0013 Handshake; `MsgType` ids for `Welcome` and `Bye` are already reserved by M14). `PROTOCOL_VERSION = 1`; the magic's first wire byte is ≥ `0x80` (M14's constraint, 0024 §8), so `Hello`/`Reject` never collide with a `MsgType`.
- Host handshake per connection: TS parses the frozen prefix, join key and secret (DataView; the server is outside 0016); magic or version wrong, or no `Hello` within 5 s, closes with `ProtocolError`. Non-`Hello` messages before `Hello` are dropped silently (at most 8, then close): this lets the net worker stay a pure byte pump across reconnects (M29).
- Session table `SHA-256(secret) → { playerId, lastPresence }` (WebCrypto), persisted with `Storage.write` at key `sessions` (0005 key list).
- `Welcome` built in Rust by `sim_attach`; then the logged `Joined`/`Connected` event (0013, Join is late join) and the first frames as M15 already sends them. M15's implicit accept (`PlayerId = conn`) is deleted.
- **Reveal rule (0013 "Join is late join", last sentence; handed over by M15b):** `ClientCore::revealed() -> bool` is true once every chunk of the visible rectangle is both held by the replica and locally generated; it is mirrored in a `revealed` word of M16's clock block and in `HeadlessClient.status()`. M29 gates the first terrain draw on it in the browser.
- Client on `Welcome`: seed and worldgen params reach the client instance and the gen workers from `Welcome` instead of `world.params` (M13's interim rule; in remote mode they are unknown before it), view clamps go to `setViewClamp` (M11), the last presence sample to `seed_presence` (this brief builds it; M19 scoped it but did not implement it — see the `ClientCore::seed_presence` Scope item below), `seq_seed`/`session_state` in the clock block are set from `Welcome` instead of the first frame's `ack_seq` (M16's interim rule), and the `Hello`→`Welcome` round trip feeds `LeadEstimator.seed_rtt_ms` (M26, if ticked).
- **`ClientCore::seed_presence(G::Presence)`: build it.** M19's own Provides listed this method for M28 to call from `Welcome`, but M19's Deviations (steps 1-3) record it as not built — no caller existed yet in that cut. This brief is that caller, so it must add the method itself (host-side `PresenceTable::restore(who, sample)` already exists and stamps `Tick(0)`, per M19 Deviations).
- `Reject{VersionMismatch | BadKey | Full}` built in TS (it must not depend on the instance), then `close(code)`.
- Same secret on a second connection: the session moves, the old connection gets `Bye{Superseded}` and `close(Superseded)`, nothing is logged.
- Client `Bye{Leave}` on `client.leave()` / `HeadlessClient.leave()`. Until M28b the host logs `Disconnected` at once on any close; M28b inserts the grace.
- Heartbeat: an empty frame when nothing was sent to a client for the interval of 0010 (Rates). Moved here from M31 because the dead timer is untestable without it.
- `createLink` (below): dead timer, probe, jittered backoff, open-new-before-discarding-old (0013 Client policy). Pure TS on `Clock`/`Scheduler`, used by `HeadlessClient` now and the net worker in M29.
- Single-player takes the same path: the main thread calls `loadOrMintSecret()`, the client worker config carries `{ secret, joinKey: "", buildHash }`, the client instance emits `Hello` first. Existing browser tests keep passing through it.

## Non-scope
Resume hint, epochs, grace, idle, pending resend (M28b). WebSocket, net worker, reload/"updating" flow, the remote `host` option of `createClient` (M29). Rate limits (M31).

## Files, packages and crates touched
- `packages/engine/crates/engine`: `session` module (codecs, client session state, `sim_attach`)
- `packages/engine/src/host/{handshake,sessions}.ts`, `src/net/link.ts`, `src/client/secret.ts`, client worker shell (`Welcome` fan-out), `src/test/net-harness.ts`; tests under `packages/engine/tests/netcode/`
- fixture: M16's action fixture

## Seams
**Provides:**
- `enum CloseCode { Superseded = 4001, VersionMismatch = 4002, BadKey = 4003, Full = 4004, ProtocolError = 4005 }`, passed to `Connection.close`. The close code, not the message body, is what a non-parsing net worker acts on.
- Sim exports `sim_attach(conn, len) -> len` (input region: `player_id, epoch, joined, last presence, Hello tail` = camera report + optional resume, which M28 ignores; output: `Welcome` bytes) and `sim_detach(conn)`; `sim_has_player(player_id) -> u32`.
- `ClientCore::revealed()`, clock-block word `revealed` (M29 gates drawing on it).
- Client exports `client_hello() -> len` (config → `Hello` in the transmit region); session status = M16's `session_state` word in the clock block, extended to `0 Handshaking | 1 Online | 2 Rejected(reason) | 3 Superseded` (M28b adds `Resyncing`).
- `createLink({ dial: () => Connection, clock, scheduler, seed, onUp(conn, gen), onDown(why) }): Link` with `probe()`, `stop()`, `state`; it stops for good on `Superseded`, `BadKey`, `Full`, and reports `VersionMismatch` without retrying by itself (M29 owns the reload policy). Messages and closes from a connection that is no longer current are ignored, so a `Superseded` aimed at a socket the client already replaced is harmless.
- `loadOrMintSecret(): Uint8Array` (`localStorage` key `engine.playerSecret`, one per origin).
- Harness: `createNetHarness({ secrets?, joinKey? })`, `HeadlessClient.leave()`, `harness.connectRaw(): Connection` (hand-written `Hello` bytes), `serverInternals(server).handshakesSettled(): Promise<void>` used by `settle()`.

**Consumes:** harness, `HeadlessClient`, memory pair, byte pump (M27); `SimHost.accept` and M15's implicit accept, which this replaces (M15, M15b); `MsgType`, `CameraReport`, golden-bytes pattern (M14); `Record::Player` logging (M15/M16); clock block `seq_seed`/`session_state` (M16); `Storage.write`, key `sessions` (M22); `PresenceTable.get`/`restore` (M19; `seed_presence` is not consumed from M19 — it is built by this brief, per the Scope item above); `setViewClamp` (M11); gen-worker params path (M08b); `LeadEstimator.seed_rtt_ms` (M26, if ticked).

## Planning decisions
- **"Copy my player link" (PRE-PLAN §10): not built; no milestone.** The Requirement says no cross-device recovery. What keeps it cheap later: the secret has one accessor (`loadOrMintSecret`), the invite fragment is parsed as `#k=<joinKey>` with unknown parameters ignored (so `&p=<secret>` can be added without breaking old links), and `exportWorld` already carries the session table (0005). Revisit when Tyler asks or the first real identity loss happens.
- **`Joined` vs `Connected` is decided by the sim, not the table:** `Joined` iff `sim_has_player` is false. The table entry is written before the record is appended and the next id is `max(table, sim) + 1`, so a crash between the two never orphans or duplicates a player.
- **Async digest, deterministic order.** `crypto.subtle.digest` is a promise; completed handshakes queue and are consumed at the next tick boundary in `Hello`-arrival order, which keeps harness runs reproducible from the seed.
- **`Full` counts concurrent sessions** (connected or, after M28b, in grace) against `maxPlayers`; a known secret is refused too when no seat is free.
- **`dispatch` before `Welcome`** keeps M16's rule (throws until `client.ready`); this brief only moves `ready` from "first frame" to "`Welcome` applied".

## Order of work
1. Codecs + golden bytes (Rust), TS `Reject` builder against the same goldens.
2. Session table + host handshake; harness switched to secrets; M27 scenarios green again.
3. `Superseded`, `Bye{Leave}`, `Full`, `BadKey`, `VersionMismatch` scenarios.
4. Heartbeat; `createLink` with virtual-clock unit tests; `HeadlessClient` on `createLink`.
5. Browser single-player path through `Hello`/`Welcome`.

## Tests added
Rust: `session/golden-hello`, `golden-welcome`, `golden-reject` (frozen prefix bytes), `golden-bye`. Netcode: `handshake/reveal-after-visible-chunks` (false after `Welcome`, true only when the last visible chunk is both received and generated), `handshake/join-then-return-same-player` (same secret → same `PlayerId`, `Connected` not `Joined`), `handshake/version-mismatch`, `handshake/bad-key`, `handshake/full`, `handshake/superseded` (old end gets `4001`, no log record), `handshake/garbage-before-hello`, `handshake/no-hello-timeout`, `handshake/crash-between-table-and-log` (storage fault injection), `liveness/heartbeat-idle-world`, `liveness/dead-after-silence`, `liveness/backoff-schedule` (exact virtual times for one seed), `liveness/stale-socket-ignored`, `liveness/probe-on-visible` (virtual clock: `probe()` on a silently dead link redials within the 0013 Client policy probe deadline instead of waiting out the dead timer; on a live link it changes nothing). Browser: existing single-player tests, plus `secret/persists-across-reload` and `handshake/welcome-view-clamp-limits-zoom` (single-player page whose host view clamp, 0010, is 128 tiles per axis: injected wheel zoom-out stops at 128 in `client.camera.read`; the `Welcome` → `setViewClamp` wiring of 0019 §1).

## Exit criteria
- [ ] Every netcode scenario opens with `Hello`; no provisional-join code path remains in the sim host.
- [ ] Named tests above pass; `Reject` golden bytes are identical from the TS builder and the Rust parser.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t handshake` · `pnpm test netcode -t liveness` · `pnpm test rust -t session` · `pnpm test browser -t secret` · `pnpm lint`

## Budgets
None asserted here. Heartbeat bytes appear in `NetCounters` and are budgeted in M31.

## Context artifacts
Netcode `CLAUDE.md`: secrets and `connectRaw`. `packages/engine/CLAUDE.md`: one line naming `CloseCode` as the only signal the net worker reads.

## Manual device checks
none (the device check for reconnect timing is attached to M29)

## Deviations
