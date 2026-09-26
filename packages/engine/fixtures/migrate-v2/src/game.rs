//! Shared by `fx-migrate-v2` and `fx-migrate-v2-hz30` (docs/plan/24b-upgrade-and-migration.md
//! Files: "three tiny crates sharing source by `#[path]`"; `fx-migrate-v2-hz30/src/lib.rs`
//! `#[path]`-includes this exact file). `SCHEMA_VERSION = 2`: `Entity` drops `fx-migrate-v1`'s own
//! `keep` field and gains `shield`; `Global` gains `version`. The tick rate is a const generic
//! (`V2<HZ>`) so the two crates differ only in which `HZ` they instantiate, never in this file's
//! own text -- `TickRate::hz` is a `const fn`, so `V2::<30>::TICK_RATE` is exactly as compile-time-
//! checked as a literal `TickRate::hz(30)` would be.

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, SaveIncompatible, TickCx, Unknown, WorldRead,
    WorldWrite,
};
use engine::migrate::OldStore;
use engine::time::{TickRate, Ticks};
use engine::world::{Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

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

/// `SCHEMA_VERSION = 2`: `keep` (schema 1's own culling flag, meaningful only during migration) is
/// gone; `shield` is new, defaulted to `0` for a migrated entity (0024 §3a: this shape change is
/// exactly a `SCHEMA_VERSION` bump).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub period: u32,
    pub fires: u32,
    pub shield: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub deposits: u32,
}

/// `version` is new in schema 2 (bumped by `migrate` itself, never by ordinary play).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub rolls: u32,
    pub version: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Deposit,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    Unknown,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// A private copy of `fx-migrate-v1`'s own schema-1 shapes (Planning decisions 1: "new code cannot
/// name old types" -- this module never imports `fx-migrate-v1`, even though the cross-fixture
/// test binary that exercises `migrate` below happens to have it as a `[dev-dependencies]` entry
/// to build real old bytes). Structurally identical to `fx-migrate-v1::{Pos, Entity, Player,
/// Global}` by construction, not by any shared code path.
mod old {
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct Pos {
        pub x: i32,
        pub y: i32,
    }
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct Entity {
        pub pos: Pos,
        pub period: u32,
        pub fires: u32,
        pub keep: bool,
    }
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct Player {
        pub deposits: u32,
    }
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct Global {
        pub rolls: u32,
    }
}

pub struct V2<const HZ: u32>;

impl<const HZ: u32> Game for V2<HZ> {
    const SCHEMA_VERSION: u32 = 2;
    const TICK_RATE: TickRate = TickRate::hz(HZ);
    const GAME_VERSION: &'static str = env!("CARGO_PKG_VERSION");
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Entity) -> TilePos {
        e.pos.tile()
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
            Action::Deposit => {
                let mut p = *w.player(who)?;
                p.deposits = p.deposits.wrapping_add(1);
                w.put_player(who, p);
                Ok(())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            if let Ok(Some(e)) = cx.entity(id)
                && e.period > 0
            {
                let at = cx.tick().add(Ticks(e.period));
                cx.wake_at(id, at);
            }
        }
        while let Some(id) = cx.next_due() {
            if let Ok(Some(e)) = cx.entity(id) {
                let mut e2 = *e;
                e2.fires = e2.fires.wrapping_add(1);
                let at = cx.tick().add(Ticks(e2.period));
                cx.put_entity(id, e2);
                cx.wake_at(id, at);
            }
        }
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }

    /// Brings a `SCHEMA_VERSION = 1` (`fx-migrate-v1`) world forward. `from_schema != 1` declines
    /// (`SaveIncompatible`): this game only ever knows how to migrate from its own immediate
    /// predecessor.
    fn migrate(
        from_schema: u32,
        old: &mut OldStore,
        w: &mut dyn WorldWrite<Self>,
    ) -> Result<(), SaveIncompatible> {
        if from_schema != 1 {
            return Err(SaveIncompatible);
        }

        let g: old::Global = old.global()?;
        w.put_global(Global {
            rolls: g.rolls,
            version: 2,
        });

        for p in old.drain_players() {
            let who = p.key;
            let decoded: old::Player = p.decode()?;
            w.put_player(
                who,
                Player {
                    deposits: decoded.deposits,
                },
            );
        }

        // Schema 1's own `keep` flag decides which entities this schema re-creates at all
        // (Planning decisions 3: "for entities the game did not re-create" -- their timer/wake/
        // active-list registrations are dropped automatically by the engine, not by this loop).
        for e in old.drain_entities() {
            let id = e.key;
            let decoded: old::Entity = e.decode()?;
            if decoded.keep {
                w.put_entity(
                    id,
                    Entity {
                        pos: Pos {
                            x: decoded.pos.x,
                            y: decoded.pos.y,
                        },
                        period: decoded.period,
                        fires: decoded.fires,
                        shield: 0,
                    },
                );
            }
        }

        old.carry_tiles(w);
        Ok(())
    }
}

/// A flat worldgen distinct from `fx-migrate-v1`'s own (Deviations: a different tile value on
/// purpose, so `carry_tiles_canonicalises_against_new_pristine` can tell "matches the new build's
/// pristine" apart from "matches the old one").
pub struct FlatWorldgen;

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 2;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}
