# Spec overview

Read this first. Domain details are in the sibling files.

## Goal

A multiplayer web game engine for one genre Tyler likes to prototype: top-down, tile-based, tick-simulated automation/crafting games on an infinite procedurally generated grid (Factorio-likes). The engine owns the hard reusable parts; each game supplies content and rules. The repo contains the engine and one small reference game that exercises every engine feature.

## Engine vs. game

| Engine owns | Game owns |
|---|---|
| Camera, viewport, and most user input (pan, zoom, gestures) | World generation algorithm (noise, biomes, resources) |
| Knowing which chunks are visible/subscribed; requesting async chunk generation; chunk lifecycle | Tile art and assets |
| WebGPU rendering | Data model (tiles, entities, player state) |
| Tick loop and scheduling; running the sim in a worker or on a server | Simulation rules and game-defined actions |
| Engine-defined actions (connect/disconnect). Camera + viewport are *not* actions: see below | Delta definitions, interpolation and prediction logic |
| Connected players and their chunk subscriptions | Game UI (DOM overlay) |
| Transport, delta delivery, the interpolation/prediction machinery | Per-game config (chunk size, world cap, etc.) |
| Persistence (snapshots + action log) and replay | |

Guiding idea: the game defines *what* (data and rules); the engine pieces everything together and handles *when and where* it runs.

## Fixed decisions (Tyler's)

- pnpm monorepo. TypeScript on the JS side. Rust→WASM for everything that reasonably can be. Accepted exception: the renderer's WebGPU calls, the camera, and input handling are TypeScript on the main thread (see `client.md`).
- **Game authors write simulation logic in Rust** (worldgen, actions, tick rules, deltas, prediction). The game crate and engine crate compile into one WASM module. TypeScript is for bootstrapping and UI.
- The engine is the single published npm package, with **zero runtime npm dependencies** and multiple entrypoints (main thread, worker, server). See `runtime-and-packaging.md`.
- The reference game is a separate, private package: Vite plus a simple game.
- Custom WebGPU renderer; no rendering library.
- WebSockets for multiplayer unless research finds something clearly better.
- Game UI is a game-owned DOM overlay; the engine renders no UI widgets.
- **The camera never mutates the world, and is not an action.** It is deliberately non-mutating so that it can live independently of the sim: the sim's host uses each client's camera + viewport only to decide chunk subscriptions. Only actions change the world.
- The server entrypoint should be agnostic to where it's hosted, as defined under Hosting in `sync.md`.

## Scale and trust

- 2–8 players per world: friends playing co-op. One process per world.
- The world fits in memory.
- Server-authoritative validation of actions is enough; no further anti-cheat.
- Networks: assume decent, modern mobile connections. Not worst-case, not great 5G.

## Non-goals

Confirmed by Tyler (2026-09-19).

- Accounts/auth (a player is an opaque ID/token; see Sessions in `sync.md`), matchmaking, lobbies.
- Audio.
- A non-WebGPU rendering fallback.
- Modding or loading game code at runtime.
- More than one world per server process.

## Glossary

- **Engine**: the published package + Rust crate(s). **Game**: the engine's consumer (e.g. the reference game).
- **Sim**: the deterministic tick simulation, in a web worker (single-player) or on a server (multiplayer).
- **Client**: everything in the player's browser that isn't the sim: input, camera, state sync layer, renderer, UI.
- **Action**: a serialized message expressing player intent; the only way to change the sim from outside. Engine-defined or game-defined.
- **Delta**: a viewport-scoped state update sent from the sim to a client.
- **Chunk**: a fixed-size square of tiles; the unit of generation, subscription, and streaming.
