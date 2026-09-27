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

**Steps 1-2 (this range).** Base `d6711b5`.

- **Concurrent-write incident.** Two of this implementer's own research forks (launched read-only,
  `subagent_type: "fork"`) independently began *implementing* this same milestone in the shared,
  non-worktree checkout while the foreground session was also working -- a real hazard, not a
  hypothetical one (see the orchestrator's own note for future delegations: prefer `isolation:
  "worktree"` for anything that could plausibly start writing). The resulting Rust work (session
  codecs, `sim_attach`/`sim_detach`/`sim_has_player`, `client_hello`/`client_on_welcome`, `Replica::
  set_own_player`) converged on essentially the design this brief already called for and was
  verified (`pnpm test rust`, `pnpm test wasm -t "abi registry"`) rather than discarded; a stray
  duplicate `session.rs` (an earlier, incompatible draft, different `MAGIC`, no resume support) was
  deleted in favour of the richer `session/mod.rs` that had already passed its own tests and blessed
  goldens. No data was silently trusted: every inherited file was read, diffed and test-verified
  before this implementer built on top of it or committed.
- **Session codecs** (`crates/engine/src/session/mod.rs`): `Hello`/`Welcome`/`Reject`/`Bye`, golden
  bytes at `session_hello`/`session_welcome`/`session_reject`/`session_bye`. `MAGIC = 0x474E_4580`
  (`\x80ENG` little-endian, low byte `0x80`). `Welcome`'s `params` field is `Codec`-encoded (binary,
  postcard), not JSON: `Worldgen::Params: Serialize + DeserializeOwned` is exactly `Codec`'s own
  blanket bound, so this needed no new trait bound anywhere. `Reject` is the one codec proven
  byte-identical across languages (Constraints): `src/host/handshake.ts`'s `buildReject` vs. the
  Rust golden, both checked against `crates/engine/tests/golden/session_reject.hex` in
  `src/host/handshake.test.ts`.
- **`sim_attach`'s exact input-region layout** (`ABI_VERSION` 25->27 across two additive widenings):
  `player_id varint · epoch u32 · joined u8 · presence: has_presence u8 + (len varint + bytes)? ·
  hello_tail` (`host::Host::attach`'s doc comment; `src/host/handshake.ts`'s `buildAttachInput`
  builds it). `epoch` is always `0` from this brief's own callers (M28b owns real epoch bumping).
  `sim_has_player(player) -> u32` and `sim_detach(conn) -> status` are new, additive exports;
  `sim_connect`/`sim_disconnect`/`Host::connect` are untouched (still real: native tests,
  `testkit::Loopback`, recovery's own re-attach path) -- "no provisional-join code path remains in
  the sim host" is true of the production `SimHost.accept` path only, since `worker/sim.ts`'s own
  single-player call site still passes no `handshake` deps (Non-scope here: the browser
  single-player path through `Hello`/`Welcome` is step 5's).
- **`ClientCore::revealed(visible: TileRect) -> bool`** (`ABI_VERSION` 26->27, `client_clock_stats`
  widened 16->20 bytes, a 5th LE `u32`): every chunk of `visible` both `Replica::is_held` and
  `TerrainStore::is_cached`. Takes the rect as a parameter rather than storing one, since `game_
  instance.rs`'s own `CachedCameraView::visible` already has it. Clock-block `revealed` word lands
  at offset 28 (the block's own reserved 8th slot); `SessionState` is renamed in place (`Connecting`
  ->`Handshaking`=0, `Live`->`Online`=1, same numeric values) plus two new values, `Rejected`=2,
  `Superseded`=3 (unused by any caller until step 3).
- **Session table** (`src/host/sessions.ts`): `SHA-256(secret) hex -> { playerId, lastPresenceHex }`,
  JSON at `Storage` key `sessions` (0005's existing key, `worldKeys().sessions`). **Not implemented
  this range: writing `lastPresenceHex`.** No production ABI export currently hands TS a player's
  *live* presence sample (`Host::debug_presence` is `#[cfg(test/feature=testing)]`-only) -- the
  natural write site is disconnect (0001: "so a returning player's camera can start where they
  were"), which is step 3's own territory (`Bye`/grace) to build alongside a real export for it.
  `Welcome`'s own `presence` field is real and wired (echoes whatever `lastPresenceHex` already
  holds, i.e. always empty in this range) so step 3 only has to add the write side.
- **PlayerId allocation ("next id is `max(table, sim) + 1`").** Race-free by construction, not by
  locking: the synchronous span from `sessions.lookup` to `sessions.create` (no `await` in between)
  means a second secret's digest, however it interleaves, always sees the first's reservation
  already in the in-memory table before picking its own candidate; only `sessions.save()` (the
  durable write) is awaited afterward.
- **Async digest timing (real bug, found and fixed).** `crypto.subtle.digest` resolves through
  Node's own libuv thread pool, not a plain microtask -- awaiting `VirtualClock.advanceBy` alone
  (itself just a synchronous body wrapped `async`) never reliably gives its completion callback a
  turn, so the very first cut of this milestone's own `advanceTicks` loop left every handshake
  stuck "Handshaking" forever (every M27 netcode scenario failed with "dispatch before ready").
  Fixed by making `net-harness.ts`'s `advanceTicks` `await simHost.handshakesSettled()` at the top
  of every iteration (a real `await` on the actual in-flight promise, not an incidental yield);
  `settle()` does the same once up front. Root-caused with temporary `console.error` tracing (routed
  through `test-results/netcode/output.log`, since the suite's own JSON reporter swallows stdout on
  a passing run) -- removed before committing.
- **`createWorldServer` always wires the real handshake** (never optional there; only `worker/
  sim.ts`'s 2-6-argument calls to `createSimHostFromInstance` fall back to implicit accept, per its
  own `handshake?` parameter). **Consequence, found late, not fixed in this range:** two existing
  `tests/wasm/puts.test.ts` tests -- `wasm_connected_100_matches_its_own_golden` and
  `wasm_script_a_matches_native` -- call `createWorldServer(...)` + `server.accept(fakeConnection())`
  directly with no `Hello` ever sent, so the connection now simply never attaches (silently tolerated
  as untimed-out "garbage" within the test's own short run) and the resulting `sim_hash()` no longer
  matches `golden-connected.json`/`golden-script-a.json`. **Stopped and reported per Constraints**
  ("do not move any existing golden ... stop and report before re-blessing"): these two tests are
  left red. Fixing them means teaching each to speak a real `Hello`/`Welcome` (mechanically similar
  to `net-harness.ts`'s own `makeClient`) and re-blessing both goldens to the new, legitimately
  different hash -- a real decision (which hash is "correct" now, and whether the doc comments
  citing the old literal hex need updating) the orchestrator should make, not this implementer.
  Every other suite is green: `rust` 612, `unit` 286, `wasm` 154/156 (these 2 failing), `netcode`
  10/10, `pnpm test wasm -t "abi registry"` 17/17. `node scripts/repeat.mjs netcode 20`: 20/20 once
  a stale `vite preview` process left over from earlier in this same session (holding a lock under
  `tests/browser/pages/dist/`, unrelated to `netcode`) was killed -- the first attempt, before that
  cleanup, measured `pass=16 fail=4 hang=3`, entirely attributable to that lock contention (empty
  stdout on every failing/hung run, one of them a literal `ENOTEMPTY: rmdir .../dist/fixtures`).
- **`counters-exact.test.ts` literals re-measured**, not loosened: opening every connection with
  `Hello`/`Welcome` legitimately changes the exact bytes a fixed-seed run sends (72 B `Hello` up,
  102 B `Welcome` + this connection's own first `Frame` down, both landing in the same tick bucket
  since `sim_attach` and the per-connection frame pass both run inside `pumpHandshakes`'s own tick
  boundary). New literals measured once, pasted from the real run, not computed by the test itself.
- **`Reject`/`ProtocolError` two-tier failure model, exactly as Planning decisions implies but this
  brief's Scope line reads ambiguously:** a message that fails to parse as `Hello` at all (bad
  magic/version/truncated) is treated as *garbage* -- silently dropped and counted (cap 8, then
  `ProtocolError`) -- not an instant close on its own. A `Reject` (`VersionMismatch`/`BadKey`/
  `Full`) only ever follows a *successfully parsed* `Hello` whose content disagrees (build hash,
  join key, capacity). `ProtocolError` therefore fires from exactly two places: garbage exceeding
  the cap, or no valid `Hello` within `HELLO_TIMEOUT_MS` (5000).
- **`Full`'s exact counting rule** ("concurrent sessions" against `maxPlayers`, default 8, 0009):
  implemented as every connection currently `awaiting-attach` or `settled`, not yet distinguishing a
  *known* secret reconnecting from a brand-new one (0013: "a known secret is refused too when no
  seat is free" -- true here since nothing in this range special-cases it, but untested: no `Full`
  scenario exists until step 3).
- **`HeadlessClient`**: `myPlayerId?`/`game_instance.rs`'s `TerrainConfig.my_player_id` deleted;
  replaced by `secret: Uint8Array` (16 B), `joinKey?: string`, `buildHash: Uint8Array` (32 B),
  `clock?: { now(): number }` (feeds `seed_lead_rtt_ms`'s own measured Hello->Welcome round trip).
  `client_hello()`'s own `Hello.camera` is always a zeroed `CameraReport` (no real camera exists
  that early in a connection's life); the real one a scenario's own `setCamera` queued only reaches
  the host afterward, over the ordinary `client_poll_uplink` path -- one real behavioural
  consequence, not a bug (see `counters-exact.test.ts`'s own updated doc comment).
- **`net-harness.ts`**: `createNetHarness({ secrets?, ... })` (`joinKey?` is the pre-existing
  `world.joinKey`, not a new duplicate top-level field); `deterministicSecret(seed, index)` (a
  splitmix64-style mix, not `crypto.getRandomValues` -- determinism, not identity security, same
  standing `conditionLink`'s own seeded jitter already has). `harness.connectRaw(): Connection`
  lands as specified (Seams) but is not yet exercised by any test in this range (step 3's own job).
- **Not built this range** (left for steps 3-5, as scoped): `Bye`/`client.leave()`/
  `HeadlessClient.leave()`; `Superseded` detection (a second connection on the same secret currently
  just gets its own independent session-table lookup and a second `ConnSlot` -- nothing yet frees
  the first); heartbeat; `createLink`; the browser single-player path (`loadOrMintSecret()` exists,
  `src/client/secret.ts`, but nothing calls it yet); view-clamp wiring to `setViewClamp` (Welcome's
  `view_max_tiles_per_axis`/`view_max_chunks` fields are real and echoed, but nothing on the client
  side consumes them into the camera yet -- also browser wiring, step 5).
