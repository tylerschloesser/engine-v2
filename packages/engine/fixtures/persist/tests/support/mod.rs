//! Shared script for `fx-persist`'s own recorded log (docs/plan/22-persistence-log-and-snapshots.md
//! Order of work step 3: "record the `persist` fixture log by a scripted native run"). `record()`
//! drives a `Sim<Persist>` through a fixed, deterministic script while writing the exact same
//! records through `engine::persist::FrameWriter`, so the log and the live hashes stay in lockstep
//! by construction -- the same technique `engine`'s own `testing::replay` tests use, at fixture
//! scale (~320 ticks, past several would-be 25-tick and 1-tick heavy-mode snapshot boundaries).
//!
//! Exercises every part of the fixture's own feature set (docs/plan/
//! 22-persistence-log-and-snapshots.md Files): a `Joined` connection event, `PlaceTimer` (the
//! timer wheel, self-rearming via `TickCx::wake_at`), `Roll` (`SimRng`), and enough `Harvest` calls
//! to run the origin tile's resource down to zero and then keep going -- the tail of those are
//! rejected (`Reject::Depleted`), so the log also carries rejected actions, not only accepted ones.

use engine::bytes::ByteSink;
use engine::game::{PlayerEvent, PlayerId};
use engine::persist::FrameWriter;
use engine::sim::{Outcome, Record, Sim, WorldParams};
use engine::time::Tick;
use fx_persist::{Action, Persist, Pos};

pub fn fixture_params() -> WorldParams<Persist> {
    WorldParams {
        seed: 42,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

fn idle(sim: &mut Sim<Persist>, out: &mut Vec<Outcome<Persist>>, idle_since: &mut u32) {
    sim.step(&[], out);
    *idle_since += 1;
}

fn logged(
    sim: &mut Sim<Persist>,
    out: &mut Vec<Outcome<Persist>>,
    log: &mut Vec<u8>,
    idle_since: &mut u32,
    records: &[Record<Persist>],
) {
    let tick_delta = *idle_since + 1;
    let mut w = FrameWriter::<Persist>::new();
    for r in records {
        match r {
            Record::Action { who, seq, action } => w.push_action(*who, *seq, *action),
            Record::Player { who, ev } => w.push_connection(*who, *ev),
        }
    }
    w.finish(tick_delta, &mut VecSink(log));
    sim.step(records, out);
    *idle_since = 0;
}

/// The recorded script's log bytes and the checkpoint hashes taken at fixed points along the way
/// (ascending ticks). `PLAYER` is the one player in the script.
pub const PLAYER: PlayerId = PlayerId(1);

pub struct Recorded {
    pub log: Vec<u8>,
    // Read by `tests/fixture_log.rs`'s own bless test; `tests/heavy.rs` only needs `log`, and
    // Rust's per-binary dead-code analysis does not see across that split.
    #[allow(dead_code)]
    pub checkpoints: Vec<(Tick, u64)>,
}

pub fn record() -> Recorded {
    let mut sim = Sim::<Persist>::genesis(fixture_params());
    let mut out = Vec::new();
    let mut log = Vec::new();
    let mut idle_since = 0u32;
    let mut checkpoints = Vec::new();
    let mut seq = 0u32;
    let mut next_seq = || {
        seq += 1;
        seq
    };

    logged(
        &mut sim,
        &mut out,
        &mut log,
        &mut idle_since,
        &[Record::Player {
            who: PLAYER,
            ev: PlayerEvent::Joined,
        }],
    );
    logged(
        &mut sim,
        &mut out,
        &mut log,
        &mut idle_since,
        &[Record::Action {
            who: PLAYER,
            seq: next_seq(),
            action: Action::PlaceTimer {
                at: Pos { x: 5, y: 5 },
                period: 7,
            },
        }],
    );
    for _ in 0..5 {
        idle(&mut sim, &mut out, &mut idle_since);
    }
    logged(
        &mut sim,
        &mut out,
        &mut log,
        &mut idle_since,
        &[Record::Action {
            who: PLAYER,
            seq: next_seq(),
            action: Action::Roll,
        }],
    );
    checkpoints.push((sim.tick(), sim.state_hash()));

    // Deplete the origin tile (starts at `fx_persist::HARVEST_START` = 50) and keep going a good
    // way past zero, so the tail of these is rejected (`Reject::Depleted`) -- a real reject/accept
    // mix in the log, and a real growth-audit-free path (`Harvest` declares no growth override,
    // the trait default, well under the fixture's generous `max_action_growth`).
    for i in 0..60u32 {
        if i % 6 == 0 {
            idle(&mut sim, &mut out, &mut idle_since);
        }
        logged(
            &mut sim,
            &mut out,
            &mut log,
            &mut idle_since,
            &[Record::Action {
                who: PLAYER,
                seq: next_seq(),
                action: Action::Harvest {
                    at: Pos { x: 0, y: 0 },
                },
            }],
        );
        if i == 30 {
            checkpoints.push((sim.tick(), sim.state_hash()));
        }
    }
    checkpoints.push((sim.tick(), sim.state_hash()));

    // A second `Roll`, well past several of `heavy_mode_fixture_n25`'s own 25-tick restore
    // boundaries (the first `Roll` above lands around tick 8, before even the *first* boundary,
    // so a `heavy_mode_fixture_n25` run that lost `SimRng` state on every restore would still
    // pass -- both runs process that first `Roll` identically before any restore ever happens.
    // Confirmed by injection: dropping the restored `SimRng` in `Authority::from_snapshot`, kept
    // only long enough to observe the result, then reverted -- `heavy_mode_fixture_n25` stayed
    // green (a real vacuity gap in the fast tier alone) while `slow_heavy_mode_fixture_n1` failed
    // at tick 8 (`FirstDivergence { tick: Tick(8) }`), the first `Roll`. This second `Roll` closes
    // that gap for the fast tier too.
    logged(
        &mut sim,
        &mut out,
        &mut log,
        &mut idle_since,
        &[Record::Action {
            who: PLAYER,
            seq: next_seq(),
            action: Action::Roll,
        }],
    );
    checkpoints.push((sim.tick(), sim.state_hash()));

    // Run well past several 25-tick (and 1-tick) heavy-mode snapshot boundaries with the timer
    // still pending (docs/plan/22-persistence-log-and-snapshots.md implementer notes: "heavy mode
    // actually crosses snapshot points with pending timers").
    while sim.tick().0 < 320 {
        idle(&mut sim, &mut out, &mut idle_since);
    }
    checkpoints.push((sim.tick(), sim.state_hash()));

    Recorded { log, checkpoints }
}
