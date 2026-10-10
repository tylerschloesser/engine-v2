//! [`LeadEstimator`] (M26 Planning decisions "Lead
//! estimation"): "Sample per ack = `ack.tick − auth_tick_at_dispatch`: pure tick arithmetic, no
//! wall clock. Lead = median of the last 8 samples, clamped to 1..=40 ticks. Before the first
//! sample: 1, or `ceil(rtt / tick) + 1` once seeded." Drives `ClientCore::set_lead` (Seams).
//!
//! Allocation: [`Self::samples`] is a fixed `[i64; HISTORY]` ring, never a `Vec` -- `on_ack_sample`
//! runs from inside `ClientCore::on_frame`'s own ack-pop loop (`client::core`, under
//! `.claude/rules/hot-paths.md`'s `client/**`), so it must stay allocation-free like every other
//! per-frame call there.

use crate::time::{Tick, TickRate, Ticks};

const HISTORY: usize = 8;
const LEAD_MIN: i64 = 1;
const LEAD_MAX: i64 = 40;

pub struct LeadEstimator {
    tick_ms: f64,
    samples: [i64; HISTORY],
    /// How many of `samples` (from index 0) hold a real value so far (grows to `HISTORY`, then
    /// stays there while `next` keeps overwriting the oldest in ring order).
    count: usize,
    next: usize,
    /// Set once by [`Self::seed_rtt_ms`]; used only before the first real ack sample (Planning
    /// decisions: "Before the first sample: 1, or `ceil(rtt / tick) + 1` once seeded").
    seeded_lead: Option<i64>,
}

impl LeadEstimator {
    pub fn new(rate: TickRate) -> Self {
        LeadEstimator {
            tick_ms: 1000.0 / rate.hz_value() as f64,
            samples: [0; HISTORY],
            count: 0,
            next: 0,
            seeded_lead: None,
        }
    }

    /// The `Hello`→`Welcome` RTT seed (M28/M29's own call into this, Seams): only takes effect
    /// while [`Self::count`] is still `0` -- a real ack sample always wins once one exists.
    pub fn seed_rtt_ms(&mut self, rtt_ms: f64) {
        let lead = (rtt_ms / self.tick_ms).ceil() as i64 + 1;
        self.seeded_lead = Some(lead.clamp(LEAD_MIN, LEAD_MAX));
    }

    /// One ack's own sample (module doc comment, verbatim formula). A lead change this produces
    /// never touches an already-pending action's own frozen `predicted_tick` (0012 "Frozen
    /// predicted tick"; Planning decisions "A lead change never touches a pending action") --
    /// enforced by construction, since this type never sees a `Pending<G>` at all.
    pub fn on_ack_sample(&mut self, auth_tick_at_dispatch: Tick, ack_tick: Tick) {
        let sample = ack_tick.0 as i64 - auth_tick_at_dispatch.0 as i64;
        self.samples[self.next] = sample;
        self.next = (self.next + 1) % HISTORY;
        if self.count < HISTORY {
            self.count += 1;
        }
    }

    /// Median of the last (up to 8) samples, clamped to `1..=40` (module doc comment). `1` (never
    /// seeded) or `ceil(rtt / tick) + 1` (seeded) before the first real sample.
    pub fn lead(&self) -> Ticks {
        if self.count == 0 {
            return Ticks(self.seeded_lead.unwrap_or(LEAD_MIN) as u32);
        }
        let mut buf = self.samples;
        let n = self.count;
        buf[..n].sort_unstable();
        let median = if n % 2 == 1 {
            buf[n / 2] as f64
        } else {
            (buf[n / 2 - 1] as f64 + buf[n / 2] as f64) / 2.0
        };
        Ticks(median.round().clamp(LEAD_MIN as f64, LEAD_MAX as f64) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Median of the last 8 samples, clamped `1..=40` -- literal numbers pinned here (must-knows).
    ///
    /// Inject-fail-revert: swapping the median for a mean changes the asserted value below (7
    /// samples at `2` plus one outlier at `40`: mean is `\~6.75` -> rounds to `7`, median is `2`);
    /// reverted before commit.
    #[test]
    fn lead_is_median_of_last_8_clamped() {
        let mut e = LeadEstimator::new(TickRate::HZ_20);
        for _ in 0..7 {
            e.on_ack_sample(Tick(0), Tick(2));
        }
        e.on_ack_sample(Tick(0), Tick(40));
        assert_eq!(e.lead(), Ticks(2), "median of [2,2,2,2,2,2,2,40] is 2");

        // Clamp above 40: nine samples of 50 pushes the 9th sample into the ring (evicting the
        // oldest of the 7 twos above), and every remaining sample now exceeds the 1..=40 clamp.
        let mut e2 = LeadEstimator::new(TickRate::HZ_20);
        for _ in 0..8 {
            e2.on_ack_sample(Tick(0), Tick(50));
        }
        assert_eq!(e2.lead(), Ticks(40), "median 50 clamped to the 40 ceiling");

        // Clamp below 1: a sample of 0 (an ack landing on the exact dispatch tick) clamps up.
        let mut e3 = LeadEstimator::new(TickRate::HZ_20);
        e3.on_ack_sample(Tick(5), Tick(5));
        assert_eq!(e3.lead(), Ticks(1), "median 0 clamped to the 1 floor");
    }

    /// Ring behaviour: only the *last* 8 samples count, oldest evicted first.
    #[test]
    fn lead_uses_only_the_last_8_samples() {
        let mut e = LeadEstimator::new(TickRate::HZ_20);
        // 8 samples of 10, then 8 more of 4: only the second batch should remain live.
        for _ in 0..8 {
            e.on_ack_sample(Tick(0), Tick(10));
        }
        assert_eq!(e.lead(), Ticks(10));
        for _ in 0..8 {
            e.on_ack_sample(Tick(0), Tick(4));
        }
        assert_eq!(e.lead(), Ticks(4), "the 10s must have been fully evicted");
    }

    /// Before any sample: `1` unseeded, `ceil(rtt / tick) + 1` seeded (Planning decisions,
    /// verbatim). At 20 Hz (`tick_ms = 50`), an RTT of 120 ms is `ceil(120/50) = 3`, `+1 = 4`.
    ///
    /// Inject-fail-revert: dropping the `+ 1` makes the seeded assertion read `3`, not `4`;
    /// reverted before commit.
    #[test]
    fn lead_seed_from_rtt() {
        let mut e = LeadEstimator::new(TickRate::HZ_20);
        assert_eq!(e.lead(), Ticks(1), "unseeded, no sample yet");
        e.seed_rtt_ms(120.0);
        assert_eq!(e.lead(), Ticks(4), "ceil(120/50) + 1 = 4");

        // A real sample always wins over the seed, even a single one.
        e.on_ack_sample(Tick(0), Tick(9));
        assert_eq!(e.lead(), Ticks(9));
    }

    /// `lead_converges_to_exact`'s own constant (must-knows): a `Loopback` round trip at one-way
    /// downlink delay `d` settles at `2*d + 1` ticks -- proven against the real client/host wire in
    /// `fixtures/predict/tests/clock.rs`, not duplicated here (this module has no `Loopback`); this
    /// unit test only pins that *this* type converges to whatever constant sample repeats, so a
    /// steady real round trip of `2*d + 1` does land on exactly that lead once 8 samples agree.
    #[test]
    fn lead_converges_when_every_sample_agrees() {
        let mut e = LeadEstimator::new(TickRate::HZ_20);
        let d = 3u32;
        let round_trip = 2 * d + 1;
        for _ in 0..8 {
            e.on_ack_sample(Tick(100), Tick(100 + round_trip));
        }
        assert_eq!(e.lead(), Ticks(round_trip));
    }
}
