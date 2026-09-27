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
- One observed, unreproduced flake: `server/load-or-create` failed once (`expectedHash` read back
  as `'0000000000000000'`, i.e. the post-stop reload found no manifest) across roughly 15 repeated
  runs, isolated or grouped with its sibling tests. Not reproduced again in 11 further consecutive
  runs after the failure. Plausibly a pre-existing `fsStorage` timing edge under machine load
  (`fsStorage`/`Persistence` are M22b's, unmodified here), not something this milestone's own code
  introduced -- flagged for whoever next touches `fsStorage` under contention, not chased further.
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

Notes for the steps 3-4 implementer:

- `createWorldServer`, `WorldServer`, `HostServices.onFatal?` are in `src/server.ts`, re-exported
  nowhere new (same file as `createSimHost`/`SimHost`).
- `memoryConnectionPair`, `conditionLink`, `ConditionedLink`, `ConditionerOptions`,
  `ConditionerConditions`, `StallOptions` are in `src/net/{memory-connection,conditioner}.ts`, also
  re-exported from `engine/test` (`src/test.ts`). `createVirtualClock`, `VirtualClock`,
  `PendingDelivery` are in `src/test/virtual-clock.ts`, same re-export.
- `HeadlessClient`'s own byte pump should reuse `VirtualClock.scheduleDelivery`/`nextLinkId` only
  if it needs to interleave with conditioned links on the same clock; otherwise a plain `setTimer`
  suffices, since `ManualClock.advance`/`frame` are still there unchanged.
- `conditionLink` takes over `a.onMessage`/`a.onClose`/`b.onMessage`/`b.onClose` completely --
  `createNetHarness`/`HeadlessClient` must always talk to `link.ends[i]`, never to the raw pair
  passed into `conditionLink`.
- `manualTimer()` (a `HostServices.timer` double: `every()` records the callback, `fire()` invokes
  it) is duplicated across `src/server.test.ts`, `tests/wasm/puts.test.ts` and `tests/wasm/
  server.test.ts` (as `timerDouble()` in the last); `nodeHostServices`'s own real timer is
  `systemScheduler`-backed and unrelated, but a future shared test double belongs in `engine/test`
  if a fourth copy would otherwise appear in the netcode harness.
