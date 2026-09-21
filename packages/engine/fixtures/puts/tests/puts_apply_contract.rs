//! `apply`'s "validate first, write after" contract (0003, 0004 Consequences): docs/plan/
//! 12b-world-access-and-sim-driver.md Tests added.

use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead as _};
use engine::sim::{Record, Rejected, Sim, WorldParams};
use engine::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos};
use engine::worldgen::Worldgen;
use fx_puts::{Action, Pos, Puts, Reject};

fn new_sim(seed: u64) -> Sim<Puts> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    })
}

/// `joined_must_put_player` (Planning decisions of docs/plan/12-store-and-game-trait.md, carried
/// into `fx_puts::Puts::on_player`): after a `Joined` event, the player table must already hold a
/// slot -- `Store::apply(&Delta::Roster, ..)`'s own no-op-without-a-slot fallback (M12 Deviations)
/// exists only because this must always hold.
#[test]
fn joined_must_put_player() {
    let mut sim = new_sim(9);
    let mut out = Vec::new();
    sim.step(
        &[Record::Player {
            who: PlayerId(1),
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    assert!(sim.authority().player(PlayerId(1)).is_ok());
}

/// `fx_puts::Puts::apply`'s own `Bump`/`Remove` reject without writing anything (the fixture's
/// module doc comment): running one through `Sim::step` must not trip the "a rejecting apply
/// recorded a write" assert.
#[test]
fn rejecting_apply_wrote_nothing() {
    let mut sim = new_sim(3);
    let mut out = Vec::new();
    sim.step(
        &[Record::Player {
            who: PlayerId(1),
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Bump {
                at: Pos { x: 0, y: 0 },
            },
        }],
        &mut out,
    );
    assert_eq!(out.len(), 1);
    assert!(matches!(
        out[0].result,
        Err(Rejected::Game(Reject::NotFound))
    ));
}

// A deliberately bad game whose `apply` writes state and *then* rejects -- proving the assert in
// `Sim::step` actually fires, not just that a well-behaved handler stays quiet.

struct BadGen;
impl Worldgen for BadGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BadEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BadPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BadGlobal {
    n: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct BadReject;
impl From<Unknown> for BadReject {
    fn from(_: Unknown) -> Self {
        BadReject
    }
}

struct BadGame;
impl Game for BadGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = BadGen;
    type Action = ();
    type Reject = BadReject;
    type Entity = BadEntity;
    type Player = BadPlayer;
    type Global = BadGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &BadEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &BadEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(w: &mut dyn engine::game::WorldWrite<Self>) {
        w.put_global(BadGlobal::default());
    }
    fn on_player(_w: &mut dyn engine::game::WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    /// Deliberately bad: writes, *then* rejects -- violates "validate first, write after" (0003).
    fn apply(
        w: &mut dyn engine::game::WorldWrite<Self>,
        _who: PlayerId,
        _a: &(),
    ) -> Result<(), BadReject> {
        w.put_global(BadGlobal { n: 1 });
        Err(BadReject)
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

#[test]
#[should_panic(expected = "a rejecting apply recorded a write")]
fn rejecting_apply_wrote_nothing_twin_panics() {
    let mut sim: Sim<BadGame> = Sim::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 0,
        max_modified_tiles: 0,
        max_action_growth: 0,
    });
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: (),
        }],
        &mut out,
    );
}
