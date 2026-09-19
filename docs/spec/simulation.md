# Simulation and persistence

## Requirements

- The game is a tick-based simulation.
- The sim runs in the cloud (multiplayer) or in a web worker (single-player). Same sim code either way.
- All actions are serialized and sent as messages.
- The world is deterministic: given the original simulation code, the original seeds and parameters, and all actions with their timings, the world can be reconstructed exactly.
- The sim tracks which players are connected and what each is seeing (camera position + viewport), so it knows which chunks each player is subscribed to.
- Some actions are engine-defined and engine-managed (connection, camera/viewport); others are game-defined (see `reference-game.md`).
- The engine manages data storage: something appropriate in the browser ("localStorage or whatever"), something appropriate on the server.
- The world only needs to be persisted occasionally, for crash recovery.
- Actions are stored indefinitely so the world can be replayed.

Tick rate lives in `sync.md`.

## Open questions

- **Game-facing API.** The shape of the Rust traits a game implements (state, actions, tick, worldgen, deltas, prediction), and how the TypeScript side (UI, action dispatch) gets matching types: codegen, a schema, or hand-written?
- **Determinism in practice.** Float behavior in WASM across browser engines and versus a native build, NaN canonicalization, RNG, iteration order of collections, and no wall-clock or ambient input inside the sim. Does the server run the same WASM module (safest for bit-identical results) or a native build of the same crates?
- **Action timing and ordering.** Who assigns an action's tick (the server on receipt?), ordering among players within a tick, validation and rejection of invalid actions, and how rejections reach the client's prediction layer.
- **Replay vs. code changes.** A log only replays against the sim version that produced it. Version-stamp logs and snapshots; decide what happens on upgrade (snapshot at the boundary and start a new log segment?).
- **Snapshots.** Format, cadence, and consistency with the log (snapshot at tick N + actions after N). Does "indefinitely" allow compaction behind a snapshot, or is the full log kept from tick 0?
- **Storage.** Browser: OPFS (sync access handles work in workers) vs. IndexedDB; quotas and eviction; localStorage is almost certainly too small and blocks the main thread. Server: a minimal storage interface that stays host-agnostic.
- **Time units.** Game durations are authored in seconds but the sim counts ticks; define the conversion so changing the tick rate doesn't change game feel.
- Can a single-player world later be hosted as multiplayer (same snapshot + log format)? Nice to have.
