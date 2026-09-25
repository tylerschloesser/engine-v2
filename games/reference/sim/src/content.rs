//! Terrain and resource ids (docs/plan/20-reference-game-v0.md Scope: "content.rs: terrain and
//! resource ids ..."). Chosen in step 1/2 so `worldgen.rs` has real targets to write; step 4 adds
//! `TraitSet` bits (`NOT_BUILDABLE` on both waters, `COLLECTABLE` on every resource id) and
//! [`register`], in this same file (Scope: "registered in `Game::register`").
//!
//! **Resource ids double as their own "full" depletion-stage visual id** (Deviations has the exact
//! reasoning and the formula step 5's `tile_visual` uses): `RESOURCE_STAGE_FULL/HALF/LOW` are
//! offsets added to a resource id to get that stage's visual id, and the *default* (identity)
//! `Registry::resource_visual` mapping therefore already shows the "full" art with no override
//! needed, until step 5 makes the mapping depend on `aux` too.

use engine::game::Game as _;
use engine::time::{TickRate, Ticks};
use engine::world::{Registry, TraitSet};

/// Base terrain ids (Requirements: "grass, dirt, water, sand, etc."; this game's own five, 0008
/// §1's height+moisture classification in `worldgen.rs`).
pub const DEEP_WATER: u8 = 0;
pub const WATER: u8 = 1;
pub const SAND: u8 = 2;
pub const GRASS: u8 = 3;
pub const DIRT: u8 = 4;

/// Resource ids (Requirements: "iron, wood, stone, coal"). `0` is reserved by the engine for "no
/// resource" (0018 §3), so every resource id here is non-zero -- chosen as each resource's own
/// "full" depletion-stage visual id (see this file's own doc comment and Deviations), spaced 3
/// apart (one id per stage) with headroom after the 5 terrain visual ids (0..4).
pub const IRON: u8 = 16;
pub const WOOD: u8 = 19;
pub const STONE: u8 = 22;
pub const COAL: u8 = 25;

/// `tile_visual`'s stage offsets (step 5), added to a resource id to get that stage's visual id.
/// Thresholds (Planning decisions "Depletion stages"): full 7-10, half 4-6, low 1-3 units of
/// [`UNITS_PER_TILE`].
pub const RESOURCE_STAGE_FULL: u8 = 0;
pub const RESOURCE_STAGE_HALF: u8 = 1;
pub const RESOURCE_STAGE_LOW: u8 = 2;

/// Requirements ("Resources deplete: 10 units per tile"): `aux`'s starting value on a resource
/// tile (Scope: "`aux` starts at the units-per-tile Requirement").
pub const UNITS_PER_TILE: u16 = 10;

/// `TraitSet` bits (0007 §6, step 4): the game declares which bit means what, the engine only
/// carries the bitset. Bit 0 on both waters ("placement asks the tiles", `docs/spec/
/// reference-game.md`); bit 1 on every resource id (`rules::collect::start`'s own check).
pub const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
pub const COLLECTABLE: TraitSet = TraitSet(1 << 1);

/// Collect range (Requirements: "within 3 tiles of a resource ... centre of the player circle to
/// centre of the resource tile"), in Q24.8 raw units (0007 §2: 256 raw units = 1 tile).
pub const RANGE_Q8: i32 = 3 * 256;

/// Collect duration (Requirements: "Collecting takes 2 seconds"), as `TICK_RATE.secs(2)` (0006
/// "Conversion rule"). Generic over the rate (not just [`crate::RefGame`]'s own fixed
/// `TICK_RATE`) so `durations_at_20_and_30_hz` can check the same `const fn` at 20 and 30 Hz (0006
/// Consequences), not only at this crate's own compiled-in rate.
pub const fn collect_ticks(rate: TickRate) -> Ticks {
    rate.secs(2)
}

/// [`collect_ticks`] at [`crate::RefGame`]'s own `TICK_RATE` -- what `rules::collect::start`
/// actually uses.
pub const COLLECT: Ticks = collect_ticks(crate::RefGame::TICK_RATE);

/// Trait tables + entity prototypes (0007 §6, `Game::register`'s own doc comment): both waters are
/// `NOT_BUILDABLE`, every resource id is `COLLECTABLE`. No entity prototypes yet (furnaces are
/// M32, Non-scope here).
pub fn register(r: &mut Registry) {
    r.set_base_traits(DEEP_WATER, NOT_BUILDABLE);
    r.set_base_traits(WATER, NOT_BUILDABLE);
    for &resource in &[IRON, WOOD, STONE, COAL] {
        r.set_resource_traits(resource, COLLECTABLE);
    }
}
