//! Terrain and resource ids (docs/plan/20-reference-game-v0.md Scope: "content.rs: terrain and
//! resource ids ..."). Chosen in step 1/2 so `worldgen.rs` has real targets to write; step 4 adds
//! `TraitSet` bits (`NOT_BUILDABLE` on both waters, `COLLECTABLE` on every resource id) and
//! `Game::register`, in this same file (Scope: "registered in `Game::register`").
//!
//! **Resource ids double as their own "full" depletion-stage visual id** (Deviations has the exact
//! reasoning and the formula step 5's `tile_visual` uses): `RESOURCE_STAGE_FULL/HALF/LOW` are
//! offsets added to a resource id to get that stage's visual id, and the *default* (identity)
//! `Registry::resource_visual` mapping therefore already shows the "full" art with no override
//! needed, until step 5 makes the mapping depend on `aux` too.

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
/// Thresholds (Planning decisions "Depletion stages"): full 7-10, half 4-6, low 1-3 units of the
/// `UNITS_PER_TILE` Requirement (10).
pub const RESOURCE_STAGE_FULL: u8 = 0;
pub const RESOURCE_STAGE_HALF: u8 = 1;
pub const RESOURCE_STAGE_LOW: u8 = 2;
