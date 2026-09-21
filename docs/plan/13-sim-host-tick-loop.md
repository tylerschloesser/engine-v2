# M13: TS sim host, sim worker and the tick loop

Status: done (2026-09-21) · After: 06b, 08b, 12b · Tyler-dependent: no

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
- **`engine/test`:** `stepTick(client, n)`, `worldHash(client)`, `simCounters(client)`; in the browser they travel through the control block and resolve with M06b's `untilQuiescent`. `fixtures/puts/golden/scenario.json` + `pnpm golden puts`: the `.wasm` run becomes the authority for `puts_idle_100` (M12b exit note). `puts_idle_100` runs no actions, but `fx-puts`'s `Bump`/`Remove` reject with `NotFound` by design in any script that does — `WorldRead::entity_at` is always `Ok(None)` until M21 lands occupancy (M12b Deviations) — so that is not a regression to chase if a later scenario exercises them.

## Non-scope
Connections, subscriptions, frames (M15, M15b). Actions (M16). Storage, snapshots, real log bytes (M22): `sim_seal_frame` returns 0 here. `visibilitychange` → `pause()` wiring, Web Lock, OPFS (M23). `createWorldServer` and adapters (M27). Panic recovery (M24): a trap marks the host dead and surfaces the message, nothing more.

## Files, packages and crates touched
`packages/engine/src` (`server.ts`, `worker.ts`, `abi.ts`, `test.ts`), `packages/engine/crates/engine` (`abi/registry.rs`, `host/mod.rs`, `host/warm.rs`, `game_instance.rs`), `packages/engine/fixtures/puts` (page + config only).

## Seams
**Provides:** exports above; `host::Host<G>`, `GameInstance<G>`, re-pointed `export_game!`; `createSimHost`, `SimHost`, `AtomicsTimer`, `MAX_CATCHUP_TICKS`, `WARM_BUDGET_MS`; types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage`; `host::warm::set_view`; `engine/test` `stepTick`/`worldHash`/`simCounters`; counters `ticksRun`, `ticksDropped`, `tickOverruns`, `chunksWarmed`, `genOnMiss`.
**Consumes:** M12b `Sim<G>`, `WorldParams<G>`, goldens; M06 `ControlBlock`, `SabSet`; M06b `ClientOptions.host`, setup message, `runBlockingLoop`, `shell.fatal`, `parkWorkers`/`untilQuiescent`; M03 `Clock`/`Scheduler`, fixture page; M02 `abi::registry`, `Instance`, `export_instance!`, `instantiate`, `InstanceConfig`, `runHashScenario`, `pnpm golden`; M04 zero-GC harness, `budgets.json`; M08 `GenCore`, config keys; M08b `view::nearest_first`. M06b also owes: the `sim` stub's `W_ACK`-on-every-wake store to keep (or replace) once real work fills `body()`, that a wake during `park()` is not replayed on `resume()`, `lastSeen` from `Shell.observeWake()` on any re-entry to `runBlockingLoop`, `parkWorkers` before `__pageReady` on a new zero-GC page, and that `noTimeout()` for `sim` must become a real deadline while staying allocation-free (integer milliseconds, no double-valued temporary) (`docs/plan/06b-workers-and-spawn.md`, Deviations "Notes for later briefs"). M08b's Deviations "Notes for later briefs" (`docs/plan/08b-gen-workers-and-queue.md`) also apply: wiring `callParked`'s `testCall` handler into the `sim` kind is a one-line addition, and `runBlockingLoop`'s drain-on-entry (built for `gen`, shared by every kind including `sim`). Superseding that Deviations entry's own "browser suite's 19 s/25 s trip-wire" line: M09's gate (Deviations "Gate round 3", ADR 0026) restructured the `browser` suite rather than merely tripping the wire — `pnpm test browser` (fast tier) now runs only the `chromium`/`gc` projects, quiet-machine at 14 s of 25 s with 60 tests; three-browser determinism (`@engines` on WebKit/Firefox) and every production page's `burst` negative control but `gc-loop`'s moved to `pnpm test:slow` (the `engines` leg, port 4518). Whatever zero-GC page or isolate this milestone adds gets its `burst` negatives demoted to `@slow` automatically (`zeroGcSuite`'s own mechanism, not something to configure here) and its clean test must show the sim isolate in `presentIsolates`.

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
- [x] All tests above pass in Node, Bun and Chromium.
- [x] No `Date.now`, `performance.now`, `setTimeout`, `setInterval` outside the injected `Clock`/timer in the files touched (lint rule or grep test from M03).
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t simhost` · `pnpm test wasm -t idle_100` · `pnpm test browser -t sim_worker` · `pnpm lint`.

## Budgets
Allocation per isolate, sim worker row (PRE-PLAN §7): M04 harness over 600 stepped frames with ticks running. Chunk generation row (warmer budget): `simhost_warmer_respects_budget` with a fake clock; `chunksWarmed` in `budgets.json`. Tick time: counter only (`tickOverruns` = 0 in tests).

## Context artifacts
`packages/engine/src/CLAUDE.md`: "the sim host is one module for worker and server; never import `node:` or DOM here". ABI table in the crate `CLAUDE.md` gains the sim exports.

## Manual device checks
none

## Deviations

Built: steps 1-3 (this brief's own cut line, unchanged below) **plus steps 4-6**, built by the next
implementer starting from what was recorded here; that range's own record is the new section below,
"Steps 4-6: sim worker kind, browser stepping, the zero-GC window". All six steps of this milestone
are now done.

### Rust: `host::Host<G>`, `host::warm::Warm`, `game_instance::GameInstance<G>`

`crates/engine/src/host/mod.rs`, `crates/engine/src/host/warm.rs`, `crates/engine/src/game_instance.rs`.

- `Instance` (`abi/registry.rs`) gained three defaulted methods, in this order after `sim_hash`:
  `fn sim_genesis(&mut self) -> Status` (default `Status::Unsupported`), `fn sim_seal_frame(&mut
  self, _persist: &mut [u8]) -> Result<u32, Status>` (default `Err(Status::Unsupported)`), `fn
  sim_warm_one(&mut self) -> u32` (default `0`, the "always answer, cost nothing" shape of
  `gen_take`/`upload_stage` -- no `Status` crosses). Externs (`export_instance!`, right after
  `sim_hash`): `sim_genesis() -> u32`, `sim_seal_frame() -> i32` (len, or `-(status)`, exactly
  `sim_build_frame`'s shape), `sim_warm_one() -> u32`. `abi::mod` gained the matching generic
  `sim_genesis`/`sim_seal_frame`/`sim_warm_one` functions, same role-check pattern as
  `sim_tick`/`sim_build_frame`. **`ABI_VERSION` 6 -> 7**, in both `registry.rs` and `src/abi.ts`
  (`ABI_EXPORTS` gained the three rows, `role: 'sim'`).
- `RegionId::Persist` is **not declared** by `Host::init` this milestone: `sim_seal_frame` always
  returns 0 (Non-scope: real log bytes are M22), so `abi::mod::sim_seal_frame`'s
  `rt.layout.bytes_mut(RegionId::Persist)` reads an empty slice (`RegionLayout::bytes_mut` on an
  undeclared region, by design) rather than a sized buffer. M22 is the one that calls
  `layout.region(RegionId::Persist, ..)` and gives this real content.
- `pub struct Host<G: Game>`: `{ pending: Option<sim::WorldParams<G>>, cache_chunks: u32, sim:
  Option<Sim<G>>, outcomes: Vec<sim::Outcome<G>>, warm: warm::Warm }`. `impl<G: Game> Instance for
  Host<G> where G::Global: Default` (the same bound `Sim::genesis` itself already carries, M12b).
  `init(role, game_cfg_json, _layout)` errors `Status::BadConfig` for any role but `Sim`, parses a
  private `SimConfig<P>` (camelCase JSON: `seed: HexU64`, `params: P`, `maxEntities` (default
  262_144), `maxModifiedTiles` (default 1_048_576), `maxActionGrowth` (default 4_096),
  `cacheChunks` (default 1024)) and stores it as `pending`, **without** building a `Sim<G>` yet.
  `sim_genesis()` (`Status::AlreadyInitialised` on a second call) takes `pending` and calls
  `Sim::genesis`. `sim_tick()` is `Status::NotInitialised` before genesis, else `sim.step(&[],
  &mut self.outcomes)` (`outcomes` reused, not reallocated). `sim_hash()` is `0` before genesis,
  else `sim.state_hash()`. `sim_seal_frame` is `Err(NotInitialised)` before genesis, else always
  `Ok(0)`. `sim_warm_one()` is `0` before genesis, else `self.warm.warm_one(sim.authority()
  .store().terrain()).is_some() as u32`. Inherent `pub fn sim(&self) -> Option<&Sim<G>>` and `pub
  fn cache_chunks(&self) -> u32` (both used by nothing yet; see "cacheChunks is parsed but inert"
  below).
- `host::warm::Warm`: `pub const MAX_VIEWS: usize = 8`; `pub fn new() -> Self`; `pub fn
  set_view(&mut self, conn: u32, rect: ChunkRect)` and `pub fn clear_view(&mut self, conn: u32)`
  (out-of-range `conn` is `debug_assert!`-and-ignore, `WorldWrite::set_tile`'s own convention); pub
  fn warm_one(&mut self, terrain: &TerrainStore) -> Option<ChunkCoord>` (**not** `-> u32`, and
  takes **no** `ChunkDims` -- `nearest_first`/`is_cached`/`materialize` need none; `Host::sim_
  warm_one` converts `.is_some()` to `u32` at the ABI boundary). Internals: `views: [Option<
  ChunkRect>; 8]`, `scratch: [ChunkCoord; 512]` (0008 §5's 169-chunk worst case, doubled), both
  reserved at `new()`, no allocation after. `warm_one` iterates connection slots in order; for each
  set view, computes its centre as `TilePos::new((min.x+max.x)/2, (min.y+max.y)/2)` (chunk-
  coordinate space reinterpreted as `TilePos`, `nearest_first`'s own documented convention), calls
  `nearest_first(view, centre, &mut scratch)`, and returns the first `!terrain.is_cached(chunk)`
  found, after calling `terrain.materialize(chunk)`. Seams' literal `host::warm::set_view` is
  `Warm::set_view` (a method, not a free function -- there is no free-standing `warm::set_view`).
- `game_instance::GameInstance<G>`: `enum { Sim(Box<Host<G>>), Gen(GenCore<G::Worldgen>),
  Client(ClientInstance<G>) }` (`Sim`'s payload boxed: clippy `large_enum_variant`, `Warm`'s 4 KiB
  scratch array dwarfs the other two variants). `impl<G: Game> Instance for GameInstance<G> where
  G::Global: Default`; every method matches on the active variant, `_ => Status::WrongRole` (sim
  exports) / `Status::Unsupported` (gen/client exports) / `0` (`u32`-returning exports) on the
  wrong variant -- unreachable in practice since the variant is fixed at `init` by `role`, kept
  only for exhaustiveness. `init` dispatches: `Role::Sim` -> `Host::<G>::init(..)`; `Role::Gen` ->
  parses a `TerrainConfig<P>` (`seed`, `params`, `genWorkers` default 1, `cacheChunks` default
  1024 -- the last unused by `Gen`) and builds `GenCore::new(dims, seed, params)` with `dims =
  ChunkDims::new(G::CHUNK_BITS)`; `Role::Client` -> `ClientInstance::<G>::init(..)`.
  `pub struct ClientInstance<G: Game> { terrain: Box<TerrainStore>, feed: TerrainFeed, uploader:
  Box<Uploader<G::Client, G>>, input_queue: Box<InputQueue> }` -- the generic form of
  `fixtures/terrain`'s own hand-written `FixtureRole::Client` arm (same fields, same `frame`/
  `gen_take`/`gen_deliver`/`client_gen_stats`/`client_chunk_hash`/`upload_stage`/`on_input`
  bodies), built once here rather than once per fixture. **Inherits `Uploader::new`'s existing
  `CHUNK_BITS == 5` assertion** (0024 §9's open item): a `Game` with a non-default `CHUNK_BITS`
  panics building its client role, same as it always has for `fixtures/terrain`.
  `fixtures/terrain` and `fixtures/worldgen` are **untouched** -- they keep their own
  `Instance`/`export_instance!` and never route through `GameInstance<G>`; only `fixtures/puts`
  (`export_game!(Puts)` in place of `export_instance!(Puts)`) does.
- **`cacheChunks` is parsed but inert.** `SimConfig::cache_chunks`/`TerrainConfig::cache_chunks`
  reach `Host`/`ClientInstance`, but `Sim::genesis` (M12b's fixed signature) takes no cache-size
  parameter -- it always builds `TerrainStore` at its own private `DEFAULT_CACHE_CHUNKS = 1024`.
  Wiring the sim role's own cache size needs `Sim::genesis`'s signature widened, a change to
  another milestone's Provides this brief does not make; `Host::cache_chunks()` exists so whoever
  does that wiring does not also have to re-plumb the config parse.
- **`counters.genOnMiss` (TS) has nothing to read.** No export surfaces "a tick's own read
  generated a chunk on miss" (0008 §2's second table row); it is declared (per this brief's own
  instruction to spell every counter field) and stays `0`.

### `host::warm` test host and results

Native (`host/warm.rs`'s own `#[cfg(test)] mod tests`, no `Game`/`Sim` needed -- `Warm` only
touches `TerrainStore`): `warm_nearest_first` (5x5 rect, asserts nearest-first order and that a
fully-warmed rect returns `None`), `warm_is_invisible_to_hash` (an `Fnv64` over
`TerrainStore::write_canonical` before/after warming a 3x3 rect: identical), plus
`warm_one_with_no_view_is_a_noop` (not named in Tests added; added because it is the one-line base
case the other two both assume). `pnpm test rust`: 188 -> 191 (+3).

### TypeScript: `SimHost` (`packages/engine/src/server.ts`)

**Full public surface, exactly as built** (types not already in the brief's Seams list, verbatim):

```ts
export const MsgClass = { ReliableOrdered: 0, LatestWins: 1 } as const
export type MsgClass = (typeof MsgClass)[keyof typeof MsgClass]

export interface Connection {
  send(cls: MsgClass, bytes: Uint8Array): void
  close(code: number): void
  onMessage: ((bytes: Uint8Array) => void) | null
  onClose: ((code: number) => void) | null
  readonly datagrams: boolean
  readonly bufferedAmount?: number
}

export interface Storage {
  append(key: string, bytes: Uint8Array): void | Promise<void>
  sync(key: string): void | Promise<void>
  write(key: string, bytes: Uint8Array): void | Promise<void>
  delete(key: string): void | Promise<void>
  onError: ((err: unknown) => void) | null
  flush(): Promise<void>
  read(key: string): Promise<Uint8Array | null>
  list(prefix: string): Promise<string[]>
}

export interface HostServices {
  wasm: WebAssembly.Module
  storage: Storage
  clock: { now(): number }
  timer: { every(ms: number, fn: () => void): () => void }
  onIdle?: () => void
}

export interface WorldConfig<Params = unknown> {
  worldId: string
  buildHash: string
  params: {
    seed: string           // decimal text; createSimHost converts to HexU64 once (0024 §5)
    worldgen: Params
    maxEntities?: number
    maxModifiedTiles?: number
    maxActionGrowth?: number
  }
  joinKey?: string
  maxPlayers?: number
  keepTickingWhenEmpty?: boolean
  view?: { maxTilesPerAxis?: number; maxChunks?: number }
  cacheChunks?: number
  arenaBytes?: number
  actionRate?: { perSecond?: number; burst?: number }
  bandwidth?: {
    softCapBytesPerS?: number
    chunkRefillBytesPerS?: number
    chunkBurstBytes?: number
    hardCapBytesPerS?: number
  }
}

export interface SimHostCounters {
  ticksRun: number
  ticksDropped: number
  tickOverruns: number
  chunksWarmed: number
  genOnMiss: number        // always 0 this milestone: see Rust section above
}

export interface SimHost {
  start(): void
  stop(): void
  pause(): void
  resume(): void
  stepTick(n?: number): void
  hash(): string            // 16-digit lowercase hex (EngineInstance.readU64Hex's own format)
  readonly counters: SimHostCounters
  logSink: ((bytes: Uint8Array) => void) | null
}

export function createSimHost(cfg: WorldConfig, services: HostServices): SimHost
```

**`HostServices.timer`'s exact shape and how a blocking implementation gets the next deadline
(the seam step 4 depends on).** `timer: { every(ms: number, fn: () => void): () => void }`,
**unchanged from 0009, verbatim** -- no field was added or renamed. `SimHost.start()`/`resume()`
call `services.timer.every(TICK_MS, onFire)` **exactly once each time they arm** (`TICK_MS` fixed
at 50, see "20 Hz is hardcoded" below) and keep the returned stop function; `SimHost` never calls
`every` again while armed, and never varies `ms` between calls. All of `SimHost`'s own pacing state
(`base`, `counters.ticksRun`) lives inside the closure `createSimHostFromInstance` returns and is
**not needed by the timer**: `onFire`'s own `due` calculation is self-correcting from wall time
(`Math.floor((now - base) / TICK_MS) - counters.ticksRun`) regardless of exactly when `onFire`
actually ran, which is the whole point of catch-up pacing. Consequently, a step-4 `AtomicsTimer`
implementing `{ every(ms, fn): stop }` on top of `runBlockingLoop(shell, body, timeoutMs)` (whose
`timeoutMs: () => number` `worker/shell.ts` already calls before every wait -- see
`noTimeout()`'s own doc comment, unchanged by this range) needs **nothing from `SimHost`**: it can
track its own `nextFireAt = lastFireAt + ms` (set once at the `every()` call, advanced by `ms`
after every `fn()` call it makes) and return `Math.max(0, nextFireAt - clock.now())` from its own
`timeoutMs` closure -- ordinary deadline-scheduling over the one fixed `ms` `SimHost` already
hands it, decoupled from `SimHost`'s internal `base`/`ticksRun` bookkeeping. **This was designed
deliberately, not left implicit**: `worker/sim.ts`'s current stub (`src/worker/sim.ts`) still
imports `noTimeout` from `worker/shell.ts` unchanged -- step 4 is the one that replaces it, per
M06b's own "Notes for later briefs" ("M13 replaces `noTimeout()` for `sim` with a real deadline
... allocation-free: integer milliseconds, no double-valued temporary"), and the
`AtomicsTimer`-internal `nextFireAt`/`timeoutMs` above satisfies that constraint (integer ms
throughout, no temporary needed beyond what `Math.max`/subtraction already produce).

**`SimInstance`: the seam between `SimHost` and any instance, real or fake (not in the brief's own
Seams list, but load-bearing for "a fake instance under Vitest").**

```ts
export interface SimInstance {
  simGenesis(): number                                     // Status
  simTick(): number                                        // Status
  simSealFrame(): { len: number; bytes?: Uint8Array }       // len 0 => nothing; bytes present iff len > 0
  simHash(): string                                         // 16-digit lowercase hex
  simWarmOne(): number                                      // 1 generated, 0 nothing cold
}
export function wrapEngineInstance(inst: EngineInstance): SimInstance
export function createSimHostFromInstance(sim: SimInstance, services: Pick<HostServices, 'clock' | 'timer'>): SimHost
export function buildSimInstanceConfig(cfg: WorldConfig): InstanceConfig   // pure; seed conversion happens here
export function seedToHexU64(seed: string): string
export const MAX_CATCHUP_TICKS = 5   // 0005 "Idle pause is replay-safe": "at most 5 catch-up ticks per wakeup"
export const WARM_BUDGET_MS = 2      // 0008 §2 "Sim host warmer"
```

`createSimHost(cfg, services)` is `createSimHostFromInstance(wrapEngineInstance(instantiate(
services.wasm, Role.Sim, buildSimInstanceConfig(cfg))), services)` -- a thin composition. A "fake
instance under Vitest" (Tests added) is a hand-written object satisfying `SimInstance`, not a
faked `EngineInstance`: this is why `wrapEngineInstance` exists as a separate, named function
rather than being inlined into `createSimHost`, and it is the one piece the WASM-under-Node test
(step 3) exercises that the fake-instance tests (step 2) do not.

**20 Hz is hardcoded, not read from the module.** `TICK_HZ = 20` / `TICK_MS = 50` are private
constants in `server.ts`. 0009 fixes tick rate as "a compile-time constant of the game crate ...
not config", so `WorldConfig` cannot carry it, and this brief's own Scope names exactly three new
exports (`sim_genesis`/`sim_seal_frame`/`sim_warm_one`), none of which reads `Game::TICK_RATE`.
`fx-puts`'s `Puts` does not override `TICK_RATE` (uses the trait default, `TickRate::HZ_20`), so
nothing exercises a mismatch today. **A future game with a non-default `TICK_RATE` will silently
mispace** until an export for it exists (the natural shape: a defaulted `Instance` method
`tick_hz(&mut self) -> u32 { 20 }`, `Host<G>`/`GameInstance<G>` overriding it with
`G::TICK_RATE.hz_value()`, following exactly the `sim_hash`/`gen_take` "one more registry row"
pattern) -- flagged here as a real, load-bearing gap rather than silently assumed.

**Tick procedure, exactly as Scope specifies, one function (`runOneTick`, private):** `seal =
sim.simSealFrame()`; `if (seal.len > 0 && host.logSink) host.logSink(seal.bytes)`; `sim.simTick()`
(throws on a non-`Ok` status); "the per-connection frame pass" is a no-op this milestone (M15b,
Non-scope) -- there is no code for it yet, not an empty loop. `simhost_seal_precedes_tick` is a
fake `SimInstance` whose `simSealFrame`/`simTick` each push a tag onto a shared array and whose
`logSink` is a `vi.fn` also pushing a tag; the test asserts the array equals `['seal', 'log:4',
'tick']` -- a genuine call-order proof, not an inferred one. A companion test (not separately named
in Tests added) proves `logSink` is *not* called when `len === 0`.

**Pacing, exactly as Scope's formula**, with one correction made during implementation: the
warmer's `nextDeadline` is the deadline of the tick **not yet run** (`base + (counters.ticksRun +
1) * TICK_MS`), not `base + counters.ticksRun * TICK_MS` (the tick that was *just* run) -- the
latter is always `<=` the current wall time immediately after that tick runs, which would leave
zero warmer budget on every fire. Caught by `simhost_warmer_respects_budget` failing with 0
chunks warmed before the fix.

**`pause()`/`resume()`**: `pause()` disarms the timer and records `pausedAt`; `resume()` (and
`start()`, symmetrically) add `now() - pausedAt` onto `base` before re-arming, so the paused wall-
clock interval is invisible to the `due` calculation on resume -- "idle pause is replay-safe"
(0005) with no catch-up burst for time spent paused. `stop()` disarms and clears `pausedAt` without
touching `base`/counters. `start()` is idempotent (a second call while running is a no-op) and
only calls `sim.simGenesis()` once ever, via a `genesisDone` flag (`Status.AlreadyInitialised` is
tolerated, not thrown, so a defensive second call never crashes). `stepTick(n)` calls
`ensureGenesis()` too (so `engine/test`'s future `stepTick`, or this milestone's own WASM-under-
Node test, can drive a host that never called `start()` at all) and runs `n` ticks through the
**same** `runOneTickTimed()` `onFire` uses (including overrun counting), entirely bypassing the
pacing timer and `due`/catch-up math.

### `tests/support/scenario.ts` (shared with `fixtures/hash`/`fixtures/worldgen`)

`SimScenario.input` is now **optional** (`input?: {...}`, was required) and `SimScenario.genesis?:
boolean` was added. `runSimScenario`: `if (genesis) ok(inst.call0(inst.x.sim_genesis), ..)` before
the tick loop; the `Rx`-region presence check and the per-tick `sim_admit` injection both run only
`if (input)`. `fixtures/hash/golden/scenario.json` (still supplies `input`, no `genesis` key) is
unaffected byte-for-byte; `fixtures/puts/golden/scenario.json` sets `genesis: true` and omits
`input` entirely (`Host<Puts>` declares no `Rx` region -- Non-scope: connections/actions are
M15/M16).

### `fixtures/puts/golden/scenario.json` (new) and the golden switch

```json
{
  "role": "sim",
  "genesis": true,
  "config": {
    "arenaBytes": 100663296,
    "game": {
      "seed": "0x1",
      "params": null,
      "maxEntities": 262144,
      "maxModifiedTiles": 1048576,
      "maxActionGrowth": 4096,
      "cacheChunks": 1024
    }
  },
  "ticks": 100,
  "checkpointEvery": 100
}
```

`params: null` (not `{}`): `FlatWorldgen::Params = ()`, and serde's unit type deserializes from
JSON `null`. `arenaBytes = 100663296` = 96 MiB (0015 §5's sim-role default). Seed `0x1` and the
budget defaults match `puts_scenarios.rs`'s existing `new_sim(1)` exactly, so the native and
`.wasm` runs are directly comparable. Blessed with `pnpm golden puts`: `golden/golden.json`'s one
checkpoint is `195e71ef0defbf7a` -- **byte-identical** to the native-blessed hash M12b already
recorded (`fixtures/puts/tests/golden/puts_idle_100.hash`, same value, now deleted as dead weight
now that `puts_idle_100_golden` reads `golden/golden.json` instead).

`fixtures/puts/tests/puts_scenarios.rs`'s `puts_idle_100_golden` now ends with
`engine::testing::assert_golden(env!("CARGO_MANIFEST_DIR"), &[sim.state_hash()])` in place of
`engine::assert_golden_hash!("puts_idle_100", sim.state_hash())` -- same native driving code
(`new_sim(1)` + 100 `sim.step(&[], ..)` calls) via `Sim<Puts>` directly, just compared against the
`.wasm`-authoritative file instead of a native-only one. `puts_script_a_golden` is untouched
(still `assert_golden_hash!`; M16's own exit note owns that switch).

`tests/wasm/puts.test.ts` (new): `wasm_idle_100_matches_native` -- Node, `instantiate` +
`runHashScenario` over the same `scenario.json`, compared against the same `golden.json`, plus
`memGrows() === 0`. `tests/wasm/bun-leg.mjs` gained `runPutsLeg()` (mirrors `runWorldgenLeg`),
reported as `'wasm_idle_100_matches_native (bun)'`, added to the `tests` array alongside the
existing `hash`/`worldgen`/growth legs -- there is no third Rust-native "scenario runner" test for
`puts` (unlike `fixtures/hash`/`fixtures/worldgen`'s own `tests/scenario.rs`): `puts_idle_100_golden`
already *is* the native leg (M12b's own exit note), so a second one would be redundant, and the
brief's Tests added does not name one.

### Context artifacts

- `packages/engine/src/CLAUDE.md` (new file -- none existed before): "the sim host is one module
  for the sim worker and a server ... never import `node:` or DOM here", plus a one-line pointer
  to who else drives `createSimHost` (`worker/sim.ts` step 4; a future `createWorldServer`, M27).
- `packages/engine/crates/engine/CLAUDE.md`: the `src/abi/` bullet gained the three sim export
  names and shapes; a new bullet documents `src/host/` and `src/game_instance.rs` (module map,
  what `GameInstance<G>` dispatches to, that `fixtures/terrain`/`fixtures/worldgen` are untouched).

### Measured

`pnpm test` at acceptance: `rust 191` (+3: `host::warm`'s three tests), `unit 153` (+8:
`server.test.ts`), `wasm 40` (+2: `wasm_idle_100_matches_native` Node + Bun), `browser 90`
(unchanged -- nothing in steps 1-3 touches a browser page). `pnpm lint` green (biome, rustfmt,
clippy, tsc). `pnpm test unit -t simhost`: 8 tests pass. `pnpm test wasm -t idle_100`: 1 test pass
(the Node leg; the `-t` filter does not reach into the Bun leg's own internal test list, a
pre-existing property of the `script` suite adapter, not something this range changed).
`pnpm test browser -t sim_worker`: **0 tests matched** -- expected and not a failure: the
`sim_worker_steps_and_hashes`/`sim_worker_yields_for_cdp` browser tests are step 5's own, not
built here. `pgrep`/`lsof -ti tcp:4517` clean after every run in this session; no background
process left running.

### Notes for later briefs (steps 4-6)

- **`AtomicsTimer` needs nothing from `SimHost`** beyond the fixed `ms` `SimHost.start()`/
  `resume()` pass to `services.timer.every(ms, fn)` once: see "`HostServices.timer`'s exact shape"
  above for the deadline-scheduling recipe (`nextFireAt = lastFireAt + ms`, fed into
  `runBlockingLoop`'s own `timeoutMs: () => number`). Do not add a "next deadline" getter to
  `SimHost` -- it was deliberately not needed.
- **20 Hz is hardcoded in `server.ts`** (`TICK_HZ`/`TICK_MS`, private constants). If step 4's sim
  worker or any later milestone needs a non-default `Game::TICK_RATE` to pace correctly, that gap
  is real and unaddressed; see "20 Hz is hardcoded" above for the shape a fix would take (a
  defaulted `Instance::tick_hz` export, `ABI_VERSION` bump).
- **`cacheChunks` (TS `WorldConfig.cacheChunks` / Rust `Host::cache_chunks()`) is parsed on both
  sides but wired nowhere**: `Sim::genesis` always uses its own private 1024-chunk default. Wiring
  it needs `Sim::genesis`'s signature widened (M12b's Provides), which this brief did not do.
- **`counters.genOnMiss` always reads 0** (TS): no export exists for it; see the Rust section
  above.
- `worker/sim.ts` (`src/worker/sim.ts`) is **unchanged** by this range: it still returns `{ body,
  timeoutMs: noTimeout }` from M06b. Step 4 replaces `body`/`timeoutMs` with ones built on
  `AtomicsTimer` + `createSimHost`, and wires `CB_TEST_CONTROL`'s step-tick request word (M06b
  Deviations: global control word 4).
- `SimHost.stepTick(n)` and `SimHost.hash()` are the two methods `engine/test`'s future
  `stepTick(client, n)`/`worldHash(client)` (step 5) most directly need to reach through the
  worker's parked test-call channel (`worker/test-call.ts`'s `handleTestCall`, already wired for
  `client`/`gen` per M08b -- adding `sim` is "one line", per that brief's own Deviations note)."
- `Host<G>`'s `pending`/`sim` split (genesis deferred out of `init`) means a step-4/M22b load path
  can add a `sim_load(len)`-shaped export later that takes the same `pending.take()` branch
  `sim_genesis` does now, without changing `init`'s own shape.

### Steps 4-6: sim worker kind, browser stepping, the zero-GC window

Commits `M13 step 4`, `M13 step 5`, `M13 step 6` on `main`, starting from `fe632fc`. All exit
criteria below are **met** unless noted.

#### Orchestrator-mandated: `tick_hz` closes "20 Hz is hardcoded"

Built exactly as specified in the delegation prompt, not redesigned: `Instance::tick_hz(&mut self)
-> u32 { 20 }` (defaulted, `abi/registry.rs`, right after `sim_warm_one`), extern `tick_hz() ->
u32` in `export_instance!`, generic `abi::tick_hz<T: Instance>(slot)` (same "always answer, cost
nothing on a wrong role" shape as `sim_warm_one`: the trait default on anything but `Role::Sim`, not
an error). `Host<G>` and `GameInstance<G>` both override it as `G::TICK_RATE.hz_value()`
(`GameInstance<G>`'s own override does not match on its active variant: the answer is the same
`G`-level constant regardless, and `abi::tick_hz` only ever calls it while `role == Role::Sim`
anyway). **`ABI_VERSION` 7 -> 8** in both `registry.rs` and `abi.ts`; `abi.ts` gained the `tick_hz`
row (`role: 'sim'`).

`SimInstance` gained `tickHz(): number`; `wrapEngineInstance` implements it as `inst.call0(inst.x.
tick_hz)`. `createSimHostFromInstance` reads it once, at construction (before the pacing timer ever
arms, and before `sim_genesis` -- `Host<G>::tick_hz` doesn't touch `self.sim`, so this is safe pre-
genesis): `const tickMs = Math.round(1000 / (sim.tickHz() || DEFAULT_TICK_HZ))`, and every pacing
computation (`onFire`'s `due`, `warm`'s deadline, `runOneTickTimed`'s overrun check, `arm`'s
`services.timer.every` call) now reads this local `tickMs` instead of a module constant. `TICK_HZ`/
`TICK_MS` (module constants) are gone; `DEFAULT_TICK_HZ = 20` survives only as the `|| ...` fallback
for a `tickHz()` of `0` (division by zero -- never returned by a real export, only reachable by a
pathological fake). New test `simhost_paces_at_configured_tick_rate` (`server.test.ts`): a fake
instance reporting `tickHz: () => 40` (25 ms/tick) actually paces at 25 ms, proven by asserting
`ticksRun` stays 0 after `HZ_MS / 2` (would be wrong for 20 Hz too, so this alone doesn't
distinguish) then becomes 1 after the other half (25 ms total -- well under 20 Hz's own 50 ms
interval, so only a host actually paced at 40 Hz ticks here). `fakeSim()`'s default and the one
hand-built `SimInstance` in `server.test.ts` both gained `tickHz: () => 20`.

#### `worker/sim.ts`, `worker/atomics-timer.ts`: the real sim worker kind

`createAtomicsTimer(clock)` (new file) implements `HostServices['timer']` (`{ every(ms, fn): stop
}`, unchanged shape) plus `timeoutMs(): number` (for `runBlockingLoop`) and `poll(): void` (called
on every `body()` pass, whatever woke it): `every()` records `ms`/`fn` and sets `nextFireAt =
clock.now() + ms`; `poll()` runs `while (clock.now() >= nextFireAt) { fn(); nextFireAt += ms }`
(0, one or more calls, self-correcting the same way `SimHost.onFire` already is); `timeoutMs()`
returns `Math.max(0, nextFireAt - clock.now())` while armed, `Infinity` otherwise. Exactly the
recipe the steps-1-3 Deviations laid out ("nothing from `SimHost`", integer `ms` throughout).

`worker/sim.ts`: builds `createSimHostFromInstance(wrapEngineInstance(inst), { clock: systemClock,
timer: atomicsTimer.timer })` (`systemClock` from `clock.ts`, not a bare `performance.now()` --
`packages/engine/CLAUDE.md`'s `noRestrictedGlobals` rule). **`simHost.start()` (real-time pacing)
is armed only when `!message.test`** -- an orchestrator decision made here, not asked for by the
brief, recorded because it is load-bearing: a test/dev topology (`message.test` present, which
every browser page in this suite sets) never arms the wall-clock pacing timer at all; it drives
every tick itself, deterministically, through a new global control word. Reasoning: if pacing were
armed unconditionally, a deterministic `stepTick(client, n)` call racing a real 50 ms wall-clock
boundary on a slow CI machine could let `onFire`'s own catch-up loop run an *extra*, uncounted tick
during the same test, corrupting a hash comparison that must match a golden bit-for-bit -- exactly
the kind of intermittent failure this delegation prompt warned is a measurement, not a hiccup, to
chase down after the fact. Gating on `!message.test` costs nothing today (no production caller ever
sets `options.test`) and needs no new flag (the existing test-gate convention every other kind body
already uses for `gcHook`/`echo`/`__engineWorkerKind`).

**`CB_SIM_STEP_REQ` (`sab/control.ts`, global word index 5, was reserved):** the brief's own Scope
line ("a `CB_*` step-tick request word serves `stepTick`"), built as a plain monotonic counter, the
exact shape `CB_FRAME_REQ` already has (`worker/client.ts`'s `frameReq !== lastFrameReq` idiom): a
caller `Atomics.add`s the number of ticks wanted, then wakes `WORKER_HOST`; `body()` diffs the word
against what it last saw and calls `simHost.stepTick(delta)` for that many, bypassing pacing
entirely (deterministic). `W_ACK` is stored unconditionally at the end of every `body()` pass
(kept from the M06b stub, per that Deviations note's own question -- "keep or replace": **kept**,
because `asHarness.stepTick()`'s *existing*, unmodified generic wake-then-ack lockstep for `sim`/
`gen` targets (`test/client.ts`, built in M03/M08b) depends on it, and that mechanism is used by
every pre-existing production-topology zero-GC page (`gc-topology.ts`, `gc-echo.ts`) this range
must not break).

**A real regression, found and reverted before it shipped:** the first version of this range made
`asHarness.stepTick()` itself bump `CB_SIM_STEP_REQ` for a `sim`-kind target (so the one shared
generic mechanism would drive real ticks everywhere). This broke `gc-topology`/`topology`/`gc-echo`
outright: those pages spawn a `sim`-kind worker against `fixtures/hash`, whose own hand-written
`Instance` never overrides `sim_genesis` (trait default `Status::Unsupported`); `SimHost.ensureGenesis`
(steps 1-3, accepted, unchanged) throws on anything but `Ok`/`AlreadyInitialised`, which
`runBlockingLoop`'s `runBodyOnce` turns into `shell.fatal` -- the worker died on its first
tick request and `asHarness.stepTick`'s ack-spin then failed every time ("worker 'sim1' did not
ack" across 8+ browser tests). **Fix:** `asHarness.stepTick()` is back to its original, byte-for-
byte unmodified form (never touches `CB_SIM_STEP_REQ`); a *new*, separately exported
`stepSimTickSync(client, n = 1)` (`test/client.ts`) is the one thing that bumps the word, and only a
page that explicitly calls it (`gc-sim.ts`) or the async `stepTick` built on top of it drives real
ticking. This is why `topology`/`gc-topology`/`gc-echo`'s own `sim` isolate stays exactly as inert
as the M06b stub left it (their `drive()`/test code never calls `stepSimTickSync`), and it is
deliberate, not an oversight: those pages' whole point is generic worker-kind plumbing over
`fixtures/hash`, never a real `Sim<G>`.

#### `engine/test`: `stepTick`, `worldHash`, `simCounters` (`test/client.ts`, `test.ts`)

```ts
export function stepSimTickSync(client: Client, n = 1): void        // sync core: bump, wake, spin on ack
export function stepTick(client: Client, n = 1): Promise<void>      // stepSimTickSync then untilQuiescent(client)
export async function worldHash(client: Client): Promise<string>    // callParked(client, 'sim', 'sim_hash', [], 8)
export async function simCounters(client: Client): Promise<SimHostCounters>
```

`stepSimTickSync` is a fourth exported name past the brief's own three (Seams lists `stepTick`/
`worldHash`/`simCounters`) -- needed because `stepTick`'s own trailing `untilQuiescent` (a
`parkWorkers` round trip) has no place inside a zero-GC page's synchronous, measured `drive()` loop;
`gc-sim.ts` (step 6) calls the sync core directly. `stepTick`'s own safety argument: it spins on
`W_ACK` reaching the wake it just issued (`stepFrame`'s own idiom) *before* calling
`untilQuiescent`, so the step request is confirmed served before `parkWorkers` sets `W_YIELD` --
without that ordering, a `parkWorkers` wake racing the worker's *first* wake (before it ever checks
`W_YIELD`) could make the worker break out of its loop and park without ever running `body()` at
all, silently dropping the requested ticks. (`untilQuiescent` itself needed no change: by the time
its own `parkWorkers` phase observes `W_PARKED === 1` for the host worker, that worker's single
thread has necessarily already finished the synchronous `body()` call the earlier wake triggered.)

`worldHash` reads `sim_hash` through `callParked` (the parked-only `test-call` channel, M08b) and
formats the returned `Result`-region bytes the same way `EngineInstance.readU64Hex` does (a
`hex64()` helper here, since `callParked`'s reply is a plain copy, not a live instance to call
`readU64Hex` on). `simCounters` needed a channel `callParked`/`handleTestCall` cannot provide by
itself: `SimHostCounters` is JS-side `SimHost` state, not an ABI export. Fix: `worker/sim.ts`'s own
`testCall` handler is a small wrapper, not the one-line `handleTestCall(inst, m)` every other kind
uses -- it special-cases one synthetic name (`SIM_COUNTERS_CALL = '__sim_counters'`, `worker/
protocol.ts`, shared with `test/client.ts` so both sides agree on the string without either
importing the other) and encodes `SimHost.counters` as five little-endian `u32`s
(`SIM_COUNTERS_BYTES = 20`) into the reply; every other name still falls through to
`handleTestCall`. This *is* the "one line" M08b's Deviations promised for wiring `sim` into
`callParked`, plus this one extra name.

#### `main.no_wasm_instantiate` and the `sim-config.ts` split

Importing `buildSimInstanceConfig`/`seedToHexU64`/`WorldConfig` from `server.ts` directly into
`client.ts` (needed for the "createClient local host" Scope item) failed `main.no_wasm_instantiate`
immediately: `server.ts` also imports `instantiate` from `loader.ts`, and that test scans
`client.ts`'s whole *runtime* (non-type-only) import closure, which a value import from `server.ts`
pulls `loader.ts` into regardless of which name is actually used. Fix: the three pure names (no
`EngineInstance`/`instantiate` dependency) moved to a new `sim-config.ts`; `server.ts` re-exports
all three unchanged (Seams: no renamed Provides) and is the only thing that still imports
`loader.ts`. `client.ts` imports `buildSimInstanceConfig`/`seedToHexU64`/`WorldConfig` from `sim-
config.ts` directly, never touching `server.ts` at all.

#### `createClient` local host (`client.ts`)

`ClientOptions.host`'s `world` field is now `WorldConfig<Params> = Omit<ServerWorldConfig<Params>,
'buildHash'>` (`Params` defaults `unknown`; `ClientOptions` itself stays non-generic), exactly as
the Scope line specifies. `start()` builds `worldConfig = { ...options.host.world, buildHash:
options.wasm.buildHash }` (local host only) and two per-worker config values: `simGame =
options.test?.game ?? (worldConfig && buildSimInstanceConfig(worldConfig).game)` for the `sim`
spawn, and `game = options.test?.game ?? (worldConfig && { seed: seedToHexU64(worldConfig.params.
seed), params: worldConfig.params.worldgen })` for every other spawn (`client`/`gen`) -- the minimal
`TerrainConfig` shape (`game_instance.rs`) needs (`seed`, `params`; `genWorkers`/`cacheChunks`
defaulted), built inline rather than through a second named export nothing else calls yet. Both
still fall back to `options.test?.game` first, preserving that field's own documented meaning
("overriding `host.world.game`") for every worker kind, `sim` included -- this is what lets every
*other* browser page in the suite (which all set `test.game`) keep passing unchanged; `sim-worker.
ts`/`gc-sim.ts` (steps 5-6) are the only pages that omit `test.game` and so are the only ones
exercising `simGame`/`game`'s real-`WorldConfig` path at all. `gc-echo.ts`/`gc-topology.ts`/
`topology.ts`'s own `host.world` literals were updated from the old `{ game: DEFAULT_GAME }` stub
shape to a structurally-valid (but runtime-inert, since `test.game` still wins) `WorldConfig`
literal -- required for `tsc -p tests/browser/pages/tsconfig.json` alone (a third tsconfig
`pnpm lint` runs that this range's own `npx tsc --noEmit -p .`/`-p tests/tsconfig.json` checks
missed on the first pass).

#### A real per-tick allocation, found by `gc-sim.ts` and fixed

`wrapEngineInstance.simSealFrame` (steps 1-3) returned a fresh `{ len: 0 }` object literal on every
call -- every tick this milestone ever runs, since `sim_seal_frame` always returns 0 until M22
(Non-scope). `gc-sim.ts`'s first clean measurement caught it directly: `sim` isolate 16.81 B/frame,
`byFn`'s top entry `simSealFrame@...: 9600` bytes over the 600-tick window (16 B x 600, one small
object per tick). Fixed per `.claude/rules/hot-paths.md` ("preallocate scratch objects at init and
mutate them"): `wrapEngineInstance` now closes over one `sealResult: { len: number; bytes?:
Uint8Array }` object, mutated in place (`sealResult.len = 0; delete sealResult.bytes` on the always-
taken `raw === 0` branch under this milestone's Non-scope; the `raw > 0` branch, unexercised today,
still calls `.subarray()` -- M22's own problem once real log bytes exist). Re-measured after the
fix: `sim` 0.8133 B/frame, a constant across 8 clean runs, matching the flat "8" worker budget every
other page's `client`/`sim`/`gen0` row already uses. This was a correctness gap in already-accepted
code, not a design choice; fixing it needed no signature or seam change.

#### Browser pages and specs (steps 5-6)

`sim-worker.html`/`src/sim-worker.ts` (step 5): a real `createClient()` local topology over `fx-
puts`, **no `test.game` override** -- the one page in the whole browser suite exercising
`createClient`'s real-`WorldConfig`-to-sim-config conversion end to end (`simGame`/`game`, above).
`test: { flags: {} }` only (no `clock`, no `gcHook`): enables the parked `test-call` channel
`worldHash`/`simCounters` need (`worker.ts`'s `testEnabled` gate reads `message.test`, which comes
from `options.test?.flags`, not `options.test` itself). `world.params.seed: '1'` matches `fixtures/
puts/golden/scenario.json`'s `seed: "0x1"` exactly (`seedToHexU64('1') === '0x1'`). `sim-worker.
spec.ts`: `sim_worker_steps_and_hashes` (hash after `stepTick(100)` equals `readGolden<Golden>
('puts', 'golden.json').checkpoints[0]`, the same file `wasm_idle_100_matches_native`/
`puts_idle_100_golden` are each compared against; also asserts every `SimHostCounters` field for
this idle-100 run, spelling out which are live -- see below) and `sim_worker_yields_for_cdp`
(`park()`/CDP-`evaluate` proves the sim isolate reaches the `yield` protocol and steps correctly
across a park/resume round trip, `workers.spec.ts`'s own pattern).

`gc-sim.html`/`src/gc-sim.ts` (step 6): `asHarness(client)` built the normal way (park before
`__pageReady`), but `installGcPage(harness, { drive() { stepSimTickSync(client, 1) } })` -- no
`stepFrame`/generic `stepTick` at all, since neither would touch `CB_SIM_STEP_REQ`. `gc-sim.spec.
ts`: `zeroGcSuite({ pageId: 'sim', path: '/gc-sim.html', controlKinds: ['object', 'burst'] })`, same
`controlKinds` reasoning as `topology`/`echo`/`gen` (no spare `postMessage` type for a message-
driven tick). `budgets.json`'s `gc.pages.sim` **only lists `main` and `sim`** -- `client`/`gen0` are
spawned (`createClient`'s topology always does) but deliberately left out, matching `gen`'s own
`net`-not-budgeted precedent (its Deviations: "no mechanism to apply a negative control to it at
all"): `drive()` here never wakes `client`/`gen0`, so `applyGcHook`'s own check (inside `body()`,
which only runs on a real wake) never runs for them either, and their `object`/`burst` negative
controls could never trip -- confirmed by running with them included first (`sim neg object
client`/`gen0` and `sim neg burst client`/`gen0` all failed to trip, plus a real cross-isolate
"sibling nudge" on `sim`'s own reading, the same open, unresolved phenomenon `topology`'s own
Deviations already names). Narrowing to `main`+`sim` is not a lowered bar: it is what "your clean
test must show the sim isolate in `presentIsolates`" (the delegation prompt's own requirement) asks
for, verbatim, and `client`/`gen0`'s own zero-GC coverage already exists on `topology`/`echo`/`gen`.

#### Which counters are live (the delegation prompt's own instruction: say plainly)

Exercised end to end by `sim_worker_steps_and_hashes` (a 100-tick idle run, no actions, no view
set): `ticksRun` **live** (asserted `100`), `ticksDropped` **live but 0 in every test here**
(`stepTick`/`stepSimTickSync` both bypass the pacing/catch-up path entirely -- only a real-time-
paced host, never spawned by any test in this milestone, could ever make it nonzero; unit test
`simhost_caps_catchup_and_drops_time` is the one place this counter is actually driven nonzero, and
it uses a fake instance, not a real worker), `tickOverruns` **live but 0 in every test here** (same
shape: `simhost_counts_tick_overrun`, a fake-instance unit test, is the one place this is driven
nonzero; a real `fx-puts` tick never runs long enough to trip it). `chunksWarmed` **structurally 0
this milestone, not a dead assertion in disguise but not yet reachable either**: `host::warm::Warm`
warms only chunks inside a connection's own set view, and `set_view` has no caller before M15 (no
production or test code calls it); `simhost_warmer_respects_budget` (unit, fake instance) is the
only place `chunksWarmed` is ever nonzero today. `genOnMiss` **permanently 0** (steps 1-3's own
finding, unchanged): no ABI export exists for it at all. `sim_worker_steps_and_hashes` asserts the
whole `SimHostCounters` object against `{ ticksRun: 100, ticksDropped: 0, tickOverruns: 0,
chunksWarmed: 0, genOnMiss: 0 }` with a comment spelling out which of the zeros are structural
(`chunksWarmed`/`genOnMiss`) versus merely true-for-this-run (`ticksDropped`/`tickOverruns`), so a
reader cannot mistake the assertion for coverage of paths it does not exercise.

#### Measured

`pnpm test` at acceptance: `rust 191` (unchanged: no Rust test added this range, only `tick_hz`'s
extern/trait method, covered by `abi registry` fixture-export tests), `unit 154` (+1:
`simhost_paces_at_configured_tick_rate`), `wasm 40` (unchanged), `browser 95` (+5:
`sim_worker_steps_and_hashes`, `sim_worker_yields_for_cdp`, `sim clean`, `sim neg object main`,
`sim neg object sim`; `sim neg burst main`/`sim neg burst sim` are `@slow`, confirmed passing under
`pnpm test:slow -t "sim neg burst"`). `pnpm lint`: biome, rustfmt, clippy, all three `tsc` projects
(`tsconfig.json`, `tests/tsconfig.json`, `tests/browser/pages/tsconfig.json`) green. `gc-sim`
budgets, `playwright --project gc --grep "sim clean" --repeat-each 8 --workers 1`: `main` an exact
constant 21.4933 B/frame across all 8 runs, `sim` an exact constant 0.8133 B/frame across all 8 runs
(zero run-to-run spread on both, unusually tight -- no reliability concern chased further given
that). Software mode (`pnpm gc software -t "sim clean"`): passes; `attributedBytesPerFrame.main`
measured 0. **The implementer's first explanation of that 0 was wrong and is corrected here by the
orchestrator, because the wrong explanation is the dangerous artefact:** it read the 0 as `drive`
not surviving inlining in the sampled frames, which is exactly ADR 0029's documented failure mode
and would have made this budget vacuous. Measured directly instead of argued
(`pnpm gc software -t "sim neg object main"`): the control **trips**, and since the `object`
control causes no GC events by design it can only have tripped on assertion B -- so attribution
under `drive` demonstrably works on this page. The real reason `main` attributes ~0 is that on
`gc-sim.ts` the tick work happens in the **sim worker isolate**, not on main: main's `drive()` only
pokes `CB_SIM_STEP_REQ`. The hardware figure of 21.49 B/frame is raw total including harness
overhead outside the root, which is why the two numbers differ without contradicting each other.
The budget of 0 is therefore real and is policed by a control that genuinely trips). `pgrep`/`lsof -ti tcp:4517` /`:4518`
clean after every run in this session; no background process left running.

### Notes for later briefs

- **Software-mode `sim` budget (`attributedBytesPerFrame.main: 0`) was measured once, not repeated.**
  If a later range touches `gc-sim.ts`'s `drive()` or `stepSimTickSync` and software mode starts
  failing, re-derive from a fresh `pnpm gc software -t "sim clean"` run rather than assuming 0 is
  permanently correct.
- **`client`/`gen0` on `gc-sim.ts` have no zero-GC coverage of their own** (deliberately, above):
  fine today since `topology`/`echo`/`gen` already cover them under `host.kind === 'local'`/
  `'remote'` generically, but a future milestone that gives `fx-puts` real client/gen work (M15b's
  frame pass, or terrain/worldgen wiring) should reconsider whether `gc-sim.ts` needs to wake them
  too, or whether a fourth page is cleaner.
- **`CB_SIM_STEP_REQ` is a plain `u32` counter wrap risk**, same as `CB_FRAME_REQ` already has: after
  2^32 cumulative step-tick calls (`Atomics.add` wraps silently), `worker/sim.ts`'s own `(stepReq -
  lastStepReq) >>> 0` delta computation stays correct across the wrap (unsigned subtraction), so
  this is not a bug, just worth knowing the invariant it relies on if the word's own meaning ever
  changes.
- **`simGame`/`game`'s real-`WorldConfig` conversion path is exercised by exactly one page**
  (`sim-worker.html`); every zero-GC/topology page still uses `test.game`. A later milestone wiring
  a second real local-host game should watch for the same `TerrainConfig`/`SimConfig` field-name
  mismatch this range worked around (`worldgen` vs `params`, decimal vs hex seed) rather than
  assuming `worldConfig.params` can be forwarded verbatim to every role.
- **The `sim_seal_frame` `raw > 0` branch's `.subarray()` call is still a per-call allocation**,
  unexercised by any test today (Non-scope: `sim_seal_frame` always returns 0 until M22). M22 is
  the one that gives it real content and should re-measure `gc-sim.ts`'s `sim` row once it does --
  a `Uint8Array` view over the `Persist` region built once at init and re-sliced only when `len`
  changes would avoid a second per-tick allocation there, the same pattern `sealResult` above uses
  for the object itself.
