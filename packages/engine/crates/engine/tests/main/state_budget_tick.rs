//! The tick-rule half of the state budget (docs/plan/21b-timers-wakeups-and-tickcx.md Tests
//! added): `tick_rule_put_past_limit_is_applied`, `tick_spawn_without_ids_is_engine_fault`. A
//! test-local `Game` whose tick rule spawns exactly one entity every tick -- deliberately not
//! `fixtures/machines`, so its own goldens (`place-border`, `full-world`, `smelt-cycle`,
//! `idle-world-costs-zero`) stay fixed.

use engine::game::{
    EntityId, Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead,
    WorldWrite,
};
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit::set_next_entity_id;
use engine::world::{ChunkCoord, Footprint, PrototypeId, Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct SEntity;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct SPlayer;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct SGlobal;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum SAction {
    /// Declares `Growth::entities(1)` and actually spawns one.
    Grow,
    /// Declares `Growth::NONE` and writes nothing.
    Noop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct SReject;
impl From<Unknown> for SReject {
    fn from(_: Unknown) -> Self {
        SReject
    }
}

struct SGen;
impl Worldgen for SGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

struct SGame;
impl Game for SGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = SGen;
    type Action = SAction;
    type Reject = SReject;
    type Entity = SEntity;
    type Player = SPlayer;
    type Global = SGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
    }
    fn prototype(_e: &SEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &SEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(SGlobal);
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, SPlayer);
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &SAction) -> Result<(), SReject> {
        match a {
            SAction::Grow => {
                w.spawn(SEntity);
                Ok(())
            }
            SAction::Noop => Ok(()),
        }
    }
    /// Spawns exactly one entity every tick, through `TickCx` -- never checked against the state
    /// budget (0004/0023: "never for ... tick rules").
    fn tick(cx: &mut TickCx<'_, Self>) {
        cx.spawn(SEntity);
    }
    fn growth(a: &SAction) -> Option<Growth> {
        match a {
            SAction::Grow => Some(Growth::entities(1)),
            SAction::Noop => Some(Growth::NONE),
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &SAction,
    ) -> Result<(), SReject> {
        Ok(())
    }
}

fn genesis(seed: u64, max_entities: u32) -> Sim<SGame> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities,
        max_modified_tiles: 1_000_000,
        max_action_growth: 4096,
    })
}

const MAX_ENTITIES: u32 = 3;

/// Runs the whole script (join, 5 idle ticks that each spawn one entity through the tick rule,
/// then a rejected `Grow` and an accepted `Noop`) against a fresh `Sim`, returning the final
/// `(entity_count, state_hash)` and each action's own outcome.
fn run_script(seed: u64) -> (u32, u64, Vec<bool>) {
    let mut sim = genesis(seed, MAX_ENTITIES);
    let mut out = Vec::new();
    let p1 = PlayerId(1);
    sim.step(
        &[Record::Player {
            who: p1,
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    // 5 idle ticks: the tick rule spawns one entity each, unconditionally -- past `MAX_ENTITIES`,
    // which tick-rule writes are never checked against (0007 §8 "soft by the margin").
    for _ in 0..5 {
        sim.step(&[], &mut out);
    }
    let mut oks = Vec::new();
    sim.step(
        &[Record::Action {
            who: p1,
            seq: 1,
            action: SAction::Grow,
        }],
        &mut out,
    );
    oks.push(out[0].result.is_ok());
    sim.step(
        &[Record::Action {
            who: p1,
            seq: 2,
            action: SAction::Noop,
        }],
        &mut out,
    );
    oks.push(out[0].result.is_ok());
    (
        sim.authority().store().entity_count(),
        sim.state_hash(),
        oks,
    )
}

#[test]
fn tick_rule_put_past_limit_is_applied() {
    let (count, hash, oks) = run_script(1);
    assert!(
        count > MAX_ENTITIES,
        "5 tick-rule spawns plus one accepted Noop must all be applied regardless of the limit \
         (Grow itself is rejected): got {count}"
    );
    assert!(
        !oks[0],
        "a growing action must be rejected once the budget is full"
    );
    assert!(oks[1], "Growth::NONE must always pass");

    // Replay: an identical script from a fresh `Sim` reaches the identical count, hash and outcomes.
    let (replay_count, replay_hash, replay_oks) = run_script(1);
    assert_eq!(count, replay_count);
    assert_eq!(hash, replay_hash);
    assert_eq!(oks, replay_oks);
}

#[test]
#[should_panic(expected = "an engine fault")]
fn tick_spawn_without_ids_is_engine_fault() {
    let mut sim = genesis(2, 1_000_000);
    // Push `next_entity_id` to the exhaustion boundary (0022 §2) without spawning billions of
    // entities to reach it.
    set_next_entity_id(&mut sim, EntityId::PROVISIONAL_BIT);
    let mut out = Vec::new();
    sim.step(&[], &mut out); // the tick rule's own unconditional spawn must panic.
}
