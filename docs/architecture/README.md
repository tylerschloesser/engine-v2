# Architecture

A multiplayer web game engine for one genre: top-down, tile-based, tick-simulated automation and crafting games on an infinite procedurally generated grid (Factorio-likes). The engine owns the hard reusable parts; a game supplies content and rules. The repo holds the engine and one small reference game that exercises every engine feature. The guiding idea: the game defines *what* (data and rules); the engine pieces it together and handles *when and where* it runs.

## Engine and game

The engine owns:

- Camera, viewport and most user input (pan, zoom, gestures).
- Which chunks a client sees and subscribes to; async chunk generation requests; chunk lifecycle.
- WebGPU rendering.
- The tick loop and scheduling; running the sim in a worker (single-player) or on a server (multiplayer).
- Engine-defined player events (`PlayerEvent::{Joined, Connected, Disconnected}` in `crates/engine/src/game.rs`, logged and replayed like actions), and the connected players with their chunk subscriptions.
- Transport, delta derivation and delivery, interpolation and prediction machinery.
- Persistence (snapshots plus action log) and replay.

A game supplies, as one Rust crate implementing the `Game` trait (`game.rs`): the worldgen algorithm (`type Worldgen`), the data model (`Entity`, `Player`, `Global`), the rules (`apply`, `on_player`, `genesis`), the game-defined `Action` and `Reject` types, the `Presence` type, per-action prediction opt-outs, and per-game constants (`CHUNK_BITS`, `TICK_RATE`, `SCHEMA_VERSION`). It also supplies the client-side view code (`ClientSide`), tile art and assets, and the game UI.

The game crate and the engine crate link into one WASM module, so the engine cannot ship a prebuilt binary; the game's build produces it (`packages/engine/src/build-game.ts`, `engine/vite`). A reference-style game has three parts:

- A Rust crate (`games/reference/sim`).
- A TS client (`games/reference/src`: Vite app, `createClient`, a DOM overlay UI in `src/ui`).
- A server entry (`games/reference-server`: `index.mjs` for Node, `bun.ts`, `deno.ts`, loading the built `game.wasm`/`game.json`).

TypeScript is for bootstrapping and UI. Sim code is Rust and deterministic: [determinism rule](../../.claude/rules/determinism.md).

## Fixed decisions (Tyler's)

- pnpm monorepo, TypeScript on the JS side, Rust to WASM for everything that reasonably can be. The accepted exception is the main thread: the renderer's WebGPU calls, the camera and input handling are TypeScript, and no WASM runs there ([threads-and-boundary](threads-and-boundary.md), [renderer](renderer.md)).
- Game authors write simulation logic in Rust (worldgen, data types, actions, tick rules, presence, client-side view code).
- The engine is the single npm package `engine` (`packages/engine`, private for now, with the Rust crate bundled via `files`), with zero runtime npm dependencies (`dependencies: {}`) and several entrypoints: `.` (client), `./worker`, `./server`, `./server/node`, `./server/bun`, `./server/deno`, `./vite`, `./render`, `./test`. The `ws` library is injected by the game (the reference server depends on it, the engine does not). Rust crate policy: `serde`, `postcard`, `serde_json` and `ts-rs` are allowed (approved by Tyler, 2026-09-19); anything else needs an ADR. Stable Rust only, so no WASM threads. See [runtime-and-hosting](runtime-and-hosting.md), [0017](../decisions/0017-packaging-and-build.md).
- The reference game is a separate, private package: Vite plus a simple game (`games/reference`).
- Custom WebGPU renderer; no rendering library. No fallback renderer.
- WebSockets for multiplayer ([0009](../decisions/0009-transport-and-hosting.md)).
- Game UI is a game-owned DOM overlay; the engine renders no UI widgets (guarded by `src/no-engine-ui.test.ts`). It supplies world-to-screen transforms, picking and low-GC state observation ([camera-input-overlay](camera-input-overlay.md), [client-api](client-api.md)).
- The camera never mutates the world and is not an action. The sim's host uses each client's camera and viewport only to decide chunk subscriptions; only actions change the world ([0001](../decisions/0001-camera-and-presence.md), [0010](../decisions/0010-rates-and-subscriptions.md)).
- The server entrypoint is agnostic to where it is hosted: one long-lived single-threaded JS context with `WebAssembly`, a timer and clock, all of a world's connections in that context, and injected storage. A host that cannot pin a world's connections to one instance is out of scope ([0009](../decisions/0009-transport-and-hosting.md), [runtime-and-hosting](runtime-and-hosting.md)).
- Cross-origin isolation is mandatory for every game (COOP `same-origin` plus COEP `require-corp`), so SharedArrayBuffer is always present; there is no `postMessage` fallback. `checkSupport` (`src/support.ts`) reports `not-isolated` otherwise ([0015](../decisions/0015-threads-memory-and-topology.md)).

## Scale, trust, platforms

- 2 to 8 players per world, friends co-op. `MAX_PLAYERS_LIMIT = MAX_CONNS / 2 = 8` in `src/server.ts`; `MAX_CONNS` is 16 there and in `crates/engine/src/host`, the spare half being reconnect headroom ([0053](../decisions/0053-connection-slots-and-full-admission.md); [0013](../decisions/0013-sessions-and-integrity.md)). `WorldConfig.maxPlayers` (`src/sim-config.ts`) defaults to that limit.
- One process per world; a server process hosts exactly one world, created or loaded at startup. Mapping URLs to worlds is the deployer's problem.
- The world fits in memory. Coordinates are unbounded; the cap applies to materialized chunks held in memory (budgets in `SimConfig` such as `worldBudgetBytes`, and `cacheChunks`; [0007](../decisions/0007-world-model.md), [world-and-worldgen](world-and-worldgen.md)). Chunk size is per game (`Game::CHUNK_BITS`, default 5, so 32x32 tiles).
- Baseline phone: iPhone 12-class or 4 GB Android, with a 256 MiB whole-tab target ([0015](../decisions/0015-threads-memory-and-topology.md)). Default arenas (`DEFAULT_ARENA_BYTES`, `src/client.ts`): sim 96 MiB, client 48 MiB, gen 4 MiB. 64 MiB is the world-budget target the sim arena is sized around; `worldBudgetBytes` defaults to `u32::MAX`, so nothing is enforced unless a game sets it ([0007](../decisions/0007-world-model.md), [0062](../decisions/0062-budgets-as-measured-at-phase-3-exit.md)). Game `.wasm` budget is 1 MB brotli (warn) and 2 MB (fail) (`packages/engine/budgets.json`).
- Both of these are configurable per game: the zoom range (default 12 to 256 tiles across the long axis, `DEFAULT_MIN_TILES`/`DEFAULT_MAX_TILES` in `src/camera/camera.ts`) and the subscription cap `view.maxChunks` (default 144, `CAP_CHUNKS` in `host/subs.rs`).
- Browsers: Tier 1 is the current and previous major Chrome (desktop, Android) and Safari (macOS, iOS 26+); Tier 2 is Firefox desktop. Anything else gets a capability screen built from `checkSupport` failure codes (the reference game's `src/ui/capability.ts`). Design inside the WebGPU compatibility-mode subset; no testing commitment for such devices. Device-only checks run by hand: [device-check skill](../../.claude/skills/device-check/SKILL.md).
- Server runtimes: Node 22.18 or newer and Bun are tested (the `wasm` suite has a `bun` leg); Deno is best-effort.
- Trust: server-authoritative validation of actions is enough; no further anti-cheat. A player is an opaque id plus a device-local secret; access is a join key in the invite link ([sync-and-netcode](sync-and-netcode.md)).
- Networks: decent modern mobile connections, neither worst case nor great 5G.

## Non-goals

Confirmed by Tyler, 2026-09-19:

- Accounts, auth, matchmaking, lobbies.
- Audio.
- A non-WebGPU rendering fallback.
- Modding or loading game code at runtime.
- More than one world per server process.

## Glossary

- **Engine**: the `engine` package plus its Rust crate (`packages/engine`). **Game**: the engine's consumer, a crate implementing `Game` plus a client (the reference game is `games/reference`).
- **Sim**: the deterministic tick simulation: `GameInstance` (`crates/engine/src/game_instance.rs`) driven by the sim host (`crates/engine/src/host`, `src/worker/sim.ts`). It runs in a web worker (single-player) or in a server process (multiplayer: `src/server.ts`).
- **Client**: everything in the browser that is not the sim: input, camera, replica and sync layer, renderer, overlay (`src/client.ts`, `src/client/`, `src/camera`, `src/input`, `src/render`).
- **Action**: a serialized message of player intent (`Game::Action`) and the only way to change the sim from outside. Game-defined; the engine's own inputs are `PlayerEvent`s.
- **Delta**: a viewport-scoped state update from the sim to one client (`crates/engine/src/delta.rs`, `wire/`).
- **Chunk**: a square of tiles (`1 << CHUNK_BITS` per side): the unit of generation, subscription and streaming (`world/coords.rs` `ChunkCoord`).
- **Presence**: a per-player engine channel carrying a small game-defined sample (at most 32 encoded bytes; camera state rides it, [0001](../decisions/0001-camera-and-presence.md)) (`presence.rs`).
- **Host**: the object running a sim for one world and its connections (`crates/engine/src/host`); **replica**: a client's local copy of subscribed state.

## Docs index

- [world-and-worldgen](world-and-worldgen.md): chunks, coordinates, worldgen, the world cap.
- [simulation](simulation.md): tick loop, actions, apply.
- [sync-and-netcode](sync-and-netcode.md): wire, sessions, prediction, reconciliation, integrity.
- [persistence](persistence.md): snapshots, action log, recovery, export and import.
- [threads-and-boundary](threads-and-boundary.md): workers, SharedArrayBuffer, the `extern "C"` ABI.
- [renderer](renderer.md): WebGPU renderer.
- [camera-input-overlay](camera-input-overlay.md): camera, input, overlay anchoring.
- [client-api](client-api.md): the client API and engine events.
- [runtime-and-hosting](runtime-and-hosting.md): server adapters, packaging, build, hosting.
- [testing-and-tooling](testing-and-tooling.md): suites, goldens, gc tests, device checks.
- Reference game: [`games/reference/README.md`](../../games/reference/README.md).
- Decisions (the why): [`docs/decisions/README.md`](../decisions/README.md). Invariants: `.claude/rules/` (determinism, hot paths, prediction).

## Where code lives

- `packages/engine/src`: engine TypeScript (client, camera, input, render, host, net, sab, storage, server adapters); nested `CLAUDE.md` files give per-directory notes.
- `packages/engine/crates/engine`: the Rust crate (`Game` trait, sim, world, wire, session, predict, interp, persist, host, `abi`).
- `packages/engine/fixtures`: small game crates and recorded data used by tests (goldens, migrations, presence, prediction).
- `packages/engine/tests`: `browser` (Playwright), `netcode`, `wasm` (runtime legs), `support`.
- `games/reference`: the reference game (`sim/` crate, `src/` client, `world.json`).
- `games/reference-server`: the Node/Bun/Deno server entry and Fly image for the reference game.
- `scripts`: `pnpm test`/`lint`/`setup:tools` runners; suites are registered in `scripts/suites.mjs`.
