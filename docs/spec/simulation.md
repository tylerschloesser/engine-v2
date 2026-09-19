# Simulation and persistence

## Requirements

- The game is a tick-based simulation.
- The sim runs in the cloud (multiplayer) or in a web worker (single-player). Same sim code either way.
- All actions are serialized and sent as messages.
- The world is deterministic: given the original simulation code, the original seeds and parameters, and all actions with their timings, the world can be reconstructed exactly.
- The sim tracks which players are connected and what each is seeing (camera position + viewport), so it knows which chunks each player is subscribed to.
- Some actions are engine-defined and engine-managed (connection); others are game-defined (see `reference-game.md`).
- Camera + viewport updates are not actions and never mutate the world (see Fixed decisions in `overview.md`). They feed subscriptions only, so they are neither logged nor needed for replay.
- The engine manages data storage: something appropriate in the browser ("localStorage or whatever"), something appropriate on the server.
- The world only needs to be persisted occasionally, for crash recovery.
- Actions are stored indefinitely so the world can be replayed.

- **Idle worlds.** A multiplayer world pauses at zero connected players (a per-game flag can keep it ticking). A single-player world pauses when the tab is hidden. No offline progress.
- **Upgrades may invalidate saves** during prototyping: saves and logs are version-stamped, a mismatch produces a clean "save incompatible" error, and a game may supply an optional `migrate` hook. Old sim binaries are not archived.
- **Save export/import** at the engine level is in scope (protection against browser storage eviction, and the path from a single-player world to a hosted one). Game UI for it is optional.

Tick rate lives in `sync.md`.

## Open questions

- **Game-facing API.** Decided in [0003](../decisions/0003-game-facing-api.md) (which lists the sub-problems deferred to Phase 2).
- **Determinism in practice.** Decided in [0002](../decisions/0002-determinism-same-wasm-everywhere.md).
- **Action timing and ordering.** Decided in [0004](../decisions/0004-action-timing-and-rejection.md) and [0012](../decisions/0012-prediction-and-reconciliation.md).
- **Replay vs. code changes.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Snapshots.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Storage.** Decided in [0005](../decisions/0005-persistence-and-recovery.md) and [0009](../decisions/0009-transport-and-hosting.md).
- **Time units.** Decided in [0006](../decisions/0006-time-units.md).
- **Single-player world later hosted as multiplayer.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Log growth.** Decided in [0004](../decisions/0004-action-timing-and-rejection.md); why nothing camera- or position-derived is logged: [0001](../decisions/0001-camera-and-presence.md).
- **Browser durability.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Sim crash recovery.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Snapshot schema evolution.** Decided in [0005](../decisions/0005-persistence-and-recovery.md).
- **Idle worlds (replay safety).** Decided in [0005](../decisions/0005-persistence-and-recovery.md) and [0013](../decisions/0013-sessions-and-integrity.md).
