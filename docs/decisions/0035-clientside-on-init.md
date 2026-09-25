# 0035: `ClientSide::on_init` gives a client its own world's seed and params once

Status: Accepted (2026-09-25). Amends the `ClientSide` trait block of [0003](0003-game-facing-api.md)'s Decision section. Implemented in M20b (`docs/plan/20b-reference-player-and-collect-ui.md`, gate round 1 fix).

## Context

`ClientSide<G>: Default` ([0003](0003-game-facing-api.md)) is constructed with no arguments, so a client instance has no channel to learn the seed or [`Worldgen::Params`](0008-chunk-generation.md) its own world was created with. `RefClient`'s spawn rule (`docs/plan/20b-reference-player-and-collect-ui.md` Scope: "`RefClient` finds the land tile nearest the origin by spiralling over its own terrain function") had no such channel either, so it computed `nearest_land_tile` against a hard-coded duplicate of the world's real seed and params (`content::SEED`, `RefParams::default()`) baked into `Default`/`with_spring_state`. That value is correct only by coincidence, for the one seed the constant happens to match, and wrong for any other world the same game code might run.

M20b's gate found this by way of a test that could not fail: under `content::SEED` + `RefParams::default()`, tile `(0, 0)` is land regardless of seed (the noise function's height channel reads exactly `0.0` at the origin lattice point), which is also `nearest_land_tile`'s own `unwrap_or(TilePos::new(0, 0))` fallback and `CameraState`'s own default centre. A test asserting spawn `== (0, 0)` cannot distinguish a working search, a broken search hitting its fallback, and no search having run at all.

## Decision

**One provided hook on `ClientSide`, called exactly once:**

```rust
pub trait ClientSide<G: Game>: Default {
    // ...existing methods (frame, extract, tile_visual, ui)...

    /// Called exactly once, right after `Default::default()` constructs this client, before
    /// anything else calls `frame`/`extract`/`ui`: the seed and worldgen params this instance's
    /// own world was created with. No-op by default.
    fn on_init(&mut self, _seed: u64, _params: &<G::Worldgen as Worldgen>::Params) {}
}
```

`ClientInstance::init` (`packages/engine/crates/engine/src/game_instance.rs`) builds the client with `G::Client::default()`, calls `client.on_init(cfg.seed.0, &cfg.params)`, and only then constructs `Pristine::<G::Worldgen>::new(cfg.seed.0, cfg.params)` — `on_init` must run first because `Worldgen::Params` is not required to be `Clone`, so the call borrows `cfg.params` before `cfg` is consumed. `RefClient::on_init` (`games/reference/sim/src/client.rs`) uses the hook to recompute `self.spawn = TileXY::from_tile(nearest_land_tile(seed, params))`, replacing the `content::SEED` guess, so a real page's spawn now tracks whatever seed and params its own world actually uses.

**Constraints, unchanged from 0003:**

- Default body is a no-op: every existing game and fixture that never overrides `on_init` is unaffected.
- `on_init` is outside the deterministic core, like the rest of `ClientSide` (0003 "Outside the deterministic core": unreachable from `apply`/`tick`, unsnapshotted, unhashed).
- Called exactly once per client instance, never re-invoked on reconnect or resubscription within the same instance.
- It carries only the inputs to worldgen (seed, params) — never a channel for replicated state. The replica remains the only source of world state; a game must not use `on_init` to smuggle player, entity, or global state into a client ahead of or outside normal replication.

## Alternatives rejected

- **Pass the seed through `FrameView` instead.** `FrameView` is a per-frame value, recomputed and handed to `frame`/`extract`/`ui` on every call, for state that changes or is read continuously; the seed and params are fixed for the life of the instance, so threading them through every frame call is the wrong shape. It is also too late for state a client needs before its own first frame runs (`RefClient`'s spawn must already be correct on the very first `ui()` call).
- **A `Default`-replacing constructor** (e.g. `ClientSide::new(seed, params)` in place of `Default::default()`). Breaks the trait bound `ClientSide<G>: Default` and therefore every existing game and fixture, not an additive change.

## Consequences

- Every game gets a defaulted no-op; only a game whose client state depends on its world's seed or params needs to override it (`RefClient` is the first).
- `RefClient::spawn` now tracks the real seed/params of the world it runs against instead of a hard-coded duplicate — a correctness fix, not only a test seam. `games/reference/sim/tests/spawn.rs::spawn_alt_params_is_nearest_land_tile` asserts the hook's own effect (`RefClient::on_init` then `RefClient::spawn()`), not just the underlying `nearest_land_tile` function, against an independently-scanned fixture (`games/reference/tests/fixtures/spawn-alt-params.json`).
- `games/reference/tests/browser/spawn.spec.ts`'s `reference_new_player_spawns_on_land` now exercises a world (`test-entry.ts`'s `?altSpawnParams`, raising `water_level` so the origin is water) whose nearest land tile is not `(0, 0)` — the trivial "origin is already land" value shared by every real seed's default params, `nearest_land_tile`'s own fallback, and `CameraState`'s own default centre — so the test can now fail.
- Revisit if a client ever needs the seed/params to change mid-instance (e.g. reseeding a running world): `on_init`'s "called exactly once" guarantee does not cover that case and none is planned.

## Sources

- `docs/plan/20b-reference-player-and-collect-ui.md` Deviations, gate round 1 fix (the finding, the fixture, the live-revert proofs).
- Commit `885f7af` (`packages/engine/crates/engine/src/client/texel.rs`, `packages/engine/crates/engine/src/game_instance.rs`, `games/reference/sim/src/client.rs`, `games/reference/sim/tests/spawn.rs`).
- [0003](0003-game-facing-api.md) Decision (`ClientSide` trait block) and "Outside the deterministic core".
