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
    StartCollect { tile: TileXY, from: WorldXY },
    CancelCollect,
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

/// Per-resource counts (Requirements: inventory is per player). Named fields, not an array indexed
/// by resource id: only four resource kinds exist and will not grow within this game
/// (`docs/spec/reference-game.md` fixes the list), so a fixed struct reads better than a `[u32; N]`
/// the caller has to remember the index convention for. `TS` (M20b step 3): also `Ui.inventory`'s
/// own field type, read straight off the replicated `RefPlayer` -- one shape for both purposes.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Inventory {
    pub iron: u32,
    pub wood: u32,
    pub stone: u32,
    pub coal: u32,
}

impl Inventory {
    /// Adds one unit of the resource named by a resource id (`content::{IRON, WOOD, STONE,
    /// COAL}`); any other id is a no-op (defensive: every caller already checked `COLLECTABLE`).
    pub fn add(&mut self, resource: u8, n: u32) {
        if resource == content::IRON {
            self.iron = self.iron.saturating_add(n);
        } else if resource == content::WOOD {
            self.wood = self.wood.saturating_add(n);
        } else if resource == content::STONE {
            self.stone = self.stone.saturating_add(n);
        } else if resource == content::COAL {
            self.coal = self.coal.saturating_add(n);
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

/// `PlayerState { inventory, stone_mined, collecting }` (Scope, exactly these three fields --
/// unlocks and `crafting` are M20b/M32, Non-scope here).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefPlayer {
    pub inventory: Inventory,
    pub stone_mined: u32,
    pub collecting: Option<Collecting>,
}

/// `GlobalState` (Scope: "empty for now"). The engine roster (coloured dots) is M20b's.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefGlobal;

/// This game has no entities yet (furnaces arrive with M32).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefEntity;

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

/// `Ui { me, inventory, collecting, in_range }` (Scope, M20b step 3). `me` is a raw `u32`, not
/// `engine::game::PlayerId` (same reason as [`UiCollecting::done_at`]: `PlayerId` has no `TS` impl).
/// `Default` reserves `in_range`'s capacity once ([`MAX_IN_RANGE`]); `RefClient::ui` clears and
/// refills it every call, so steady state allocates nothing (Scope, verbatim).
#[derive(Clone, PartialEq, Debug, serde::Serialize, TS)]
#[ts(export)]
pub struct RefUi {
    pub me: u32,
    pub inventory: Inventory,
    pub collecting: Option<UiCollecting>,
    pub in_range: Vec<UiInRange>,
}

impl Default for RefUi {
    fn default() -> Self {
        RefUi {
            me: 0,
            inventory: Inventory::default(),
            collecting: None,
            in_range: Vec::with_capacity(MAX_IN_RANGE),
        }
    }
}

pub struct RefGame;

impl Game for RefGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = RefWorldgen;
    type Action = RefAction;
    type Reject = RefReject;
    type Entity = RefEntity;
    type Player = RefPlayer;
    type Global = RefGlobal;
    type Presence = PlayerPresence;
    type Ui = RefUi;
    type Client = RefClient;

    fn register(r: &mut Registry) {
        content::register(r);
    }

    fn prototype(_e: &RefEntity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(_e: &RefEntity) -> TilePos {
        TilePos::new(0, 0)
    }

    fn genesis(_w: &mut dyn WorldWrite<Self>) {}

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if ev == PlayerEvent::Joined {
            w.put_player(who, RefPlayer::default());
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &RefAction) -> Result<(), RefReject> {
        match a {
            RefAction::StartCollect { tile, from } => {
                rules::collect::start(w, who, tile.tile(), from.world())
            }
            RefAction::CancelCollect => rules::collect::cancel(w, who),
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
            RefAction::CancelCollect => Ok(()),
        }
    }
}

engine::export_game!(RefGame);
