//! Per-phase tick timing for the benchmark builds (docs/plan/39y-wasm-tick-cost.md step 2).
//! Compiled to nothing unless cargo feature `bench-phases` is on: `mark` is an empty
//! `#[inline(always)]` function, so a release build has no counter, no import and no code here.
//!
//! `mark(p)` attributes the time since the previous `mark` to phase `p`. Natively the sums live in
//! a thread-local (`take`); in a `.wasm` the module has no clock, so each mark calls the one
//! output-only import `engine.bench_mark(id)` and the loader's hook (`setBenchMarkHook`) reads the
//! host clock. **Never feeds state:** nothing here is read by sim code, hashed or branched on.

/// The phases of `Host::tick` (`sim_tick`), in the order they run. `Start` only resets the clock.
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Phase {
    Start = 0,
    /// Gathering action players, then `Sim::step`'s record loop (empty on most ticks).
    Records = 1,
    /// `Authority::begin_tick`: wake swap and active-list compaction.
    BeginTick = 2,
    /// `Game::tick`: the timer drain, the game's `advance`, `put_entity` and the wake list.
    GameTick = 3,
    /// `end_tick` and `advance_tick`.
    EndTick = 4,
    /// The change log walk that bumps each touched chunk's version.
    Changes = 5,
    /// Routing the outcomes to connections.
    Results = 6,
    /// Per-connection camera hold and subscription update.
    Subs = 7,
    // Sub-phases of `GameTick`, sampled: one furnace in `SAMPLE_EVERY` (see `drain_enter`). Their
    // sums are a sample, multiply by `SAMPLE_EVERY`. `Skip` is the unsampled time between samples.
    Skip = 8,
    /// `next_due`: the timer drain's pop.
    Drain = 9,
    /// The game's `advance` logic and its reads.
    Advance = 10,
    /// `TickCx::wake_at`: the timer insert.
    WakeAt = 11,
    /// `TickCx::put_entity`.
    Put = 12,
    /// The cost of one `mark` itself: a sampled furnace marks twice in a row at its start. Each
    /// sampled sub-phase includes one such cost; readings subtract it.
    Overhead = 13,
}

/// One timer pop in this many is timed in full.
pub const SAMPLE_EVERY: u32 = 16;

/// Number of phases, `Start` included (the host's readout has this many slots).
pub const PHASES: usize = 14;

#[cfg(not(feature = "bench-phases"))]
#[inline(always)]
pub fn mark(_: Phase) {}

#[cfg(all(feature = "bench-phases", target_arch = "wasm32"))]
#[inline(never)]
pub fn mark(p: Phase) {
    #[link(wasm_import_module = "engine")]
    unsafe extern "C" {
        #[link_name = "bench_mark"]
        fn host_bench_mark(id: u32);
    }
    // SAFETY: output-only import; the host reads a number and returns.
    unsafe { host_bench_mark(p as u32) }
}

#[cfg(all(feature = "bench-phases", not(target_arch = "wasm32")))]
mod native {
    use super::{PHASES, Phase};
    use std::cell::{Cell, RefCell};
    use std::time::Instant;

    thread_local! {
        static LAST: Cell<Option<Instant>> = const { Cell::new(None) };
        static SUMS: RefCell<[u64; PHASES]> = const { RefCell::new([0; PHASES]) };
    }

    pub fn mark(p: Phase) {
        // Wall clock, measurement only: nothing reads it back into sim state.
        #[allow(clippy::disallowed_methods)]
        let now = Instant::now();
        if let Some(last) = LAST.with(|l| l.replace(Some(now))) {
            if !matches!(p, Phase::Start) {
                let ns = now.duration_since(last).as_nanos() as u64;
                SUMS.with(|s| s.borrow_mut()[p as usize] += ns);
            }
        }
    }

    /// The nanoseconds each phase has taken since the last `take`, then zeroed.
    pub fn take() -> [u64; PHASES] {
        SUMS.with(|s| std::mem::replace(&mut *s.borrow_mut(), [0; PHASES]))
    }
}

#[cfg(all(feature = "bench-phases", not(target_arch = "wasm32")))]
pub use native::{mark, take};

#[cfg(feature = "bench-phases")]
mod sample {
    use super::{Phase, SAMPLE_EVERY, mark};
    use core::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
    static COUNT: AtomicU32 = AtomicU32::new(0);
    static ON: AtomicBool = AtomicBool::new(false);

    pub fn drain_enter() {
        let on = COUNT.fetch_add(1, Relaxed).is_multiple_of(SAMPLE_EVERY);
        ON.store(on, Relaxed);
        if on {
            mark(Phase::Skip);
            mark(Phase::Overhead);
        }
    }
    pub fn at(p: Phase) {
        if ON.load(Relaxed) {
            mark(p);
        }
    }
}

/// Called at the start of `TickCx::next_due`: decides whether this furnace is sampled.
#[cfg(feature = "bench-phases")]
#[inline(always)]
pub fn drain_enter() {
    sample::drain_enter()
}
/// A sampled furnace's sub-phase boundary (no-op otherwise).
#[cfg(feature = "bench-phases")]
#[inline(always)]
pub fn sampled(p: Phase) {
    sample::at(p)
}
#[cfg(not(feature = "bench-phases"))]
#[inline(always)]
pub fn drain_enter() {}
#[cfg(not(feature = "bench-phases"))]
#[inline(always)]
pub fn sampled(_: Phase) {}
