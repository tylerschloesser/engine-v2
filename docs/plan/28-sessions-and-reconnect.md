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

**Gate item + steps 3-4 (this range).** Base `3d2089c` (step 2). Commits: `ab5815d` (gate),
`31cf661` (step 3), `21235c5` (step 4, partial).

- **Gate item.** `tests/wasm/puts.test.ts`'s `wasm_connected_100_matches_its_own_golden` and
  `wasm_script_a_matches_native` now speak a real `Hello` (a throwaway `Role.Client` instance's
  own `client_hello()` bytes, fed to `conn.onMessage` directly, `serverInternals(server).
  handshakesSettled()` awaited before ticking) instead of relying on the old implicit accept.
  Both checked-in goldens (`golden-connected.json`, `golden-script-a.json`, including the literal
  `0a7cc2623a83a03e`) come out **unchanged**, exactly as predicted: `wasm_connected_100` has no
  actions to interleave with the handshake at all, and `wasm_script_a`'s own first entry (`tick:
  1`, `connect: true` plus action `seq: 1` in the same script entry) turns out not to need the
  connect record and the action on the identical tick after all -- a real handshake cannot admit
  an action before its own attach has been processed at a tick boundary (Welcome must round-trip
  first, 0013), so `seq: 1` ends up admitted for tick 2 instead of tick 1, landing in the *same*
  frame as `seq: 2` (which was already scheduled for tick 2) rather than its own. This reshuffles
  only ticks 1-2 (`Joined`/`Connected` alone on tick 1; `Paint` then `Spawn` together on tick 2,
  in arrival order) and touches disjoint tile positions with no tick-count-dependent effect in
  between, so the final `Store` state -- and therefore the hash -- is bit-identical either way.
  Never re-blessed. `pnpm test wasm`: 156/156.
- **Superseded** (0013 "the same secret in a second tab: newest wins"): `Host::attach`
  (`host/mod.rs`) scans `self.conns` for another `ConnSlot` already carrying the same `PlayerId`
  and frees it silently on every attach -- no `Disconnected` record, no `presence.remove` (the
  player is only moving connections, not leaving). `last_superseded: Option<ConnId>` records
  which one; `Instance::sim_last_superseded(&self) -> u32` (`u32::MAX` = none) is a **new instance
  method, not a new ABI export symbol** -- `sim_attach`'s own `Result`-region contract widened in
  place (one LE `u32` at offset 0, written by `abi::mod::sim_attach` right after a successful
  attach, a second sequential borrow of `rt.layout` after the `Tx` borrow has already ended) the
  same way `client_clock_stats` widened from 16 to 20 bytes at M28 step 2. `ABI_VERSION` 27 -> 28.
  `server.ts`'s `pumpHandshakes` reads `built.supersededConn` off the widened
  `SimInstance.simAttach` and sends the freed connection `Bye{Superseded}`
  (`host/handshake.ts`'s new `buildBye`/`ByeReason`, pure, golden-matched: `[0x05, reason]`
  against `session_bye.hex`) then `closeHandshake(..., CloseCode.Superseded)`. **Orchestrator
  ruling, fixed in this range (commit `a02b683`):** `conditionLink` used to close synchronously
  and set one flag (`disconnected`) that every not-yet-released delivery on either direction
  checked at release time -- including ones already scheduled *before* `close()` was ever called
  -- so a `Bye` sent immediately before close was always dropped, unlike a real reliable-ordered
  connection (or a WebSocket), which delivers queued data ahead of its own close. Fixed by
  scheduling `close(code)` itself through the same per-direction `seq`/`floorAt` ordering
  `makeSend` already uses (`scheduleClose`), with new per-end `aClosing`/`bClosing` idempotency
  flags distinct from `disconnected` (which stays `disconnect()`'s own abrupt "drop everything"
  flag, untouched). `superseded` now asserts the `Bye` bytes arrive (last message, `[0x05, 1]`)
  immediately before the `4001` close, ordered (`events` array); reverting the fix fails exactly
  that assertion.
- **`HeadlessClient.leave()`** sends `Bye{Leave}` then calls `connection.close(0)`; `status()`
  now also exposes `revealed` (`ClientCore::revealed()` was already wired end to end by step 2 --
  `worker/client-net.ts`'s `createNetPump` already read it off `client_clock_stats` into the clock
  block -- nothing had read it back out on the headless side until now).
- **`net-harness.ts`: `addClient(secret?)`/`makeClient(secretOverride?)`.** Additive, not a
  renamed seam: a scenario that wants a *specific* returning or superseding identity (not merely
  "some real one") passes it; omitted, behaviour is exactly pre-existing.
- **`crash-between-table-and-log`'s own storage-fault-injection shape** (not a reusable helper --
  local to the one test): `storage.append` is monkey-patched to throw exactly once, right after
  `serverInternals(server).handshakesSettled()` has durably written the session table but before
  the next tick's own `sim_seal_frame` -> `logSink` -> `Persistence.appendFrame` -> `storage.
  append` call, proven to matter (the tick throws only while armed, inject-fail-revert). The
  "crash" itself is simulated by never trusting or ticking that in-memory `WorldServer` again and
  building a fresh one over the same backing `Map` (`memoryStorage(backing)` twice) -- `stop()` is
  never called on the "crashed" instance, since it would run its own snapshot/flush sequence
  against a world 0005 says a failed write already made unrecoverable-from-here. No TS `Welcome`
  decoder exists yet: `parseWelcomePlayerId` (local to `handshake.test.ts`) reads just the one
  leading varint field these scenarios need, a tiny LEB128 reader mirroring `host/handshake.ts`'s
  own private `readVarint`, not a general decoder.
- **`superseded`'s "no log record" claim, proven black-box (commit `f0bc520`, orchestrator
  ruling):** wraps `SimHost.logSink` (`worldServerTestHandle`) and decodes each frame's own
  `count` field (0005 Formats: `len varint | tick_delta varint | count varint | records |
  crc32`), asserting the record-count delta across the supersede-processing tick is exactly `1`
  (the surviving connection's own ordinary `Connected`) -- proven to matter by temporarily
  pushing a `Disconnected` record in `Host::attach`'s own eviction branch (not committed): the
  delta becomes `2`, failing.
- **Real `PlayerId`-swap race, found and fixed (commit `5a2d4ba`), the actual root cause of the
  `conditioned-link` flake the orchestrator flagged as in-scope:** `server.ts`'s handshake
  `settle()` picked each never-before-seen secret's `PlayerId` (`sessions.create`) the instant its
  own `crypto.subtle.digest` resolved; `pumpHandshakes` only ever *consumes* `attachQueue` in
  `Hello`-arrival order, but the digest itself resolves through Node's real libuv thread pool,
  whose completion order across two concurrent hashes is not seeded. Two simultaneously-joining
  clients' own `PlayerId`s could therefore swap between runs of the identical seed -- not
  wall-clock leakage, an unseeded `Math.random`, or `Map` ordering, but a genuine cross-closure
  race on *when* each `settle()` is allowed to touch the session table (the orchestrator's four
  named candidates were all ruled out; the cause is unrelated to `advanceTo`/`conditioner.ts`
  themselves). Fixed with `sessionMutationChain`, a promise chain extended in the same arrival
  order `attachQueue`'s own `slotIndex` already fixes: each handshake awaits its predecessor's own
  turn before touching `sessions`, regardless of real digest completion order. Found via a scratch
  loop harness (400+ sequential same-seed trace comparisons, not committed) that reproduced the
  mismatch at iteration 37 before the fix and ran clean after it; `node scripts/repeat.mjs netcode
  20`: 20/20 (was ~1/20-30 failing before).
- **Heartbeat (commit `5121986`), tick-based, in Rust (orchestrator ruling):** `ConnSlot` gains
  `last_sent_tick: Tick`; `Host::build_frame`'s own "nothing to say" branch falls through to build
  the wire format's own already-defined heartbeat shape (`wire/CLAUDE.md`: "no sections =
  heartbeat", the 10-byte header alone) once `G::TICK_RATE.millis(500)` ticks (10 at 20 Hz) have
  passed since that connection was last actually sent anything -- no new ABI export, no wall-clock
  timer: `sim_build_frame` simply returns a real length instead of `0` on a due tick.
  `connection_and_subscriptions.rs`'s `idle_tick_builds_no_frame` (asserted silence held
  indefinitely) is renamed `idle_tick_heartbeats_after_ten_silent_ticks` and now pins the exact
  tick it doesn't.
- **`HeadlessClient` wired onto `createLink` (commit `7ce2691`).** `HeadlessClientOptions.dial: ()
  => Connection` replaces `connection`; `onUp` re-attaches `bytePump`, resets the pre-`Welcome`
  state and resends `Hello`; `leave()` sends `Bye{Leave}` then `link.stop()` (the close-ordering
  fix above means the `Bye` is actually delivered now). **Real bug found while wiring this:**
  `createLink`'s own `dial()` set `onMessage`/`onClose` directly on the raw dialed `Connection`
  and handed *that same object* to `onUp` -- but a 0009 `Connection` has only one `onMessage`/
  `onClose` slot each, so `HeadlessClient`'s own `bytePump.attach(conn)` (which also sets
  `onMessage`) silently stole every message away from the dead timer, which then never reset.
  Fixed in `link.ts` itself: `onUp` now receives a thin wrapper (send/close pass through; `onUp`'s
  own raw-connection callbacks re-dispatch to whatever the caller sets on the wrapper afterward),
  so `link.ts`'s own bookkeeping and a caller's own protocol no longer fight over one slot.
  `liveness/{dead-after-silence, stale-socket-ignored, probe-on-visible, backoff-schedule}` needed
  the same fix (poked `onMessage`/`onClose` on the `onUp` result directly) -- now target the
  harness's own raw `dials[]`, same literals. Every existing netcode scenario passed through the
  new wiring unmodified, `assertConverged()` included -- the wrapper bug above was the only thing
  that needed fixing, never a scenario. `liveness/heartbeat-idle-world` added: `fx-puts` has its
  own once-a-second "walk/day bump" (real `Global` writes, no client action) that keeps a plain
  dead-timer check from distinguishing "heartbeat" from "the game's own ambient ticking" on its
  own, so the assertion instead looks for the heartbeat's own precise signature -- a `bytesDown
  === 10` tick in `harness.counters(0).perTick`, which only a header-only frame can ever produce.
  Proven to fail with heartbeat forced off (not committed): zero such ticks.
- `pnpm lint`: green throughout (biome, rustfmt, clippy, tsc). Final `node scripts/repeat.mjs
  netcode 20`: 20/20. `pnpm test wasm`: 156/156. `pnpm test rust -t host`: 23/23.

**Open gate failures (orchestrator, after steps 1-4, on `cd33857`):** full `pnpm test`: rust 612, unit 286, wasm 156, netcode 24 green; **`browser` red on 6**: `[chromium] replica_hash_equals_host_in_browser`, `[chromium] progress_from_done_at_and_clock`, `[reference] reference_collect_flow`, `reference_several_buttons`, `reference_pan_out_cancels`, `reference_ui_smoke_collect_and_inventory` (a collect button never disables). The browser path still takes `sim_connect` until step 5, so a step 1-4 change broke it; bisect `d6711b5..cd33857` before fixing.
