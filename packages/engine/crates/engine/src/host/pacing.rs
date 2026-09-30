//! Per-connection byte pacing (docs/plan/31-rates-and-integrity.md steps 3-4, docs/decisions/
//! 0010-rates-and-subscriptions.md "Bandwidth budget"): the chunk-data token bucket, the visible-
//! first enter queue, the soft cap with its degrade levels, and the counters that prove them.
//!
//! Host-side, unlogged and a function of tick count alone: the bucket refills per tick in integer
//! bytes (`refill / tick rate`, the remainder carried), the soft-cap window is 1 s of ticks, and
//! nothing reads a wall clock, so a run is reproducible under the virtual clock
//! (`.claude/rules/determinism.md`). Every `Vec` is reserved once in [`Pacing::new`]; steady state
//! allocates nothing (`.claude/rules/hot-paths.md`).

use crate::time::TickRate;
use crate::world::ChunkCoord;

/// 0009 `WorldConfig.bandwidth`, defaults from 0010's table (KB = 1000 B here).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BandwidthConfig {
    /// Tick frames above this in any 1 s window degrade that client's frame rate.
    pub soft_cap_bytes_per_s: u32,
    /// Chunk-data token bucket refill rate.
    pub chunk_refill_bytes_per_s: u32,
    /// Chunk-data token bucket capacity (the burst).
    pub chunk_burst_bytes: u32,
    /// Documented ceiling (soft cap + refill); structural, no third limiter enforces it.
    pub hard_cap_bytes_per_s: u32,
    /// A connection with no network in it (single-player's local host): the bucket never holds a
    /// chunk back and degrade never engages. A host that is stepped faster than its client renders
    /// (the stepped test entries) would otherwise read as a stalled peer.
    pub unpaced: bool,
}

impl Default for BandwidthConfig {
    fn default() -> Self {
        BandwidthConfig {
            soft_cap_bytes_per_s: 16_000,
            chunk_refill_bytes_per_s: 48_000,
            chunk_burst_bytes: 128_000,
            hard_cap_bytes_per_s: 64_000,
            unpaced: false,
        }
    }
}

/// Cost of a pristine chunk enter (0010: "a pristine chunk enter is ~3 B").
pub const PRISTINE_ENTER_COST: i64 = 3;
/// Never collapse a chunk's deltas into a snapshot below this many queued delta bytes, however
/// small the chunk's snapshot.
pub const MIN_COLLAPSE_BYTES: u32 = 64;
/// Effective backlog (ticks) above which a client is degraded to 2, and twice it to 4. 0010's
/// stalls are 0.3-3 s and the link declares a peer dead after 3 s of silence, so a stalled client
/// must reach level 4 well inside that: 12 ticks is 600 ms, above a p99 RTT of 400 ms.
pub const BACKLOG_HI_TICKS: u32 = 12;
/// Uplinks arrive at least once a second (0010), so this many ticks of silence are not a backlog.
const UPLINK_SLACK_TICKS: u32 = 22;
/// Recovery (0010 leaves it open; brief's Planning decisions): one level down after this many
/// seconds under 75 % of the soft cap with the backlog at most [`BACKLOG_CALM_TICKS`] (plus the
/// `level - 1` ticks that holding frames adds to it).
pub const RECOVER_SECS: u32 = 2;
pub const BACKLOG_CALM_TICKS: u32 = 2;
/// Length of [`Pacing::late_hist`]: ticks from visible to enter sent, clamped to the last bucket.
pub const LATE_BUCKETS: usize = 128;
/// 0010: a re-enter counts when the chunk left less than this many seconds ago.
pub const REENTER_SECS: u32 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnterKind {
    /// A chunk newly subscribed: sent as pristine or snapshot, then held.
    Enter,
    /// A held chunk re-sent whole (deltas collapsed, or M31b's resync answer): always a snapshot.
    Resnapshot,
}

/// Where an enqueued chunk sorts: visible chunks first, then nearest to the look-ahead centre.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EnterPriority {
    pub visible: bool,
    pub dist_sq: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct QueuedEnter {
    pub chunk: ChunkCoord,
    pub kind: EnterKind,
    /// The tick this chunk was first seen visible while queued (`lateVisibleTicks`' start).
    pub visible_since: Option<u32>,
    pub key: (u8, i64),
}

/// The counters of one connection's pacing that the ABI reads back (`sim_conn_counters` tail).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PacingCounters {
    pub reenters_within_5s: u64,
    pub reenter_bytes: u64,
    pub cap_evictions: u64,
    pub late_visible_max: u64,
    pub late_visible_p95: u64,
    pub degrade_level: u64,
    pub degraded_ticks: u64,
    pub queued_enters: u64,
    pub bucket_tokens: i64,
    pub held_chunks: u64,
    pub collapses: u64,
    pub bundles: u64,
    /// The most ticks that ever passed between two messages sent to this connection (the heartbeat
    /// interval, held at every degrade level).
    pub max_emit_gap: u64,
    /// Chunks sent while a visible chunk was still queued behind them: always 0 (visible first).
    pub order_violations: u64,
}

pub struct Pacing {
    cfg: BandwidthConfig,
    hz: u32,
    pub held: Vec<ChunkCoord>,
    pub queue: Vec<QueuedEnter>,
    pub tokens: i64,
    refill_rem: u32,
    last_refill_tick: u32,
    // -- degrade
    pub level: u8,
    window: Vec<u32>,
    window_sum: u32,
    window_tick: u32,
    over_ticks: u32,
    calm_ticks: u32,
    seen_received_tick: u32,
    /// Set once an uplink has carried a non-zero `last_received_tick`: a connection that never
    /// acks a frame (a raw host driver, a client with no frame yet) has no backlog to measure.
    acking: bool,
    backlog_sample: u32,
    last_uplink_tick: u32,
    /// Whole frames waiting to go out together (`[len varint][frame]` records).
    pub hold: Vec<u8>,
    pub hold_frames: u32,
    /// The tick the oldest held frame was built.
    pub held_since: u32,
    pub last_emit_tick: u32,
    // -- delta collapse
    /// Estimated delta bytes per held chunk since the last emit (cleared on emit).
    pub delta_est: Vec<(ChunkCoord, u32)>,
    /// Held chunks whose deltas are suppressed until their queued snapshot is sent.
    pub collapsed: Vec<ChunkCoord>,
    // -- counters
    recent_leaves: Vec<(ChunkCoord, u32)>,
    late_hist: [u32; LATE_BUCKETS],
    late_total: u32,
    late_max: u32,
    pub reenters_within_5s: u64,
    pub reenter_bytes: u64,
    pub cap_evictions: u64,
    pub degraded_ticks: u64,
    pub collapses: u64,
    pub bundles: u64,
    max_emit_gap: u32,
    pub order_violations: u64,
}

impl Pacing {
    pub fn new(cfg: BandwidthConfig, rate: TickRate, now: u32) -> Self {
        let hz = rate.hz_value().max(1);
        Pacing {
            cfg,
            hz,
            held: Vec::with_capacity(160),
            queue: Vec::with_capacity(160),
            tokens: cfg.chunk_burst_bytes as i64,
            refill_rem: 0,
            last_refill_tick: now,
            level: 1,
            window: vec![0; hz as usize],
            window_sum: 0,
            window_tick: now,
            over_ticks: 0,
            calm_ticks: 0,
            seen_received_tick: now,
            acking: false,
            backlog_sample: 0,
            last_uplink_tick: now,
            hold: Vec::new(),
            hold_frames: 0,
            held_since: now,
            last_emit_tick: now,
            delta_est: Vec::with_capacity(160),
            collapsed: Vec::with_capacity(16),
            recent_leaves: Vec::with_capacity(1024),
            late_hist: [0; LATE_BUCKETS],
            late_total: 0,
            late_max: 0,
            reenters_within_5s: 0,
            reenter_bytes: 0,
            cap_evictions: 0,
            degraded_ticks: 0,
            collapses: 0,
            bundles: 0,
            max_emit_gap: 0,
            order_violations: 0,
        }
    }

    pub fn cfg(&self) -> BandwidthConfig {
        self.cfg
    }

    pub fn is_held(&self, c: ChunkCoord) -> bool {
        self.held.contains(&c)
    }

    pub fn is_collapsed(&self, c: ChunkCoord) -> bool {
        self.collapsed.contains(&c)
    }

    pub fn queue_position(&self, c: ChunkCoord) -> Option<usize> {
        self.queue.iter().position(|q| q.chunk == c)
    }

    /// Adds `tick - last` ticks of refill (integer bytes, remainder carried), capped at the burst.
    pub fn refill(&mut self, tick: u32) {
        if self.cfg.unpaced {
            self.tokens = self.cfg.chunk_burst_bytes as i64;
            self.last_refill_tick = tick;
            return;
        }
        let elapsed = tick.wrapping_sub(self.last_refill_tick);
        self.last_refill_tick = tick;
        if elapsed == 0 {
            return;
        }
        let total = self.refill_rem as u64
            + self.cfg.chunk_refill_bytes_per_s as u64 * elapsed.min(self.hz * 60) as u64;
        self.tokens += (total / self.hz as u64) as i64;
        self.refill_rem = (total % self.hz as u64) as u32;
        let burst = self.cfg.chunk_burst_bytes as i64;
        if self.tokens >= burst {
            self.tokens = burst;
            self.refill_rem = 0;
        }
    }

    pub fn enqueue(&mut self, chunk: ChunkCoord, kind: EnterKind, prio: EnterPriority, tick: u32) {
        if let Some(i) = self.queue_position(chunk) {
            // One entry per chunk: a snapshot request upgrades an enter, never the reverse.
            if kind == EnterKind::Resnapshot {
                self.queue[i].kind = EnterKind::Resnapshot;
            }
            return;
        }
        self.queue.push(QueuedEnter {
            chunk,
            kind,
            visible_since: prio.visible.then_some(tick),
            key: (u8::from(!prio.visible), prio.dist_sq),
        });
    }

    pub fn note_left(&mut self, chunk: ChunkCoord, tick: u32) {
        self.held.retain(|&c| c != chunk);
        self.collapsed.retain(|&c| c != chunk);
        self.delta_est.retain(|(c, _)| *c != chunk);
        self.recent_leaves.push((chunk, tick));
    }

    /// A message went out at `tick`.
    pub fn note_emit(&mut self, tick: u32) {
        self.max_emit_gap = self
            .max_emit_gap
            .max(tick.wrapping_sub(self.last_emit_tick));
        self.last_emit_tick = tick;
    }

    pub fn drop_queued(&mut self, chunk: ChunkCoord) -> bool {
        match self.queue_position(chunk) {
            Some(i) => {
                self.queue.remove(i);
                true
            }
            None => false,
        }
    }

    /// Whether `chunk` left this connection less than [`REENTER_SECS`] ago (a re-enter).
    pub fn is_reenter(&mut self, chunk: ChunkCoord, tick: u32) -> bool {
        let horizon = REENTER_SECS * self.hz;
        self.recent_leaves
            .retain(|&(_, t)| tick.wrapping_sub(t) < horizon);
        self.recent_leaves.iter().any(|&(c, _)| c == chunk)
    }

    pub fn note_late_visible(&mut self, ticks: u32) {
        let b = (ticks as usize).min(LATE_BUCKETS - 1);
        self.late_hist[b] += 1;
        self.late_total += 1;
        self.late_max = self.late_max.max(ticks);
    }

    fn late_p95(&self) -> u64 {
        if self.late_total == 0 {
            return 0;
        }
        let need = (self.late_total * 95).div_ceil(100);
        let mut cum = 0;
        for (i, n) in self.late_hist.iter().enumerate() {
            cum += n;
            if cum >= need {
                return i as u64;
            }
        }
        (LATE_BUCKETS - 1) as u64
    }

    /// Adds `est` queued delta bytes to `chunk`'s tally and returns the new total.
    pub fn add_delta_est(&mut self, chunk: ChunkCoord, est: u32) -> u32 {
        match self.delta_est.iter_mut().find(|(c, _)| *c == chunk) {
            Some(e) => {
                e.1 += est;
                e.1
            }
            None => {
                self.delta_est.push((chunk, est));
                est
            }
        }
    }

    // -- degrade -------------------------------------------------------------------------------

    /// A received uplink's `last_received_tick` (0010: the one backpressure path on every host).
    pub fn on_uplink(&mut self, now: u32, last_received_tick: u32) {
        if last_received_tick > 0 {
            self.acking = true;
        }
        if last_received_tick > self.seen_received_tick && last_received_tick <= now {
            self.seen_received_tick = last_received_tick;
        }
        self.backlog_sample = now.saturating_sub(self.seen_received_tick);
        self.last_uplink_tick = now;
    }

    /// `tick - last_received_tick` as the host can know it: the last uplink's own reading, plus any
    /// silence beyond the once-a-second uplink floor (a stalled client says nothing at all).
    pub fn effective_backlog(&self, now: u32) -> u32 {
        if !self.acking || self.cfg.unpaced {
            return 0;
        }
        let silent = now
            .saturating_sub(self.last_uplink_tick)
            .saturating_sub(UPLINK_SLACK_TICKS);
        self.backlog_sample.saturating_add(silent)
    }

    fn window_advance(&mut self, tick: u32) {
        let steps = tick.wrapping_sub(self.window_tick).min(self.hz);
        for i in 1..=steps {
            let slot = (self.window_tick.wrapping_add(i) % self.hz) as usize;
            self.window_sum -= self.window[slot];
            self.window[slot] = 0;
        }
        self.window_tick = tick;
    }

    /// Records `bytes` of non-chunk sections for `tick`, then re-decides the degrade level.
    pub fn account_frame(&mut self, tick: u32, bytes: u32) {
        self.window_advance(tick);
        let slot = (tick % self.hz) as usize;
        self.window[slot] += bytes;
        self.window_sum += bytes;
        self.update_level(tick);
    }

    pub fn window_bytes(&self) -> u32 {
        self.window_sum
    }

    fn update_level(&mut self, tick: u32) {
        let backlog = self.effective_backlog(tick);
        let over_soft = !self.cfg.unpaced && self.window_sum > self.cfg.soft_cap_bytes_per_s;
        self.over_ticks = if over_soft { self.over_ticks + 1 } else { 0 };
        let mut want = 1u8;
        if over_soft || backlog > BACKLOG_HI_TICKS {
            want = 2;
        }
        if backlog > 2 * BACKLOG_HI_TICKS || self.over_ticks >= 2 * self.hz {
            want = 4;
        }
        if want > self.level {
            self.level = want;
            self.calm_ticks = 0;
        } else {
            // Holding frames itself delays what the client last received by up to `level - 1`
            // ticks, so calm allows that much more backlog than an undegraded client would show
            // (else a degraded client could never read as calm).
            let calm = self.window_sum * 4 < self.cfg.soft_cap_bytes_per_s * 3
                && backlog <= BACKLOG_CALM_TICKS + (self.level as u32 - 1);
            if calm && self.level > 1 {
                self.calm_ticks += 1;
                if self.calm_ticks >= RECOVER_SECS * self.hz {
                    self.level /= 2;
                    self.calm_ticks = 0;
                }
            } else {
                self.calm_ticks = 0;
            }
        }
        if self.level > 1 {
            self.degraded_ticks += 1;
        }
    }

    /// Moves as many whole held frames as fit into `out` (at least one): a lone frame goes out as it
    /// was built, several as a `FrameBundle` (`wire/bundle.rs`; the hold already stores its body,
    /// `[len varint][frame]` per frame). Returns `(bytes written, frames sent)`; frames that do not
    /// fit stay held.
    pub fn take_bundle(&mut self, out: &mut [u8]) -> (usize, u32) {
        use crate::bytes::ByteReader;
        let mut end = 0usize;
        let mut frames = 0u32;
        let mut first_len = 0usize;
        let mut first_start = 0usize;
        while end < self.hold.len() {
            let mut r = ByteReader::new(&self.hold[end..]);
            let Ok(len) = r.varint() else { break };
            let head = self.hold.len() - end - r.rest().len();
            let record = head + len as usize;
            // Type byte + count + everything taken so far + this record must fit.
            if frames > 0 && 1 + 5 + end + record > out.len() {
                break;
            }
            if frames == 0 {
                first_len = len as usize;
                first_start = head;
            }
            end += record;
            frames += 1;
        }
        if frames == 0 {
            self.hold.clear();
            self.hold_frames = 0;
            return (0, 0);
        }
        let written = if frames == 1 {
            out[..first_len].copy_from_slice(&self.hold[first_start..first_start + first_len]);
            first_len
        } else {
            let mut sink = crate::bytes::SliceSink::new(out);
            use crate::bytes::ByteSink;
            sink.put_u8(crate::wire::MsgType::FrameBundle as u8);
            sink.put_varint(frames as u64);
            sink.put(&self.hold[..end]);
            sink.finish().unwrap_or(0)
        };
        self.hold.drain(..end);
        self.hold_frames -= frames;
        (written, frames)
    }

    pub fn counters(&self) -> PacingCounters {
        PacingCounters {
            reenters_within_5s: self.reenters_within_5s,
            reenter_bytes: self.reenter_bytes,
            cap_evictions: self.cap_evictions,
            late_visible_max: self.late_max as u64,
            late_visible_p95: self.late_p95(),
            degrade_level: self.level as u64,
            degraded_ticks: self.degraded_ticks,
            queued_enters: self.queue.len() as u64,
            bucket_tokens: self.tokens,
            held_chunks: self.held.len() as u64,
            collapses: self.collapses,
            bundles: self.bundles,
            max_emit_gap: self.max_emit_gap as u64,
            order_violations: self.order_violations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pacing() -> Pacing {
        Pacing::new(BandwidthConfig::default(), TickRate::HZ_20, 0)
    }

    #[test]
    fn bucket_refill_is_a_function_of_ticks_alone() {
        let mut p = pacing();
        p.tokens = 0;
        for t in 1..=20 {
            p.refill(t);
        }
        assert_eq!(p.tokens, 48_000, "48 KB/s over 20 ticks");
        p.tokens = 0;
        p.refill(20); // no time passed
        assert_eq!(p.tokens, 0);
        p.refill(1_000);
        assert_eq!(p.tokens, 128_000, "capped at the burst");
    }

    #[test]
    fn bucket_carries_the_remainder() {
        let cfg = BandwidthConfig {
            chunk_refill_bytes_per_s: 1_001,
            ..BandwidthConfig::default()
        };
        let mut p = Pacing::new(cfg, TickRate::HZ_20, 0);
        p.tokens = 0;
        for t in 1..=20 {
            p.refill(t);
        }
        assert_eq!(
            p.tokens, 1_001,
            "no byte lost to integer division over a second"
        );
    }

    #[test]
    fn degrade_escalates_on_backlog_and_recovers_after_calm() {
        let mut p = pacing();
        for t in 1..=10 {
            p.on_uplink(t, t - 1);
            p.account_frame(t, 100);
        }
        assert_eq!(p.level, 1);
        // Silence: no uplinks for a long time.
        let mut levels = Vec::new();
        for t in 11..=120 {
            p.account_frame(t, 100);
            levels.push(p.level);
        }
        assert!(levels.contains(&2) && levels.contains(&4), "{levels:?}");
        assert_eq!(*levels.last().unwrap(), 4);
        // The client is back and healthy.
        let mut t = 121;
        while p.level > 1 && t < 1_000 {
            p.on_uplink(t, t - 1);
            p.account_frame(t, 100);
            t += 1;
        }
        assert_eq!(p.level, 1, "recovers one level per calm {RECOVER_SECS} s");
    }

    #[test]
    fn late_visible_p95() {
        let mut p = pacing();
        for _ in 0..94 {
            p.note_late_visible(0);
        }
        for _ in 0..6 {
            p.note_late_visible(30);
        }
        assert_eq!(p.late_p95(), 30);
        assert_eq!(p.counters().late_visible_max, 30);
    }
}
