//! `apply_journal_overhead` (docs/plan/21b-timers-wakeups-and-tickcx.md Planning decisions "Host-
//! side atomicity of `apply` via an undo journal"): measures the undo journal's own cost against
//! `fx-machines` (10k mixed actions, 5% rejecting), native, slow tier -- also checks the "zero
//! steady-state allocations" half of the adopt criterion, through `fx_machines::export_game!`'s own
//! installed `engine::abi::Arena`. Prints both medians; the adopt/not-adopt call itself, and the
//! measured numbers, are recorded in the ADR this milestone writes (`write-adr` skill) and in this
//! brief's own Deviations.

use std::time::Duration;

use engine::game::PlayerId;
use engine::sim::{Record, Sim, WorldParams};
use fx_machines::{Action, Machines, Pos};

// No `#[global_allocator]` here: `fx_machines::export_game!` already installs
// `engine::abi::Arena` (needed for the crate's own `cdylib`/`.wasm` target), and that same
// declaration reaches this native test binary through the crate's `rlib` -- a second one would
// conflict ("`#[global_allocator]` in this crate conflicts with global allocator in: fx_machines").
fn live() -> usize {
    engine::abi::arena::live_bytes()
}

const N: usize = 10_000;

/// 10k actions, ~5% deliberately rejecting: about every 20th is a `Remove` at a position nothing
/// ever occupies (`Reject::NotFound`, a clean validate-first reject -- no write, so it exercises
/// the journal's "begin, then nothing to discard" path specifically). The other ~95% are complete,
/// self-contained `Place`/`Feed`/`Move`/`Remove` tetrads over a small, round-robin set of origins,
/// so the population stays bounded (no unbounded growth skewing the measurement) and every action
/// but the deliberate rejects finds exactly the entity it expects.
fn script() -> Vec<Record<Machines>> {
    const MACHINES: i32 = 50; // origins spaced 4 tiles apart, never on water (0007 §6 grid: every 8th tile)
    let mut out = Vec::with_capacity(N);
    let mut seq = 0u32;
    let mut push = |out: &mut Vec<Record<Machines>>, a: Action| {
        seq += 1;
        out.push(Record::Action {
            who: PlayerId(1),
            seq,
            action: a,
        });
    };

    let mut slot = 0i32;
    while out.len() < N {
        if out.len() % 20 == 0 {
            push(
                &mut out,
                Action::Remove {
                    at: Pos { x: -1000, y: -1000 },
                },
            );
            continue;
        }
        let origin = Pos {
            x: slot * 4 + 1,
            y: 1,
        };
        let moved = Pos {
            x: origin.x,
            y: origin.y + 1,
        };
        push(&mut out, Action::Place { origin });
        push(&mut out, Action::Feed { at: origin });
        push(
            &mut out,
            Action::Move {
                at: origin,
                to: moved,
            },
        );
        push(&mut out, Action::Remove { at: moved });
        slot = (slot + 1) % MACHINES;
    }
    out.truncate(N);
    out
}

fn genesis() -> Sim<Machines> {
    Sim::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1_000_000,
        max_modified_tiles: 1_000_000,
        max_action_growth: 4096,
    })
}

/// Runs `script()` once against a fresh `Sim`, with the journal disabled (`journal_disabled`)
/// controlling `Authority::set_journal_disabled_for_test`, and returns the elapsed time.
fn run_once(journal_disabled: bool) -> Duration {
    let mut sim = genesis();
    sim.authority_mut()
        .set_journal_disabled_for_test(journal_disabled);
    let mut out = Vec::new();
    let records = script();
    // Wall-clock timing for a printed measurement only (never state, never hashed, never
    // replayed): the determinism ban on `Instant` (0002 §2) is about sim/apply code, not a bench's
    // own stopwatch (`connection_and_subscriptions.rs`'s own precedent).
    #[allow(clippy::disallowed_types)]
    let start = std::time::Instant::now();
    for record in &records {
        sim.step(std::slice::from_ref(record), &mut out);
    }
    start.elapsed()
}

fn median(mut durations: Vec<Duration>) -> Duration {
    durations.sort();
    durations[durations.len() / 2]
}

/// Slow tier (`.claude/rules` crate `CLAUDE.md`: `slow_*`), run once with `pnpm test:slow rust -t
/// apply_journal_overhead`.
#[test]
fn slow_apply_journal_overhead() {
    const TRIALS: usize = 7;

    let baseline: Vec<Duration> = (0..TRIALS).map(|_| run_once(true)).collect();
    let with_journal: Vec<Duration> = (0..TRIALS).map(|_| run_once(false)).collect();
    let baseline_median = median(baseline);
    let journal_median = median(with_journal);
    let overhead_pct = (journal_median.as_secs_f64() / baseline_median.as_secs_f64() - 1.0) * 100.0;
    println!(
        "apply_journal_overhead: baseline median {baseline_median:?}, journal median \
         {journal_median:?} over {N} actions ({TRIALS} trials each), overhead {overhead_pct:.1}%"
    );

    // Zero-steady-state-allocations half of the adopt criterion: warm up, then check that running
    // the same bounded-population script for a while longer with the journal on does not grow the
    // arena.
    let mut sim = genesis();
    let mut out = Vec::new();
    let records = script();
    for _ in 0..2 {
        for record in &records {
            sim.step(std::slice::from_ref(record), &mut out);
        }
    }
    let before = live();
    for record in &records {
        sim.step(std::slice::from_ref(record), &mut out);
    }
    let after = live();
    println!(
        "apply_journal_overhead: arena growth over one more full script pass (with journal on): \
         {} B",
        after.saturating_sub(before)
    );
}
