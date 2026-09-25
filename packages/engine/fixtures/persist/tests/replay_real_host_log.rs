//! docs/plan/22-persistence-log-and-snapshots.md fix round 1, gap 1 (extended by fix round 2):
//! `testing::replay`/`testing::heavy` had never run against a log the real `Host` produces. Every
//! existing replay test built its log by hand through `FrameWriter` directly (`crates/engine/src/
//! testing/replay.rs`'s own tests, and `fixtures/persist/tests/support/mod.rs`'s `record()`),
//! never through a real connect/admit pipeline; the one real-host log this crate has
//! (`abi_log_parity.rs`) is only byte-compared, never replayed. This drives `testkit::Loopback`
//! (real `Host::connect`/`Host::on_uplink`) through a script with a live, self-rearming timer, a
//! snapshot taken mid-run, and a *second* connection after `testing::heavy`'s own first restore
//! boundary -- then checks that `testing::replay` (from genesis, and from that mid-run snapshot)
//! and `testing::heavy` all reproduce the live run's own checkpoint hashes exactly. Run twice,
//! parameterised on how many idle ticks precede the snapshot: `0` (the snapshot coincides with the
//! last logged frame) and `8` (fix round 2's own finding -- a snapshot taken well after the last
//! real frame, `sim_dirty()` still set from that old event, the ordinary case once fix round 1's
//! own gap-2 fix makes a stale-but-set dirty flag common).

use engine::abi::{Instance, Status};
use engine::persist::{SnapshotProgress, SnapshotReader};
use engine::sim::WorldParams;
use engine::store::Store;
use engine::testing::{Base, Loopback, SnapshotBase, heavy, replay};
use engine::time::Tick;
use engine::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
use engine::worldgen::Pristine;
use fx_persist::{Action, FlatWorldgen, Global, Persist, Pos};

fn params() -> WorldParams<Persist> {
    WorldParams {
        seed: 99,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

fn source() -> Box<dyn PristineSource> {
    Box::new(Pristine::<FlatWorldgen>::new(99, ()))
}

fn seal_and_tick(lb: &mut Loopback<Persist>, log: &mut Vec<u8>) {
    let mut buf = vec![0u8; 8192];
    let n = lb
        .host
        .sim_seal_frame(&mut buf)
        .expect("sim_seal_frame must succeed once genesis has run");
    if n > 0 {
        log.extend_from_slice(&buf[..n as usize]);
    }
    lb.step();
}

fn live_checkpoint(lb: &Loopback<Persist>, out: &mut Vec<(Tick, u64)>) {
    let sim = lb.host.sim().expect("genesis has run");
    out.push((sim.tick(), sim.state_hash()));
}

/// [`run_script`]'s own result: the full log, the live checkpoint list, the snapshot bytes, and
/// where in the log they were taken.
struct Scripted {
    log: Vec<u8>,
    live: Vec<(Tick, u64)>,
    snap_bytes: Vec<u8>,
    snap_tick: Tick,
    snap_log_offset: u32,
}

/// Runs the shared script, taking the snapshot after `idle_before_snapshot` extra idle ticks past
/// the last real frame (`0` = the snapshot coincides with it).
fn run_script(idle_before_snapshot: u32) -> Scripted {
    let mut lb = Loopback::<Persist>::new(params());
    let (_c0, player0) = lb.add_client(0, ChunkDims::new(5), source(), CacheCapacity::Unlimited);

    let mut log = Vec::new();
    let mut live: Vec<(Tick, u64)> = Vec::new();

    seal_and_tick(&mut lb, &mut log); // tick 1: Joined + Connected (real Host::connect)
    live_checkpoint(&lb, &mut live);

    lb.action(
        player0,
        Action::PlaceTimer {
            at: Pos { x: 1, y: 1 },
            period: 3,
        },
    );
    seal_and_tick(&mut lb, &mut log); // tick 2, the last real frame before the snapshot
    live_checkpoint(&lb, &mut live);

    for _ in 0..idle_before_snapshot {
        seal_and_tick(&mut lb, &mut log); // fix round 2: an idle gap *before* the snapshot
    }

    let snap_tick = lb.host.sim().unwrap().tick();
    let snap_log_offset = log.len() as u32;
    let begin_status = lb.host.sim_snapshot_begin(0, snap_log_offset);
    assert_eq!(begin_status, Status::Ok);
    let mut snap_bytes = Vec::new();
    loop {
        let mut buf = [0u8; 4096];
        let n = lb
            .host
            .sim_snapshot_next(&mut buf)
            .expect("sim_snapshot_next must succeed");
        if n == 0 {
            break;
        }
        snap_bytes.extend_from_slice(&buf[..n as usize]);
    }
    live_checkpoint(&lb, &mut live); // the snapshot's own tick

    let ticks_from_2 = 28u32.saturating_sub(idle_before_snapshot);
    for _ in 0..ticks_from_2 {
        seal_and_tick(&mut lb, &mut log); // ..30, crossing testing::heavy's own first N=25 restore
        // boundary (tick 25) with the timer live
    }
    live_checkpoint(&lb, &mut live); // tick 30

    // A second connection *after* that restore boundary: the heavy-mode run that gets restored at
    // tick 25 must still apply this Connection record correctly afterward.
    let (_c1, _player1) = lb.add_client(0, ChunkDims::new(5), source(), CacheCapacity::Unlimited);
    seal_and_tick(&mut lb, &mut log); // tick 31
    live_checkpoint(&lb, &mut live);

    for _ in 0..28 {
        seal_and_tick(&mut lb, &mut log); // ticks 32..59, crossing the second restore boundary too
    }
    // One more real event, so the log has a frame to anchor the final checkpoint to -- a purely
    // idle tail after the last logged frame is not recoverable from the log alone by construction
    // (0005's own "action-free sim progress lost" loss window), so a checkpoint there would be
    // asking replay to know something it fundamentally cannot.
    lb.action(player0, Action::Roll);
    seal_and_tick(&mut lb, &mut log); // tick 60
    live_checkpoint(&lb, &mut live);

    Scripted {
        log,
        live,
        snap_bytes,
        snap_tick,
        snap_log_offset,
    }
}

fn check(idle_before_snapshot: u32) {
    let Scripted {
        log,
        live,
        snap_bytes,
        snap_tick,
        snap_log_offset,
    } = run_script(idle_before_snapshot);
    let checkpoints: Vec<Tick> = live.iter().map(|(t, _)| *t).collect();

    // From genesis.
    let from_genesis = replay(Base::Genesis(params()), &log, &checkpoints);
    assert_eq!(
        from_genesis, live,
        "replay from genesis must match the live run exactly"
    );

    // From the mid-run snapshot: decode it back, then replay only the log tail written after it.
    let shell_terrain = TerrainStore::new(ChunkDims::new(5), source(), CacheCapacity::Unlimited);
    let shell = Store::<Persist>::new(shell_terrain, Global::default());
    let mut reader: SnapshotReader<Persist> = SnapshotReader::new(shell);
    let info = match reader.push(&snap_bytes).unwrap() {
        SnapshotProgress::Done(info) => info,
        SnapshotProgress::NeedMore => panic!("one push must decode a freshly-drained snapshot"),
    };
    assert_eq!(info.tick, snap_tick);
    assert_eq!(
        info.log_ref_tick, 2,
        "the last real frame before the snapshot was tick 2, regardless of any idle gap after it"
    );
    let restored_store = reader.into_store();
    let tail = &log[snap_log_offset as usize..];
    let after: Vec<Tick> = checkpoints
        .iter()
        .copied()
        .filter(|t| *t > snap_tick)
        .collect();
    let live_after: Vec<(Tick, u64)> = live
        .iter()
        .copied()
        .filter(|(t, _)| *t > snap_tick)
        .collect();
    let from_snapshot = replay(
        Base::Snapshot(Box::new(SnapshotBase {
            store: restored_store,
            tick: info.tick,
            rng: info.rng,
            log_ref_tick: info.log_ref_tick,
        })),
        tail,
        &after,
    );
    assert_eq!(
        from_snapshot, live_after,
        "replay from the mid-run snapshot must match the live tail"
    );

    // Heavy mode over the whole log: N=25 crosses two restore boundaries (ticks ~25, ~50), the
    // second connection landing between them.
    let result = heavy(params(), &log, 25);
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn replay_real_host_log_matches_live() {
    check(0);
}

/// Fix round 2's own regression test: the snapshot is taken 8 idle ticks *after* the last real
/// frame (tick 2 -> snapshot at tick 10), reproducing the exact shape that broke `Base::Snapshot`
/// replay before `log_ref_tick` existed (see `Host::sim_snapshot_begin`'s doc comment). Reverting
/// the fix (`git stash` `persist::snapshot`/`testing::replay`'s own changes, or just seeding
/// `log_ref_tick` from `info.tick` instead of `info.log_ref_tick` in `check` above) reproduces:
/// `assertion left == right failed: replay from the mid-run snapshot must match the live tail
/// left: [(Tick(30), ...), (Tick(31), <unchanged from Tick(30)>), (Tick(60), ...)]
/// right: [(Tick(30), ...), (Tick(31), <the real post-connect hash>), (Tick(60), ...)]`
/// (pasted verbatim from the actual run, see this milestone's Deviations).
#[test]
fn replay_from_snapshot_after_idle_gap_matches_live() {
    check(8);
}
