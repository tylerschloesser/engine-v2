//! [`HostClock`] v1 (docs/plan/26-prediction-rendering-and-clocks.md Planning decisions):
//! "offset sample per arriving frame (`tick × tick_ms − arrived_ms`), estimate = maximum over a
//! 2 s window (late arrivals only lower a sample), slewed with the dilation limit of 0010, never
//! stepped except by `rebase()`". Fed once per client-worker wake with the *current* authoritative
//! tick and the wake's own local wall time (`ClientCore::tick_fraction`, driven from `frame(t_ms)`'s
//! real `camera.frame_time_ms`) -- not only when a new host frame actually lands: a repeated call
//! with an unchanged `tick` at a growing `arrived_ms` only ever produces a *lower* offset sample
//! ("late arrivals only lower a sample"), so the windowed maximum stays pinned to the freshest real
//! observation and idle ticks (0010: "idle ticks send nothing") never freeze [`Self::now`]'s own
//! progress.
//!
//! Allocation: [`Self::samples`] is a `VecDeque` reserved once at [`Self::new`] and never grown
//! past that reservation in steady state (push is always paired with a pop when at capacity, and
//! the window prune only ever shrinks it further) -- `client::core::ClientCore` is under
//! `.claude/rules/hot-paths.md`'s `client/**`, so every real per-wake caller of this type must stay
//! allocation-free.

use std::collections::VecDeque;

use crate::time::{Tick, TickRate};

/// 0010 "Interpolation delay": "slewed with at most 10% time dilation, never stepped" -- the same
/// number, reused verbatim for this clock's own slew (Planning decisions: "slewed with the
/// dilation limit of 0010"). Not imported from 0010's own constant (there isn't one; the ADR is
/// prose) -- pinned here as this module's one definition.
const DILATION_LIMIT: f64 = 0.10;
/// Planning decisions: "estimate = maximum over a 2 s window".
const WINDOW_MS: f64 = 2000.0;
/// Generous headroom over what the window could ever really hold (0010's own heartbeat floor is
/// one frame every 500 ms, so ~4 samples typically; worst case every tick at 60 Hz for the full 2 s
/// window is 120) -- sized so [`Self::on_frame`] never needs to grow the deque past this even at an
/// unusually high configured tick rate.
const MAX_SAMPLES: usize = 128;

/// One `(arrived_ms, offset)` sample: `offset = tick_ms_of(tick) - arrived_ms` (module doc
/// comment).
type Sample = (f64, f64);

pub struct HostClock {
    tick_ms: f64,
    samples: VecDeque<Sample>,
    /// The windowed maximum offset as of the most recent [`Self::on_frame`] (module doc comment).
    target_offset: f64,
    /// The slewed value [`Self::now`]/[`Self::now_f64`] actually read (Planning decisions: "never
    /// stepped except by `rebase()`").
    effective_offset: f64,
    last_local_ms: f64,
    /// `false` until the very first [`Self::on_frame`] sample: that one seeds `effective_offset`
    /// directly (there is nothing to slew *from* yet, so this is initialization, not a step).
    initialized: bool,
}

impl HostClock {
    pub fn new(rate: TickRate) -> Self {
        HostClock {
            tick_ms: 1000.0 / rate.hz_value() as f64,
            samples: VecDeque::with_capacity(MAX_SAMPLES),
            target_offset: 0.0,
            effective_offset: 0.0,
            last_local_ms: 0.0,
            initialized: false,
        }
    }

    /// Integrates the slew from `self.last_local_ms` to `local_ms` at a rate bounded by
    /// [`DILATION_LIMIT`] per elapsed millisecond -- the one and only place `effective_offset`
    /// changes outside [`Self::rebase`]. A `local_ms` at or behind `self.last_local_ms` (a backward
    /// or repeated call -- main-thread rAF jitter across two reads in the same wake, in practice) is
    /// a no-op: `self.last_local_ms` itself only ever moves forward, which is what makes
    /// [`Self::now_f64`] (reading position from `self.last_local_ms`, not the raw argument)
    /// monotone regardless of what `local_ms` does.
    fn advance(&mut self, local_ms: f64) {
        if local_ms <= self.last_local_ms {
            return;
        }
        let elapsed = local_ms - self.last_local_ms;
        let diff = self.target_offset - self.effective_offset;
        let max_step = elapsed * DILATION_LIMIT;
        self.effective_offset += diff.clamp(-max_step, max_step);
        self.last_local_ms = local_ms;
    }

    /// One frame's own `(tick, arrived_ms)` sample (module doc comment). Advances the slew to
    /// `arrived_ms` *before* folding in the new sample, so the step this call itself applies still
    /// reflects the *previous* target -- the new sample only ever changes what future calls slew
    /// toward.
    pub fn on_frame(&mut self, tick: Tick, arrived_ms: f64) {
        self.advance(arrived_ms);
        let offset = tick.0 as f64 * self.tick_ms - arrived_ms;
        if self.samples.len() == self.samples.capacity() {
            self.samples.pop_front();
        }
        self.samples.push_back((arrived_ms, offset));
        while let Some(&(t, _)) = self.samples.front() {
            if arrived_ms - t > WINDOW_MS {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let mut max_offset = f64::NEG_INFINITY;
        for &(_, o) in self.samples.iter() {
            if o > max_offset {
                max_offset = o;
            }
        }
        self.target_offset = max_offset;
        if !self.initialized {
            self.effective_offset = self.target_offset;
            self.initialized = true;
        }
    }

    /// The current estimated tick and fraction into it, monotone in `local_ms` (Provides): "tick
    /// and fraction, monotone".
    pub fn now(&mut self, local_ms: f64) -> (Tick, f32) {
        let pos = self.now_f64(local_ms);
        let tick = pos.floor().max(0.0);
        let frac = ((pos - tick) as f32).clamp(0.0, 1.0);
        (Tick(tick as u32), frac)
    }

    /// [`Self::now`]'s continuous tick position (whole and fractional part together), for a caller
    /// that wants sub-tick precision without splitting it itself.
    pub fn now_f64(&mut self, local_ms: f64) -> f64 {
        self.advance(local_ms);
        (self.last_local_ms + self.effective_offset).max(0.0) / self.tick_ms
    }

    /// Snaps the slew to its current target instantly (0018 section 8: "tell the client worker to
    /// re-base interpolation" after the tab was hidden) -- the one exception to "never stepped"
    /// (module doc comment).
    pub fn rebase(&mut self) {
        self.effective_offset = self.target_offset;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Free-running (no new sample between two `now()` calls advances smoothly with the real
    /// elapsed time) and slewed (a new, larger target is approached at the pinned 10% dilation
    /// rate, never snapped) -- both literal numbers pinned here, not read back from
    /// [`DILATION_LIMIT`]/[`WINDOW_MS`] (must-knows: "Pin the brief's specified numbers as literals
    /// in tests").
    ///
    /// Inject-fail-revert: swapping the windowed-maximum fold (`if o > max_offset`) for a minimum
    /// (`if o < max_offset`) fails at this test's very first assertion (`left: (Tick(0), 0.0),
    /// right: (Tick(100), 0.0)` -- the very first sample's own seed step now folds against
    /// `f64::NEG_INFINITY` the wrong way); reverted before commit.
    #[test]
    fn host_clock_free_runs_and_slews() {
        let mut c = HostClock::new(TickRate::HZ_20); // tick_ms = 50.0
        c.on_frame(Tick(100), 5000.0); // offset = 100*50 - 5000 = 0; first sample seeds directly
        assert_eq!(c.now(5000.0), (Tick(100), 0.0));

        // Free-running: no new sample, but 25ms of local time passes -> half a tick of progress.
        let (tick, frac) = c.now(5025.0);
        assert_eq!(tick, Tick(100));
        assert!((frac - 0.5).abs() < 1e-6, "frac was {frac}");

        // A new sample raises the window's own maximum to 200 (110*50 - 5300 = 200), but the very
        // same call's own `advance` still uses the *old* target (0), so this read is unmoved.
        c.on_frame(Tick(110), 5300.0);
        assert_eq!(c.now(5300.0), (Tick(106), 0.0), "not snapped to 110 yet");

        // 1000ms later: slewed by at most 10% of 1000ms = 100ms toward the 200ms target.
        let (tick, frac) = c.now(6300.0);
        assert_eq!(tick, Tick(128), "6300 + 100 slewed ms = 6400 -> tick 128");
        assert_eq!(frac, 0.0);

        // 10000ms later: fully caught up (100ms of remaining error <= 10000*10% = 1000ms budget).
        let (tick, frac) = c.now(16300.0);
        assert_eq!(
            tick,
            Tick(330),
            "16300 + 200 fully-slewed ms = 16500 -> tick 330"
        );
        assert_eq!(frac, 0.0);
    }

    /// Monotone under both ordinary advancement and a local-time value that goes slightly backward
    /// (main-thread rAF jitter across two reads is possible in practice even though it should not
    /// happen in the same wake): [`HostClock::now_f64`] never regresses.
    ///
    /// Inject-fail-revert: changing `now_f64`'s own read from `self.last_local_ms` back to the raw
    /// `local_ms` argument fails at `local_ms=1099.0` (`51.98 < 52.0`, the backward call's own
    /// smaller `local_ms` leaking straight into the returned position); reverted before commit.
    #[test]
    fn host_clock_monotone() {
        let mut c = HostClock::new(TickRate::HZ_20);
        c.on_frame(Tick(50), 1000.0);
        let mut last = c.now_f64(1000.0);
        for local_ms in [1050.0, 1100.0, 1099.0, 1200.0, 3300.0, 3299.5, 5000.0] {
            let pos = c.now_f64(local_ms);
            assert!(
                pos >= last,
                "now_f64 regressed at local_ms={local_ms}: {pos} < {last}"
            );
            last = pos;
        }
    }

    /// `rebase()` is the one call that steps instead of slewing.
    #[test]
    fn rebase_snaps_to_target() {
        let mut c = HostClock::new(TickRate::HZ_20);
        c.on_frame(Tick(100), 5000.0); // seeds effective_offset = target_offset = 0
        c.on_frame(Tick(110), 5300.0); // target jumps to 200, effective_offset still 0
        c.rebase();
        // With effective_offset snapped to 200, `now` at 5300 reads back tick 110 immediately.
        assert_eq!(c.now(5300.0), (Tick(110), 0.0));
    }
}
