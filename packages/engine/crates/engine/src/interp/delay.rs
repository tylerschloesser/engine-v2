//! [`InterpDelay`]: 0010 Rates, "Interpolation delay": adaptive
//! `max(2 x frame interval, frame interval + p95 inter-arrival jitter)`; initial 150 ms, floor
//! 100 ms, cap 400 ms; slewed with at most 10% time dilation, never stepped.

use super::jitter::JitterStats;
use crate::time::{Tick, TickRate};

/// 0010 Rates, "Interpolation delay": initial.
pub const INITIAL_MS: f32 = 150.0;
/// 0010 Rates: floor.
pub const FLOOR_MS: f32 = 100.0;
/// 0010 Rates: cap.
pub const CAP_MS: f32 = 400.0;
/// 0010 Rates: "at most 10% time dilation".
pub const DILATION_LIMIT: f64 = 0.10;
/// Jitter samples needed before the target leaves [`INITIAL_MS`]: a p95 of two samples is noise.
/// This milestone's own choice (Deviations).
pub const MIN_SAMPLES: usize = 8;

pub struct InterpDelay {
    tick_ms: f32,
    stats: JitterStats,
    /// The last accepted frame: `(tick, arrived_ms)`.
    prev: Option<(Tick, f64)>,
    delay_ms: f64,
    target_ms: f32,
}

impl InterpDelay {
    pub fn new(rate: TickRate) -> Self {
        InterpDelay {
            tick_ms: 1000.0 / rate.hz_value() as f32,
            stats: JitterStats::new(),
            prev: None,
            delay_ms: INITIAL_MS as f64,
            target_ms: INITIAL_MS,
        }
    }

    /// One arriving host frame (heartbeats included). Jitter sample =
    /// `|(arrival_i - arrival_{i-1}) - (tick_i - tick_{i-1}) x tick_ms|` (Planning decisions). A
    /// frame whose tick does not advance (a repeat) is ignored; one whose tick goes back (a
    /// resync) only reseats the reference.
    pub fn on_arrival(&mut self, tick: Tick, arrived_ms: f64) {
        if let Some((pt, pa)) = self.prev {
            if tick.0 == pt.0 {
                return;
            }
            if tick.0 > pt.0 {
                let expected = (tick.0 - pt.0) as f64 * self.tick_ms as f64;
                self.stats
                    .record(((arrived_ms - pa) - expected).abs() as f32);
                self.target_ms = self.compute_target();
            }
        }
        self.prev = Some((tick, arrived_ms));
    }

    fn compute_target(&self) -> f32 {
        if self.stats.len() < MIN_SAMPLES {
            return INITIAL_MS;
        }
        let fi = self.tick_ms;
        (2.0 * fi)
            .max(fi + self.stats.p95_ms())
            .clamp(FLOOR_MS, CAP_MS)
    }

    /// Slews the delay toward the target by at most `DILATION_LIMIT x dt_ms`; non-positive or NaN
    /// `dt_ms` is a no-op.
    pub fn advance(&mut self, dt_ms: f64) {
        if dt_ms.is_nan() || dt_ms <= 0.0 {
            return;
        }
        let max_step = dt_ms * DILATION_LIMIT;
        let diff = self.target_ms as f64 - self.delay_ms;
        self.delay_ms += diff.clamp(-max_step, max_step);
    }

    /// Render time in host ticks: `host_now` minus the current delay. Between two calls it moves
    /// by the host's own advance minus the delay's change (at most `DILATION_LIMIT` of it).
    pub fn render_time(&self, host_now: f64) -> f64 {
        host_now - self.delay_ms / self.tick_ms as f64
    }

    pub fn delay_ms(&self) -> f32 {
        self.delay_ms as f32
    }

    /// The value the delay is slewing toward.
    pub fn target_ms(&self) -> f32 {
        self.target_ms
    }

    /// Tab return or resync (0018 section 8): the only place the delay snaps. Back to
    /// [`INITIAL_MS`] with no jitter history.
    pub fn rebase(&mut self) {
        self.stats.clear();
        self.prev = None;
        self.delay_ms = INITIAL_MS as f64;
        self.target_ms = INITIAL_MS;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HZ20: TickRate = TickRate::hz(20);

    /// Feeds `n` frames one tick apart whose arrival gaps alternate `50 +/- j` ms.
    fn feed(d: &mut InterpDelay, start_tick: u32, start_ms: f64, n: u32, j: f64) -> (u32, f64) {
        let (mut tick, mut ms) = (start_tick, start_ms);
        for i in 0..n {
            tick += 1;
            ms += if i % 2 == 0 { 50.0 + j } else { 50.0 - j };
            d.on_arrival(Tick(tick), ms);
        }
        (tick, ms)
    }

    fn settle(d: &mut InterpDelay) {
        for _ in 0..1000 {
            d.advance(16.0);
        }
    }

    #[test]
    fn interp_delay_initial_floor_cap() {
        let mut d = InterpDelay::new(HZ20);
        assert_eq!(d.delay_ms(), 150.0);
        // Steady arrivals: p95 ~ 0 -> target = max(100, 50) = 100 = floor.
        feed(&mut d, 0, 0.0, 40, 0.0);
        settle(&mut d);
        assert_eq!(d.delay_ms(), 100.0);
        // Huge jitter -> cap.
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, 60, 900.0);
        settle(&mut d);
        assert_eq!(d.delay_ms(), 400.0);
    }

    #[test]
    fn interp_delay_stays_initial_until_enough_samples() {
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, MIN_SAMPLES as u32, 0.0); // first frame is the reference: 7 samples
        assert_eq!(d.target_ms(), INITIAL_MS);
        feed(&mut d, 8, 400.0, 1, 0.0);
        assert_eq!(d.target_ms(), FLOOR_MS);
    }

    #[test]
    fn interp_delay_follows_p95_formula() {
        // Alternating gaps 50 +/- 40 -> every jitter sample is 40 ms -> bin [32,48), p95 = 48.
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, 200, 40.0);
        // 50 + 48 = 98 -> floor 100.
        assert_eq!(d.target_ms(), 100.0);
        // Jitter 120 ms: bin [112,128), p95 = 128 -> 50 + 128 = 178.
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, 200, 120.0);
        assert_eq!(d.target_ms(), 178.0);
        settle(&mut d);
        assert_eq!(d.delay_ms(), 178.0);
    }

    #[test]
    fn interp_delay_ignores_repeats_and_reseats_on_tick_regression() {
        let mut d = InterpDelay::new(HZ20);
        d.on_arrival(Tick(10), 0.0);
        d.on_arrival(Tick(10), 30.0);
        d.on_arrival(Tick(3), 60.0); // resync: reseat only
        assert_eq!(d.stats.len(), 0);
        d.on_arrival(Tick(4), 110.0); // exactly on time from the reseat
        assert_eq!(d.stats.len(), 1);
        assert_eq!(d.stats.p95_ms(), 16.0);
    }

    #[test]
    fn interp_delay_never_steps() {
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, 60, 900.0); // target jumps to the cap
        assert_eq!(d.target_ms(), 400.0);
        let mut host = 100.0f64; // host ticks
        let mut prev_render = d.render_time(host);
        let mut prev_delay = d.delay_ms();
        for frame in 0..400 {
            // Irregular frame lengths 8..40 ms, and one target change midway.
            let dt = 8.0 + ((frame * 7) % 33) as f64;
            if frame == 200 {
                feed(&mut d, 1000, 1e6, 300, 0.0); // target falls back to the floor
            }
            d.advance(dt);
            host += dt / 50.0;
            let render = d.render_time(host);
            let rate = (render - prev_render) / (dt / 50.0);
            assert!(
                (0.9 - 1e-9..=1.1 + 1e-9).contains(&rate),
                "frame {frame}: render rate {rate}"
            );
            assert!(render > prev_render, "render time must move forward");
            prev_render = render;
            prev_delay = d.delay_ms();
        }
        assert!(prev_delay < 400.0);
    }

    #[test]
    fn interp_rebase_snaps_and_clears() {
        let mut d = InterpDelay::new(HZ20);
        feed(&mut d, 0, 0.0, 60, 900.0);
        settle(&mut d);
        assert_eq!(d.delay_ms(), 400.0);
        d.rebase();
        assert_eq!(d.delay_ms(), INITIAL_MS);
        assert_eq!(d.target_ms(), INITIAL_MS);
        assert_eq!(d.stats.len(), 0);
        // The first frame after a rebase is a reference only.
        d.on_arrival(Tick(500), 5.0);
        assert_eq!(d.stats.len(), 0);
    }
}
