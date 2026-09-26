//! Fixture game `fx-migrate-v1` (docs/plan/24b-upgrade-and-migration.md Scope: "fixture games
//! migrate-v1, migrate-v2, migrate-v2-hz30"). `SCHEMA_VERSION = 1`, `TICK_RATE` the default 20Hz.
//! The "old" schema `fx-migrate-v2`'s own `migrate()` brings forward: one self-rearming timer
//! entity (mirrors `fx-persist`'s own `Timer`, plus a `keep` flag so a test scenario can choose,
//! per entity, whether the new schema's `migrate` re-creates it -- exercising "registrations for
//! entities the game did not re-create are dropped", Planning decisions 3), one player field, a
//! global counter, and tile overlays for `carry_tiles`'s own canonicalisation rule.
//!
//! Deliberately never imported by `fx-migrate-v2`/`fx-migrate-v2-hz30`'s own `[dependencies]`
//! (only by the cross-fixture *test* binaries' `[dev-dependencies]`, to build real old-schema
//! bytes): decision 1 of the milestone brief is "new code cannot name old types" -- `fx-migrate-
//! v2`'s own `migrate()` keeps a private, structurally-identical copy of the shapes below instead.

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::time::Ticks;
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

/// The one entity type, with a self-rearming timer (mirrors `fx-persist::Entity`) plus `keep`:
/// dropped by `SCHEMA_VERSION = 2` (not part of the new schema at all), read only by
/// `fx-migrate-v2`'s own `migrate()` to decide whether to carry an entity forward.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub period: u32,
    pub fires: u32,
    pub keep: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub deposits: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub rolls: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    PlaceTimer { at: Pos, period: u32, keep: bool },
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

pub struct V1;

impl Game for V1 {
    const SCHEMA_VERSION: u32 = 1;
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
            Action::PlaceTimer { at, period, keep } => {
                w.spawn(Entity {
                    pos: *at,
                    period: *period,
                    fires: 0,
                    keep: *keep,
                });
                Ok(())
            }
            Action::Deposit => {
                let mut p = *w.player(who)?;
                p.deposits = p.deposits.wrapping_add(1);
                w.put_player(who, p);
                Ok(())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        // First sight of a freshly spawned timer entity: schedule its first fire (mirrors
        // `fx-persist::Persist::tick`, verbatim).
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
}

/// A flat worldgen distinct from `fx-migrate-v2`'s own (Deviations: deliberately a different tile
/// value, so a native test can prove `carry_tiles` compares against the *new* build's pristine,
/// never the old one).
pub struct FlatWorldgen;

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(3, 0, 0));
    }
}

// Skipped under `as_dependency` (this crate's `Cargo.toml`): a native binary can install only one
// `#[global_allocator]`, and `fx-migrate-v2`'s cross-fixture test needs this crate as a plain data
// source alongside `fx-migrate-v2`'s own `export_game!`.
#[cfg(not(feature = "as_dependency"))]
engine::export_game!(V1);

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings_enginereject() {
        // Same reasoning as `fx-persist`/`fx-puts`'s own hand-written copy of this test: ts-rs's
        // derive-generated `export_bindings_*` test for `engine::sim::EngineReject` lives in the
        // `engine` crate itself, never run by this crate's own `cargo test export_bindings`.
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
