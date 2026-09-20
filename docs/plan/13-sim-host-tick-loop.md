# M13: TS sim host, sim worker and the tick loop

Status: not started · After: 06b, 08b, 12b · Tyler-dependent: no

## Goal
One TypeScript `SimHost` drives a `role=sim` instance identically in the sim worker and under Node: injected clock and timer, 20 Hz pacing, the catch-up cap, seal → log sink → tick ordering, and the 2 ms chunk warmer. `createClient({ host: { kind: 'local', world } })` (M06b's option) spawns a real sim worker; `stepTick()` from `engine/test` steps it deterministically; the fixture's hash after 100 ticks equals the native golden in Node and in the browser.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§1 sim worker and Server rows, §2 Wake-ups and the `yield` flag)
3. `docs/decisions/0009-transport-and-hosting.md` (`HostServices`, `WorldConfig`, Single-player)
4. `docs/decisions/0008-chunk-generation.md` (§2 rows "Sim host, synchronous on cache miss" and "Sim host warmer")

Mine from spikes: `spikes/zero-gc-webgpu` (the `Atomics.wait` worker loop at zero allocation), `spikes/cross-origin-sab` (control block). Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md`.

## Scope
- **ABI, sim role.** New rows in M02's `abi::registry` / `ABI_EXPORTS` with defaulted `Instance` methods, `ABI_VERSION` bumped: `sim_genesis() -> status` (creates the world from the init config; M22b adds the load path), `sim_seal_frame() -> len` (bytes into `RegionId::Persist`), `sim_warm_one() -> u32`. Existing `sim_tick`, `sim_hash` become real. `host::Host<G>` (here: `Sim<G>` + warm list; M15 adds connections) implements `abi::Instance` for `Role::Sim`; `export_game!(G)` is re-pointed to `export_instance!(GameInstance<G>)`, an enum that dispatches on `Role`: `Sim` → `Host<G>`, `Gen` → M08 `GenCore<G::Worldgen>`, `Client` → the client-role instance assembled by M06b/M08b/M09/M11, made generic over `G` here.
- **Sim-role config** (`InstanceConfig.game`, M02): M08's keys `seed` (`HexU64`; `createSimHost` converts `WorldConfig.params.seed` from decimal text once, 0024 §5) and `params`, plus `maxEntities`, `maxModifiedTiles`, `maxActionGrowth`, `cacheChunks`, `view` → `WorldParams<G>` + host config. `SimHost` converts `WorldConfig.params.seed` (decimal text, 0009) to the `HexU64` form.
- **`SimHost`** in `packages/engine/src/server.ts` (shared module, no `node:`/DOM imports): `createSimHost(cfg: WorldConfig, services: HostServices): SimHost` with `start()`, `stop()`, `pause()`, `resume()`, `stepTick(n = 1)`, `hash()`, `counters`, `logSink: ((bytes: Uint8Array) => void) | null`. Types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage` are declared exactly as 0009/0005 (types only; `storage` is unused until M22).
- **Tick procedure** (one function, the only caller of the tick exports): `len = sim_seal_frame()`; if `len > 0` call `logSink(view)`; `sim_tick()`; then the per-connection frame pass (empty until M15b).
- **Pacing.** On each timer fire: `due = floor((clock.now() − base) / tickMs) − ticksRun`; run `min(due, MAX_CATCHUP_TICKS)` (value: 0005 "Idle pause is replay-safe"); if more were due, move `base` forward so sim time falls behind wall time, and count `ticksDropped`. A tick longer than the interval counts `tickOverruns` (0010 "Tick CPU budget").
- **Sim worker kind** (`kind: 'sim'`, control-block index `WORKER_HOST`): instantiates `Role.Sim`, builds `SimHost` with an `AtomicsTimer`: an implementation of `HostServices.timer` on M06b's `runBlockingLoop(shell, body, timeoutMs)` with `timeoutMs` = time to the next deadline, so the worker blocks in `Atomics.wait` between ticks (0015 §2) and M06b's park/resume keeps working. A `CB_*` step-tick request word serves `stepTick`. `Clock` from M03. Servers pass their own `timer.every`.
- **Warmer.** Rust `host::warm`: a fixed-capacity list of view rectangles per connection slot (`set_view(conn, ChunkRect)`, fed by M15), nearest-to-centre-first iteration over uncached chunks; `sim_warm_one()` generates at most one chunk and returns 1, or 0 when nothing is cold. Iteration order from M08b's `view::nearest_first`. TS: after the tick pass, `while (clock.now() < min(nextDeadline, start + WARM_BUDGET_MS) && sim_warm_one())` (budget value: 0008 §2).
- **`createClient` local host.** M06b already defines `ClientOptions.host = { kind: 'local'; world: WorldConfig } | { kind: 'remote'; .. }` and the setup message; this milestone declares the real `WorldConfig` type (0009) it points at, types `world` as `Omit<WorldConfig<Params>, 'buildHash'>` (the engine fills `buildHash` from `wasm.buildHash`), and replaces M06b's stub sim body.
- **`engine/test`:** `stepTick(client, n)`, `worldHash(client)`, `simCounters(client)`; in the browser they travel through the control block and resolve with M06b's `untilQuiescent`. `fixtures/puts/golden/scenario.json` + `pnpm golden puts`: the `.wasm` run becomes the authority for `puts_idle_100` (M12b exit note).

## Non-scope
Connections, subscriptions, frames (M15, M15b). Actions (M16). Storage, snapshots, real log bytes (M22): `sim_seal_frame` returns 0 here. `visibilitychange` → `pause()` wiring, Web Lock, OPFS (M23). `createWorldServer` and adapters (M27). Panic recovery (M24): a trap marks the host dead and surfaces the message, nothing more.

## Files, packages and crates touched
`packages/engine/src` (`server.ts`, `worker.ts`, `abi.ts`, `test.ts`), `packages/engine/crates/engine` (`abi/registry.rs`, `host/mod.rs`, `host/warm.rs`, `game_instance.rs`), `packages/engine/fixtures/puts` (page + config only).

## Seams
**Provides:** exports above; `host::Host<G>`, `GameInstance<G>`, re-pointed `export_game!`; `createSimHost`, `SimHost`, `AtomicsTimer`, `MAX_CATCHUP_TICKS`, `WARM_BUDGET_MS`; types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage`; `host::warm::set_view`; `engine/test` `stepTick`/`worldHash`/`simCounters`; counters `ticksRun`, `ticksDropped`, `tickOverruns`, `chunksWarmed`, `genOnMiss`.
**Consumes:** M12b `Sim<G>`, `WorldParams<G>`, goldens; M06 `ControlBlock`, `SabSet`; M06b `ClientOptions.host`, setup message, `runBlockingLoop`, `shell.fatal`, `parkWorkers`/`untilQuiescent`; M03 `Clock`/`Scheduler`, fixture page; M02 `abi::registry`, `Instance`, `export_instance!`, `instantiate`, `InstanceConfig`, `runHashScenario`, `pnpm golden`; M04 zero-GC harness, `budgets.json`; M08 `GenCore`, config keys; M08b `view::nearest_first`. M06b also owes: the `sim` stub's `W_ACK`-on-every-wake store to keep (or replace) once real work fills `body()`, that a wake during `park()` is not replayed on `resume()`, `lastSeen` from `Shell.observeWake()` on any re-entry to `runBlockingLoop`, `parkWorkers` before `__pageReady` on a new zero-GC page, and that `noTimeout()` for `sim` must become a real deadline while staying allocation-free (integer milliseconds, no double-valued temporary) (`docs/plan/06b-workers-and-spawn.md`, Deviations "Notes for later briefs").

## Planning decisions
- **Write-ahead is an export boundary (0024 §1).** 0014 sketches one `sim_tick()`, but the host must hand log bytes to `Storage.append` between fixing the frame for T+1 and applying it (0004 step 3). Splitting off `sim_seal_frame()` now means M22 changes no call order: it makes the export return real bytes and points `logSink` at `storage.append`.
- **The warmer loop is in TS, one chunk per call,** because the instance has no clock (0014 §3); the ≤ 1 ms generator budget bounds the overshoot.
- **Single-player option (PRE-PLAN §10 gap):** closed by M06b (`host.kind`); nothing to decide here. Until M28 delivers seed and params in `Welcome`, the client and gen workers take them from `host.world.params`, which is only correct because no stored world exists before M22; M22b/M28 own the switch.
- **`pause()`/`resume()` exist now** so M23 only wires events; a paused host stops calling `sim_tick`, nothing is logged (0005).

## Order of work
1. `Host<G>: Instance`, `GameInstance<G>`, registry rows, config parse, native test of `host::warm`. 2. `SimHost` with a fake instance (Vitest). 3. WASM-under-Node test against the real fixture. 4. sim worker kind + `AtomicsTimer` behind M06b's `host.kind === 'local'`. 5. `engine/test` stepping in the browser. 6. zero-GC window with the sim worker ticking.

## Tests added
TS unit: `simhost_paces_at_tick_rate`, `simhost_caps_catchup_and_drops_time`, `simhost_seal_precedes_tick` (call-order spy), `simhost_pause_stops_ticks`, `simhost_warmer_respects_budget`, `simhost_counts_tick_overrun` (0010 "Tick CPU budget": the fake instance's `sim_tick` advances the fake clock past one interval once; `counters.tickOverruns === 1`, and sim time falls behind wall time by exactly the dropped amount), `simhost_seed_decimal_to_hex_u64` (0024 §5: seed `"18446744073709551615"` reaches the instance config as `"0xffffffffffffffff"` and `"0"` as `"0x0"`; non-decimal text, a sign or a value past 2^64 − 1 is a config error thrown by `createSimHost`). Rust: `warm_nearest_first`, `warm_is_invisible_to_hash`. WASM under Node/Bun: `wasm_idle_100_matches_native`. Browser: `sim_worker_steps_and_hashes` (hash after `stepTick(100)` = golden), `sim_worker_yields_for_cdp`, zero-GC test extended to the sim isolate.

## Exit criteria
- [ ] All tests above pass in Node, Bun and Chromium.
- [ ] No `Date.now`, `performance.now`, `setTimeout`, `setInterval` outside the injected `Clock`/timer in the files touched (lint rule or grep test from M03).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t simhost` · `pnpm test wasm -t idle_100` · `pnpm test browser -t sim_worker` · `pnpm lint`.

## Budgets
Allocation per isolate, sim worker row (PRE-PLAN §7): M04 harness over 600 stepped frames with ticks running. Chunk generation row (warmer budget): `simhost_warmer_respects_budget` with a fake clock; `chunksWarmed` in `budgets.json`. Tick time: counter only (`tickOverruns` = 0 in tests).

## Context artifacts
`packages/engine/src/CLAUDE.md`: "the sim host is one module for worker and server; never import `node:` or DOM here". ABI table in the crate `CLAUDE.md` gains the sim exports.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
