# Research: reference game

Phase 1 evidence for `docs/spec/reference-game.md`. Findings and recommendations, not decisions. All URLs accessed 2026-09-19 unless marked *(from memory, not fetched)*. Written against the corrected spec: the camera is not an action and never mutates the world.

## 1. Findings

### 1.1 Player position: presence (a) vs. movement action (b)

| | (a) Presence, unlogged | (b) Game-defined movement action sampled from camera |
|---|---|---|
| Fit with "camera lives independently of the sim" | Direct: nothing camera-derived enters the sim | Camera re-enters the sim through a side door; the fixed decision holds in letter only |
| Log growth (estimate) | Discrete actions only: ~500 actions/h x ~8 B = ~4 KB per player-hour | 15 Hz x 3600 x ~8 B = ~430 KB per player-hour while panning; ~100x, and it is the stream `simulation.md` says "would dominate" |
| Spring | Client-only, per render frame, ordinary floats, no determinism burden | Must be bit-deterministic at fixed tick, run in sim, re-run on client for reconciliation |
| Local feel | Circle is always exactly where the local spring puts it; nothing to reconcile | Continuous prediction + reconciliation of a springy body; mispredictions show as jitter on the thing the player stares at |
| Range rule | Checked once, when the collect action is admitted | Checked by the sim every tick (stronger, but nobody is cheating: friends co-op) |
| Engine cost | New small feature: a presence channel | None new, but the prediction machinery must handle continuous input |
| Tests continuous prediction | No | Yes |

Two ways to check range under (a):

1. **Host-side admission against last-known presence.** The action carries no position. Replay trusts the log (only admitted actions are in it) and must not re-check range. Needs slack for presence staleness (send interval + latency, x max speed).
2. **Action carries a claimed position** (`StartCollect { tile, claimed_pos }`). The sim checks `dist(claimed_pos, tile) <= RANGE` deterministically, so the rule is unit-testable headlessly, replay re-validates it, and client prediction runs the identical rule. The host's admission hook may optionally compare the claim with last-known presence for plausibility; under the stated trust model it can skip that.

Either way the engine API gains a two-stage shape: a host-side, non-deterministic **admit** step (may read presence; never runs in replay) and the deterministic **apply** step inside the sim (must never read presence). During the 2 s collect the sim cannot see the player, so leaving range is client-driven: the client sends `CancelCollect`.

### 1.2 Deterministic simplex noise in Rust

- **Patent.** US 6,867,776 ("Standard for perlin noise") is listed as expired, anticipated expiry 2022-01-08; it covered 3D-and-higher simplex for textured image synthesis, so 2D was arguably never covered. Sources: https://patents.google.com/patent/US6867776B2/en, https://en.wikipedia.org/wiki/Simplex_noise, https://github.com/godotengine/godot-proposals/discussions/5007.
- **What WASM guarantees.** The only float nondeterminism in WebAssembly is NaN bit patterns (sign and payload); everything else in `+ - * / sqrt floor trunc` is exact IEEE 754 on every engine. Other nondeterminism (threads, relaxed SIMD, resource exhaustion, host calls) is opt-in or avoidable. Source: https://github.com/WebAssembly/design/blob/main/Nondeterminism.md. Transcendentals are not WASM instructions; they come from whatever libm is linked (https://github.com/WebAssembly/design/issues/1385).
- **What Rust guarantees natively.** RFC 3514: `+ - * / % abs copysign mul_add sqrt` and float casts "produce results that exactly match IEEE 754-2008"; the compiler may not contract `a*b + c` into FMA on its own; NaN bits are unspecified; 32-bit x86 (x87) is a known non-compliant target. `sin/cos/exp/powf` are not covered. Source: https://rust-lang.github.io/rfcs/3514-float-semantics.html. (Some third-party pages claim LLVM may fuse FMA in Rust; the RFC says otherwise for default builds.)
- **Consequence.** 2D simplex needs only `+ - *`, `floor`, comparisons, and an integer hash for gradient selection. A float implementation restricted to those ops, with skew constants as literals, no `mul_add`, no NaN-producing paths, and integer hashing instead of a seeded permutation table, is bit-identical across V8, JavaScriptCore, SpiderMonkey, and native x86-64/aarch64. Fixed-point is not required. Classify tiles by comparing the noise value with literal thresholds.
- **Crates** (crates.io API and lib.rs):

| Crate | Latest | Notes |
|---|---|---|
| `noise` | 0.9.0, 2024-03-23 | f64; deps `num-traits`, `rand`, `rand_xorshift`; seeded permutation table; no release in 2.5 years |
| `fastnoise-lite` | 1.1.1, 2024-03-05 | f32 (f64 feature); uses only `sqrt`, `trunc`, `abs`; `no_std` via `libm`; OpenSimplex2; MIT |
| `opensimplex2` | 1.1.0, 2024-01-29 | KdotJPG's own port; low usage |
| `noise-functions` | 0.8.5, 2026-04-18 | Actively maintained; f32; static hashing (no runtime permutation table); `no_std` |

  All are plausibly deterministic for the reason above (I did not audit their source for `mul_add` or transcendental calls). The real risk is different: any version bump that alters output silently changes every world and breaks replay, so a crate must be pinned exactly forever, which is equivalent to vendoring. A hand-written 2D simplex + fBm is ~60-80 lines, has no dependency drift, and can share the scatter hash below.

### 1.3 Stateless resource scattering

- A pure function of `(seed, x, y, salt)` needs no neighbour or cross-chunk state, so chunks generate in any order, on any machine. Use an integer mixer: the SplitMix64 finalizer (`z ^= z>>30; z *= 0xbf58476d1ce4e5b9; z ^= z>>27; z *= 0x94d049bb133111eb; z ^= z>>31`, public domain, https://prng.di.unimi.it/splitmix64.c) over `seed ^ pack(x, y) + salt * 0x9e3779b97f4a7c15`. Wrapping integer ops are bit-identical everywhere by definition.
- Placement: `hash < density[biome]` per tile, with density 0 where the base tile lacks the `resource_allowed` trait (water). Kind from other bits of the hash, optionally gated by a low-frequency noise octave per kind so resources form loose patches. If minimum spacing is wanted, use a jittered grid (one candidate per 4x4 cell, hash picks the offset; cell size divides chunk size); avoid Poisson-disk, which needs neighbours.
- The same hash supplies the per-tile art variant (`hash & 3`), so variants need not be stored.

### 1.4 Tile pre-generation script

- **Language.** A Node TypeScript script with zero npm deps is now practical: Node runs `.ts` directly (type stripping unflagged since 22.18, stable in 24.12/25.2: https://nodejs.org/learn/typescript/run-natively), and a PNG encoder is ~40 lines with built-in `zlib.deflateSync` and `zlib.crc32` (added v22.2.0 / v20.15.0: https://github.com/nodejs/node/pull/52692). A Rust bin would need the `png` crate and a cargo build in the art loop, and there is nothing to share with the sim (art variants are cosmetic). Use a seeded PRNG, never `Math.random`, and commit the output so builds and CI need no generation step.
- **Art.** 16 px tiles; 3-4 shades per terrain, ~20 colours total; per-variant speckle (5-10% of pixels shifted one shade) from the seeded PRNG; 4 variants per terrain; resource overlays with transparency; furnace 32x32 in idle/lit states.
- **Biome edges.** Ordered (Bayer) dithering is stateless per pixel: threshold `M[x mod 4][y mod 4] / 16` with `M = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]` (https://en.wikipedia.org/wiki/Ordered_dithering). Two ways to apply it: (1) the script emits, per terrain, 15 edge/corner overlay masks whose alpha is a gradient thresholded by the Bayer matrix, and the renderer draws base + overlays from higher-priority neighbours (water < sand < dirt < grass), about 4 x (4 + 15) = 76 tiles; (2) the fragment shader does the threshold from neighbour tile IDs. (1) keeps "assets are pre-generated by a script" literally true and keeps the engine's shader generic; (2) is smaller but pushes game look into the engine. This touches the art-contract question in `client.md`.
- **Packing.** Uniform tiles need no packer: emit a grid PNG + a JSON index. Prefer loading into a `texture_2d_array` (one layer per tile) to remove atlas bleeding at fractional zoom; otherwise extrude each tile by 1 px.

### 1.5 Spring integrator

- Closed-form damped spring (Juckett, https://www.ryanjuckett.com/damped-springs/): for a given `dt` the update is a 2x2 linear map (`pos' = a*pos + b*vel; vel' = c*pos + d*vel`, relative to the target). It is exact and unconditionally stable for any `dt`. Coefficients need `exp` (critical), plus `sin/cos/sqrt` (under-damped).
- Semi-implicit Euler is cheap but only conditionally stable (roughly `dt * omega < 2` undamped) and its feel changes with step size (https://gafferongames.com/post/integration_basics/ *(from memory, not fetched)*); a frame hitch or tab-return `dt` needs clamping or sub-stepping.
- Under (a) the spring runs on the client per render frame with variable `dt`: use the closed form, recomputing coefficients per frame; float transcendentals are fine because nothing depends on the bits. "Based on the camera's acceleration and velocity" falls out naturally: a body sprung to the camera lags in proportion to velocity and overshoots on deceleration. Starting values: omega ~10 rad/s, zeta ~0.6.
- Under (b) `dt` is the fixed tick, so the four coefficients are constants: compute them once with the pure-Rust `libm` crate (software `exp/sin/cos` compiled into the module, hence identical everywhere) or bake literals; the per-tick step is then 4 multiplies and 2 adds, deterministic and cheap to re-simulate for reconciliation.

### 1.6 DOM overlay approach

Sizes from bundlephobia (whole package, min+gzip): Preact 10.29.8 = 4.8 KB; lit-html 3.3.3 = 3.2 KB; solid-js 1.9.15 = 8.4 KB (tree-shaken apps ship less); Svelte 5 compiles away, ~2-5 KB for a minimal app (https://tech-insider.org/solidjs-vs-react-vs-svelte-2026/). (https://bundlephobia.com/api/size?package=preact@latest, likewise `lit-html`, `solid-js`.)

- Garbage comes from two places. **Per-frame anchoring** must bypass any framework regardless: the game writes `transform: translate3d(...)` on pooled elements from an engine-filled `Float32Array` of screen positions. **State-change rendering** happens a few times per second at most, so even VDOM garbage (Preact) is immaterial; Solid and Svelte allocate almost nothing per update; lit-html diffs only dynamic parts.
- The UI is five widgets: anchored collect buttons, inventory bar, craft menu, build toggle, furnace panel. Framework-free TypeScript with `<template>` cloning, an element pool for collect buttons, and a ~50-line subscribe helper covers it with 0 KB and zero garbage by construction, and proves the engine's observe API needs no adapter. A framework only proves the engine "doesn't care" if the API was already framework-neutral.

## 2. Prior art

- **Bevy** ships 300+ single-feature examples ("demonstrate the main features of Bevy and how to use them") and only a handful of small complete games (Breakout, Alien Cake Addict, a minesweeper, a game menu): https://github.com/bevyengine/bevy/blob/main/examples/README.md. **Phaser** does the same at larger scale: thousands of per-feature snippets at labs.phaser.io plus a few complete mini-games *(from memory; the repo README fetched did not enumerate them)*. Pattern: coverage comes from many tiny examples; the complete games stay tiny and do not try to cover everything. Our single reference game inverts this, so the coverage matrix below is the guard, and features that gameplay reaches only by luck (a furnace straddling a chunk border, eviction at the cap, a rejected action) should be pinned by scripted scenarios in tests rather than by adding mechanics.
- **Factorio stone furnace**: 2x2, three slots (source, fuel, result), any slot can be filled or emptied by hand, 90 kW burner, iron plate every 3.2 s: https://wiki.factorio.com/Stone_furnace. Fuel is an energy pool: a fuel item is consumed into a burn buffer that lasts several smelts (coal 4 MJ, wood 2 MJ *(from memory)*), which is the same shape as "one coal fuels 10 ingots". Fuel is only consumed when there is something to smelt and room for output. Hand-mining is hold-to-mine with a progress bar, cancelled by moving away; ore patches hold finite amounts and deplete (https://wiki.factorio.com/Burner_mining_drill for the mining side). Simplest sensible UX to borrow: one panel, three counters, deposit buttons, a take-output button, a progress bar.

## 3. Recommendations

### 3.1 Defaults for the open questions

| Question | Default | Rationale |
|---|---|---|
| Where the player's position lives | **(a) presence**, with the collect action carrying a claimed position (1.1 variant 2) | Honours the fixed decision, keeps the log ~100x smaller, removes the determinism burden from the spring, and the range rule stays deterministic and testable |
| Ingot withdrawal | Yes; a take-all on the output slot. Input and fuel are not withdrawable | Without it ingots are a dead end; output-only is the smallest UI |
| Depletion | Finite: each resource tile holds 10 units, 1 per collect, tile's resource layer clears at 0 | Only mechanic that exercises tile-layer deltas and modified-chunk persistence |
| Inventory and unlock | Per player; unlock counts stone *mined by that player* | Exercises per-player private state; a shared pool would hide it |
| Shared furnaces | Any player can use any furnace | Co-op; also creates natural races for rejected actions |
| Concurrency | One collect and one craft at a time per player; no queue | Smallest state (`Option<...>`); spec is silent |
| Spawn | Initial camera position = `spawn_point(seed)`: spiral outward from (0,0) to the first tile with the `buildable` trait; all players share it. Returning players resume at their last camera position (client-remembered) | Pure function of the seed, never water; under (a) a "spawn" is only a camera start. Players may still drift over water: nothing makes it impassable |
| Disconnect | Presence (the circle) vanishes; collect is cancelled by the engine `Disconnect` action; craft and furnaces continue; inventory and unlocks are kept under the player token | Deterministic, and makes reconnect invisible |
| UI approach | Framework-free TypeScript + `<template>`; Solid is the fallback if the UI grows | 1.6 |
| Noise | Hand-written f32 2D simplex + fBm, restricted ops, integer hash | 1.2 |
| Tile script | Node `.ts`, zero deps, committed output, overlay edge masks, texture array | 1.4 |

### 3.2 Feature coverage matrix (assuming the defaults above)

| Engine feature | Exercised by | Status |
|---|---|---|
| Worldgen (async, deterministic) | Simplex biomes + hashed resources | Covered |
| Chunk streaming / subscriptions | Panning the camera | Covered |
| Tile-layer modification + modified-chunk persistence | Resource depletion | Covered **only with finite resources** |
| Multi-tile entity across chunk borders | 2x2 furnace placed on a border | Reachable, not guaranteed: pin with a scripted test |
| Trait query | Placement asks tiles `buildable`, buildings `blocks_building`; scatter asks `resource_allowed` | Covered |
| Engine actions | Connect / disconnect | Covered |
| Game actions | Collect, craft, place, deposit, take | Covered |
| Rejected actions | Races: two players take the last unit of a tile, place on the same spot, or take the same ingots; stale inventory. The UI prevents solo rejections | Covered in multiplayer; pin with scripted tests |
| Prediction + rollback | Discrete actions: collect button starts filling at once, craft debits stone at once, ghost becomes furnace at once, deposit/take update counts at once; rejection rolls each back | Covered. **Continuous prediction is not exercised under (a)** |
| Presence (new engine feature under (a)) | Player circles: local spring -> throttled presence -> relay | Covered |
| Remote-entity interpolation | Remote players' circles, via presence | Covered for presence only. **Gap: no sim-owned entity ever moves.** Smallest close: the engine uses one interpolation buffer for presence and entities, so the code path is shared; otherwise accept the gap |
| Per-player private state deltas | Inventory, unlock, collect/craft progress | Covered |
| Global state | Nothing | **Gap.** Smallest close: a player roster (coloured dots, colour from the player-ID hash) in the overlay; no names, so no text field |
| Off-screen simulation | Furnaces smelt with nobody subscribed | Covered |
| Persistence / replay | Whole game; depletion + furnaces + per-player state in snapshots | Covered |
| Overlay anchoring | Collect buttons pinned to resource tiles | Covered |
| Picking | Tile under pointer (placement); entity under pointer (click furnace) | Covered |
| Placement ghost | 2x2 furnace ghost, tinted by the predicted validity check | Covered |
| Time-units conversion | 2 s collect, 5 s craft, 5 s smelt authored as integer ms; `ticks = ceil(ms * hz / 1000)`; progress sent as `done_at_tick` | Covered; test at two tick rates |
| Reconnect | Token reclaims inventory/unlocks; craft finished while away | Covered |
| Eviction at the world cap | Nothing in gameplay | Test-only: run with a tiny cap |
| Keyboard focus (WASD vs. text input) | Nothing: the game has no text field | **Gap**; accept, or cover with an engine-level test page rather than a game mechanic |

## 4. Sketch: actions, state, deltas

Fixed-point positions: `Fx = i32` in 1/256 tile. `TilePos { x: i32, y: i32 }`. `Tick = u64`.

**Engine-defined actions:** `Connect { player }`, `Disconnect { player }`. (Camera/viewport is a non-action subscription message.)

**Game-defined actions** (all implicitly carry `player` and a client sequence number):

- `StartCollect { tile: TilePos, claimed_pos: [Fx; 2] }`: rejected if no resource, out of range, or already collecting.
- `CancelCollect {}`: sent by the client on leaving range.
- `StartCraft { recipe: RecipeId }`: rejected if locked, short of inputs, or already crafting.
- `PlaceBuilding { kind: BuildingKind, origin: TilePos }`: origin = min corner; asks every covered tile and entity for traits.
- `FurnaceDeposit { furnace: EntityId, item: ItemKind, count: u16 }`: iron ore -> input; coal/wood -> fuel.
- `FurnaceTake { furnace: EntityId }`: moves all output ingots to the inventory.

**Presence** (game-defined POD, unlogged, never visible to `tick`): `PlayerPresence { pos: [Fx; 2], vel: [i16; 2] }`. The client sets it each frame; the engine throttles (~10-15 Hz, on change), the host keeps the latest per player, relays it to other clients, and drops it on disconnect.

**State**

- Chunk layers: `base: u8` (Grass, Dirt, Sand, Water), `resource: u8` (kind in the high 3 bits, units remaining in the low 5; pristine value from worldgen), `occupancy: EntityId | 0`.
- Traits: per base tile `{ buildable, resource_allowed }`; per building `{ blocks_building }`.
- `Furnace { id, origin, iron_in: u16, coal: u16, wood: u16, burn_left: u16, ingots_out: u16, smelt_done_at: Option<Tick> }`. `burn_left` counts smelts left in the current fuel item (+10 per coal, +2 per wood; coal burned first). A furnace is in the active set only while `smelt_done_at` is `Some`.
- `PlayerState { inventory: [u16; ItemKind::COUNT], stone_mined: u32, unlocks: u8, collecting: Option<{ tile, done_at }>, crafting: Option<{ recipe, done_at }> }`; `ItemKind = Stone | Coal | Wood | IronOre | IronIngot | Furnace`.
- Global: `players: [{ id, connected }]`.

**Deltas**

- Chunk-scoped: `ChunkSnapshot` on subscribe (engine-framed; game supplies layer bytes + entities), `ResourceChanged { tile, value: u8 }`, `BuildingPlaced { id, kind, origin }`, `FurnaceChanged { id, iron_in, coal, wood, ingots_out, smelt_done_at }` (on change only, at most about one per 5 s per furnace).
- Private: `InventoryChanged { item, count }`, `Unlocked { recipe }`, `CollectStarted { tile, done_at }`, `CollectEnded { completed }`, `CraftStarted { recipe, done_at }`, `CraftEnded {}`.
- Global: `PlayerJoined { id }`, `PlayerLeft { id }`.
- Engine: `ActionRejected { client_seq, reason: u8 }` and an ack carrying the tick at which an action was applied.

**API implications for `simulation.md` / `sync.md`:** (1) two-stage admit/apply with presence visible only to admit; (2) progress is never streamed: deltas carry `done_at` and the client derives fill from the interpolated sim clock, so the engine must expose that clock; (3) a multi-tile entity must be delivered to subscribers of *any* chunk it overlaps, with one owning chunk for persistence; (4) an active-entity set that entities join and leave; (5) a duration helper from integer milliseconds to ticks; (6) a game-defined presence blob with engine-owned throttle, relay, and interpolation.

## 5. Questions for Tyler

1. **Player position:** presence (a) or a logged movement action (b)? *Default: (a), with the collect action carrying a claimed position.* Cost: continuous prediction is not exercised, and no sim-owned entity moves.
2. Is it acceptable that remote interpolation is exercised only through presence? *Default: yes.*
3. **Depletion:** finite resources, 10 units per tile? *Default: yes* (needed for tile-layer coverage; the number is taste).
4. **Furnace take-back:** output ingots only, take-all? *Default: yes; ore and fuel stay in.*
5. Inventory and unlock per player, furnaces shared? *Default: yes to all.*
6. One collect and one craft at a time, no queue; panning out of range cancels a collect? *Default: yes.*
7. **Spawn:** everyone starts at the nearest land tile to the origin; returning players resume where their camera was; players may float over water? *Default: yes.*
8. **UI:** framework-free TypeScript, or a small framework (Solid preferred)? *Default: framework-free.*
9. Add a tiny player roster (coloured dots) so global state is exercised? *Default: yes; it is the only addition beyond the written scope besides depletion.*
10. Tile size 16 px with 4 variants per terrain? *Default: yes.*
