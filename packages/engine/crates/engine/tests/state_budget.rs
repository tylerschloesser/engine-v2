//! The state-budget check + per-action growth declaration (docs/decisions/
//! 0004-action-timing-and-rejection.md "State-budget check", docs/decisions/
//! 0023-action-growth-declaration.md), native tests that need no fixture crate (docs/plan/
//! 21-entities-and-timers.md Tests added). `growth_declarations_are_honest` and `full_world_
//! rejects_place_accepts_remove_then_place` are the `machines` fixture's own (step 6): they
//! exercise real game handlers this file has no reason to duplicate.

use engine::budget;
use engine::game::{EntityId, Game, Growth, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::sim::{EngineReject, Record, Rejected, Sim, WorldParams};
use engine::testing::testkit::{fill_world, run_script, set_next_entity_id};
use engine::time::Tick;
use engine::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos};
use engine::worldgen::Worldgen;

// Deliberately over the 128 B nominal entity cost (16 `u64` fields alone are 128 B, plus `x`/`y`),
// so a check that mistakenly used `size_of::<G::Entity>()` instead of the fixed nominal figure
// would answer differently (`nominal_costs_are_constants`). Named fields, not a `[u8; N]` array:
// this workspace's pinned `serde` does not derive `Serialize`/`Deserialize` for arrays past 32.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BEntity {
    x: i32,
    y: i32,
    pad0: u64,
    pad1: u64,
    pad2: u64,
    pad3: u64,
    pad4: u64,
    pad5: u64,
    pad6: u64,
    pad7: u64,
    pad8: u64,
    pad9: u64,
    pad10: u64,
    pad11: u64,
    pad12: u64,
    pad13: u64,
    pad14: u64,
    pad15: u64,
    pad16: u64,
    pad17: u64,
    pad18: u64,
    pad19: u64,
    pad20: u64,
    pad21: u64,
    pad22: u64,
    pad23: u64,
    pad24: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct BGlobal;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum BAction {
    /// Honestly declares `Growth::entities(1)`, and spawns exactly one.
    SpawnDeclared,
    /// Undeclared (`growth` returns `None`): the 0004 nominal-headroom fallback applies.
    SpawnUndeclared,
    /// Declares `Growth::NONE` but spawns one anyway -- dishonest, for the audit tests.
    SpawnUnderDeclared,
    /// Declares a nominal cost far over `max_action_growth` -- a declared-bug test, never mind
    /// what it actually does at `apply` time (the debug_assert fires before `apply` runs).
    SpawnOverDeclaredBug,
    /// Declares `Growth::NONE` and does nothing: the "needs no ids" half of the id-exhaustion
    /// test.
    NoOpDeclaredNone,
    /// Declares `Growth::tiles(1)` and paints one tile.
    PaintTile,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct BReject;
impl From<Unknown> for BReject {
    fn from(_: Unknown) -> Self {
        BReject
    }
}

struct BGen;
impl Worldgen for BGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

struct BGame;
impl Game for BGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = BGen;
    type Action = BAction;
    type Reject = BReject;
    type Entity = BEntity;
    type Player = BPlayer;
    type Global = BGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &BEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &BEntity) -> TilePos {
        TilePos::new(e.x, e.y)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, BPlayer);
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &BAction) -> Result<(), BReject> {
        match a {
            BAction::SpawnDeclared | BAction::SpawnUndeclared | BAction::SpawnUnderDeclared => {
                w.spawn(BEntity::default());
                Ok(())
            }
            BAction::SpawnOverDeclaredBug => {
                w.spawn(BEntity::default());
                Ok(())
            }
            BAction::NoOpDeclaredNone => Ok(()),
            BAction::PaintTile => {
                w.set_tile(TilePos::new(999, 999), Tile::new(1, 0, 0));
                Ok(())
            }
        }
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
    fn growth(a: &BAction) -> Option<Growth> {
        match a {
            BAction::SpawnDeclared => Some(Growth::entities(1)),
            BAction::SpawnUndeclared => None,
            BAction::SpawnUnderDeclared => Some(Growth::NONE),
            BAction::SpawnOverDeclaredBug => Some(Growth::entities(u16::MAX)),
            BAction::NoOpDeclaredNone => Some(Growth::NONE),
            BAction::PaintTile => Some(Growth::tiles(1)),
        }
    }
}

fn params(
    seed: u64,
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
) -> WorldParams<BGame> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities,
        max_modified_tiles,
        max_action_growth,
    }
}

fn genesis(
    seed: u64,
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
) -> Sim<BGame> {
    Sim::genesis(params(
        seed,
        max_entities,
        max_modified_tiles,
        max_action_growth,
    ))
}

#[test]
fn undeclared_action_uses_max_action_growth() {
    // max_action_growth = 256 => undeclared threshold needs free_entities * 128 >= 256, i.e. 2.
    // max_modified_tiles is generous (1M) so the tile headroom never gates this on its own.
    let mut short = genesis(1, 10, 1_000_000, 256);
    fill_world(&mut short, 9, 0); // 1 free
    let mut out = Vec::new();
    short.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnUndeclared,
        }],
        &mut out,
    );
    assert!(
        matches!(
            out[0].result,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ),
        "1 free entity * 128 B < 256 B max_action_growth: must reject"
    );

    let mut enough = genesis(2, 10, 1_000_000, 256);
    fill_world(&mut enough, 8, 0); // 2 free
    let mut out2 = Vec::new();
    enough.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnUndeclared,
        }],
        &mut out2,
    );
    assert!(
        out2[0].result.is_ok(),
        "2 free entities * 128 B >= 256 B max_action_growth: must accept"
    );
}

#[test]
fn nominal_costs_are_constants() {
    // 200 sits strictly between the nominal cost (128) and this fixture's real size (>= 208, 25
    // `u64` pad fields plus `x`/`y`), so the two headroom formulas disagree at 1 free entity.
    assert!(
        std::mem::size_of::<BEntity>() >= 200,
        "test fixture needs an entity at least as big as the chosen max_action_growth"
    );
    // max_modified_tiles is generous so the tile dimension never gates this on its own.
    // max_action_growth = 200: nominal headroom (1 free * 128 B = 128) is under it, so an
    // undeclared spawn must reject -- if the check mistakenly used the real, bigger
    // `size_of::<BEntity>()` instead, the headroom would clear 200 and wrongly accept.
    let mut sim = genesis(3, 10, 1_000_000, 200);
    fill_world(&mut sim, 9, 0);
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnUndeclared,
        }],
        &mut out,
    );
    assert!(
        matches!(
            out[0].result,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ),
        "the undeclared-path headroom must use the fixed 128 B nominal cost, not size_of::<BEntity>()"
    );
}

#[test]
fn budget_verdict_replays_identically() {
    let script = vec![
        (
            Tick(1),
            Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: BAction::SpawnDeclared,
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: BAction::SpawnDeclared,
            },
        ),
        (
            Tick(3),
            Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: BAction::SpawnDeclared,
            },
        ),
    ];

    let mut live = genesis(11, 2, 100, 4096); // room for exactly 2 entities
    let mut out = Vec::new();
    let mut verdicts = Vec::new();
    for (_, record) in &script {
        live.step(std::slice::from_ref(record), &mut out);
        verdicts.push(out[0].result.is_ok());
    }
    assert_eq!(
        verdicts,
        vec![true, true, false],
        "the third spawn must be the one that finds the world full"
    );
    let live_hash = live.state_hash();

    let mut replay = genesis(11, 2, 100, 4096);
    let replay_hash = run_script(&mut replay, &script);
    assert_eq!(
        live_hash, replay_hash,
        "the verdict sequence must replay identically"
    );
}

#[test]
fn full_world_still_accepts_join() {
    let build = || {
        let mut sim = genesis(4, 5, 5, 4096);
        fill_world(&mut sim, 5, 5);
        sim
    };
    let mut sim = build();
    let mut out = Vec::new();
    sim.step(
        &[Record::Player {
            who: PlayerId(1),
            ev: PlayerEvent::Joined,
        }],
        &mut out,
    );
    assert_eq!(sim.authority().store().player(PlayerId(1)), Ok(&BPlayer));
    let live_hash = sim.state_hash();

    let mut replay = build();
    let replay_hash = run_script(
        &mut replay,
        &[(
            Tick(1),
            Record::Player {
                who: PlayerId(1),
                ev: PlayerEvent::Joined,
            },
        )],
    );
    assert_eq!(live_hash, replay_hash);
}

#[test]
fn id_exhaustion_rejects_state_budget_full() {
    let max_real_id = EntityId::PROVISIONAL_BIT - 1;

    let mut growing = genesis(5, 1_000_000, 1_000_000, 4096);
    set_next_entity_id(&mut growing, max_real_id + 1); // 0 ids left
    let mut out = Vec::new();
    growing.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnDeclared,
        }],
        &mut out,
    );
    assert!(
        matches!(
            out[0].result,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ),
        "a declared-growing action needs 1 id; none remain"
    );

    let mut noop = genesis(6, 1_000_000, 1_000_000, 4096);
    set_next_entity_id(&mut noop, max_real_id + 1);
    let mut out2 = Vec::new();
    noop.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::NoOpDeclaredNone,
        }],
        &mut out2,
    );
    assert!(
        out2[0].result.is_ok(),
        "a Growth::NONE action needs no ids and must still pass"
    );
}

#[test]
#[should_panic(expected = "max_action_growth")]
fn over_max_declaration_panics_in_debug() {
    let mut sim = genesis(7, 1_000_000, 1_000_000, 4096);
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnOverDeclaredBug,
        }],
        &mut out,
    );
}

#[test]
#[should_panic(expected = "under-declared its growth")]
fn under_declared_growth_panics_in_debug() {
    let mut sim = genesis(8, 1_000_000, 1_000_000, 4096);
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: BAction::SpawnUnderDeclared,
        }],
        &mut out,
    );
}

#[test]
fn under_declared_growth_counts_in_release() {
    budget::set_force_release_audit_for_test(true);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut sim = genesis(9, 1_000_000, 1_000_000, 4096);
        let mut out = Vec::new();
        sim.step(
            &[Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: BAction::SpawnUnderDeclared,
            }],
            &mut out,
        );
        (
            sim.authority().growth_violations(),
            sim.state_hash(),
            out[0].result.is_ok(),
        )
    }));
    budget::set_force_release_audit_for_test(false);
    let (violations, hash_with_audit, applied_ok) =
        outcome.expect("forced release mode must not panic on an under-declared action");
    assert_eq!(
        violations, 1,
        "the release-mode audit must count exactly one violation"
    );
    assert!(
        applied_ok,
        "the under-declared action's write is kept, not rolled back"
    );

    // The same write, made directly through `Authority` and never touching the audit path at
    // all: `growth_violations` is a diagnostic field on `Authority`, never hashed, so the audit
    // (whichever branch it takes) cannot change `Store`'s own state -- proven directly rather
    // than assumed. One empty `step` follows the bare spawn so both runs pass the same tick fixed
    // point (M21b): a put outside `G::tick` auto-wakes into `woken_next`, which is hashed, and only
    // a tick drains it -- without the step the wake queue, not the audit, would differ.
    let mut direct = genesis(9, 1_000_000, 1_000_000, 4096);
    direct.authority_mut().spawn(BEntity::default());
    direct.step(&[], &mut Vec::new());
    assert_eq!(hash_with_audit, direct.state_hash());
}

#[test]
fn init_rejects_budget_over_arena() {
    use engine::abi::{Instance, RegionLayout, Role, Status};

    let ok_cfg = r#"{"seed":"0x1","params":null,"maxEntities":10,"maxModifiedTiles":10,
        "maxActionGrowth":4096,"cacheChunks":1,"worldBudgetBytes":1000000000}"#;
    let mut layout = RegionLayout::new();
    assert!(engine::host::Host::<BGame>::init(Role::Sim, ok_cfg, &mut layout).is_ok());

    let bad_cfg = r#"{"seed":"0x1","params":null,"maxEntities":1000000,"maxModifiedTiles":1000000,
        "maxActionGrowth":4096,"cacheChunks":1,"worldBudgetBytes":1000}"#;
    let mut layout2 = RegionLayout::new();
    let err = engine::host::Host::<BGame>::init(Role::Sim, bad_cfg, &mut layout2);
    assert_eq!(err.err(), Some(Status::BudgetExceedsArena));
}
