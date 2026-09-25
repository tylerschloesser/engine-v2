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
}

impl From<Unknown> for RefReject {
    fn from(_: Unknown) -> Self {
        RefReject::Unknown
    }
}

/// Per-resource counts (Requirements: inventory is per player). Named fields, not an array indexed
/// by resource id: only four resource kinds exist and will not grow within this game
/// (`docs/spec/reference-game.md` fixes the list), so a fixed struct reads better than a `[u32; N]`
/// the caller has to remember the index convention for.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
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

/// `Ui` (Scope: "`Default` only; filled in M20b").
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct RefUi;

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
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &RefAction,
    ) -> Result<(), RefReject> {
        Ok(())
    }
}

engine::export_game!(RefGame);
