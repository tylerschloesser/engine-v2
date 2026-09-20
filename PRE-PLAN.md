# PRE-PLAN

Phase 1 output (2026-09-19). Input to Phase 2, which turns it into `PLAN.md` (see `docs/process.md`).

## 1. How to use this document

- This file is connective tissue: how the 21 decisions fit together, in what order things must be built, what is still open. **Facts live in the ADRs**; a number here always cites its owner, and if the two ever disagree the ADR wins.
- To write `PLAN.md`: read this file end to end, then open an ADR only for the milestone you are detailing. Requirements are in `docs/spec/*.md` and are binding. `docs/research/` and `spikes/*/RESULT.md` are evidence; you should not need them.
- Sections 8, 10 and 11 are the to-do list for Phase 2: ordering constraints, every deferred item, and what needs Tyler.

### ADR index

| # | Title | Decision in one line |
|---|---|---|
| [0001] | Camera and presence | Camera is a 16-byte unlogged report; player position is an engine presence channel; position-dependent actions carry a witness that `apply` checks |
| [0002] | Determinism | The same game-built `.wasm` runs everywhere (no native server); float/collection/RNG rules enforced by import allowlist, lints, heavy mode, golden hashes |
| [0003] | Game-facing API | `Game` trait with `apply` over `WorldRead`/`WorldWrite` whole-value puts; engine derives deltas, snapshots, prediction; TS sees JSON actions in, `Ui` JSON out |
| [0004] | Action timing | Host assigns tick T+1 and arrival order; admit (unlogged) then write-ahead log then `apply`; acks ride the delta frame; per-player `seq` |
| [0005] | Persistence | postcard in engine containers; segmented append-only log + 60 s snapshots; hash-stamped identity; OPFS / `fs` behind one `Storage`; panic recovery by re-instantiation |
| [0006] | Time units | Authors write ms/s; integer `const fn` converts to `Ticks` before the first tick; state stores only ticks |
| [0007] | World model | Pristine terrain is a pure function; state = sparse overlays + global entities; dense chunks are an invisible LRU cache; 4-byte tiles; trait tables; entities tick, chunks do not; two budgets |
| [0008] | Chunk generation | One pure per-chunk `Worldgen::generate`; clients regenerate terrain in gen workers, host generates on miss + warmer; server sends only overlays and entities |
| [0009] | Transport and hosting | Binary WebSocket, two message classes, injected `Connection`/`HostServices`; Node/Bun first, Durable Objects second, Vercel out |
| [0010] | Rates and subscriptions | 20 Hz tick, frame per tick when non-empty, 10 Hz camera, ring-1 subscribe / ring-3 + 5 s unsubscribe, 128-chunk cap, bandwidth budget |
| [0011] | Wire format and deltas | Hand-framed little-endian sections + postcard values; engine-defined `Delta`; scopes Chunk/Player/Global/Presence; per-chunk version instead of acks |
| [0012] | Prediction | Only own discrete actions are predicted: reset-and-replay overlay running the same `apply`; `Unknown` reads decline; two clocks; remote motion is interpolated |
| [0013] | Sessions and integrity | Device secret + join key; stateless reconnect with a resume hint; strict build-hash equality; 10 s disconnect grace; per-chunk desync hashes |
| [0014] | JS↔WASM boundary | Hand-rolled numbers-only `extern "C"` ABI, two output-only imports, fixed regions, one loader; no wasm-bindgen |
| [0015] | Threads, memory, topology | Main (TS) + client worker + net or sim worker + gen workers; SAB rings/seqlock/triple buffer only; mandatory COOP/COEP; fixed arena per instance |
| [0016] | Zero-GC definition | Per-isolate byte budgets (main 110, workers 8 B/frame, net ≤ 1 KB/message) asserted with CDP sampling + trace, permanent negative controls |
| [0017] | Packaging and build | One npm package with subpath exports + bundled crate; plain `cargo` driven by the engine's Vite plugin; `.wasm` as data with a build hash; tarball test; exact toolchain pins, Biome + rustfmt + clippy |
| [0018] | Renderer | TS WebGPU "ferry" on main; Rust produces DrawList + texels; one full-viewport terrain shader over page/indirection textures; art contract; frame budget |
| [0019] | Camera, input, overlay | Camera is main-thread state written to a seqlock block; semantic input events; CPU picking from the DrawList; custom-property DOM anchoring |
| [0020] | Testing strategy | nextest + Vitest (Node) + Playwright/CDP; five fast suites in 55 s; virtual-clock netcode harness; test entrypoint; CI on SwiftShader |
| [0021] | Context architecture | Nested `CLAUDE.md` + path-scoped rules; skills written when real; one commit hook; progress lives in `PROMPT.md`/`PLAN.md` |
| [0022] | Entity ids and provisional ids | Real ids are monotonic, never reused and layout-free; provisional ids are client-local (bit 31); actions address anything predictable by tile, so `Applied` carries nothing |
| [0023] | Action growth declaration | Provided `Game::growth(&Action) -> Option<Growth>` bounds what `apply` may add, so a world at its state budget still accepts actions that free state; audited, not trusted |
| [0024] | Planning amendments | Fifteen numbered fixes to gaps and contradictions in 0001–0020 found while writing the milestone briefs; cited as "0024 §n" |
| [0025] | Phase 3 orchestration | One orchestrating session lands milestones in serial on `main`; a Sonnet `milestone-implementer` sub-agent builds each; the orchestrator gates (`pnpm gate`) and is the only writer of checkboxes, `PLAN.md` and `PROMPT.md`; tags at markers. Amends 0021 |
| [0026] | Zero-GC `burst` controls in the slow tier | Generated per-isolate `burst` negative controls are `@slow` for every page but `gc-loop`; `object` negatives stay fast; each clean test asserts every expected isolate was discovered in the trace. Amends 0016 §3.8 |

## 2. Architecture overview

**Principles that shape everything.** One `.wasm` (game + engine crates) is instantiated per *role* (`sim`, `client`, `gen`) with its own non-shared memory and a fixed arena ([0014], [0015]). No WASM and no `postMessage` on any steady-state path of the main thread; threads share only fixed SAB structures ([0015]). Single-player and multiplayer run the same protocol bytes; only the transport differs ([0009], [0012]). The deterministic core (`genesis`, `on_player`, `apply`, `tick`, worldgen) sees only `WorldRead`/`WorldWrite`; everything camera-, time- or network-shaped lives outside it ([0001], [0003]).

```
SINGLE-PLAYER: one cross-origin-isolated tab, no socket
┌ Main thread: TypeScript only, no WASM ───────────────────────────────────────────────┐
│ game DOM UI · input · camera (f64) · WebGPU renderer · overlay anchors               │
└──────────────────────────────────────────────────────────────────────────────────────┘
   │ camera block (seqlock),  ▲ DrawList triple    ▲ chunk-upload ring   ▲ UI ring (JSON on
   │ input + action rings,    │ buffer             │ (texels,            │ change), clocks,
   ▼ Atomics.notify per rAF   │ (3 x 2 MiB)        │ indirection)        │ anchor table
┌ Client worker: WASM role=client ─────────────────────────────────────────────────────┐
│ replica · prediction overlay · interpolation · pristine cache + generation queue ·   │
│ extract + texel conversion · ALL uplink assembly (actions, camera report, presence)  │
└──────────────────────────────────────────────────────────────────────────────────────┘
   │ uplink ring   ▲ downlink ring (the same frame      │ request ring   ▲ 4 KiB result
   ▼               │ bytes as the wire)                 ▼                │ slabs
┌ Sim worker: WASM role=sim ───────────────────────┐   ┌ Worldgen worker(s): role=gen ─┐
│ TS sim host (pacing, subscriptions, fan-out)     │   │ 1, or 2 if >= 8 cores         │
│ authoritative world · tick loop · log, snapshots │   │ pure generate(), no state     │
│ OPFS sync handles + Web Lock                     │   └───────────────────────────────┘
└──────────────────────────────────────────────────┘

MULTIPLAYER: the sim worker is replaced by a net worker plus a server process
┌ Main thread: TypeScript only, no WASM ───────────────────────────────────────────────┐
│ game DOM UI · input · camera (f64) · WebGPU renderer · overlay anchors               │
└──────────────────────────────────────────────────────────────────────────────────────┘
   │ camera block (seqlock),  ▲ DrawList triple    ▲ chunk-upload ring   ▲ UI ring (JSON on
   │ input + action rings,    │ buffer             │ (texels,            │ change), clocks,
   ▼ Atomics.notify per rAF   │ (3 x 2 MiB)        │ indirection)        │ anchor table
┌ Client worker: WASM role=client ─────────────────────────────────────────────────────┐
│ replica · prediction overlay · interpolation · pristine cache + generation queue ·   │
│ extract + texel conversion · ALL uplink assembly (actions, camera report, presence)  │
└──────────────────────────────────────────────────────────────────────────────────────┘
   │ uplink ring   ▲ downlink ring (the same frame      │ request ring   ▲ 4 KiB result
   ▼               │ bytes as the wire)                 ▼                │ slabs
┌ Net worker: TypeScript, no WASM ─────────────────┐   ┌ Worldgen worker(s): role=gen ─┐
│ owns the WebSocket + reconnect timing            │   │ 1, or 2 if >= 8 cores         │
│ byte pump, never parses frames; its heap         │   │ pure generate(), no state     │
│ quarantines WebSocket garbage                    │   └───────────────────────────────┘
└──────────────────────────────────────────────────┘
   ▲ wss, binary WebSocket: one packet per flush, both message classes
   ▼
┌ Server process: Node >= 22 / Bun / (Durable Object) ─────────────────────────────────┐
│ game's server pkg: `ws` + Node adapter -> createWorldServer(cfg, HostServices)       │
│ the same TS sim host · one WASM role=sim · no workers, no SABs · Storage = node:fs   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Memory ownership.** Each instance owns its arena (sim 96 MiB, client 48 MiB, gen 4 MiB by default; [0015]). The sim instance owns world state (overlays, entities, players, global, timers, RNG) plus an invisible dense-chunk cache ([0007]). The client instance owns a replica of subscribed state, the prediction overlay, the interpolation buffer and its own pristine cache ([0012], [0008]). The main thread owns GPU objects, which are caches of worker-side state ([0018]). Every cross-thread byte is copied twice by JS `TypedArray.set` through views created at init ([0014], [0015]). Storage is owned by the sim host: OPFS in the sim worker, injected `Storage` on a server ([0005]).

**One frame** (display rate; main and client worker run in parallel, one frame apart):
1. Main rAF: integrate the camera from input; write the camera block; `Atomics.notify` the client worker ([0019], [0015]).
2. Same callback: take the newest DrawList slot, drain the chunk-upload ring within its byte budget, one `writeBuffer`, one draw per non-empty layer, submit ([0018]); write at most two overlay style properties ([0019]); if the UI ring's version changed, parse once and call `onUi` ([0003]).
3. Client worker wakes: drain the downlink ring into `on_frame` (apply network frames atomically, reconcile; [0011], [0012]); drain action and input rings (`on_action`, `on_input`; [0014]); call `frame(t_ms)`: `ClientSide::frame` (presence, follow target), interpolation at `host time − delay`, `extract` into the DrawList, counting sort by layer, publish to the triple buffer, `ui` if state changed ([0003], [0018]); re-prioritise the generation queue and convert finished chunks to texels ([0008], [0007]); at most every 50 ms assemble an uplink batch ([0010]).
4. Main shows that DrawList on its next rAF with the newest camera; positions are relative to an integer window origin, so a one-frame-old list has no error ([0018]).

**One tick** (20 Hz; identical code in the sim worker and on a server):
1. The injected timer fires (sim worker: `Atomics.wait` timeout); at most 5 catch-up ticks per wakeup ([0015], [0005], [0020]).
2. The frame for tick T+1 holds the records admitted during T, already appended to the log (write-ahead). They run in arrival order: `on_player` for connection events, `apply` for game actions after the state-budget check ([0004], [0005], [0007]). Every put applies to the store and is recorded as a scoped `Delta` ([0011]).
3. `G::tick(TickCx)`: queued wake-ups, timer wheel, per-system active lists; cost is O(active entities) ([0007]).
4. Per client: update the subscription set from the latest camera report ([0010]); build one network frame (header with `tick` and `ack_seq`, then ActionResults, Global, OwnPlayer, chunk enters/snapshots/leaves under the token bucket, ChunkDeltas, relayed Presence, Hashes; [0011], [0001], [0013]); `Connection.send` ([0009]). Nothing to say means nothing sent, except a heartbeat every 500 ms ([0010]).
5. Between ticks: the 2 ms chunk warmer ([0008]); the storage `sync` barrier at most once per second; a snapshot every 1,200 ticks if anything changed ([0005]).

**One action round trip** (collect button → confirmed):

| Hop | What happens | ADR |
|---|---|---|
| dispatch | Game UI calls `client.dispatch(action)`; main assigns `seq`, JSON-encodes into the action ring, returns `seq` | [0003] |
| predict | Client WASM parses into `G::Action`, runs `G::apply` on `Predicting` (overlay over replica) with a frozen predicted tick; `Unknown` read or RNG use → roll back, mark `NotPredictable`, still send; queue as pending | [0012] |
| wire | Postcard bytes + `seq` join the next uplink batch (actions flush at once); client worker → uplink ring → net worker → socket, or → sim worker | [0010], [0015], [0009] |
| admit | Host decodes, stamps `who`, rate-limits, calls `G::admit` with the presence table. Failure: `Rejected`, not logged | [0004], [0001] |
| apply | Record appended to the frame for T+1 and written to the log, then `G::apply` runs at the start of T+1; sim-state rejection stays in the log | [0004], [0005] |
| delta | Each put became a `Delta` routed to Chunk / Player / Global scope | [0011], [0003] |
| ack | `Ack { seq, tick, result }` and the deltas it caused travel in the same frame for T+1; header carries `ack_seq` | [0004], [0011] |
| reconcile | Client applies the frame atomically: deltas into the replica, pop pending `seq <= ack_seq`, clear overlay, re-run `apply` for the rest; ghost and real result swap in one render | [0012] |
| UI | `onActionResult(seq, Confirmed \| Rejected(reason))`; changed `G::Ui` JSON → UI ring → `onUi`; progress bars derive from `done_at` and `client.clock()` | [0003], [0006] |

## 3. Package and crate layout, entrypoints, build pipeline

Layout after Phase 3 (owner: [0017]; `.claude/` and nested `CLAUDE.md` files: [0021], `docs/context-architecture.md`):

```
pnpm-workspace.yaml  package.json  Cargo.toml (workspace, profiles, lints)  Cargo.lock  rust-toolchain.toml  biome.json   (pins: [0017] §10)
packages/engine/                  the one publishable package ("private": true for now), zero runtime deps
  package.json                    exports map below; "files": ["dist", "crates"]
  src/ -> dist/                   TypeScript compiled by tsc (no bundler)
    client.ts                     createClient, checkSupport: renderer, camera, input, overlay, rings, loader use
    worker.ts, worker-auto.ts     run(): client / sim / gen / net worker kinds in one self-contained module
    server.ts                     createWorldServer, TS sim host (shared with the sim worker), Connection, Storage types
    server-node.ts -bun.ts -deno.ts   adapters: loadGame(dir), fs Storage, structural `ws` typing
    vite.ts, virtual.d.ts         engine() plugin + buildGame(); `virtual:engine/wasm` declaration
    test.ts                       test entrypoint (section 6); never in production bundles
  crates/engine/                  the Rust crate (one or several: deferred), shipped inside the tarball
  fixtures/<name>/                tiny fixture game crates, one per feature; not published
games/reference/                  private Vite app
  vite.config.ts  index.html  src/ (bootstrap + framework-free DOM UI)  src/bindings/ (ts-rs output, committed)
  sim/                            the game crate (cdylib + rlib): impl Game, Worldgen, ClientSide; export_game!
  assets/ + scripts/              asset script -> tiles.png/json, sprites.png/json ([0018] art contract)
games/reference-server/           private; depends on `engine` + `ws`; builds the WebSocketServer and injects it
tests/ or per-package test dirs   suites of [0020]; golden hashes; manual iOS checklist (the budgets file is `packages/engine/budgets.json`, [0020] §9)
.claude/ (settings.json, hooks/, rules/, skills/)   created in Phase 3's first milestone ([0021])
```

| Entrypoint | Exports | Imported by |
|---|---|---|
| `engine` | `createClient`, `checkSupport`, types | the game's main-thread code |
| `engine/worker` | `run()` | nobody by default (pattern A: the engine spawns `worker-auto.js` itself); the game's two-line `worker.ts` in pattern B |
| `engine/server` | `createWorldServer`, `Connection`, `HostServices`, `Storage` | adapters; custom hosts (Durable Objects) |
| `engine/server/node`, `/bun`, `/deno` | runtime adapter, `loadGame`, fs storage | the game's server package |
| `engine/vite` | `engine()` plugin, `buildGame()` | the game's `vite.config.ts`, test and server scripts |
| `engine/virtual` | types for `virtual:engine/wasm` | the game's `tsconfig` |
| `engine/test` | stepping, hashes, hooks | tests only |
| crate `engine` (path dep) | `Game`, `Worldgen`, `ClientSide`, `Presence`, `export_game!`, ... | the game's `sim` crate |

**From a `.rs` edit to a running page** ([0017]): `fs.watch` on the game and engine crates (30 ms debounce) → `buildGame()`: `cargo build --target wasm32-unknown-unknown` on the dev profile (release for `vite build`; optional `wasm-opt`, off in dev and tests) → SHA-256 build hash → `game.wasm` + `game.json` under `<crate>/target/engine/<profile>/` → Vite `full-reload` (rustc errors go to the overlay) → the page imports `virtual:engine/wasm` (`{ url, buildHash }`) → `createClient` checks `crossOriginIsolated`, `compileStreaming` once, spawns workers, posts each the `Module`, its SABs and config ([0015]) → each worker's loader instantiates, checks `engine_abi_version`, calls `engine_init(role)` and builds its views once ([0014]). In parallel and without gating the reload: native `cargo test export_bindings` writes `src/bindings/*.ts` ([0003]). The plugin also sets COOP/COEP on dev and preview. A server loads the same `game.wasm` with `loadGame(dir)`; client and server must come from one `buildGame` output or the handshake rejects ([0013]).

**What a game author writes:** `vite.config.ts` (one plugin line), `sim/Cargo.toml` + `rust-toolchain.toml`, a Rust crate implementing the traits in section 4 ending in `engine::export_game!(MyGame);`, TypeScript bootstrap + DOM UI against generated bindings, an asset script, and for multiplayer a small server package (`ws` + the Node adapter). No worker code, no WASM glue, no delta types, no save/load ([0017], [0003]).

## 4. Game-facing API sketch

Full signatures: [0003] (traits, contexts, TS observation), [0008] (`Worldgen`), [0001] (`Presence`, `admit`), [0018] (`DrawList`, `Draw`, `tile_visual`), [0019] (camera, input, overlay), [0006] (`TickRate`, `Ticks`).

```rust
trait Game {                                   // 0003
    const SCHEMA_VERSION; const TICK_RATE = HZ_20; const CHUNK_BITS = 5;
    type Worldgen;                             // pure fn generate(seed, &Params, ChunkCoord, &mut [Tile]); WORLDGEN_VERSION (0008, 0007)
    type Action; type Reject: From<Unknown>;   // Codec + TS: plain data, postcard on the wire, JSON from the UI
    type Entity; type Player; type Global;     // replicated whole values: chunk scope / private / everyone (0011)
    type Presence;                             // <= 32 B, unlogged, client-produced (0001)
    type Ui: Default;                          // Serialize + TS + PartialEq + Default: what the DOM observes
    type Client: ClientSide<Self>;             // never replicated or hashed; floats allowed
    fn register(&mut Registry);                // trait tables + entity prototypes (TraitSet, footprint) (0007)
    fn prototype(&Entity) -> PrototypeId;      // engine derives occupancy and delta scope from it
    fn genesis(w); fn on_player(w, who, Joined|Connected|Disconnected);
    fn apply(w: &mut dyn WorldWrite, who, &Action) -> Result<(), Reject>;   // host live, replay, client prediction
    fn predict(&Action) -> bool;               // opt-out flag only (0012)
    fn tick(cx: &mut TickCx);                  // host only
    fn admit(&dyn WorldRead, &PresenceTable, who, &Action) -> Result<(), Reject>;  // host only, never replayed
    fn migrate(from_schema, &mut OldStore, w) -> Result<(), SaveIncompatible>;     // optional (0005, 0006)
}
trait WorldRead  { tick, tile, traits_at, entity_at, entity, player -> Result<_, Unknown>; global }
trait WorldWrite { set_tile, spawn, put_entity, despawn, put_player, put_global, rng }   // each put == one Delta
trait ClientSide { frame(&mut FrameCx, &mut Presence); extract(&FrameView, &mut DrawList); tile_visual(Tile); ui(&FrameView, &mut Ui) }
```

```ts
import { createClient, checkSupport } from 'engine'; import wasm from 'virtual:engine/wasm'
const client = createClient({ canvas, wasm /* + mode/url, createWorker?: see section 10 gaps */ })
client.dispatch(action): number            client.onActionResult((seq, result) => ..)      // 0003, 0004
client.onUi((ui: Ui) => ..)                client.clock()   // { authoritative, predicted, ticksPerSecond } (0006, 0012)
client.camera.{setConstraints, moveTo, read, worldToScreen, screenToWorld}                  // 0019
client.input.{on('tap'|'hover'|'longpress'|'drag*', cb), setMode, suspend, resume}          // 0019
client.overlay.{anchor(el, x, y), anchorSlot(el, slot)}                                     // 0019
// engine events the surface must carry: SaveIncompatible, WorldBusy, durable:false, storage estimate, Resyncing,
// onFatal (0005); rendererLost (0018); version mismatch / updating (0013); exportWorld / importWorld (0005)
// server: createWorldServer(cfg: WorldConfig, { wasm, storage, clock, timer, onIdle }).accept(connection)   (0009: field list)
```

**The reference game on this API** (scope: `docs/spec/reference-game.md`; coverage list and scripted-test extras: [0003] Consequences):

| Piece | Mapping |
|---|---|
| Worldgen | f64 simplex fBm (height + moisture) → base terrain; stateless `hash2` scatter → resource layer, none on water; `aux` = 10 units ([0008], [0007]) |
| Traits | `NOT_BUILDABLE` on water and on the furnace prototype; `COLLECTABLE` on resource ids; placement asks `traits_at` over the 2x2 footprint ([0007]) |
| Actions | `StartCollect { tile, from }`, `CancelCollect`, `StartCraft { recipe }`, `PlaceFurnace { origin }`, `FurnaceDeposit { at, item, count }`, `FurnaceTake { at }`: furnaces addressed by tile, per the interim rule in [0012] |
| `Entity` | `Furnace { iron_in, coal, wood, burn_left, ingots_out, smelt_done_at }` ≈ 12 B; sleeps on the timer wheel ([0007]) |
| `Player` | inventory counts, `stone_mined`, unlocks, `collecting: Option<{tile, done_at}>`, `crafting: Option<{recipe, done_at}>`; one of each, no queue |
| `Global` | engine roster (id, online) drives the coloured dots; game value small (e.g. colour table) so `put_global` is exercised ([0011]) |
| `Presence` | `PlayerPresence { pos: Q24.8 x2, vel: i16 x2 }` = 12 B, written by the client-side spring each frame; `admit` tolerance 16 tiles ([0001]) |
| `tick` rules | collect completes (depletes `aux`, overlay entry; +1 item; unlock at 5 stone), craft completes, furnace smelts 1 ingot / 5 s and burns fuel; `on_player(Disconnected)` cancels a collect |
| `Ui` | inventory, unlocks, collectables in range (tile + `done_at`), craft state, open furnace contents, roster; buttons anchor with `client.overlay`, fill is one CSS animation ([0019]) |
| Drawables | circles for players (interpolated presence), furnace sprite, radial/bar progress, 2x2 ghost with `ANCHOR_CURSOR_TILE` tinted by shared `can_place`; terrain through `tile_visual` incl. depletion ([0018]) |
| Durations | `TICK_RATE.secs(2)` collect, `secs(5)` craft and smelt, as `const` ([0006]) |

## 5. Protocol sketch

Encoding, sections and scopes: [0011]. Classes and adapter: [0009]. Rates and budgets: [0010]. Handshake, reconnect, hashes: [0013]. Single-player carries the same bytes over a SAB ring pair.

| Message | Dir | Class | Contents | ADR |
|---|---|---|---|---|
| `Hello` | C→H | reliable | frozen prefix (magic, protocol version, 32-byte build hash), join key, 16-byte player secret, camera report, optional resume hint (epoch, last tick, ≤ 128 × (dx, dy, version)) | [0013] |
| `Welcome` / `Reject` | H→C | reliable | player id, epoch, tick, tick rate, seed + params, view clamps, last processed `seq`, last presence / `VersionMismatch \| BadKey \| Full` | [0013] |
| Uplink batch (≤ 1 per 50 ms, ≥ 1 per s) | C→H | mixed | pending actions (`seq` + postcard, reliable, flushed at once); camera report 16 B and presence sample ≤ 32 B (latest-wins, ≤ 10 Hz, on change); `last_received_tick` | [0010], [0001] |
| `ResyncChunk { coord }` | C→H | reliable | sent on a per-chunk hash mismatch | [0013] |
| `Bye` | both | reliable | clean leave (skips the grace) / `Superseded` | [0013] |
| Frame (one per tick when non-empty; heartbeat ≥ every 500 ms) | H→C | reliable; Presence section latest-wins | 10-byte header `type, flags, tick, ack_seq`; sections ActionResults · Global · OwnPlayer · ChunkEnterPristine · ChunkSnapshots · ChunkLeaves · ChunkDeltas · Presence · Hashes; applied atomically | [0011], [0004] |

**Subscription changes** ([0010], [0008], [0011]): the client only ever sends its view; the host clamps it (≤ 256 tiles per axis), derives ring 1 + look-ahead, caps at 128 chunks, and unsubscribes beyond ring 3 after 5 s. Chunk enter inside frame T is a ~3-byte pristine entry or a snapshot `{coord, version, overlay runs, entity puts}` as of the end of T; deltas start at T+1; leave is `{coord}`. Chunk data spends a token bucket (48 KB/s, 128 KB burst), visible first; tick frames never queue behind it. The client generates terrain itself (ring 1 generate + upload, ring 2 generate, retain to ring 3).

**Join and reconnect** ([0013], [0005]):
```
C: open socket → Hello(build hash, key, secret, view, resume?)
H: build hash ≠ → Reject{VersionMismatch} → client reloads once, then "updating" + backoff
H: Welcome → log Joined (first sight of secret) / Connected → first frames: Global + OwnPlayer snapshots, chunk enters visible-first
   with a resume hint from the same epoch: per wanted chunk, version equal → 3-byte keep · else snapshot · unwanted → leave
C: resend pending actions with seq > Welcome.last_processed_action_seq → reveal world when visible chunks are received AND generated
Drop: client dead after 3 s without a frame → backoff 0, 0.5, 1, 2, 5 s; presence vanishes at once; Disconnected logged after 10 s grace;
      zero players → ticking stops; 30 s later snapshot + onIdle. Host restart or panic recovery → epoch bump → full resync.
```

## 6. Testing strategy

Owner: [0020]; what is asserted: [0002] (determinism), [0016] (zero GC). One command, `pnpm test [suite] [-t pattern]`, builds incrementally then runs the fast suites in parallel with a one-line-per-suite output contract; `pnpm test:slow` runs the rest; `pnpm lint` runs the format, lint and type checks of [0017] §10, whose no-compile subset is the commit hook ([0021]).

| Suite | Runner | Budget | Holds |
|---|---|---|---|
| Rust native | cargo-nextest | 10 s | unit + scenario tests ending in golden hashes; log replay; `admit`; cache-invisibility replay (capacity 1 / default / unlimited, shuffled generation); DrawList hashes; WGSL validation |
| TS unit | Vitest (Node) | 3 s | camera maths, rings, exports map, config |
| WASM under Node and Bun | Vitest + one `bun` script | 7 s | the built `.wasm` through the server entrypoint: same logs, same hashes; ABI + import-allowlist tests |
| Netcode | Vitest | 10 s | real server + K headless clients over in-memory `Connection` pairs (subset on loopback `ws`), seeded conditioner, virtual clock |
| Browser | Playwright Test, Chromium, real GPU locally | 25 s | zero-GC tests + negative controls; readback scenes with semantic pixel probes; canvas smoke; worker/SAB/COI wiring; sim hash in Chromium, WebKit, Firefox; packaging smoke |

- **The 1-minute budget** is met by running suites in parallel (wall clock ≈ the browser suite, 25–30 s; 55 s serial), by never using real rAF pacing (manual frame stepping: 600 frames ≈ 20 ms), by building on the dev profile, by a demotion rule (p95 > 0.5 s Rust/Node or > 3 s browser moves to `slow`, never the only test of a feature), and by budgeting compilation separately at ≤ 30 s ([0020], [0017]).
- **Zero GC** ([0016]): one Playwright test per topology drives 120 warm-up + 600 measured frames of normal play including panning and actions; per isolate it asserts (A) no `MinorGC`/`MajorGC` trace events in the window and (B) exact sampled bytes / N within the budget (`HeapProfiler` at `samplingInterval: 1`), plus unchanged `memory.buffer.byteLength` per instance. Negative controls must fail on the named isolate only.
- **Determinism** ([0002], [0020]): recorded logs replayed with checkpoint hashes natively, as `.wasm` in Node and Bun, and in Chromium/WebKit/Firefox; golden hashes from the `.wasm` run; worldgen golden over raw tile bytes; replay equality; heavy mode (save → fresh instance → continue → compare) at N = 1 in the slow tier; import allowlist + lint bans as mechanical guards; dev builds hash every chunk every frame ([0013]).
- **Slow tier:** heavy mode, release-profile golden replay, size test, tarball-install test ([0017]), WebKit readback scene, wall-clock benchmarks (tick and frame time, 25 % threshold, Tyler's Mac only), soak/large-world variants. CI: GitHub Actions `ubuntu-latest` on SwiftShader, timings recorded not gating; iOS by checked-in manual checklist.
- **The engine must expose** (behind `engine/test`; [0020] section 8): one injectable `Clock`/`Scheduler` everywhere (no ambient time or rAF), `stepTick()` / `stepFrame(dt)` and an awaitable cross-thread quiescence point, a caller-supplied render target, whole-world and per-region hashes at any tick, every seed as a parameter, engine-level input injection, deterministic counters (bytes/messages per tick, draw calls, upload bytes, memory high-water mark), the negative-control allocation hook, the worker `yield` flag ([0015]), a device-loss flag ([0018]).

## 7. Performance budgets

| Budget | Number | Owner |
|---|---|---|
| Frame time | 60 fps = 16.6 ms on the baseline phone: main rAF callback ≤ 4 ms, GPU ≤ 6 ms, client-worker `frame` ≤ 8 ms (parallel). Desktop proxy: main ≤ 1.3 ms, worker ≤ 2.7 ms. *Derived in this phase.* | [0018] §9 |
| Tick time | ≤ 10 ms per 50 ms tick on the slowest host (phone sim worker, Fly shared-cpu-1x); desktop proxy ≤ 3 ms on the standard large save (state budget full, 8 players; defined in [0020] §9). *Derived in this phase.* | [0010] |
| Chunk generation | ≤ 1 ms per chunk on the baseline phone; desktop benchmark warns above 0.25 ms (measured 0.09–0.11 ms). Host warmer 2 ms per tick gap. Join at full zoom-out: 81 visible chunks ≈ 8 ms desktop, 25–40 ms phone (est.) | [0008] |
| GPU upload | ≤ 64 KiB of chunk texels per frame; constant 2–10 draws | [0018] |
| Bandwidth per client, steady | down 1–5 KB/s typical; up ~0.4 KB/s while panning, ~0 at rest; soft cap 16 KB/s for tick frames | [0010] |
| Bandwidth per client, burst | chunk streaming 48 KB/s refill + 128 KB burst; hard ceiling 64 KB/s; 10–20 MB per hour of play; reconnect ≈ 1 KB each way | [0010], [0013] |
| Action rate / log | 20 actions/s sustained, burst 40; ≈ 12–18 B per logged action, 65 KB per active player-hour | [0004] |
| Memory per instance | arenas: sim 96 MiB, client 48 MiB, gen 4 MiB; ceiling 256 MiB on mobile; world budget 64 MiB (262,144 entities, 1,048,576 modified tiles); dense cache 1,024 chunks = 4 MiB | [0015], [0007] |
| Memory, whole tab | ≤ 256 MiB single-player on the baseline phone (~160 MiB multiplayer); GPU ≈ 4 MiB page + 2 MiB instances + art; SABs ≈ 12 MiB | [0015], [0018] |
| Download | game `.wasm` ≤ 1 MB brotli warn / 2 MB fail; engine JS ≤ 50 KB brotli | spec, [0015] |
| Allocation per isolate | main 110 B/frame; client, sim, gen workers 8 B/frame; net worker ≤ 1 KB per message; zero major GCs; zero `memory.grow` | [0016] |
| Latency | action → authority ≤ 1 tick + network; interpolation delay 100–400 ms adaptive (initial 150); snapshot every 60 s; log sync ≤ 1 s | [0004], [0010], [0005] |
| Dev loop | ≤ 30 s from one-line Rust edit to tests starting (spike floor: 0.2–0.6 s save → page on the dev profile) | [0020], [0017] |
| Test suite | fast tier < 60 s warm (55 s serial budget; ≈ 25–30 s parallel) | [0020] |
| Hosting cost | ≈ $5/month always-available, ≈ $0 idle | [0009] |

## 8. Milestone ordering constraints for Phase 2

Not the plan; the dependencies the plan must respect. `docs/process.md` requires a thin vertical slice (chunked world on screen, camera input, sim in a worker, one action round trip, tests green) as early as possible, and the test harness (with GC and determinism checks) early.

1. **Milestone 1 is repo scaffolding only, sized for one session:** pnpm + cargo workspaces with empty `packages/engine` and crate, the toolchain pins and `biome.json` / rustfmt / clippy setup with their exact commands ([0017] §10), `.claude/settings.json` (allowlist + the commit hook) and the `write-adr` skill ([0021]), and a **skeleton `pnpm test`** entrypoint that runs an empty Rust suite (nextest) and an empty TS suite (Vitest) under the quiet-on-success output contract of [0020] §2, plus `pnpm lint`. No engine code, no browser suite, no CI.
2. **The real test harness is milestone 2, not later.** It brings the minimum it needs to have something to test (the crate with `export_game!` + loader + `engine_init` ([0014]), `buildGame` and the Vite plugin ([0017]), one fixture game, a COOP/COEP page; the `vite-lib-worker-wasm` spike is the template) and then: Playwright wired into `pnpm test`, the injectable clock/stepping API, the import-allowlist test, the first **determinism hash across runtimes** (native + Node + Bun + three browsers), and the **zero-allocation assertion** with negative controls (ported from `spikes/zero-gc-webgpu`) running against whatever page exists. If that is more than one session, Phase 2 splits it (build + determinism hash, then the zero-GC harness) but schedules nothing else between. Every later milestone adds tests to it. The `run-tests` and `gc-test` skills land here ([0021]).
3. **The slice needs, in dependency order:** SAB ring/seqlock/triple-buffer primitives ([0015]) → world model core + `Worldgen` + gen worker ([0007], [0008]) → renderer terrain path + camera/input on main ([0018], [0019]) → `Store`/`Delta`/`WorldWrite` + tick loop in the sim worker ([0003], [0007]) → wire framing + in-browser `Connection` + subscriptions ([0011], [0009], [0010]) → `dispatch` → `apply` → ack without prediction ([0004]). Single-player first: it needs no socket and exercises the whole protocol.
4. **Codec before anything persistent or networked:** `Codec` with NaN canonicalisation and the state hash ([0002]) underlie the wire, the log, snapshots and desync hashes; golden-bytes tests fix section ids ([0011]).
5. **Prediction after the unpredicted round trip works**, and only after Phase 2 has decided the provisional-id question (section 10); the taint rule is settled inside the prediction milestone, with tests; its renderer hand-off (overlay change list, `predicted` flag) depends on the DrawList ([0012], [0018]).
6. **Persistence after the tick loop and codec; recovery and upgrade paths after persistence** ([0005]). Heavy mode arrives with the first snapshot. Panic recovery needs the loader's trap handling ([0014]).
7. **Multiplayer after single-player:** server entrypoint + Node adapter + `games/reference-server`, net worker, handshake/reconnect/epochs, desync hashes ([0009], [0013]); the netcode harness (in-memory pairs first) lands with the server entrypoint ([0020]). Presence and interpolation can land with it or just before ([0001], [0012]).
8. **Reference-game features ride the engine milestones** that enable them (collect = first action; furnace = multi-tile entity + timer wheel; roster = Global scope; overlay anchoring with the first button); engine tests use fixture games so they never wait for the reference game ([0020]).
9. **Early measurements that can change numbers:** the CI workflow with SwiftShader (spike B) is added in the milestone that lands the first GPU test, never in milestone 1 (if that is the zero-GC harness, Phase 2 may give the workflow its own session directly after it); first on-device run (iPhone: determinism page, arena reservation, fill-rate, anchoring) as soon as the slice renders; Durable Objects feasibility any time after the server entrypoint. Schedule each explicitly; none blocks the slice.
10. **Each milestone fits one session** and names its spec/ADR reading list, exit criteria and verifying commands (`docs/process.md`); skills and rule files attach to the milestone that makes them real ([0021]).

## 9. Risks (ranked)

| # | Risk | L / I | Mitigation | Trigger: it has happened when |
|---|---|---|---|---|
| 1 | **Real-iPhone behaviour is untested**: WASM determinism on device, terrain fill-rate, memory ceiling (148 MiB of arenas + GPU under WebKit's ~300 MB kill line), DOM anchoring, posted `Module`, OPFS latency, worker-socket resume | M / H | Manual checklist from the first rendering milestone ([0020] §10); stated fallbacks: render-scale cap 1.5 → 1, drop neighbour reads, per-chunk quads ([0018]); smaller arenas by config ([0015]); per-anchor `translate()` ([0019]); `instantiateStreaming` in the worker ([0017]) | golden hash differs on the phone; < 60 fps or GPU > 6 ms at max zoom-out; tab reloads under play; anchors swim |
| 2 | **Prediction open problems** (provisional ids, `NotPredictable` taint, overlay → renderer change list, host atomicity, timer completion gap, iterating reads) | H / M | Interim rule: address by tile; decide provisional ids in Phase 2 and the taint rule in the prediction milestone; ship the unpredicted round trip first so prediction is additive ([0012], [0003]) | an action needs an `EntityId` of a predicted entity; local reject while host accepts in tests; ghost flicker on ack |
| 3 | **128-chunk cap is tight at maximum zoom-out**: a square 256-tile view needs 121 chunks for ring 1 alone, leaving 7 for look-ahead and hysteresis | H / L–M | Known Phase 3 tuning item: eviction already degrades to farthest-first ([0010]); options are a lower default max zoom, a larger cap, or look-ahead only below a zoom threshold. Cap and zoom range both come from a Requirement, so changing either default goes to Tyler | chunk enter/leave churn or late chunks while panning at full zoom-out in the netcode byte counters |
| 4 | **WebGPU wrapper-object floor and Safari/Firefox differences**: the floor (≈ 104–118 B/frame) is browser-owned and measured in desktop Chromium only; `writeBuffer` from a SAB view and texture-as-view are unverified elsewhere; no GC instrument outside Chromium | M / M | Budget by formula in one budgets file ([0016]); constant wrapper count per frame ([0018]); manual Safari/Firefox run of the harness shape; iOS "by feel" checklist | Chrome update moves the clean number past 110; validation error on Safari; visible periodic hitch on iOS |
| 5 | **Durable Objects feasibility unverified** (CPU accounting for timer ticks, timer accuracy, 128 MB headroom, restart frequency) | M / L | DO is the second target; design assumes nothing DO-specific; Node/Bun on Fly meets the cost target alone ([0009]) | feasibility check shows ticks billed or throttled beyond the $5 target, or < 96 MiB usable |
| 6 | **SwiftShader CI unverified** (spike B): flags, packages, speed (58 ms/frame locally on a 4096-quad scene), agreement with Metal | M / M | Software-adapter form of the GC assertion is decided ([0016] caveat b); fallbacks: Dawn node bindings for readback, or GPU tests local-only ([0020]) | null adapter or timeouts on `ubuntu-latest`; probe mismatches beyond tolerance |
| 7 | **Dev-loop and suite budgets are floors from trivial crates**; real sim + serde + fat LTO may exceed 30 s / 60 s | M / M | Dev profile in the fast tier, crate split as first lever, intermediate profile, demotion rule ([0017], [0020]) | suite warning (> budget) or failure (> 1.5x) in `pnpm test`; rebuild > 30 s |
| 8 | **`Tracing.start` stall** (~10 s in 4/570 spike runs; 0/400 with `--disable-features=SpareRendererForSitePerProcess`, suggestive not proven) | L / L | Flag is in the config; harness times the call and reports a named warning, not a failure ([0016]) | browser suite sporadically ≈ 10 s over budget with that warning |
| 9 | **Vite pattern-A symlink caveat**: `vite dev` + engine reached through a symlink with no workspace-root marker puts the worker URL outside `server.fs.allow` | L / L | Root `pnpm-workspace.yaml` avoids it here; plugin appends the engine dir to `fs.allow` (untested); pattern B is the documented escape ([0017]) | "outside of Vite serving allow list" in the Vite log; worker `error` before ready |
| 10 | **Whole-value puts or frame sizes exceed the bandwidth budget** on a busy base; network figures are assumptions | L–M / M | Byte counters in the netcode suite from the first encoder; engine-side byte diffing is ready as a non-API change ([0011], [0010]) | bytes per client per tick above the budgets file ([0020] §9); soft cap degrade engaged in the reference game |
| 11 | **Deprecated CDP call** (`Target.sendMessageToTarget`) removed by a Chrome update | L / M | Own CDP WebSocket with flattened sessions ([0016]); negative controls turn the suite red rather than silently blind | worker sessions fail to attach after a Playwright/Chromium bump |
| 12 | **Game-author determinism slips** (HashMap, std transcendentals, NaN) | M / L | Lints, allowlist, heavy mode, cross-engine goldens ([0002]) | heavy-mode or golden mismatch naming the first divergent tick |

## 10. Unknowns deliberately deferred

Every item an ADR or spec file marks "Deferred". "2" = Phase 2 decides it in `PLAN.md`; "2→3" = Phase 2 can only schedule it (needs code or a device); "3" = measured during execution.

| Item | Why deferred | Owner | Phase |
|---|---|---|---|
| Typed fast path + quantized deltas for continuous action streams | no planned game needs them; log format unaffected | [0001], [0004] | 2 |
| Presence as an optional replay track | cosmetic | [0001] | 2 |
| Determinism run on real x86-64, physical iPhone and Android | spike had emulation and desktop builds only; first CI milestone closes x86 | [0002] | 2→3 |
| Whether `+simd128` and `wasm-opt` may be enabled for the sim module | unmeasured; both stay off | [0002] | 2→3 |
| Provisional ids for predicted entities (stable key vs id rewriting) | depends on final action shapes and whether the engine may see inside `G::Action` | [0012], [0003] | 2 |
| Taint rule after a `NotPredictable` pending action | needs tests against the real pending queue, i.e. code | [0012], [0003] | 3 |
| Per-action growth declaration, so shrinking actions pass the state-budget check in a full world | adds a `Game` hook; belongs with the other `apply` items | [0004], [0007] | 2 |
| Per-frame overlay change list + `predicted` flag for the renderer | depends on the DrawList design | [0012], [0003] | 2 |
| Host-side atomicity of `apply` via an undo journal (asserted until then) | cost unmeasured | [0012], [0003], [0004] | 2→3 |
| Own-timer completion gap of one RTT | UX call that needs the running game | [0012], [0003] | 2→3 |
| Lead (clock) estimation; iterating/range reads over replica + overlay; `entity(id)` "gone" vs "unsubscribed" | spike built none of them | [0012], [0003] | 2 |
| Exact `TickCx`, `FrameCx`, `FrameView`, `OldStore` shapes | need design choices the spike did not make; no second schema exists | [0003], [0005], [0019], [0018] | 2 |
| Final check of reference-game feature coverage against the engine feature list | list is fixed only when `PLAN.md` defines milestones | `docs/spec/reference-game.md`, [0003] | 2 |
| OPFS append/flush latency on iOS Safari | only tunes the 1 s sync interval; needs a device | [0005] | 2→3 |
| Helper that rescales `Tick`/`Ticks` fields during `migrate` | depends on `OldStore`; no world needs it | [0006] | 2 |
| Entity store layout and `EntityId` reuse policy | depends on the provisional-id decision | [0007] | 2 |
| Overlay promotion to dense at 512 entries; bucketed per-chunk area effects | no v1 rule needs them | [0007] | 2 |
| On-device validation of the 64 MiB world-budget split | no engine code to measure | [0007] | 2→3 |
| ms per chunk on a real iPhone and mid-range Android (revisits 1 ms budget, worker count) | no dev server existed to serve the driver page | [0008] | 2→3 |
| Sampled pristine-hash check between client and server | golden-hash test catches the cause first | [0008] | 2 |
| Whether noise helpers move from the reference game into the engine crate | algorithm is the game's; only one game exists | [0008] | 2 |
| Durable Object adapter and feasibility check | gates only whether DO is a supported host | [0009] | 2→3 |
| WebTransport adapter | no target server runtime ships it | [0009] | 2 (revisit) |
| Real frame sizes against the bandwidth budget | no encoder exists | [0010] | 2→3 |
| Engine-side byte diffing of old vs new values | should follow a measurement on a busy furnace field | [0011] | 2→3 |
| Exact section ids, varint coordinate coding, overlay run format | fixed by the first encoder and its golden-bytes tests | [0011] | 2→3 |
| "Copy my player link" identity escape hatch | Tyler accepted no cross-device recovery for now | [0013] | 2 |
| How iOS Safari reports a worker-owned socket after resume | needs a phone; only tunes the 3 s timeout and probe | [0013] | 2→3 |
| Final export list per role, region ids and sizes, status codes | follow from the module breakdown in `PLAN.md` | [0014] | 2 |
| Where `engine.log` text is decoded | dev ergonomics only | [0014] | 2 |
| On-device memory ceilings (largest reservation, sim + client + WebGPU coexisting, untouched pages) | needs Tyler's devices | [0015] | 2→3 |
| Ring capacities, uplink poll period, control-block layout, `yield` protocol | implementation numbers behind a fixed mechanism | [0015] | 2 |
| Verifying COOP/COEP listings on one real static host | the spike could not deploy | [0015] | 2→3 |
| Whether the periodic snapshot `write` is inside the strict zero-GC window (default: inside; log `append`/`sync` are inside by construction, [0005]) | its rename uses promise-only OPFS calls; no persistence code or measurement | [0016] | 2→3 |
| Final main-thread B/frame number and overlay-anchoring string constant | depend on the real renderer's wrapper count | [0016] | 3 |
| Software-adapter form of assertion B (scene, N, per-function numbers) | SwiftShader on a runner unmeasured | [0016] | 3 |
| Untested by the packaging spike, first exercised in Phase 3: the plugin's `server.fs.allow` entry; recursive `fs.watch` on Linux/Windows; real Safari with a posted `Module`; `ts-rs` adding zero bytes | the spike ran on macOS with a tarball install and Playwright WebKit only | [0017] | 3 |
| Whether `crates/` holds one crate or several | follows the module breakdown; first lever if the dev loop slows | [0017] | 2 |
| Real release build time and size; intermediate profile; `debug = "line-tables-only"`; snapshot → reload → restore on Rust edit | need a real sim | [0017] | 3 |
| Zero-GC harness shape run by hand in Safari and Firefox | CDP instrument is Chromium-only | [0018] | 2→3 |
| Terrain shader fill-rate on real phones (manual check, fallbacks stated) | phones cannot be automated; no shader yet | [0018], `docs/spec/client.md` | 2→3 |
| Exact WGSL, manifest JSON schema, upload-ring record layout, worker frame clock | implementation details, no cross-domain effect | [0018] | 2 |
| Overlay anchoring on iOS Safari (manual check, fallback stated) | phones cannot be automated | [0019], `docs/spec/client.md` | 2→3 |
| "Follow with user offset" (a follow target currently disables panning entirely) | needs a later decision; no v1 game feature asks for it | [0019] | 2 |
| Input-ring record layout, easing curves, wheel constants, `FrameCx` shape | tuning or implementation details | [0019] | 2 |
| Spike B: SwiftShader WebGPU on a stock `ubuntu-latest` runner | local loop proven, fallback known; runs with the first CI workflow | [0020], `docs/spec/testing.md` | 3 |
| Spike C: byte-identical traces over loopback `ws` | in-memory path is deterministic by construction | [0020] | 3 |
| Measuring the 30 s rebuild and per-suite numbers; sccache vs shared `CARGO_TARGET_DIR` | no code to measure | [0020] | 3 |

**Gaps found while writing this file** (no ADR states them; small, Phase 2 decides inside the relevant milestone): the `createClient` option that selects single-player (it forwards a `WorldConfig`, [0009]) vs a server URL; how `client.input` events and the input ring surface inside `FrameCx`; how the main thread learns `Welcome.last_processed_action_seq` to seed `seq` (a field of the clock seqlock block is the obvious carrier); whether `dispatch` before `Welcome` queues or fails; the `TileTexel::from_tables` registration call; where test files live (one `tests/` tree vs per package).

## 11. Items awaiting Tyler

1. **Sign-off on `serde_json`** in the engine crate, which goes beyond the approved `serde` + `postcard` (+ `ts-rs` at build time) list. It parses UI-dispatched action JSON and one-time config inside the client/sim WASM; alternatives and why they lose are in [0003]. Related, for the same sign-off: `ts-rs` is declared as a normal dependency whose code LTO removes (the size test watches it), and `libm` would be added pinned only if the engine ever needs a transcendental ([0017] §7).
2. **Proposed amendment to the zero-GC Requirement wording** in `docs/spec/testing.md`: the net worker cannot be "approximately zero allocation" because the WebSocket API allocates a `MessageEvent` + `ArrayBuffer` per message; [0016] budgets it at ≤ 1 KB per message with zero major GCs and confines it to its own heap. The same edit could replace "about 100 B/frame" with the measured main-thread floor (≈ 104–118 B/frame in production shape; test budget 110). Until Tyler edits the Requirement, [0016] is the operative reading.
3. **Environment:** accept the Xcode license (`sudo xcodebuild -license accept`) so native `cargo test` and the `ts-rs` bindings step link, or confirm the runner keeps exporting `DEVELOPER_DIR=/Library/Developer/CommandLineTools` ([0020] §10).
4. **Proposed amendment to the Requirement wording on deltas and prediction.** `docs/spec/sync.md` (Requirements, "The engine abstracts this: the game defines the data model, the deltas, and the interpolation and prediction logic") and `docs/spec/overview.md` (engine/game table, game column: "Delta definitions, interpolation and prediction logic"; Fixed decisions: "worldgen, actions, tick rules, deltas, prediction") give the game more than [0003], [0011] and [0012] do. Backed by `spikes/prediction-api`, the engine derives deltas from `WorldWrite` puts and prediction from the shared `apply`, and owns interpolation; the game defines only data, rules, presence, and optional `predict()` opt-outs. Until Tyler edits the Requirements, the ADRs are the operative reading. Proposed text:
   - `sync.md`: "The engine abstracts this: the game defines the data model (actions, entities, per-player and global state, presence) and the rules (`apply` and tick rules). The engine derives deltas from the rules' writes, predicts by re-running the same `apply` on the client, and interpolates remote motion. The game writes no delta types and no separate prediction or interpolation logic; it may opt individual actions out of prediction."
   - `overview.md` table, game column: "Replicated data types, the presence type, per-action prediction opt-outs"; engine column: "Transport, delta derivation and delivery, the interpolation/prediction machinery".
   - `overview.md` Fixed decisions: "(worldgen, data types, actions, tick rules, presence, client-side view code)".
5. **Collect range has no number.** `docs/spec/reference-game.md` says "within a certain distance"; [0001] checks `dist(from, tile) <= RANGE`. Proposed default: **3 tiles** (centre of the player circle to the centre of the resource tile), to be recorded in the Requirement.
6. **Devices for the manual checklist:** [0018], [0008] and [0015] assume one iPhone (12-class or newer, iOS 26+) and one mid-range 4 GB Android phone. Does Tyler have the Android device, or is Android checked on desktop Chrome only?
7. **Accounts and spend for two deferred checks:** a Cloudflare Workers paid plan ($5/month) for the Durable Objects feasibility check ([0009]) and one real static host deploy to verify the COOP/COEP listings ([0015]); plus a Fly machine if the cost target is to be verified rather than computed.
8. **Heads-up, no action yet:** if Phase 3 tuning of risk 3 needs a different default maximum zoom or subscription cap, that changes numbers stated in the Requirements of `docs/spec/client.md` and will come back as a question.

[0001]: docs/decisions/0001-camera-and-presence.md
[0002]: docs/decisions/0002-determinism-same-wasm-everywhere.md
[0003]: docs/decisions/0003-game-facing-api.md
[0004]: docs/decisions/0004-action-timing-and-rejection.md
[0005]: docs/decisions/0005-persistence-and-recovery.md
[0006]: docs/decisions/0006-time-units.md
[0007]: docs/decisions/0007-world-model.md
[0008]: docs/decisions/0008-chunk-generation.md
[0009]: docs/decisions/0009-transport-and-hosting.md
[0010]: docs/decisions/0010-rates-and-subscriptions.md
[0011]: docs/decisions/0011-wire-format-and-deltas.md
[0012]: docs/decisions/0012-prediction-and-reconciliation.md
[0013]: docs/decisions/0013-sessions-and-integrity.md
[0014]: docs/decisions/0014-js-wasm-boundary.md
[0015]: docs/decisions/0015-threads-memory-and-topology.md
[0016]: docs/decisions/0016-zero-gc-definition.md
[0017]: docs/decisions/0017-packaging-and-build.md
[0018]: docs/decisions/0018-renderer.md
[0019]: docs/decisions/0019-camera-input-and-overlay.md
[0020]: docs/decisions/0020-testing-strategy.md
[0021]: docs/decisions/0021-context-architecture.md
[0022]: docs/decisions/0022-entity-ids-and-provisional-ids.md
[0023]: docs/decisions/0023-action-growth-declaration.md
[0024]: docs/decisions/0024-planning-amendments.md
[0025]: docs/decisions/0025-phase-3-orchestration.md
[0026]: docs/decisions/0026-zero-gc-burst-controls-in-slow-tier.md
