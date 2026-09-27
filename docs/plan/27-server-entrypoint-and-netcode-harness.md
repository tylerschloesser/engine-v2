# M27: Server entrypoint and netcode harness

Status: not started · After: 22b, 24, 16b · Tyler-dependent: no

## Goal
`engine/server` exports `createWorldServer(cfg, host).accept(connection)`, built on the TS sim host of M13/M15b and the persistence of M22/M22b, and `engine/server/node` runs a built game under Node. A `netcode` suite in `pnpm test` runs that real server with the real `.wasm` and K headless role=client instances in one Node process, joined by in-memory `Connection` pairs behind a seeded conditioner on a virtual clock, and asserts replica/host hash convergence. Every later network milestone adds scenarios to this harness.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0009-transport-and-hosting.md` (Decision: message classes, injected adapter, `WorldConfig`, Node, host-agnostic)
3. `docs/decisions/0020-testing-strategy.md` (§3 suites and budgets, §7 netcode harness, §8 what the engine exposes)
4. `docs/decisions/0017-packaging-and-build.md` (§2 exports map, §5 server half: `loadGame`)

Mine from spikes: `spikes/determinism-hash/` (Node and Bun loader shape). Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md` (the client shell reused headless).

## Scope
- `createWorldServer(cfg: WorldConfig, host: HostServices)` as typed in 0009: `createSimHost` + `Persistence.open` (load, recover or create), `host.timer` started when loaded, `accept(c)` (connections arriving before `ready` wait), `stop()` = `SimHost.stop()` then close connections.
- **0024 §5 (amends 0009), implemented here, not re-decided:** `createWorldServer` returns `{ ready, accept, stop }`; `ready: Promise<void>` rejects with M22b/M24b's `WorldLoadError`, because loading is asynchronous and 0009's synchronous signature has nowhere to report it; `HostServices` gains `onFatal?`, mapped from M24's `SimHost.onFatal`; `WorldConfig.params.seed` stays decimal text (M13's `createSimHost` converts it to `HexU64`).
- Until M28 there is no handshake: `accept` uses M15's implicit accept (`PlayerId = conn`). Scenarios here are join-only.
- `engine/server/node`: M02's `loadGame` and M22b's `fsStorage` stay; add `nodeHostServices({ wasm, storage, onIdle?, onFatal? })` supplying `clock` and `timer` from `systemClock`/`systemScheduler` (M03). The `ws` attachment is M29.
- In-memory `Connection` pair, conditioner, virtual clock, byte pump, headless client, harness (names under Seams), exported from `engine/test`.
- `netcode` suite registered in `scripts/suites.mjs` under the contract and budget of 0020 §2–3; the `wasm` suite's scenarios switched to run their logs through `createWorldServer` with `memoryStorage()` (Bun: M02's plain script, extended).

## Non-scope
Handshake, identity, reconnect (M28, M28b). Net worker, `ws`, loopback subset (M29). Token bucket, soft cap (M31), `Hashes` (M31b). Bun/Deno adapters (M35b). Misprediction-bound assertions (M34c, once prediction runs multiplayer). Any Rust change: `region_hash` already exists on both sides (M15).

## Files, packages and crates touched
- `packages/engine/src/server.ts`, `src/server-node.ts`, `src/net/{memory-connection,conditioner,pump}.ts`, `src/test/{virtual-clock,headless-client,net-harness}.ts`
- `packages/engine/tests/netcode/` (new suite, nested `CLAUDE.md`), `tests/wasm/`; fixtures: M16's action fixture and M15's `puts` fixture, unchanged
- No crate. No ADR: the 0009 amendment is 0024 §5.

## Seams
**Provides:**
- `createWorldServer`, `WorldServer = { ready: Promise<void>; accept(c: Connection): void; stop(): Promise<void> }`; `nodeHostServices`.
- `memoryConnectionPair(opts?: { datagrams?: boolean }): [Connection, Connection]`: `send` copies and never delivers re-entrantly.
- `conditionLink(a, b, { seed, latencyMs, jitterMs, stall?: { p, rtoMs } }, clock): ConditionedLink` with `ends: [Connection, Connection]`, `set(conditions)`, `stall(ms)`, `disconnect(code?)`. Wraps any `Connection` pair (memory now, `ws` in M29); semantics of 0020 §7.
- `createVirtualClock(): VirtualClock`, M03's `ManualClock` plus `advanceTo(t): Promise<void>` (awaits physical arrival, then releases in `(deliverAt, link, seq)` order) and `advanceBy(ms)`.
- `createBytePump({ uplink, downlink })` with `attach(conn)`, `detach()`, `drain()`: the net worker's pump core (0015 §1) between M06 rings (`SabSet.uplink`/`downlink`) and a `Connection`. M29 wraps it in the worker.
- `HeadlessClient`: M15b's client-worker shell made callable without `Atomics.wait` (`pump()`, `stepFrame(dt)`), terrain generated synchronously on miss (M08b's headless rule), a byte pump to its `Connection`; methods `dispatch(action): number`, `setView(report)`, `setCamera({ x, y, tilesAcross })` (writes its camera block, so a game's `ClientSide::frame` produces presence once M18/M19 land), `ui(): unknown` (the last `Ui` JSON, `null` before the first), `replicaHash()`, `onActionResult(cb)`, `status()`.
- `createNetHarness({ fixture, seed, clients, world?, transport?: 'memory', conditions? }): Promise<NetHarness>` (`fixture` is a fixture name or any `buildGame` output directory, so the reference game runs in it from M34) with `clock`, `server`, `storage`, `clients[]`, `link(i)`, `addClient()`, `advanceTo(t)`, `advanceTicks(n)`, `settle()` (all links empty, pumps drained, every client has applied the host's latest tick), `assertConverged()` (`replicaHash()` equals `hostRegionHash(conn)` per client), `counters(i): NetCounters` (M15b's `netCounters` per client, per tick and totals, plus `messagesDown/Up`), `trace(): Uint8Array` (every released message as `(t, link, dir, bytes)`), `dispose()`. A failure prints seed and scenario and dumps the action log (0020 §2).

**Consumes:** `createSimHost`, `SimHost`, `stepTick`, types `Connection`/`MsgClass`/`HostServices`/`WorldConfig` (M13); `SimHost.accept`, `RingConnection` as the model adapter, `replicaHash`/`hostRegionHash`/`netCounters` (M15b); `Host`, `ClientCore`, `region_hash` (M15); `dispatch` path (M16); UI-ring kind-1 record behind `ui()` (M16b; earlier in PLAN order though not in this milestone's After chain: if unticked, `ui()` returns `null` and its test waits for M34); `setCamera`'s camera block (M06b); `memoryStorage` (M22); `Persistence.open`, `fsStorage`, `SimHost.stop` (M22b); `SimHost.onFatal` (M24, if ticked: M24 is not in this milestone's After; if it is not, declare `HostServices.onFatal?` here and M24 wires the mapping); `Clock`/`Scheduler`, `ManualClock`, `systemClock` (M03); rings (M06); `loadGame`, loader (M02).

## Planning decisions
- **WebTransport adapter (PRE-PLAN §10): not built in Phase 3, no milestone.** Revisit when both hold: Node LTS or workerd ships a non-experimental WebTransport server, and the Tier-1 iOS floor includes it (0009, Alternatives rejected); or when field play shows head-of-line stalls beyond the interpolation cap of 0010. The option is kept alive here: every `send` carries its `MsgClass`, and one scenario runs a `datagrams: true` memory pair with latest-wins drops.
- **The server is the sim host plus load and stop.** No second host loop: `createWorldServer` and the sim worker construct the same module with different `HostServices` (0015 §1, Server).
- **One thread, stepped actors.** Headless clients reuse the production client shell and rings in-thread rather than a second sync-layer implementation, so netcode tests cover the shipped decode path. M15's `testkit::Loopback` stays the Rust-native counterpart for byte-level tests.
- **Test placement** follows M01: `packages/engine/tests/netcode/`.

- **From M22b's Deviations.** `Persistence.open(storage, cfg, newInstance, options?)` returns a `Sim` whose connection table is **empty**: replay applies logged `Connected` records to game state but never calls `Host::connect`, so every client must reconnect through the normal accept path after a load or recovery (session resume itself is M28/M28b). `fsStorage(dir)` is exported from `engine/server/node`.

## Order of work
1. `createWorldServer` (0024 §5 shape) over `createSimHost` + `Persistence.open`; move the `wasm` suite onto it.
2. Memory pair, `VirtualClock`, conditioner, with TS unit tests (ordering, seeded reproducibility).
3. Byte pump, `HeadlessClient`, harness; first scenario green.
4. Remaining scenarios, suite registration, `nodeHostServices` + fs round trip.

## Tests added
Netcode: `join-converges` (K=4, action mix, `assertConverged`), `late-join`, `conditioned-link` (latency, jitter, stall; the same seed gives an identical `trace()` twice), `latest-wins-datagrams`, `counters-exact` (bytes per client per tick exact for a fixed seed), `headless-ui-and-camera` (`ui()` returns the fixture's last `Ui` JSON, M16b's kind-1 record; `setCamera` moves the subscription), `harness-accepts-build-dir` (`fixture` given as a `buildGame` output directory). `wasm`: `server/load-or-create` (stop, reopen on fs storage, same hash), `server/ready-rejects-on-corrupt-world`, `server/accept-before-ready-waits`. TS unit: `virtual-clock`, `conditioner`, `memory-connection`, `byte-pump-backpressure` (full ring retries, `drops` stays 0).

## Exit criteria
- [ ] `pnpm test netcode` passes within the 0020 §3 budget; two runs of one seed produce identical traces.
- [ ] `pnpm test wasm` runs its logs through `createWorldServer` under Node and Bun with the existing golden hashes.
- [ ] No `node:` import outside `src/server-node.ts` and M22b's fs storage (grep test); Biome's restricted-globals rule (M03) passes with no new override.
- [ ] `createWorldServer`'s return type and `HostServices.onFatal?` match 0024 §5 (type-asserted in a `unit` test).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode` · `pnpm test wasm` · `pnpm test netcode -t late-join` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Test suite" (`netcode` and `wasm` rows of 0020 §3), measured by the runner. `counters-exact` seeds the bandwidth rows M31 asserts.

## Context artifacts
`packages/engine/tests/netcode/CLAUDE.md`: how to write a scenario (harness API, no real time, seed always printed, nothing mocked). `run-tests` skill gains the `netcode` suite.

## Manual device checks
none

## Deviations

**Steps 1-2 (this range).** Base `8dccaa9`. Commits `86ef8be` (step 1), `33fec51` (step 2).

- `createWorldServer(cfg: WorldConfig, host: HostServices): WorldServer` lands in `server.ts`,
  exactly the 0024 §5 shape: `WorldServer = { ready: Promise<void>; accept(c: Connection): void;
  stop(): Promise<void> }`. Built like `createSimHost` (a fresh `role=sim` instance from
  `host.wasm`, driven through `createSimHostFromInstance`) but over `Persistence.open` instead of
  `Persistence.create` -- `createSimHost` itself is untouched (still always-create; it stays a
  test-only convenience, `src/server.test.ts`/`tests/wasm/persistence.test.ts`'s own caller, not
  used by `createWorldServer`). `HostServices.onFatal?: (f: { tick: number; message: string }) =>
  void` added verbatim; wired only after a live `SimHost` exists (a load failure surfaces through
  `ready` rejecting instead, never reaching `onFatal`). `accept(c)` before `ready` settles queues
  `c` (flushed in arrival order once ready resolves; never flushed on a rejection, since 0024 §5
  defines no protocol for reporting that back). `onFatal`'s own handler closes every connection
  this world ever accepted (`c.close(0)`), then calls `host.onFatal`.
- `pnpm test wasm -t server` (`tests/wasm/server.test.ts`, new): `server/load-or-create` (fs
  storage, stop, reopen, same `sim_hash()` via a fresh `Persistence.open` read on each side),
  `server/ready-rejects-on-corrupt-world` (a manifest that parses but names a segment 0 whose log
  bytes are undecodable -- `ready` rejects `instanceof WorldLoadError` with `kind: 'corrupt'`),
  `server/accept-before-ready-waits` (a `Storage.read` that never resolves until the test releases
  it; `conn.onMessage` stays `null` until `ready` settles). All three green; failability proven for
  `ready-rejects-on-corrupt-world` by temporarily swallowing `Persistence.open`'s rejection inside
  `createWorldServer` and observing the test fail, then reverting.
- `src/server.test.ts` gained one unit test type-asserting `createWorldServer`'s signature and
  `HostServices.onFatal?` against 0024 §5 (Exit criterion 4) -- compile-time (`tsc`), not runtime.
- `src/no-node-import.test.ts` (new, `unit`): the `node:` import grep (Exit criterion 3), scanning
  every non-test `.ts` under `src/`. Allowlist: `server-node.ts`, `storage/fs.ts` (the brief's own
  two), plus `vite.ts` and `build-game.ts` -- pre-existing dev-only build tooling (0017 §5), not the
  "server core" 0017's own Alternatives-rejected line means by "adapters". Neither is new to this
  milestone; both already imported `node:` before it.
- **The wasm suite's scenarios, moved onto `createWorldServer`, narrowed to `fx-puts` only.**
  `determinism.test.ts` (`fx-hash`) and `worldgen.test.ts` (`fx-worldgen`) stay on the raw
  `instantiate` + direct `sim_tick`/`gen_chunk` path: both are low-level `export_instance!` fixtures
  with no `Host<G>` wrapper, so `sim_seal_frame` is unimplemented (`Status::Unsupported`, the M13
  trait default) and `wrapEngineInstance.simSealFrame` throws on the very first tick if driven
  through `createSimHostFromInstance`/`createWorldServer`. Only `puts.test.ts` (`fx-puts`, a real
  `Host<G>`-based game, the one fixture 0020 §3's "the built game+engine `.wasm` through the server
  entrypoint" line actually describes) moved: `wasm_idle_100_matches_native`,
  `wasm_connected_100_matches_its_own_golden`, `wasm_script_a_matches_native` now tick through
  `createWorldServer` + `memoryStorage()` with a manual clock/timer double (`manualTimer()`,
  already in the file), then read the checkpoint hash back by reopening the same storage through
  `Persistence.open` and calling `wrapEngineInstance(...).simHash()` -- `WorldServer` exposes no
  hash directly. `wasm_script_a_matches_native` delivers each scripted action's pre-encoded wire
  bytes through the accepted connection's own `onMessage` (wired by `SimHost.accept`), not a direct
  `sim_admit` call. `bun-leg.mjs`'s `runPutsLeg` (the Bun leg's idle-100 counterpart,
  `wasm_idle_100_matches_native (bun)`) moved the same way, against `dist/server.js`. No golden
  value changed (`0a7cc2623a83a03e` for script-a, unchanged; every other checkpoint verified equal
  to the checked-in golden): `sim_seal_frame`/`sim_dirty` never touch `Sim::state_hash()`
  (confirmed by reading `crates/engine/src/host/mod.rs`'s `sim_hash`/`sim_tick`), and replay
  reconstructs identical state by construction (0005). Measured: `pnpm test wasm` 154 tests (was
  151; +3 from `server.test.ts`), `pnpm test unit` 275 tests (was 252; +23).
- `WORLD_CFG`/the Bun leg's `worldCfg` reconstruct a `WorldConfig` from each scenario's checked-in
  `InstanceConfig` (`config.game.seed: "0x1"` decimal is `"1"`; every other field is already the
  scenario's own default). `buildSimInstanceConfig` adds one field the scenario JSON lacks
  (`game.buildHash`, a fixed dummy `'ab'.repeat(32)` here): harmless, since `sim_hash()` never
  reads it, only `Persistence`'s own identity bookkeeping does.
- **Gate round 1 fix: `fsStorage` durability defect, root-caused and fixed (`a471a41`).** The
  `server/load-or-create` flake (first noted below as "one observed, unreproduced flake" -- wrong;
  it reproduced 2/30 under `node scripts/repeat.mjs wasm 30`) was a real bug in `fsStorage`
  (`src/storage/fs.ts`, M22b's), not a timing edge to leave. Traced with temporary logging
  (`console.error` in `fsStorage.write`/`.flush`, `Persistence.create`, `SimHost.stop`, reverted
  before committing): `Persistence.create`'s own manifest write and `snapshotNow`'s own snapshot
  write are both fire-and-forget (0005: "the tick path never awaits storage"), but `fsStorage`'s
  `flush()` (and `read()`/`list()`) only ever awaited `LogAppender`'s own `sync()` chain (the
  append-only log path) -- the separate temp-file + `datasync` + `rename` path behind `write()`/
  `delete()` was never tracked anywhere `flush()` could reach. Measured in the trace: `SimHost.stop`
  resolved `flush()` 9 ms before the world's own manifest `rename()` had actually landed, so a
  reopen on the same directory sometimes raced it, read back `null`, and silently created a second,
  empty world (`sim_hash()` `'0000000000000000'`) instead of loading the first. Fix: `fsStorage`
  now tracks every `write()`/`delete()` promise (`pendingWrites`, awaited by `flush()`/`list()`;
  `latestWriteByKey`, awaited by `read()` for that key) alongside the existing appender sync --
  `write()`/`delete()`'s own caller still sees a real rejection; the tracked copies swallow it, the
  same way `LogAppender.sync()`'s own chain already routes a write failure to `onError` rather than
  rejecting. `node scripts/repeat.mjs wasm 30 --timeout 60`: `pass=30 fail=0 hang=0`.
- **Gate round 1 fix: a real inject-fail-revert for `server/ready-rejects-on-corrupt-world`.**
  Swallowed `Persistence.open`'s rejection inside `createWorldServer` (`.then(fn, () => {})` in
  place of `.then(fn)`) so `ready` resolved instead of rejecting on the same corrupt-world storage
  the test builds; the test failed (`Error: promise resolved "undefined" instead of rejecting`) as
  expected, then reverted.
- `src/net/memory-connection.ts`: `memoryConnectionPair(opts?: { datagrams?: boolean }):
  [Connection, Connection]` exactly as named in Seams. `send` copies (`.slice()`) and defers
  delivery to the peer via `queueMicrotask`, so it can never call the peer's `onMessage` inside its
  own call frame (proven: temporarily made delivery synchronous, both the copy-timing and the
  reentrancy test failed as expected, then reverted). `close(code)` on one end closes the pair:
  the peer's own queue is dropped and its `onClose` fires (async, one microtask) with the same
  code.
- `src/test/virtual-clock.ts`: `createVirtualClock(startMs?): VirtualClock` (`ManualClock` plus
  `advanceTo`/`advanceBy`, as named). Beyond the brief's own two named additions, `VirtualClock`
  also exposes `scheduleDelivery(entry: PendingDelivery)` and `nextLinkId(): number` -- not called
  out in the brief's Seams line for `VirtualClock`, but needed so `conditionLink` (below) can
  register pending releases on a *shared* clock and have several links' releases interleave in one
  global `(deliverAt, link, seq)` order under one `advanceTo` caller. `advanceTo(t)` throws if `t`
  is before `now()`. While releasing, the underlying `ManualClock`'s own `now()` is advanced to
  each entry's `deliverAt` *before* calling its `run()` (not deferred to the end): a conditioner's
  own `send` inside `run()` computes its next draw relative to "now", which must be the virtual
  instant the message is actually arriving at. Proven failable: dropping the `seq` term from the
  sort comparator, with entries deliberately registered out of `seq` order via `scheduleDelivery`,
  produced the wrong release order (`['first','c','a','b']` instead of `['first','a','b','c']`);
  reverted.
- `src/net/conditioner.ts`: `conditionLink(a, b, opts: { seed, latencyMs, jitterMs, stall?: { p,
  rtoMs } }, clock): ConditionedLink` with `ends: [Connection, Connection]`, `set(conditions)`,
  `stall(ms)`, `disconnect(code?)`, exactly as named. Conditioning happens on the *send* side (the
  public `ends[i].send` draws `deliverAt` and schedules the underlying `a`/`b`'s own `send` as the
  release); the underlying pair's own `onMessage` is a straight, immediate passthrough to the
  public end's callback. Two independent seeded PRNG streams per link (`seed` and `seed + 1`, one
  per direction) -- xorshift32, hand-written (no ambient randomness in `src/net/`, which is outside
  `src/test/`: `no-ambient-random.test.ts` greps literally, including comments, which cost one
  wording fix). "Order preserved" per direction: each direction's own draw is floored at its own
  previous message's `deliverAt`, proven by an 8-message burst under wide jitter arriving in send
  order with monotonic `deliverAt`. A stall draw (`stall.p`) on `latest-wins` traffic over a
  `datagrams: true` link drops the message outright instead of stalling (0020 §7: "message drops
  apply only to `latest-wins` traffic on a datagram adapter"); every other combination stalls.
  `conditionLink`'s own `run()` wraps the underlying `send` in a `Promise` resolved by a second
  `queueMicrotask` (queued strictly after the underlying pair's own delivery microtask), so
  `VirtualClock.advanceTo`'s `await` genuinely observes the message having arrived at the far end's
  `onMessage` before moving to the next release -- the "awaits physical arrival" language of 0020
  §7, applied to an in-memory pair rather than a real socket.
- Not built here (steps 3-4's own): `src/net/pump.ts` (`createBytePump`), `HeadlessClient`,
  `createNetHarness`, the `netcode` suite's `tests/netcode/` directory and its `CLAUDE.md`,
  `nodeHostServices`, the `run-tests` skill update.

**Steps 3-4.** Base `1668d24`'s own predecessor (`bfb0331`). Commits `1668d24` (byte pump) through
the step-4 commits below.

- `src/net/pump.ts`: `createBytePump({ uplink, downlink })` -> `{ attach(conn), detach(), drain() }`,
  exactly the Seams shape. `attach`'s `onMessage` handler never drops a downlink byte on a full
  ring (a JS-side FIFO retried by every `drain()` call, unlike `client-net.ts`'s own drop-and-count
  uplink policy): proven failable by shrinking a test's downlink ring to 2 slots for 5 queued
  messages and asserting `drops === 0` after repeated `drain()` calls (`pump.test.ts`). Uplink
  forwarding always tags `MsgClass.ReliableOrdered` (Deviations: no production code sends
  `LatestWins` yet -- confirmed by grep, only test files and `conditioner.ts` itself name it).
  `byte-pump-backpressure` (Tests added) is this file's own `pump.test.ts`, two cases.
- **Fix, found by this milestone's own first real multi-message round trip through a real
  `SimHost`:** `memoryConnectionPair.send`/`conditionLink`'s own `makeSend` ignored a 3rd `len`
  argument (`RingConnection.send`'s own optional parameter, Orchestrator ruling 2: "the whole
  persistent region view, real length as a separate number"), so a real `SimHost.runOneTick`
  frame -- always `frame.bytes` (the whole `Tx` region) + `frame.len` -- copied and delivered the
  *whole region*, not the real message, once driven through either. Both now accept and honour an
  optional 3rd `len` (`bytes.slice(0, len)` in place of `bytes.slice()`); proven by the
  `HeadlessClient` smoke run that found it (a live client never reaching `session_state: Live`
  because `on_frame` decoded garbage), fixed, then re-run clean.
- `src/test/headless-client.ts`: `createHeadlessClient({ wasm, game: { seed, worldgen },
  connection })` -> `HeadlessClient`. A real `Role.Client` instance plus a real `Role.Gen` instance
  (both via plain `instantiate`, no `Shell`/worker), driven by `pump()`/`stepFrame(dtMs)` in this
  thread. Reuses the shipped decode path for the one real cross-thread-shaped boundary this
  topology still has (`worker/client-net.ts`'s own `createNetPump`, unmodified, over a real
  `uplink`/`downlink` SAB ring pair from `createSabSet('net', 0)` and a `createShell`/`ControlBlock`
  built only to satisfy `createNetPump`'s wake-target parameter -- never woken by anything real).
  Skips `actionRing`/`uiRing` entirely (Deviations: those rings exist only to cross a *page's*
  main-thread/worker boundary, which does not exist here): `dispatch()` writes the `[seq][len][json]`
  record straight into `Rx` and calls `on_action` synchronously; `pump()` drains `client_poll_ui()`
  directly, decoding kind-1/kind-2 records the same way `client.ts`'s own `pollActionResults` does.
  Terrain generation on miss is synchronous and ring-free (docs/plan/08b's own "headless clients ...
  generate synchronously on miss"): `gen_take(0)` (the client's own `gen_workers` config defaults to
  1) -> read `cx`/`cy` straight off `Result` -> `gen_chunk` on the `Role.Gen` instance -> copy
  `GenOut` + a `writeGenHeader` into the client's own `GenIn` -> `gen_deliver(0, len)`, looped until
  `gen_take` says there is no more work.
  - **`setView(report)` vs `setCamera({x,y,tilesAcross})` (a genuine seam gap in the brief's own
    Seams line, resolved here, not escalated: both are named with no further shape given).**
    `setCamera` is `test/client.ts`'s own convenience, reused verbatim: only `centreX`/`centreY`/
    `tilesAcross` change, leaving `halfExtentTilesX/Y` wherever they were -- which is `0` by
    `CameraState`'s own default, and a `0` half-extent subscribes no chunks at all (0010's
    subscription target reads `half_w`/`half_h`, `client/camera.rs`'s `to_report()`). Reusing that
    convenience unchanged would make every headless scenario subscribe nothing. Fix (in scope,
    JS-only): `setCamera` here additionally derives a symmetric `halfExtentTiles{X,Y}` via the
    existing pure `camera/transform.ts` formula against a synthetic square viewport (any equal
    `widthPx`/`heightPx` pair; the ratio to `tilesAcross` is what matters), so a real subscription
    forms. `setView(report: { x, y, halfW, halfH, velX?, velY? })` is the lower-level, 1:1
    `CameraReport`-shaped primitive (`wire/uplink.rs`'s own six fields) for a test needing exact,
    asymmetric or non-derived control (`counters-exact`'s literal byte pinning). Both take effect on
    the next `stepFrame`, matching `setCamera`'s own existing doc comment.
- **Real finding, escalated, not fixed here (Rust change; "No crate" / "Non-scope: Any Rust
  change" is this milestone's own fixed boundary): `own_player`/per-connection region-hash parity
  is broken for every connection but `connId 0`.** Found empirically: a 2-3 real `HeadlessClient`
  join with `assertConverged()` (no arguments) always mismatched for every `connId != 0`, byte-
  identical mismatch pair regardless of camera position, with or without any action ever
  dispatched; `SetNote`-per-client dispatch showed each non-zero client's `ui().note` staying `0`
  (never its own dispatched value) and an unsolicited `NotPredictable` verdict for that same
  dispatch (client0 never got one for the identical action). Root cause, read directly:
  `ClientInstance::init` (`crates/engine/src/game_instance.rs`, ~line 273) hardcodes
  `Replica::new(..., PlayerId(1))` unconditionally -- "Single-connection assumption ... this
  milestone's own topology never gives one client instance more than one host link, and it is
  always `conn == 0` ... `PlayerId = conn + 1`, not `conn` ... a real multi-connection handshake is
  M28's, Non-scope here" (that comment's own "this milestone" is M15b, predating any second real
  connection ever existing to violate it). `apply_own_player(who, state)` (`client/replica.rs`)
  stores the incoming `OwnPlayer` wire record under the *real* `who` the host sent, but never
  updates `self.own_player` itself -- so `region_hash()`/`ui()`'s own `store.player(own_player)`
  read is permanently pinned to slot 1 for every client, matching only `connId 0` (whose real
  `PlayerId` is `0 + 1 = 1` by the same convention). `host::region_hash(conn)` always finds a value
  (`on_player(Joined)` puts a default unconditionally), so the mismatch is structural -- present
  with no player-scoped action ever dispatched, unfixable by scenario design. `net-harness.ts`'s
  `assertConverged(opts?: { only?: number[] })` (an additive, backward-compatible option beyond the
  brief's own no-argument signature) documents this at the call site and lets a scenario state
  exactly what the current engine supports; `join-converges`/`late-join`/`harness-accepts-build-dir`
  use `{ only: [0] }` and assert the rest directly (global-scope `ui()` equality, byte traffic, no
  crash). `packages/engine/tests/netcode/CLAUDE.md` carries the same note for whoever writes the
  next scenario. **Recommend:** either accept this as a correct, documented M27/M28 boundary, or
  spin a narrow "b" brief giving `TerrainConfig` an optional `myPlayerId`/`conn` override (default
  `1`, current behaviour unchanged) if K>1 convergence testing is needed before M28's real
  handshake lands.
- `src/test/net-harness.ts`: `createNetHarness(opts): Promise<NetHarness>`. `server` builds the
  sim host directly from the already-exported `Persistence.open` + `createSimHostFromInstance` +
  `wrapEngineInstance` (the same pieces `createWorldServer` itself composes, per that function's
  own doc comment) rather than through the opaque `createWorldServer(cfg, host)` wrapper --
  `WorldServer`'s fixed `{ ready, accept, stop }` shape has no seam for live `sim_region_hash(conn)`
  access, which `assertConverged`/`hostRegionHash` need at an arbitrary tick (0020 §8: "per-region
  state hashes at any tick" is exactly what a test entrypoint must expose) and `SimHost.accept`'s
  own `number` return (the real `connId`) that the wrapper's `void`-returning `accept` throws away.
  `createWorldServer`'s own `{ ready, accept, stop }` lifecycle is proven separately by
  `tests/wasm/server.test.ts` (steps 1-2) and not re-proven here. Ticking is `SimHost.stepTick(1)`
  per loop iteration (bypassing the pacing timer entirely -- `host.timer` is a no-op `every()` that
  never fires), interleaved with `clock.advanceBy(tickMs)` so a conditioner's own send-time draws
  see the correct virtual "now" before the next tick runs; `tickMs` is read from the real instance's
  own `tick_hz()`, not hardcoded. `fixture` accepts either an already-resolved `{ wasm, buildHash }`
  (what `tests/support/fixtures.ts`'s `loadFixture(name)` returns) or a raw directory path (through
  `engine/server/node`'s `loadGame`) -- never a bare "fixture name" resolved internally: `src/test/
  **` ships in `dist/` (0017 §2's `./test` subpath), and `packages/engine/fixtures/` is outside
  `files`, so baking in that directory would break for every external consumer. `NetCounters` is
  named `NetHarnessCounters` here (Deviations: a real name collision with `test/client.ts`'s own,
  differently-shaped `NetCounters` -- ring stats and `sim_conn_counters` fields that do not exist
  for this transport at all; "no renamed Provides" protects the *existing* one, not a same-named but
  incompatible new one) and is tracked by wrapping each conditioned link's own two ends in a tracing
  decorator (`traced()`) that records `(t, link, dir, tick, bytes)` on delivery -- one shared
  mechanism backing `counters(i)` (aggregated by tick) and `trace()` (the whole log, encoded as one
  flat `Uint8Array`: `[t u32][link u32][dir u8][len u32][bytes]*`). `transport?: 'memory'` is the
  only accepted value (throws otherwise); real `ws`/loopback is M29's, Non-scope.
- `src/server-node.ts`: `nodeHostServices({ wasm, storage, onIdle?, onFatal? }): HostServices`,
  `clock`/`timer` from `systemClock`/a `setTimeout`-chain wrapper around `systemScheduler.setTimer`/
  `clearTimer` only (never `requestFrame`/`cancelFrame`, which call `requestAnimationFrame` --
  absent under Node). Proven with a real wall-clock round trip: `tests/wasm/server.test.ts`'s
  `nodeHostServices: a real server ticks over real fs storage and reopens to the same hash` (120 ms
  real wait, two independent `createWorldServer`+`nodeHostServices` instances over the same
  directory, same `sim_hash()`).
- **Storage conformance addition (M22's own `runStorageConformance`), with a real inject-fail-
  revert.** `flush_then_reopen_sees_the_write`: `write()` *not* awaited (0005's own "the tick path
  never awaits storage" shape -- `Persistence.create`'s manifest write and `snapshotNow`'s snapshot
  write are exactly this), then `flush()` awaited, then a *fresh* `make()` instance reads the same
  key. `memoryStorage(backing?: Map)` gained an optional, additive backing-map parameter (every
  existing no-arg call unaffected) so `conformance.test.ts`'s own memory leg can share one across
  `make()` calls the same way `fsStorage(dir)`'s repeated calls already do (`durable: false`'s own
  `flush()` is already a no-op, so this leg cannot fail the check by construction -- it exists to
  prove the check itself is not vacuous). Reverting `a471a41` (`git show a471a41 -- .../fs.ts | git
  apply -R -`) and rebuilding: `storage_conformance_fs` fails 15/15 direct runs
  (`Error: flush_then_reopen_sees_the_write: expected 'durable', got null`, plus an unhandled
  `ENOENT` rename racing the same reopen); re-applying the fix (`git checkout -- .../fs.ts`) and
  rebuilding: passes 10/10. OPFS (browser conformance, `tests/browser/pages/src/storage-opfs-
  worker.ts`): runs it, but not as a true reopen -- that harness prebuilds one isolated `opfsStorage`
  instance per `make()` call specifically to avoid a real deadlock risk (an OPFS sync access handle
  is exclusive; a second live instance over the same worldId while the first's is still open is
  exactly the "second instance" this check would need). Fixed the minimum to keep it green without
  touching that constraint: the 10th prebuilt slot reuses the 9th's own instance (the same JS
  object) rather than opening an unrelated one, so the check exercises write-then-flush-then-read
  without a real reopen and without new deadlock risk; `storage_conformance_opfs`
  (`storage-opfs.spec.ts`) passes with the new name added to its expected list. A true OPFS reopen
  proof would need this prebuilding scheme restructured -- not attempted here, time-boxed out.
- `src/test.ts`: `createBytePump`/`BytePump` (`./net/pump.js`), `createHeadlessClient`/
  `HeadlessClient`/`HeadlessClientOptions`/`HeadlessClientStatus`/`ViewReport`
  (`./test/headless-client.js`), `createNetHarness`/`NetHarness`/`NetHarnessCounters`/
  `NetHarnessOptions` (`./test/net-harness.js`) added to the existing re-export list, no renamed
  Provides.
- `vitest.config.ts` gained the `netcode` project (`packages/engine/tests/netcode/**/*.test.ts`);
  `scripts/suites.mjs` gained the `netcode` suite row (10,000 ms budget, 0020 §3).
- Netcode scenarios (`tests/netcode/`): `join-converges` (K=4, a mix of `Paint`/`Spawn`/`SetMotd`/
  `Roll`, `assertConverged({ only: [0] })` plus global-scope `ui()` equality across all four),
  `late-join` (a client added mid-session after real state exists, plus an unsubscribed joiner
  seeing global scope only -- proven failable: asserting the joiner's `motd` *before* it is ever
  set fails as expected), `conditioned-link` (latency/jitter/stall; the same seed's `trace()` byte-
  identical across two independent runs; a stall scenario proving delivery is delayed, not lost --
  failable by disabling `stall` and observing the delayed-then-arrives assertion invert), `latest-
  wins-datagrams` (a `datagrams: true` memory pair, `stall.p = 1`: dropped outright for
  `MsgClass.LatestWins`, merely delayed for `ReliableOrdered` -- failable by setting `stall.p = 0`
  and observing `received` become 1 either way), `counters-exact` (K=1, literal per-tick
  `bytesDown`/`bytesUp` for seed 4001, read once from a real run and pinned as literals, never
  computed from source -- failable by dispatching one extra action and observing the literals no
  longer match), `headless-ui-and-camera` (`ui()` null before the first record, then the fixture's
  JSON; `setCamera` moving 100,000 tiles away produces strictly more `bytesDown` than staying put --
  failable by asserting `>=` in place of `>` against a camera that never actually moves), `harness-
  accepts-build-dir` (`fixture: fixtureBuildDir('puts')`, a raw path string, behaving identically to
  every other scenario's already-resolved `{ wasm, buildHash }`). `tests/netcode/support.ts`:
  `putsFixture()`, `square(i)` (spread camera positions), `DEFAULT_SEED`.
- Measured: `pnpm test netcode` 10 tests, `0.7s/10s` budget; `node scripts/repeat.mjs netcode 20`:
  `pass=20 fail=0 hang=0`. `pnpm test wasm`: 155 tests (was 154; +1, `nodeHostServices`'s own real
  round trip). `pnpm test unit`: 277 tests (was 275; +2, `pump.test.ts`). `pnpm lint`: green.
- Context artifacts written: `packages/engine/tests/netcode/CLAUDE.md` (55 lines, under the 60-line
  cap `context-artifacts.test.mjs` enforces); `run-tests` skill gained the `netcode` suite line.
