//! `SubscriptionSet` (docs/decisions/0010-rates-and-subscriptions.md "Subscription set"): the
//! host-side chunk set one connection is subscribed to, derived from its latest (untrusted, clamped)
//! `CameraReport`. Ring 1 plus a velocity-scaled look-ahead (`view::lookahead_chunks`, the same
//! function 0008 §5's generation queue uses, so the generation set this feeds through
//! [`SubscriptionSet::warm_rect`] stays a superset of the subscription target) is subscribed at
//! once; a chunk unsubscribes only once it has been outside ring 3 continuously for the hold time.
//! Over the 128-chunk cap, the farthest chunk in the lowest-priority class (visible > ring 1 >
//! look-ahead > retained) is evicted, repeatedly, until back at the cap.
//!
//! Host-side, not sim-side (crate `CLAUDE.md`: "host/ and client/ are outside the deterministic
//! core"): nothing here needs to produce identical bits on every runtime, only to be reproducible
//! under test (`.claude/rules/determinism.md`, per this milestone's brief). `Vec`s are used freely
//! (unlike `sim`/`world`/`apply` code), but every one is reserved once at [`SubscriptionSet::new`]
//! and only `clear`/`push`/`swap_remove`d afterwards, matching `host::warm::Warm` and
//! `authority::ChangeLog`'s own steady-state-no-realloc convention.

use crate::time::{Tick, TickRate, Ticks};
use crate::view::lookahead_chunks;
use crate::wire::CameraReport;
use crate::world::{ChunkCoord, ChunkDims, ChunkRect, TILE_MAX, TILE_MIN, TilePos};

/// 0010 "Cap": 128 chunks per client.
pub const CAP_CHUNKS: usize = 128;
/// 0010 "Untrusted-view clamps": at most 256 tiles per axis, i.e. half-extent at most 128.
pub const MAX_HALF_TILES: u16 = 128;
/// 0010 does not name a minimum (only "zero or over-large extents are clamped about the centre,
/// never rejected"): one tile is the smallest extent that still names a chunk to subscribe
/// (docs/plan/15-connection-and-subscriptions.md Deviations records this as this milestone's own
/// reading of an unspecified number, same footing as `view::lookahead_chunks`'s own algorithm
/// reading of 0008 §5).
pub const MIN_HALF_TILES: u16 = 1;
/// 0010 "Subscription set": unsubscribe only beyond ring 3.
const RING_UNSUB: i32 = 3;

/// Clamps an untrusted [`CameraReport`] to 0010's "Untrusted-view clamps": extent per axis in
/// `[MIN_HALF_TILES, MAX_HALF_TILES]`, centre inside the world's tile range. Velocity is not
/// clamped (only its sign feeds [`lookahead_chunks`]; an over-large magnitude cannot widen the
/// subscription beyond the fixed 2-chunk look-ahead cap).
pub fn clamp_report(report: CameraReport) -> CameraReport {
    CameraReport {
        center_x: report.center_x.clamp(TILE_MIN, TILE_MAX),
        center_y: report.center_y.clamp(TILE_MIN, TILE_MAX),
        half_w: report.half_w.clamp(MIN_HALF_TILES, MAX_HALF_TILES),
        half_h: report.half_h.clamp(MIN_HALF_TILES, MAX_HALF_TILES),
        vel_x: report.vel_x,
        vel_y: report.vel_y,
    }
}

/// The chunk rectangle a (clamped) camera report names, in `dims`'s chunk size.
fn visible_rect(report: CameraReport, dims: ChunkDims) -> ChunkRect {
    let cx = report.center_x as i64;
    let cy = report.center_y as i64;
    let hw = report.half_w as i64;
    let hh = report.half_h as i64;
    let clamp = |v: i64| v.clamp(TILE_MIN as i64, TILE_MAX as i64) as i32;
    let min = TilePos::new(clamp(cx - hw), clamp(cy - hh));
    let max = TilePos::new(clamp(cx + hw), clamp(cy + hh));
    ChunkRect::new(dims.chunk_of(min), dims.chunk_of(max))
}

#[inline]
fn dist_sq(c: ChunkCoord, center: ChunkCoord) -> i64 {
    let dx = c.x as i64 - center.x as i64;
    let dy = c.y as i64 - center.y as i64;
    dx * dx + dy * dy
}

#[inline]
fn rect_center(r: ChunkRect) -> ChunkCoord {
    ChunkCoord::new((r.min.x + r.max.x) / 2, (r.min.y + r.max.y) / 2)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Entry {
    chunk: ChunkCoord,
    /// `None` while inside this update's target (ring 1 ∪ look-ahead); set to the tick it first
    /// fell outside, so the hold time (0010: "5 s", counted in ticks per this brief's Planning
    /// decisions) is measured from there.
    outside_target_since: Option<Tick>,
}

/// Eviction priority (0010 "Cap: ... priority order visible > ring 1 > look-ahead > retained").
/// Derived `Ord` ranks ascending by discriminant, and eviction always picks the *largest* `(class,
/// distance)` key, so the discriminants are declared in evict-first order: `Retained` (worst,
/// evicted before any other class) has the highest value.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Class {
    Visible = 0,
    Ring1 = 1,
    LookAhead = 2,
    Retained = 3,
}

/// One connection's subscribed chunk set (docs/plan/15-connection-and-subscriptions.md Scope).
/// [`SubscriptionSet::update`] is the only mutator: given the latest camera report and the current
/// tick, it recomputes the target, applies hysteresis and the cap, and reports what changed since
/// the previous call via [`SubscriptionSet::entered`]/[`SubscriptionSet::left`] (each call's own
/// delta, not accumulated).
pub struct SubscriptionSet {
    dims: ChunkDims,
    hold: Ticks,
    entries: Vec<Entry>,
    target: Vec<ChunkCoord>,
    entered: Vec<ChunkCoord>,
    left: Vec<ChunkCoord>,
    visible: ChunkRect,
    ring1: ChunkRect,
    ring3: ChunkRect,
}

impl SubscriptionSet {
    pub fn new(dims: ChunkDims, tick_rate: TickRate) -> Self {
        let zero = ChunkRect::new(ChunkCoord::new(0, 0), ChunkCoord::new(0, 0));
        SubscriptionSet {
            dims,
            hold: tick_rate.secs(5),
            entries: Vec::with_capacity(CAP_CHUNKS + 4),
            target: Vec::with_capacity(CAP_CHUNKS),
            entered: Vec::with_capacity(CAP_CHUNKS),
            left: Vec::with_capacity(CAP_CHUNKS),
            visible: zero,
            ring1: zero,
            ring3: zero,
        }
    }

    /// Recomputes the subscribed set from a fresh (untrusted) camera report. Idempotent given the
    /// same `(report, tick)` (calling it twice at the same tick with an unchanged report leaves
    /// `entered`/`left` both empty the second time).
    pub fn update(&mut self, report: CameraReport, tick: Tick) {
        let report = clamp_report(report);
        self.visible = visible_rect(report, self.dims);
        self.ring1 = self.visible.expanded(1);
        self.ring3 = self.visible.expanded(RING_UNSUB);

        self.target.clear();
        for c in self.ring1.iter() {
            self.target.push(c);
        }
        let mut lookahead = [ChunkCoord::default(); 2];
        let n = lookahead_chunks(
            self.visible,
            (report.vel_x as i32, report.vel_y as i32),
            self.dims,
            &mut lookahead,
        );
        for &c in &lookahead[..n] {
            if !self.ring1.contains(c) {
                self.target.push(c);
            }
        }

        self.entered.clear();
        self.left.clear();

        // Hysteresis: age out entries no longer in the target; unsubscribe only past ring 3 and
        // the hold time.
        let mut i = 0;
        while i < self.entries.len() {
            let in_target = self.target.contains(&self.entries[i].chunk);
            if in_target {
                self.entries[i].outside_target_since = None;
                i += 1;
                continue;
            }
            let since = *self.entries[i].outside_target_since.get_or_insert(tick);
            let elapsed = tick.0.wrapping_sub(since.0);
            let outside_ring3 = !self.ring3.contains(self.entries[i].chunk);
            if outside_ring3 && elapsed >= self.hold.0 {
                self.left.push(self.entries[i].chunk);
                self.entries.swap_remove(i);
            } else {
                i += 1;
            }
        }

        // Subscribe every target chunk not already held.
        for &c in &self.target {
            if !self.entries.iter().any(|e| e.chunk == c) {
                self.entries.push(Entry {
                    chunk: c,
                    outside_target_since: None,
                });
                self.entered.push(c);
            }
        }

        self.evict_over_cap();
    }

    fn class(&self, chunk: ChunkCoord) -> Class {
        if self.visible.contains(chunk) {
            Class::Visible
        } else if self.ring1.contains(chunk) {
            Class::Ring1
        } else if self.target.contains(&chunk) {
            Class::LookAhead
        } else {
            Class::Retained
        }
    }

    /// 0010 "Cap: ... evict farthest-first immediately, in priority order". Repeatedly removes the
    /// single worst `(class, distance)` entry (worst class first, farthest within a class) until
    /// at or under [`CAP_CHUNKS`]. An entry evicted the same tick it was added is removed from
    /// `entered` instead of appearing in `left` (net: it never happened, from the client's view).
    fn evict_over_cap(&mut self) {
        let center = rect_center(self.visible);
        while self.entries.len() > CAP_CHUNKS {
            let mut worst_idx = 0;
            let mut worst_key = (self.class(self.entries[0].chunk), 0i64);
            worst_key.1 = dist_sq(self.entries[0].chunk, center);
            for (i, e) in self.entries.iter().enumerate().skip(1) {
                let key = (self.class(e.chunk), dist_sq(e.chunk, center));
                if key > worst_key {
                    worst_key = key;
                    worst_idx = i;
                }
            }
            let removed = self.entries.swap_remove(worst_idx);
            if let Some(pos) = self.entered.iter().position(|&c| c == removed.chunk) {
                self.entered.swap_remove(pos);
            } else {
                self.left.push(removed.chunk);
            }
        }
    }

    pub fn entered(&self) -> &[ChunkCoord] {
        &self.entered
    }

    pub fn left(&self) -> &[ChunkCoord] {
        &self.left
    }

    pub fn is_subscribed(&self, chunk: ChunkCoord) -> bool {
        self.entries.iter().any(|e| e.chunk == chunk)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn chunks(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        self.entries.iter().map(|e| e.chunk)
    }

    /// The rectangle to feed `host::warm::Warm::set_view` (docs/plan/
    /// 15-connection-and-subscriptions.md Deviations 1): `visible` expanded by 2 rings, which
    /// exactly contains ring 1 (expanded by 1) and every look-ahead chunk
    /// (`view::lookahead_chunks` places one at `visible.expanded(1)`'s edge plus one more chunk --
    /// `visible.expanded(2)`'s own edge), so the generation set this drives stays a superset of the
    /// subscription target (0008 §5).
    pub fn warm_rect(&self) -> ChunkRect {
        self.visible.expanded(2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(cx: i32, cy: i32, half: u16, vel: (i16, i16)) -> CameraReport {
        CameraReport {
            center_x: cx,
            center_y: cy,
            half_w: half,
            half_h: half,
            vel_x: vel.0,
            vel_y: vel.1,
        }
    }

    fn dims32() -> ChunkDims {
        ChunkDims::new(5) // edge 32, 0010's own worked numbers
    }

    #[test]
    fn subs_ring1_plus_lookahead() {
        let mut s = SubscriptionSet::new(dims32(), TickRate::HZ_20);
        s.update(report(0, 0, 16, (0, 0)), Tick(1));
        let visible = visible_rect(clamp_report(report(0, 0, 16, (0, 0))), dims32());
        let ring1 = visible.expanded(1);
        for c in ring1.iter() {
            assert!(s.is_subscribed(c), "{c:?} should be in ring1");
        }
        assert_eq!(s.len(), ring1.iter().count(), "no velocity: exactly ring1");

        // Now with velocity: up to 2 extra chunks appear, just beyond ring1's edge.
        let mut s2 = SubscriptionSet::new(dims32(), TickRate::HZ_20);
        s2.update(report(0, 0, 16, (300, -300)), Tick(1));
        assert_eq!(s2.len(), ring1.iter().count() + 2);
        let mut buf = [ChunkCoord::default(); 2];
        let n = lookahead_chunks(visible, (300, -300), dims32(), &mut buf);
        assert_eq!(n, 2);
        for &c in &buf[..n] {
            assert!(s2.is_subscribed(c), "{c:?} should be a look-ahead chunk");
        }
    }

    #[test]
    fn subs_hysteresis_no_traffic_on_small_pan() {
        let dims = dims32();
        let mut s = SubscriptionSet::new(dims, TickRate::HZ_20);
        s.update(report(0, 0, 16, (0, 0)), Tick(1));
        assert!(!s.entered().is_empty());

        // Pan by one tile (well under the ~64-tile hysteresis threshold, 0010): still inside ring1
        // for most chunks, and anything that falls out of ring1 is still inside ring3, so nothing
        // unsubscribes.
        s.update(report(1, 0, 16, (0, 0)), Tick(2));
        assert!(
            s.left().is_empty(),
            "a 1-tile pan must not unsubscribe anything"
        );

        // Pan back to the original centre well within the hold time: still no unsubscribes, and
        // nothing that was already held re-enters (it never left).
        s.update(report(0, 0, 16, (0, 0)), Tick(3));
        assert!(s.left().is_empty());
    }

    #[test]
    fn subs_unsubscribe_after_hold() {
        let dims = dims32();
        let mut s = SubscriptionSet::new(dims, TickRate::HZ_20);
        s.update(report(0, 0, 16, (0, 0)), Tick(1));
        let visible0 = visible_rect(clamp_report(report(0, 0, 16, (0, 0))), dims);

        // Pan far enough that the whole original view is outside ring3 of the new view. The hold
        // (5 s = 100 ticks at 20 Hz) must elapse before anything unsubscribes.
        let hold = TickRate::HZ_20.secs(5).0;
        let far = report(100_000, 0, 16, (0, 0));
        s.update(far, Tick(2));
        assert!(
            s.left().is_empty(),
            "must not unsubscribe before the hold time elapses"
        );

        for t in 3..(2 + hold) {
            s.update(far, Tick(t));
            assert!(
                s.left().is_empty(),
                "must not unsubscribe before tick {}",
                2 + hold
            );
        }
        s.update(far, Tick(2 + hold));
        assert!(
            !s.left().is_empty(),
            "must unsubscribe once the hold time has fully elapsed"
        );
        // Every unsubscribed chunk came from the original (now-abandoned) view.
        let old_ring1 = visible0.expanded(1);
        for &c in s.left() {
            assert!(old_ring1.contains(c), "{c:?} was never in the old view");
        }
    }

    #[test]
    fn subs_cap_evicts_farthest_first() {
        let dims = dims32();
        let mut s = SubscriptionSet::new(dims, TickRate::HZ_20);

        // Old view: a modest ring1 (25 chunks at this size), well over the cap's slack once a
        // maximal new view (121 chunks, 0010's own worked "ring1 is 11x11=121") is subscribed.
        let old = report(0, 0, 32, (0, 0));
        s.update(old, Tick(1));
        let old_visible = visible_rect(clamp_report(old), dims);
        let old_ring1 = old_visible.expanded(1);
        let old_count = old_ring1.iter().count();
        assert_eq!(s.len(), old_count);
        assert!(old_count > CAP_CHUNKS - 121, "test needs eviction to bite");

        // New view: maximal extent, far enough away that the old view shares nothing with it and
        // sits outside its ring3 immediately. Well inside `TILE_MAX` on both sides so the centre
        // clamp (0010) does not itself skew the rect (unlike a centre near the coordinate edge).
        let new = report(4_000_000, 0, MAX_HALF_TILES, (0, 0));
        s.update(new, Tick(2));
        let new_visible = visible_rect(clamp_report(new), dims);
        let new_ring1 = new_visible.expanded(1);
        let new_count = new_ring1.iter().count();
        assert_eq!(new_count, 121, "0010's own worked number at the clamp");

        assert_eq!(s.len(), CAP_CHUNKS, "trimmed back to the cap");
        for c in new_ring1.iter() {
            assert!(
                s.is_subscribed(c),
                "every new-view chunk must survive (highest priority): {c:?}"
            );
        }
        let evicted = old_count + new_count - CAP_CHUNKS;
        assert_eq!(s.left().len(), evicted);
        let survivors = CAP_CHUNKS - new_count;
        assert_eq!(survivors, old_count - evicted);

        // Farthest-first: every evicted old chunk is at least as far from the new view's centre as
        // every surviving old chunk.
        let new_center = rect_center(new_visible);
        let survivor_chunks: Vec<ChunkCoord> =
            s.chunks().filter(|c| !new_ring1.contains(*c)).collect();
        assert_eq!(survivor_chunks.len(), survivors);
        let max_survivor_dist = survivor_chunks
            .iter()
            .map(|&c| dist_sq(c, new_center))
            .max()
            .unwrap_or(0);
        let min_evicted_dist = s
            .left()
            .iter()
            .map(|&c| dist_sq(c, new_center))
            .min()
            .unwrap_or(i64::MAX);
        assert!(
            min_evicted_dist >= max_survivor_dist,
            "an evicted chunk must not be closer than a surviving one"
        );
    }

    #[test]
    fn subs_clamps_oversized_and_zero_views() {
        let dims = dims32();

        // Zero extent: clamped to the minimum, never rejected (0010: "never rejected").
        let zero = report(5, 5, 0, (0, 0));
        let clamped = clamp_report(zero);
        assert_eq!(clamped.half_w, MIN_HALF_TILES);
        assert_eq!(clamped.half_h, MIN_HALF_TILES);

        // Over-large extent: clamped to the max (256 tiles per axis, 0010).
        let huge = report(0, 0, u16::MAX, (0, 0));
        let clamped = clamp_report(huge);
        assert_eq!(clamped.half_w, MAX_HALF_TILES);
        assert_eq!(clamped.half_h, MAX_HALF_TILES);

        // Centre outside the world's coordinate range is clamped into it, never rejected.
        let far = report(i32::MAX, i32::MIN, 16, (0, 0));
        let clamped = clamp_report(far);
        assert_eq!(clamped.center_x, TILE_MAX);
        assert_eq!(clamped.center_y, TILE_MIN);

        // A `SubscriptionSet::update` with any of these never panics and always yields a non-empty
        // subscription (a clamp, not a rejection).
        let mut s = SubscriptionSet::new(dims, TickRate::HZ_20);
        s.update(zero, Tick(1));
        assert!(!s.is_empty());
        s.update(huge, Tick(2));
        assert!(!s.is_empty());
        s.update(far, Tick(3));
        assert!(!s.is_empty());
    }
}
