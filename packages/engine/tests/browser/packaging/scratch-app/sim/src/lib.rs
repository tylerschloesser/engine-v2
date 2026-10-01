//! The smallest game the tarball test needs: one action (`Ping`) that bumps a global counter, no
//! entities, flat terrain. Written the way an external game would write it (0017 §6).

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub pings: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub pings: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Action {
    Ping,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Reject {
    Unknown,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

pub struct Scratch;

impl Game for Scratch {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = Flat;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, engine::world::Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Entity) -> TilePos {
        TilePos::new(e.x, e.y)
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player::default());
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Ping => {
                let mut g = *w.global();
                g.pings = g.pings.wrapping_add(1);
                w.put_global(g);
                let mut p = *w.player(who)?;
                p.pings = p.pings.wrapping_add(1);
                w.put_player(who, p);
                Ok(())
            }
        }
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

pub struct Flat;

impl Worldgen for Flat {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

engine::export_game!(Scratch);
