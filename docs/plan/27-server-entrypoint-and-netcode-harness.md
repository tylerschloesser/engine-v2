# M27: Server entrypoint and netcode harness

Status: not started · After: 22b · Tyler-dependent: no

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
- **0024 §5 (amends 0009), implemented here, not re-decided:** `createWorldServer` returns `{ ready, accept, stop }`; `ready: Promise<void>` rejects with M22b/M24b's `WorldLoadError`, because loading is asynchronous and 0009's synchronous signature has nowhere to report it; `HostServices` gains `onFatal?`, mapped from M24's `SimHost.onFatal`; the seed is accepted as text or hex as §5 states.
- Until M28 there is no handshake: `accept` uses M15's implicit accept (`PlayerId = conn`). Scenarios here are join-only.
- `engine/server/node`: M02's `loadGame` and M22b's `fsStorage` stay; add `nodeHostServices({ wasm, storage, onIdle?, onFatal? })` supplying `clock` and `timer` from `systemClock`/`systemScheduler` (M03). The `ws` attachment is M29.
- In-memory `Connection` pair, conditioner, virtual clock, byte pump, headless client, harness (names under Seams), exported from `engine/test`.
- `netcode` suite registered in `scripts/suites.mjs` under the contract and budget of 0020 §2–3; the `wasm` suite's scenarios switched to run their logs through `createWorldServer` with `memoryStorage()` (Bun: M02's plain script, extended).

## Non-scope
Handshake, identity, reconnect (M28, M28b). Net worker, `ws`, loopback subset (M29). Token bucket, soft cap (M31), `Hashes` (M31b). Bun/Deno adapters (M35b). Misprediction-bound assertions (M34, once prediction runs multiplayer). Any Rust change: `region_hash` already exists on both sides (M15).

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

**Consumes:** `createSimHost`, `SimHost`, `stepTick`, types `Connection`/`MsgClass`/`HostServices`/`WorldConfig` (M13); `SimHost.accept`, `RingConnection` as the model adapter, `replicaHash`/`hostRegionHash`/`netCounters` (M15b); `Host`, `ClientCore`, `region_hash` (M15); `dispatch` path (M16); UI-ring kind-1 record behind `ui()` (M16b); `setCamera`'s camera block (M06b); `memoryStorage` (M22); `Persistence.open`, `fsStorage`, `SimHost.stop` (M22b); `SimHost.onFatal` (M24); `Clock`/`Scheduler`, `ManualClock`, `systemClock` (M03); rings (M06); `loadGame`, loader (M02).

## Planning decisions
- **WebTransport adapter (PRE-PLAN §10): not built in Phase 3, no milestone.** Revisit when both hold: Node LTS or workerd ships a non-experimental WebTransport server, and the Tier-1 iOS floor includes it (0009, Alternatives rejected); or when field play shows head-of-line stalls beyond the interpolation cap of 0010. The option is kept alive here: every `send` carries its `MsgClass`, and one scenario runs a `datagrams: true` memory pair with latest-wins drops.
- **The server is the sim host plus load and stop.** No second host loop: `createWorldServer` and the sim worker construct the same module with different `HostServices` (0015 §1, Server).
- **One thread, stepped actors.** Headless clients reuse the production client shell and rings in-thread rather than a second sync-layer implementation, so netcode tests cover the shipped decode path. M15's `testkit::Loopback` stays the Rust-native counterpart for byte-level tests.
- **Test placement** follows M01: `packages/engine/tests/netcode/`.

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
