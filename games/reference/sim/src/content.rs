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

use engine::client::rgba;
use engine::game::Game as _;
use engine::time::{TickRate, Ticks};
use engine::world::{Footprint, PrototypeId, Registry, TraitSet};

/// The size of `RefGlobal::colours`, indexed by `PlayerId` (M34). The engine hands out ids
/// `1..=maxPlayers` (default 8), so 16 leaves headroom; an id past it stays unassigned.
pub const MAX_PLAYERS: usize = 16;

/// Player colours (M34), `rgba`-packed. A `RefGlobal::colours` entry is a 1-based index into this
/// table; 0 means unassigned and draws [`UNASSIGNED_COLOUR`]. Eight entries, so eight joins can all
/// differ.
pub const PALETTE: [u32; 8] = [
    rgba(0xe6, 0x4a, 0x4a, 0xff),
    rgba(0x3a, 0x8f, 0xf0, 0xff),
    rgba(0xf0, 0xc0, 0x30, 0xff),
    rgba(0xb0, 0x5c, 0xe0, 0xff),
    rgba(0xf0, 0x8a, 0x30, 0xff),
    rgba(0x30, 0xd0, 0xd0, 0xff),
    rgba(0xf0, 0x70, 0xb0, 0xff),
    rgba(0xd8, 0xd8, 0xd8, 0xff),
];

/// What an unassigned player (palette index 0) draws as: the own circle's colour before M34.
pub const UNASSIGNED_COLOUR: u32 = rgba(0x40, 0xc0, 0x40, 0xff);

/// The packed colour of palette index `idx` (0 or out of range: [`UNASSIGNED_COLOUR`]).
pub const fn colour_of(idx: u8) -> u32 {
    if idx == 0 || idx as usize > PALETTE.len() {
        UNASSIGNED_COLOUR
    } else {
        PALETTE[idx as usize - 1]
    }
}

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
/// Carried by an entity prototype (the furnace): every tile of its footprint is covered, so a
/// resource under it cannot be collected (R1, Tyler 2026-10-10). Derived through `traits_at`'s
/// occupant term, never stored: it follows the furnace through save, load and pick-up for free.
pub const COVERS_RESOURCE: TraitSet = TraitSet(1 << 2);

/// Collect range (Requirements: "within 3 tiles of a resource ... centre of the player circle to
/// centre of the resource tile"), in Q24.8 raw units (0007 §2: 256 raw units = 1 tile).
pub const RANGE_Q8: i32 = 3 * 256;

/// Tiles per axis scanned around the player's own tile for the in-range check (`RefClient::ui`,
/// M20b step 3 -- moved here so [`crate::MAX_IN_RANGE`] can be *derived* from it, not a separately
/// chosen headroom number): `RANGE` tiles plus one, to cover the player's own fractional offset
/// inside its own tile.
pub const RANGE_SCAN_TILES: i32 = RANGE_Q8 / 256 + 1;

/// The one seed every real page of this v0 game uses (`games/reference/CLAUDE.md`: "`TEST_SEED` ...
/// is also `src/main.ts`'s own world seed"). Duplicated here, as a plain `u64`, rather than read
/// from a world config at runtime: `engine::client::ClientSide` is `Default`-only (no seed/params
/// channel from the engine to a game's `Client`), so the spawn rule's own terrain function (M20b
/// step 5 Scope: "spiralling over its own terrain function, pure, no engine read") has no way to
/// learn a real session's seed except by already knowing it -- true today only because this v0 game
/// never lets a player choose a world. `sim/tests/common/mod.rs::TEST_SEED` now aliases this
/// constant instead of repeating the literal a third time; `main.ts`/`test-entry.ts`'s own string
/// literal is the one copy no Rust `pub const` can reach.
pub const SEED: u64 = 0x5EED_1234_ABCD_0042;

/// `admit`'s witness tolerance (0001 "Witness-carrying actions" step 1: "reject if farther than 16
/// tiles from the sample or if no sample exists"; `PRE-PLAN.md` §4 Presence row), in the same
/// Q24.8 raw units as [`RANGE_Q8`]. Deliberately much larger than `RANGE_Q8`: it only guards
/// against an implausible claim (staleness of half an RTT plus one 100 ms sample interval, 0001),
/// while `RANGE_Q8` is `apply`'s own exact gameplay rule.
pub const ADMIT_TOLERANCE_Q8: i32 = 16 * 256;

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

/// Smelt duration (Requirements: "smelting takes 5 seconds"), generic over the rate like
/// [`collect_ticks`] so `smelt_takes_five_seconds_at_20_and_30_hz` can check both.
pub const fn smelt_ticks(rate: TickRate) -> Ticks {
    rate.secs(5)
}

/// [`smelt_ticks`] at [`crate::RefGame`]'s own `TICK_RATE`: what `rules::furnace::advance` uses.
pub const SMELT: Ticks = smelt_ticks(crate::RefGame::TICK_RATE);

/// Ingots one unit of fuel smelts (Requirements: one coal smelts 10, one wood smelts 2). A count
/// of smelts, never a tick rate (0006 "Rates and continuous quantities"): `Furnace::burn_left`
/// holds the smelts left in the lit unit.
pub const COAL_INGOTS: u16 = 10;
pub const WOOD_INGOTS: u16 = 2;

/// Most one furnace slot (`iron_in`, `coal`, `wood`) holds; a deposit that would exceed it is
/// rejected, so the entity stays plain fixed-width data.
pub const SLOT_CAP: u32 = 999;

/// Item ids (M32; the six inventory slots, in slot order): the index into [`crate::Inventory`]'s
/// fixed array. Distinct from the tile resource ids above (`IRON = 16` ...): a resource id says what
/// a *tile* holds, an item id what a *player* carries; [`ItemId::from_resource`] is the one bridge.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ItemId {
    Stone = 0,
    Iron = 1,
    Wood = 2,
    Coal = 3,
    Furnace = 4,
    Ingot = 5,
}

/// Number of inventory slots (one per [`ItemId`]).
pub const ITEM_COUNT: usize = 6;

impl ItemId {
    pub const fn idx(self) -> usize {
        self as usize
    }

    /// The item with wire id `n` (`FurnaceDeposit::item`); `None` for an id no slot has.
    pub const fn from_wire(n: u8) -> Option<ItemId> {
        match n {
            0 => Some(ItemId::Stone),
            1 => Some(ItemId::Iron),
            2 => Some(ItemId::Wood),
            3 => Some(ItemId::Coal),
            4 => Some(ItemId::Furnace),
            5 => Some(ItemId::Ingot),
            _ => None,
        }
    }

    /// The item a collected tile resource turns into; `None` for a non-resource id.
    pub const fn from_resource(resource: u8) -> Option<ItemId> {
        match resource {
            IRON => Some(ItemId::Iron),
            WOOD => Some(ItemId::Wood),
            STONE => Some(ItemId::Stone),
            COAL => Some(ItemId::Coal),
            _ => None,
        }
    }
}

/// One crafting recipe (Requirements: "A furnace costs 5 stone and takes 5 seconds to craft",
/// unlocked once the player has mined 5 stone). The recipe's id is its index in [`RECIPES`] and also
/// its bit in `RefPlayer::unlocks`.
pub struct Recipe {
    pub output: ItemId,
    /// `(item, count)` pairs deducted at `StartCraft`.
    pub cost: &'static [(ItemId, u32)],
    /// Duration in whole seconds; converted with `TICK_RATE.secs(..)` ([`Recipe::ticks`]).
    pub secs: u32,
    /// Unlock condition: `RefPlayer::stone_mined` reaching this count sets the recipe's unlock bit.
    pub unlock_stone_mined: u32,
}

impl Recipe {
    /// Duration in ticks at `rate` (0006 "Conversion rule"), generic over the rate so
    /// `craft_duration_at_20_and_30_hz` can check both.
    pub const fn ticks(&self, rate: TickRate) -> Ticks {
        rate.secs(self.secs)
    }
}

/// Recipe id of the furnace (index into [`RECIPES`]).
pub const RECIPE_FURNACE: u8 = 0;

/// The recipe table: one entry.
pub const RECIPES: [Recipe; 1] = [Recipe {
    output: ItemId::Furnace,
    cost: &[(ItemId::Stone, 5)],
    secs: 5,
    unlock_stone_mined: 5,
}];

/// The furnace's prototype id: the one entity prototype, registered first in [`register`] (so the
/// engine hands out id 0; `register` asserts it).
pub const FURNACE_PROTO: PrototypeId = PrototypeId(0);

/// The furnace's footprint (Requirements: 2x2 tiles), anchored at its min corner (`Furnace::origin`).
pub const FURNACE_FOOTPRINT: Footprint = Footprint { w: 2, h: 2 };

/// Sprite id of the furnace in `assets/sprites.json` (two frames, left to right: idle = 0, lit = 1;
/// the frame is `Draw::param`). Must match `scripts/gen-assets.mjs`'s `SPRITES`.
pub const SPRITE_FURNACE: u16 = 0;

/// Trait tables + entity prototypes (0007 §6, `Game::register`'s own doc comment): both waters are
/// `NOT_BUILDABLE`; every resource id is `COLLECTABLE` and **not** `NOT_BUILDABLE` (R1: a furnace may
/// stand on a resource); the furnace prototype is `NOT_BUILDABLE` (so one furnace refuses another
/// through the occupant term of `traits_at`, with no entity named in the rule) and `COVERS_RESOURCE`
/// (a covered resource is not collectable until the furnace is picked up).
pub fn register(r: &mut Registry) {
    r.set_base_traits(DEEP_WATER, NOT_BUILDABLE);
    r.set_base_traits(WATER, NOT_BUILDABLE);
    for &resource in &[IRON, WOOD, STONE, COAL] {
        r.set_resource_traits(resource, COLLECTABLE);
    }
    let furnace = r.add_prototype(NOT_BUILDABLE.union(COVERS_RESOURCE), FURNACE_FOOTPRINT);
    assert_eq!(furnace, FURNACE_PROTO, "the furnace must be prototype 0");
}

/// Client-local UI intent codes for `client.input.emit(code, a, b)` (M18's `InputKind.Game` record,
/// 0024 section 7c), read by `RefClient::frame` from `FrameCx::input()`. Never sim state, never an
/// action. Mirrored by `src/ui/build.ts`'s `LOCAL`: change both together.
pub mod local {
    /// `a != 0` turns construction mode on, `a == 0` off.
    pub const PLACE_MODE: u32 = 1;
    /// Closes the furnace panel (M33b step 3 reads it).
    pub const CLOSE_PANEL: u32 = 2;
}
