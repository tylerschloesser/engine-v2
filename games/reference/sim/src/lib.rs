//! `reference-sim`: the reference game's Rust crate (docs/plan/20-reference-game-v0.md). Steps 1-3
//! (Order of work) scaffolded the crate, worldgen and asset pipeline; step 4-6 add the real
//! `Action`/`Reject`/`Player`/`Global`/`Ui`, `content::register`, the collect rules and the
//! depletion `tile_visual` override.
//!
//! Module layout (`games/reference/CLAUDE.md`): `noise.rs` (composes `engine::noise` into the
//! height/moisture channels), `worldgen.rs` (`RefWorldgen`/`RefParams`, the real simplex/fBm
//! generator plus `hash2` scatter), `content.rs` (terrain/resource ids, `TraitSet`s, durations and
//! `Game::register`), `rules/` (one file per feature; `collect.rs` is the first).

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, TilePos, WorldPos};
use ts_rs::TS;

pub mod client;
pub mod content;
pub mod noise;
pub mod rules;
pub mod worldgen;

pub use client::{PlayerPresence, RefClient};
pub use worldgen::{RefParams, RefWorldgen};

/// A tile coordinate, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which derives neither `Serialize` nor `TS` -- the same reason `fixtures/presence`'s own
/// `TileXY` exists).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct TileXY {
    pub x: i32,
    pub y: i32,
}

impl TileXY {
    pub const fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }

    pub const fn from_tile(t: TilePos) -> Self {
        TileXY { x: t.x, y: t.y }
    }
}

/// A Q24.8 world position, plain data (same reason as [`TileXY`]; not `engine::world::WorldPos`).
/// `StartCollect`'s own witness (0001 "Witness-carrying actions"): the client's claimed position
/// when it pressed the button.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct WorldXY {
    pub x: i32,
    pub y: i32,
}

impl WorldXY {
    pub const fn world(self) -> WorldPos {
        WorldPos {
            x: self.x,
            y: self.y,
        }
    }
}

/// `Action::{StartCollect, CancelCollect}` (Scope; 0001's own reference-game example, verbatim
/// field shape). `#[ts(export)]`: without it ts-rs's derive macro writes no `export_bindings_*`
/// test at all (`add-action-type` skill).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum RefAction {
    StartCollect {
        tile: TileXY,
        from: WorldXY,
    },
    CancelCollect,
    /// M32: start crafting recipe `recipe` (index into `content::RECIPES`).
    StartCraft {
        recipe: u8,
    },
    /// M33: place a furnace item from the inventory with its min corner at `origin` (footprint
    /// 2x2). Addressed by tile, never by id.
    PlaceFurnace {
        origin: TileXY,
    },
}

/// `Reject` (Scope). `NoResource`/`OutOfRange`/`Busy` are `rules::collect::start`'s own three
/// rejection reasons, in the same order Scope validates them (minus "tile readable", which is
/// `Unknown`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum RefReject {
    Unknown,
    NoResource,
    OutOfRange,
    Busy,
    /// `StartCraft` (M32): the recipe id is not in `content::RECIPES`.
    UnknownRecipe,
    /// `StartCraft`: the player has not unlocked that recipe.
    Locked,
    /// `StartCraft`: the inventory cannot pay the recipe's cost.
    Unaffordable,
    /// `PlaceFurnace` (M33): the inventory holds no furnace.
    NoFurnace,
    /// `PlaceFurnace`: some footprint tile is `NOT_BUILDABLE` (water, a resource, another furnace).
    NotBuildable,
    /// `admit`'s own rejection (0001 "Witness-carrying actions" step 1, HOST ONLY, never
    /// replayed): the claimed `from` is farther than `content::ADMIT_TOLERANCE_Q8` from the
    /// player's latest presence sample, or no sample exists yet. Distinct from `OutOfRange`
    /// (`apply`'s own, much tighter, `RANGE_Q8` check against the *tile*) so a client can tell
    /// "the host doesn't believe where you are" from "you really aren't close enough".
    ImplausiblePosition,
}

impl From<Unknown> for RefReject {
    fn from(_: Unknown) -> Self {
        RefReject::Unknown
    }
}

/// Per-item counts (Requirements: inventory is per player): a fixed array indexed by
/// [`content::ItemId`] (M32: plain data, no `Vec`). `TS`: also `Ui.inventory`'s own field type and
/// `UiRecipe::cost`'s, one shape for all three.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Inventory(pub [u32; content::ITEM_COUNT]);

impl Inventory {
    pub fn get(&self, item: content::ItemId) -> u32 {
        self.0[item.idx()]
    }

    pub fn add(&mut self, item: content::ItemId, n: u32) {
        let slot = &mut self.0[item.idx()];
        *slot = slot.saturating_add(n);
    }

    /// Adds one collected tile resource (`content::{IRON, WOOD, STONE, COAL}`); any other id is a
    /// no-op (defensive: every caller already checked `COLLECTABLE`).
    pub fn add_resource(&mut self, resource: u8, n: u32) {
        if let Some(item) = content::ItemId::from_resource(resource) {
            self.add(item, n);
        }
    }
}

/// A player's in-flight collect (Scope: "`collecting = Some { tile, done_at }`"; PRE-PLAN.md §4).
/// `tile: TileXY`, not `engine::world::TilePos` (same reason as [`TileXY`]'s own doc comment: a
/// replicated `Player` field must be `Codec`, and `TilePos` derives neither `Serialize` nor
/// `Deserialize`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Collecting {
    pub tile: TileXY,
    pub done_at: engine::time::Tick,
}

/// A player's in-flight craft (M32): the recipe id (index into `content::RECIPES`) and the tick it
/// completes. Independent of [`Collecting`]: one collect and one craft at a time, each its own slot.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Crafting {
    pub recipe: u8,
    pub done_at: engine::time::Tick,
}

/// `PlayerState { inventory, stone_mined, collecting, unlocks, crafting }`. `unlocks` is a bitset
/// with one bit per recipe id, set by the collect tick rule (`rules::craft::update_unlocks`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefPlayer {
    pub inventory: Inventory,
    pub stone_mined: u32,
    pub collecting: Option<Collecting>,
    pub unlocks: u32,
    pub crafting: Option<Crafting>,
}

/// `GlobalState` (Scope: "empty for now"). The engine roster (coloured dots) is M20b's.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefGlobal;

/// The one entity kind (M33): a 2x2 furnace (`content::FURNACE_PROTO`). `origin` is its min-corner
/// tile (`Game::anchor`; `TileXY`, not `TilePos`, for the same `Codec` reason as [`Collecting`]).
/// The fields after `origin` are the furnace's own state (`PRE-PLAN.md` §4, Entity row), operated
/// by M33b; placement leaves them all zero. Furnaces are addressed by tile everywhere (0022 §6).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Furnace {
    pub origin: TileXY,
    pub iron_in: u16,
    pub coal: u16,
    pub wood: u16,
    /// Ticks of burn left in the current fuel unit.
    pub burn_left: u16,
    pub ingots_out: u16,
    /// The tick the current smelt completes, `None` while idle.
    pub smelt_done_at: Option<engine::time::Tick>,
}

impl Furnace {
    /// A fresh, empty furnace anchored at `origin`.
    pub fn new(origin: TileXY) -> Self {
        Furnace {
            origin,
            ..Furnace::default()
        }
    }
}

/// The game's `Game::Entity`; the name every pre-M33 test already imports.
pub type RefEntity = Furnace;

/// The maximum number of simultaneous `Ui.in_range` entries (M20b step 3, sized correctly in step
/// 5's own orchestrator fix): `RefClient::ui`'s bounding-box scan (`client.rs`) visits every tile in
/// a `(2 * RANGE_SCAN_TILES + 1)` square around the player's own tile and can push at most one
/// `UiInRange` per tile it visits, so the scan's own tile count is a hard upper bound on how many
/// entries `tracked_range`/`out.in_range` can ever hold -- truncation (`ui()` silently dropping an
/// in-range resource past this cap, the Goal's own "every resource in range" broken) cannot happen
/// by construction, not merely by generous headroom. The true worst case (every tile whose *centre*
/// can be within `RANGE_Q8` of some point, the exact disc bound) is 32 for `RANGE_Q8 = 3 tiles`
/// (found by exhaustive search over sub-tile offsets) -- well under this square's own 81, but the
/// square is what the scan loop actually visits, so it is the bound that needs no separate proof of
/// correctness against the scan's own shape.
pub(crate) const MAX_IN_RANGE: usize = {
    let side = (2 * content::RANGE_SCAN_TILES + 1) as usize;
    side * side
};

/// `Ui.collecting`'s own shape (M20b step 3, Scope: "`collecting: Option<{ tile, done_at }>`"): not
/// [`Collecting`] itself, which carries `done_at: engine::time::Tick` -- `Tick` has no `TS` impl (a
/// bug fix to the engine crate is out of this milestone's scope, Files touched), so the UI-facing
/// mirror carries the raw tick number instead. The client reconstructs remaining time itself from
/// `done_at` and `client.clock()` (0003 "How the UI observes state": "progress bars are derived
/// from a `done_at` tick in `Ui` and `client.clock()`").
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiCollecting {
    pub tile: TileXY,
    pub done_at: u32,
}

/// One `Ui.in_range` entry (M20b step 3, Scope: "`{ tile, resource, from }`"). `from` is the
/// player's own position when this tile entered range, refreshed only when the set of in-range
/// tiles changes (Planning decisions "Where `from` comes from") -- computed and cached by
/// `RefClient::ui` (`client.rs`), not recomputed fresh from the live spring every call.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiInRange {
    pub tile: TileXY,
    pub resource: u8,
    pub from: WorldXY,
}

/// An in-flight craft as `Ui` shows it (`UiCollecting`'s own reasoning: raw `done_at` tick number).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiCrafting {
    pub recipe: u8,
    pub done_at: u32,
}

/// One unlocked recipe as the crafting menu lists it (M32): `cost` per item, `secs` for the
/// progress bar's label, `affordable` against the player's current inventory.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiRecipe {
    pub recipe: u8,
    pub cost: Inventory,
    pub secs: u32,
    pub affordable: bool,
}

/// `Ui { me, inventory, collecting, in_range, spawn }` (Scope, M20b steps 3 and 5). `me` is a raw
/// `u32`, not `engine::game::PlayerId` (same reason as [`UiCollecting::done_at`]: `PlayerId` has no
/// `TS` impl). `Default` reserves `in_range`'s capacity once ([`MAX_IN_RANGE`]); `RefClient::ui`
/// clears and refills it every call, so steady state allocates nothing (Scope, verbatim). `spawn`
/// (step 5, Scope: "publishes it as `Ui.spawn`") is the nearest land tile to the origin, computed
/// once at `RefClient` construction (`client.rs`'s own `nearest_land_tile`) and copied in unchanged
/// on every `ui()` call -- it never changes for the life of a client, so it is not itself a
/// per-frame value (the `Ui` rule, `games/reference/CLAUDE.md`).
#[derive(Clone, PartialEq, Debug, serde::Serialize, TS)]
#[ts(export)]
pub struct RefUi {
    pub me: u32,
    pub inventory: Inventory,
    pub collecting: Option<UiCollecting>,
    pub in_range: Vec<UiInRange>,
    pub spawn: TileXY,
    /// M32: the player's unlock bitset, the in-flight craft, and the unlocked recipes only.
    pub unlocks: u32,
    pub crafting: Option<UiCrafting>,
    pub recipes: Vec<UiRecipe>,
    /// M33: construction mode is on (client-local, `content::local::PLACE_MODE`).
    pub placing: bool,
    /// M33: the inventory holds a furnace item (shows the Build button).
    pub can_build: bool,
}

impl Default for RefUi {
    fn default() -> Self {
        RefUi {
            me: 0,
            inventory: Inventory::default(),
            collecting: None,
            in_range: Vec::with_capacity(MAX_IN_RANGE),
            spawn: TileXY::default(),
            unlocks: 0,
            crafting: None,
            recipes: Vec::with_capacity(content::RECIPES.len()),
            placing: false,
            can_build: false,
        }
    }
}

pub struct RefGame;

impl Game for RefGame {
    const SCHEMA_VERSION: u32 = 3;
    //  3: `Furnace` entity, `PlaceFurnace`, resources `NOT_BUILDABLE` (M33).
    type Worldgen = RefWorldgen;
    type Action = RefAction;
    type Reject = RefReject;
    type Entity = Furnace;
    type Player = RefPlayer;
    type Global = RefGlobal;
    type Presence = PlayerPresence;
    type Ui = RefUi;
    type Client = RefClient;

    fn register(r: &mut Registry) {
        content::register(r);
    }

    fn prototype(_e: &Furnace) -> PrototypeId {
        content::FURNACE_PROTO
    }

    fn anchor(e: &Furnace) -> TilePos {
        e.origin.tile()
    }

    fn genesis(_w: &mut dyn WorldWrite<Self>) {}

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        match ev {
            PlayerEvent::Joined => w.put_player(who, RefPlayer::default()),
            // A disconnected player's collect is cancelled (position is presence and goes stale);
            // their craft keeps running (0013 "A disconnected player's state"). One put.
            PlayerEvent::Disconnected => {
                if let Ok(&p) = w.player(who)
                    && p.collecting.is_some()
                {
                    {
                        w.put_player(
                            who,
                            RefPlayer {
                                collecting: None,
                                ..p
                            },
                        );
                    }
                }
            }
            PlayerEvent::Connected => {}
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &RefAction) -> Result<(), RefReject> {
        match a {
            RefAction::StartCollect { tile, from } => {
                rules::collect::start(w, who, tile.tile(), from.world())
            }
            RefAction::CancelCollect => rules::collect::cancel(w, who),
            RefAction::StartCraft { recipe } => rules::craft::start(w, who, *recipe),
            RefAction::PlaceFurnace { origin } => {
                rules::place::place_furnace(w, who, origin.tile())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        rules::collect::tick(cx);
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        p: &PresenceTable<Self>,
        who: PlayerId,
        a: &RefAction,
    ) -> Result<(), RefReject> {
        match a {
            RefAction::StartCollect { from, .. } => rules::collect::admit(p, who, from.world()),
            RefAction::CancelCollect
            | RefAction::StartCraft { .. }
            | RefAction::PlaceFurnace { .. } => Ok(()),
        }
    }
}

engine::export_game!(RefGame);
