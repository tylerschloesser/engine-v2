//! Fixture game `fx-belts` (M40 onward, `PLAN.md`): the home of every engine belt test. Belts are
//! the engine's `engine::transport` module (docs/decisions/0076) exercised without the reference
//! game's rules (0076 §9: "engine tests never use the reference game").
//!
//! M40 is a skeleton: a valid `Game` on the `fx-machines` shape (one entity type, `Action::Noop`,
//! flat worldgen, `export_game!`) so the crate builds through `pnpm test`'s `fixtures` step and the
//! allowlist and ABI-registry tests cover it. The item-representation spike lives in
//! `tests/spike_repr.rs` (native only, ships nothing: 0077). Belt rules arrive with M42.

use engine::game::{
    Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldWrite,
};
use engine::world::{ChunkCoord, Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

/// M40: no belt action exists yet. `Noop` keeps the enum non-empty (postcard needs a variant) and
/// lets a scenario advance ticks through the ordinary action path.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Noop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`): only reachable on a predicting client.
    Unknown,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// The one entity type (M40: a placeholder 1x1 marker anchored at `origin`; M51's belt entities are
/// the reference game's, not this fixture's).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Marker {
    pub origin: Pos,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global;

pub struct Belts;

impl Game for Belts {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Marker;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        let id = r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        debug_assert_eq!(id, PrototypeId(0));
    }

    fn prototype(_e: &Marker) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Marker) -> TilePos {
        TilePos::new(e.origin.x, e.origin.y)
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global);
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Noop => Ok(()),
        }
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Noop => Some(Growth::NONE),
        }
    }

    fn admit(
        _w: &dyn engine::game::WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

/// Flat grass everywhere: belt tests want a world with nothing in the way.
pub struct FlatWorldgen;

const EDGE: usize = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), EDGE * EDGE);
        out.fill(Tile::new(0, 0, 0));
    }
}

engine::export_game!(Belts);
