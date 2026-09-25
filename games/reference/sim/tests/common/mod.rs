//! Shared native test support (docs/plan/20-reference-game-v0.md Provides: "native test helper
//! `sim/tests/common/mod.rs::RefScenario`"). Steps 2-3 need only [`TEST_SEED`]; `RefScenario`
//! itself (a new world, join a player, dispatch, step ticks, read player/tile, state hash) is left
//! for step 4/5, once `Game::apply`/`content::register` exist to drive (this brief's Deviations
//! has the exact reasoning).

/// The one seed every native test in this crate shares (Provides: "the `TEST_SEED` value").
pub const TEST_SEED: u64 = 0x5EED_1234_ABCD_0042;
