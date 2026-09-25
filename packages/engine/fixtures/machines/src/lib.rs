//! Fixture game `fx-machines` (docs/plan/21-entities-and-timers.md): a 2x2 multi-tile entity that
//! exercises footprint occupancy, footprint-scoped delta/snapshot delivery and the state-budget
//! check end to end -- the things M21 makes real that no earlier fixture's 1x1 entities ever
//! could.
//!
//! Handlers: `Place { origin }` spawns a `Machine` anchored at `origin` (its footprint is the
//! prototype's 2x2, 0024 §7) after asking the tiles it would cover for `NOT_BUILDABLE` (0007 §6:
//! "the same bit query names no tile type" -- water and another machine share the bit, so this
//! handler names neither). `Feed { at }`/`Remove { at }` look an entity up by position through the
//! now-real `WorldRead::entity_at` (M21); `Move { at, to }` relocates one, checked the same way
//! `Place` is. No tick rule yet (21b: timers, wake-ups, the `done_at` field this milestone only
//! stores).
//!
//! `growth`: `Place` declares `Growth::entities(1)`; every other handler declares `Growth::NONE`
//! (none of them ever adds an entity or a modified tile -- `Move`/`Feed` overwrite an existing
//! entity's whole value, `Remove` only removes).

use engine::game::{
    Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{ChunkCoord, Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`). `#[ts(export)]`: `Action`'s own two struct-variant fields need a
/// generated file too (ts-rs writes one only for an opted-in type it is referenced from).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// `NOT_BUILDABLE` (0007 §6): the one trait bit this fixture declares, shared by water (base id
/// [`WATER_BASE`]) and the `Machine` prototype -- `Place`/`Move` ask `traits_at` for it, naming
/// neither source.
pub const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
/// The worldgen's water base tile id.
pub const WATER_BASE: u8 = 1;
/// The worldgen's grass (buildable) base tile id.
pub const GRASS_BASE: u8 = 0;
/// The `Machine` prototype's footprint (2x2, 0007 §5): both axes well under any of 0007 §3's
/// chunk edges, so it overlaps at most 4 chunks when anchored on a corner.
pub const MACHINE_FOOTPRINT: Footprint = Footprint { w: 2, h: 2 };

/// One action per handler this fixture exercises.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Place { origin: Pos },
    Feed { at: Pos },
    Move { at: Pos, to: Pos },
    Remove { at: Pos },
}

/// `From<Unknown>` (0003: "add a `?` to each read and `impl From<Unknown> for Reject`").
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`): the target chunk is not held (never reachable
    /// on the host, only meaningful for a predicting client, M25).
    Unknown,
    /// `Feed`/`Move`/`Remove`: no entity at that position.
    NotFound,
    /// `Place`/`Move`: some tile the new footprint would cover carries `NOT_BUILDABLE` (water or
    /// another machine).
    Blocked,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Replicated whole-value entity (0003: "plain data, no `Vec`"), anchored at its own `origin`
/// (`Game::anchor`, 0024 §7). `fed`/`done_at`/`count` are 21b's own fields to actually act on
/// (the timer wheel, wake-ups): this milestone only stores them.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Machine {
    pub origin: Pos,
    pub fed: bool,
    pub done_at: u32,
    pub count: u32,
}

/// No per-player state this fixture needs yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

/// No global state this fixture needs yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global;

/// The 4 tiles a [`MACHINE_FOOTPRINT`] anchored at `origin` covers.
fn covers(origin: Pos) -> [TilePos; 4] {
    let t = origin.tile();
    [
        TilePos::new(t.x, t.y),
        TilePos::new(t.x + 1, t.y),
        TilePos::new(t.x, t.y + 1),
        TilePos::new(t.x + 1, t.y + 1),
    ]
}

/// "Ask the tiles" (0007 §6): `true` if any tile the footprint at `origin` would cover carries
/// `NOT_BUILDABLE` -- whether from the tile itself (water) or an occupant (another machine),
/// `traits_at`'s own union answers with one query naming neither.
fn blocked(w: &dyn WorldRead<Machines>, origin: Pos) -> Result<bool, Unknown> {
    for p in covers(origin) {
        if w.traits_at(p)?.contains(NOT_BUILDABLE) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub struct Machines;

impl Game for Machines {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = MachinesWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Machine;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.set_base_traits(WATER_BASE, NOT_BUILDABLE);
        // The only prototype: `Machine`'s own 2x2, sharing the water bit (module doc comment).
        let id = r.add_prototype(NOT_BUILDABLE, MACHINE_FOOTPRINT);
        debug_assert_eq!(id, PrototypeId(0));
    }

    fn prototype(_e: &Machine) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Machine) -> TilePos {
        e.origin.tile()
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global);
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Place { origin } => {
                let r: &dyn WorldRead<Machines> = w;
                if blocked(r, *origin)? {
                    return Err(Reject::Blocked);
                }
                w.spawn(Machine {
                    origin: *origin,
                    fed: false,
                    done_at: 0,
                    count: 0,
                });
                Ok(())
            }
            Action::Feed { at } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                let mut m = w.entity(id)?.copied().ok_or(Reject::NotFound)?;
                m.fed = true;
                w.put_entity(id, m);
                Ok(())
            }
            Action::Move { at, to } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                let mut m = w.entity(id)?.copied().ok_or(Reject::NotFound)?;
                let r: &dyn WorldRead<Machines> = w;
                if blocked(r, *to)? {
                    return Err(Reject::Blocked);
                }
                m.origin = *to;
                w.put_entity(id, m);
                Ok(())
            }
            Action::Remove { at } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                w.despawn(id);
                Ok(())
            }
        }
    }

    /// No v1 rule needs a tick rule yet (21b: timers, wake-ups, active lists).
    fn tick(_cx: &mut TickCx<'_, Self>) {}

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Place { .. } => Some(Growth::entities(1)),
            Action::Feed { .. } | Action::Move { .. } | Action::Remove { .. } => Some(Growth::NONE),
        }
    }

    /// HOST ONLY, never replayed (0004 Pipeline step 2): unused here (every rejection this
    /// fixture needs is a real `apply`-time read, `admit`'s default `Ok` is unchanged).
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

/// A sparse, deterministic water grid (0007 §6's own bit, not a realistic biome -- Non-scope:
/// worldgen itself is M08's): every 8th tile on both axes is water, everything else grass. Dense
/// enough that a fixed scenario can reliably place a machine near or away from one; sparse enough
/// that most footprints never touch it by accident.
pub struct MachinesWorldgen;

const EDGE: i32 = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for MachinesWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        let bx = chunk.x.wrapping_mul(EDGE);
        let by = chunk.y.wrapping_mul(EDGE);
        for ty in 0..EDGE {
            let wy = by.wrapping_add(ty);
            for tx in 0..EDGE {
                let wx = bx.wrapping_add(tx);
                let water = wx.rem_euclid(8) == 0 && wy.rem_euclid(8) == 0;
                out[(ty * EDGE + tx) as usize] =
                    Tile::new(if water { WATER_BASE } else { GRASS_BASE }, 0, 0);
            }
        }
    }
}

engine::export_game!(Machines);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn water_is_not_buildable() {
        let mut r = Registry::new();
        Machines::register(&mut r);
        assert!(
            r.tile_traits(Tile::new(WATER_BASE, 0, 0))
                .contains(NOT_BUILDABLE)
        );
        assert!(
            !r.tile_traits(Tile::new(GRASS_BASE, 0, 0))
                .contains(NOT_BUILDABLE)
        );
        assert!(r.prototype_traits(PrototypeId(0)).contains(NOT_BUILDABLE));
        assert_eq!(r.footprint(PrototypeId(0)), MACHINE_FOOTPRINT);
    }

    #[test]
    fn covers_is_the_2x2_block() {
        let got = covers(Pos { x: 5, y: 5 });
        assert_eq!(
            got,
            [
                TilePos::new(5, 5),
                TilePos::new(6, 5),
                TilePos::new(5, 6),
                TilePos::new(6, 6),
            ]
        );
    }
}
