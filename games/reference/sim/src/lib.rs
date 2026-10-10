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
    Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, TilePos, WorldPos};
use ts_rs::TS;

#[cfg(feature = "bench")]
pub mod bench;
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
    /// M33b: move `count` of `item` (a `content::ItemId` wire id: iron, coal or wood) from the
    /// player into the furnace at `at`, any tile under its footprint (0022 section 6).
    FurnaceDeposit {
        at: TileXY,
        item: u8,
        count: u32,
    },
    /// M33b: move every ingot out of the furnace at `at` to the player. Not predicted (R2).
    FurnaceTake {
        at: TileXY,
    },
    /// M33b: pick the furnace at `at` up into the inventory; valid only when it is empty.
    FurnacePickUp {
        at: TileXY,
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
    /// `PlaceFurnace`: some footprint tile is `NOT_BUILDABLE` (water, another furnace).
    NotBuildable,
    /// `FurnaceDeposit`/`FurnaceTake`/`FurnacePickUp` (M33b): no furnace on the addressed tile.
    NoFurnaceHere,
    /// `FurnaceDeposit`: `item` is not iron, coal or wood.
    BadItem,
    /// `FurnaceDeposit`: `count` is zero.
    BadCount,
    /// `FurnaceDeposit`: the player holds fewer than `count`.
    NotEnoughItems,
    /// `FurnaceDeposit`: the slot would exceed `content::SLOT_CAP`.
    SlotFull,
    /// `FurnaceTake`: the furnace holds no ingots.
    NothingToTake,
    /// `FurnacePickUp`: the furnace still holds ore, fuel (lit included) or ingots.
    FurnaceNotEmpty,
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

/// `GlobalState` (M34): each player's colour as a 1-based `content::PALETTE` index, 0 = unassigned,
/// indexed by `PlayerId` (`content::MAX_PLAYERS` slots). Global scope: every client reads every
/// player's colour, offline ones included. Written only by `on_player(Joined)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefGlobal {
    pub colours: [u8; content::MAX_PLAYERS],
}

/// The brief's name for [`RefGlobal`].
pub type GlobalState = RefGlobal;

impl RefGlobal {
    /// No colour assigned to anyone (`genesis`'s value; a `const` so a stub world can lend it).
    pub const EMPTY: RefGlobal = RefGlobal {
        colours: [0; content::MAX_PLAYERS],
    };

    /// `who`'s palette index; 0 when unassigned or past the table.
    pub fn colour(&self, who: PlayerId) -> u8 {
        self.colours.get(who.0 as usize).copied().unwrap_or(0)
    }
}

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
    /// Smelts left in the currently lit fuel unit (`content::{COAL,WOOD}_INGOTS` when lit).
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

/// The open furnace as the panel reads it (M33b): its anchor tile and the six state fields, with
/// `smelt_done_at` as a raw tick number (`UiCollecting::done_at`'s reasoning).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiFurnace {
    pub at: TileXY,
    pub iron_in: u16,
    pub coal: u16,
    pub wood: u16,
    pub burn_left: u16,
    pub ingots_out: u16,
    pub smelt_done_at: Option<u32>,
}

/// One roster entry as `Ui.roster` shows it (M34): the engine roster joined with
/// `RefGlobal::colours`. `colour` is the player's RGB (an unassigned player reads as
/// `content::UNASSIGNED_COLOUR`), so the DOM needs no palette of its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct UiRosterEntry {
    pub id: u32,
    pub online: bool,
    pub colour: [u8; 3],
    pub me: bool,
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
    /// M33b: the furnace whose panel is open (`RefClient::open`), `None` when none or it is gone.
    pub furnace: Option<UiFurnace>,
    /// M34: every player in the engine roster, ascending id, online or not.
    pub roster: Vec<UiRosterEntry>,
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
            furnace: None,
            roster: Vec::with_capacity(content::MAX_PLAYERS),
        }
    }
}

/// Gives `who` a free palette index (M34), drawn with the sim RNG, in one `put_global`. Does
/// nothing when `who` already has one (a rejoin) or has no slot. When every index is taken (more
/// players than colours) any index may repeat. `rng()` is `Err` under prediction: `on_player` is
/// host-only, so that arm is unreachable there and leaves the colour unassigned.
fn assign_colour(w: &mut dyn WorldWrite<RefGame>, who: PlayerId) {
    let g = *w.global();
    let slot = who.0 as usize;
    if slot >= content::MAX_PLAYERS || g.colours[slot] != 0 {
        return;
    }
    let n = content::PALETTE.len() as u32;
    let mut free = [0u8; content::MAX_PLAYERS];
    let mut nfree = 0u32;
    for idx in 1..=n as u8 {
        if !g.colours.contains(&idx) {
            free[nfree as usize] = idx;
            nfree += 1;
        }
    }
    let Ok(rng) = w.rng() else { return };
    let idx = if nfree > 0 {
        free[rng.below(nfree) as usize]
    } else {
        rng.below(n) as u8 + 1
    };
    let mut next = g;
    next.colours[slot] = idx;
    w.put_global(next);
}

pub struct RefGame;

impl Game for RefGame {
    // `test-hooks` (never shipped) reports one version higher: a save of the normal build is then
    // `SaveIncompatible` (M34b).
    const SCHEMA_VERSION: u32 = if cfg!(feature = "test-hooks") { 7 } else { 6 };
    //  3: `Furnace` entity, `PlaceFurnace`, resources `NOT_BUILDABLE` (M33).
    //  4: `FurnaceDeposit`, `FurnaceTake`, `FurnacePickUp` and their rejects (M33b).
    //  5: `RefGlobal { colours }`, written on `Joined` (M34).
    //  6: resources are buildable (R1); a furnace covers the resources under it: `StartCollect` refuses
    //     a covered tile and a due collect on one ends with no item (M39ai).
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

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(RefGlobal::EMPTY);
        // `bench` (never shipped): the worldgen carried the bench marker, so fill the world with the
        // standard large save (0020 section 9). The seed comes from the world's own rng, which is
        // seeded from the world seed: genesis sees no params.
        #[cfg(feature = "bench")]
        if let Some(scale) = bench::marker_scale(w) {
            let seed = match w.rng() {
                Ok(r) => (u64::from(r.next_u32()) << 32) | u64::from(r.next_u32()),
                Err(_) => 0,
            };
            bench::build(w, seed, bench::Shape::scaled(scale));
        }
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        match ev {
            PlayerEvent::Joined => {
                w.put_player(who, RefPlayer::default());
                assign_colour(w, who);
            }
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
            RefAction::FurnaceDeposit { at, item, count } => {
                rules::furnace::deposit(w, who, at.tile(), *item, *count)
            }
            RefAction::FurnaceTake { at } => rules::furnace::take(w, who, at.tile()),
            RefAction::FurnacePickUp { at } => rules::furnace::pick_up(w, who, at.tile()),
        }
    }

    /// Every action is predicted (R2, Tyler 2026-10-10: `FurnaceTake` too; the engine's opt-out keeps
    /// its fixture-only coverage). A take's local result can differ from the host's when a tick
    /// rule added an ingot meanwhile; the host's answer replaces the prediction (a hint, 0012).
    fn predict(_a: &RefAction) -> bool {
        // `test-hooks` (never shipped): the poison craft is the host's to panic on alone.
        #[cfg(feature = "test-hooks")]
        if matches!(_a, RefAction::StartCraft { recipe: 255 }) {
            return false;
        }
        true
    }

    fn growth(a: &RefAction) -> Option<Growth> {
        match a {
            RefAction::PlaceFurnace { .. } => Some(Growth::entities(1)),
            _ => Some(Growth::NONE),
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        rules::collect::tick(cx);
        rules::furnace::tick(cx);
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
            | RefAction::PlaceFurnace { .. }
            | RefAction::FurnaceDeposit { .. }
            | RefAction::FurnaceTake { .. }
            | RefAction::FurnacePickUp { .. } => Ok(()),
        }
    }
}

engine::export_game!(RefGame);
