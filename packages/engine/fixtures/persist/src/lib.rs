//! Fixture game `fx-persist` (docs/plan/22-persistence-log-and-snapshots.md Files: "one entity type
//! with a timer, one player field, a global counter, one RNG-using action, tile depletion"). Used
//! by this milestone's own recorded log + checkpoint hashes (`tests/fixture_log.rs`) and by native
//! heavy mode (`tests/heavy.rs`); the `.wasm` this crate also builds (`cdylib`) is M22b's/steps
//! 4-6's to wire up, not this half's.
//!
//! `PlaceTimer` spawns a `Timer` entity; `Timer::tick` re-arms itself through `wake_at` (M21b),
//! so the timer wheel is non-empty at any tick after the first `PlaceTimer` -- exactly what heavy
//! mode needs to "actually cross snapshot points with pending timers" (this milestone's own
//! implementer notes). `Roll` is the one RNG-using action, bumping `Global::rolls`. `Harvest`
//! depletes a tile's `aux` amount by one per call, rejecting `Depleted` once it reaches zero.

use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::time::Ticks;
use engine::world::{PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`) -- same shape as `fx-puts::Pos`.
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

/// The one entity type, with a self-rearming timer (0007 §7).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub period: u32,
    pub fires: u32,
}

/// One player field (Files: "one player field").
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub deposits: u32,
}

/// A global counter (Files: "a global counter"), bumped by `Roll`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub rolls: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    /// Spawns a `Timer` entity at `at`, firing every `period` ticks.
    PlaceTimer { at: Pos, period: u32 },
    /// The one RNG-using action (Files).
    Roll,
    /// Tile depletion (Files): decrements the tile's `aux` amount by one, rejecting `Depleted`
    /// once it reaches zero.
    Harvest { at: Pos },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    Unknown,
    /// `Harvest`: the tile's `aux` amount is already zero.
    Depleted,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// The origin tile's starting resource amount (`Tile::aux`), genesis's own "tile depletion" setup.
pub const HARVEST_START: u16 = 50;

pub struct Persist;

impl Game for Persist {
    const SCHEMA_VERSION: u32 = 1;
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
        r.add_prototype(TraitSet::EMPTY, engine::world::Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Entity) -> TilePos {
        e.pos.tile()
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
        w.set_tile(TilePos::new(0, 0), Tile::new(1, 0, HARVEST_START));
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player::default());
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::PlaceTimer { at, period } => {
                w.spawn(Entity {
                    pos: *at,
                    period: *period,
                    fires: 0,
                });
                Ok(())
            }
            Action::Roll => {
                let r = w.rng()?.below(100);
                let mut g = *w.global();
                g.rolls = g.rolls.wrapping_add(r + 1);
                w.put_global(g);
                Ok(())
            }
            Action::Harvest { at } => {
                let t = w.tile(at.tile())?;
                if t.aux() == 0 {
                    return Err(Reject::Depleted);
                }
                w.set_tile(at.tile(), t.with_aux(t.aux() - 1));
                let mut p = *w.player(who)?;
                p.deposits = p.deposits.wrapping_add(1);
                w.put_player(who, p);
                Ok(())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        // First sight of a freshly spawned `Timer` (its own apply-time `spawn` auto-woke it,
        // M21b): schedule its first fire. Every following fire reschedules itself the same way,
        // so the timer wheel is non-empty at any tick from here on (this milestone's own note:
        // "heavy mode actually crosses snapshot points with pending timers").
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

/// A trivial deterministic worldgen (mirrors `fx-puts::FlatWorldgen`): nothing here depends on
/// interesting terrain.
pub struct FlatWorldgen;

impl Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

engine::export_game!(Persist);

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings_enginereject() {
        // Same reasoning as `fx-puts`/`fx-machines`' own hand-written copy of this test: ts-rs's
        // derive-generated `export_bindings_*` test for `engine::sim::EngineReject` lives in the
        // `engine` crate itself, never run by this crate's own `cargo test export_bindings`.
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
