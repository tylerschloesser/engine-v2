//! `apply`'s "validate first, write after" contract (0003, 0004 Consequences): M12b Tests added.

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

/// `joined_must_put_player` (Planning decisions of M12, carried
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

// 0037 §1 (wiring): without `debug_assertions` a rejecting `apply` that wrote is rolled back by the
// undo journal through `Sim::step` -> `Authority::handle_rejected_apply_write`, counted in
// `apply_rollbacks`. Every normal test build has `debug_assertions` (the twin above panics), so this
// test exists only in a build without them: `slow_rollback_path_runs_without_debug_assertions`
// below builds and runs it that way.

#[cfg(not(debug_assertions))]
#[test]
fn release_rejecting_apply_that_wrote_is_rolled_back() {
    let mut sim: Sim<BadGame> = Sim::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 0,
        max_modified_tiles: 0,
        max_action_growth: 0,
    });
    let mut out = Vec::new();
    let hash = sim.state_hash();
    assert_eq!(sim.authority().apply_rollbacks(), 0);
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: (),
        }],
        &mut out,
    );
    assert_eq!(
        sim.authority().apply_rollbacks(),
        1,
        "the journal rolled the write back"
    );
    assert_eq!(sim.state_hash(), hash, "the rejected apply left no trace");
    assert_eq!(out.len(), 1);
    assert!(matches!(out[0].result, Err(Rejected::Game(BadReject))));
}

/// Runs the test above in a build with `debug_assertions` off: the dev/test profile with the flag
/// overridden by environment (no production hook), in a target directory of its own so the shared
/// one is not rebuilt. Only a debug-assertions build compiles this test (the nested build would
/// otherwise recurse), and it runs in the slow tier.
#[cfg(debug_assertions)]
#[test]
fn slow_rollback_path_runs_without_debug_assertions() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let target = manifest.join("../../../../target/no-debug-assertions");
    let output =
        std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["test", "-p", "fx-puts", "--test", "puts_apply_contract"])
            .args([
                "--",
                "release_rejecting_apply_that_wrote_is_rolled_back",
                "--exact",
            ])
            .current_dir(manifest)
            .env("CARGO_TARGET_DIR", &target)
            .env("CARGO_PROFILE_DEV_DEBUG_ASSERTIONS", "false")
            .env("CARGO_PROFILE_TEST_DEBUG_ASSERTIONS", "false")
            .output()
            .expect("cargo test spawns");
    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + &String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{text}");
    assert!(
        text.contains("release_rejecting_apply_that_wrote_is_rolled_back ... ok"),
        "the release-only test did not run: {text}"
    );
}
