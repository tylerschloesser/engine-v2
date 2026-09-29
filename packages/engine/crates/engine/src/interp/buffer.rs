//! [`InterpBuffer`]: a per-key ring of [`DEPTH`] samples `{ t, pos, vel }` evaluated at a render
//! time (0012 "Remote motion": Hermite on position + velocity; extrapolate at most 250 ms, then
//! hold; fade after 2 s of silence).
//!
//! Units: `t` is host ticks (`f64`); `pos` is `WorldPos` (Q24.8 tiles); `vel` is Q24.8 tiles per
//! *second* (0001's `Presence::vel`), so the buffer needs the tick rate to integrate.
//!
//! Allocation: each key's ring is a fixed array. The key table is a sorted `Vec` whose *first*
//! push of a new key may allocate (unless [`InterpBuffer::reserve_keys`] covered it); a push to a
//! known key, [`InterpBuffer::sample`], [`InterpBuffer::remove`] and [`InterpBuffer::clear`] never
//! allocate.

use crate::game::{EntityId, PlayerId};
use crate::world::WorldPos;

/// Samples kept per key (Planning decisions: "Buffer depth 8 samples per key").
pub const DEPTH: usize = 8;
/// 0012 "Remote motion": "extrapolate at most 250 ms, then hold".
pub const EXTRAPOLATION_CAP_MS: f64 = 250.0;
/// 0012 "Remote motion": "fade an avatar after 2 s of silence".
pub const SILENCE_LIMIT_MS: f64 = 2000.0;
/// Length of the linear alpha ramp that starts at [`SILENCE_LIMIT_MS`]. 0012 fixes the start but
/// not the length: this milestone's own choice (Deviations).
pub const FADE_MS: f64 = 500.0;

/// What a buffer is keyed by: remote players today, replicated moving entities later (same
/// buffer, same code path: 0012 "Remote motion").
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum InterpKey {
    Player(PlayerId),
    Entity(EntityId),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InterpMode {
    /// Render time is inside the sampled span.
    Interp,
    /// Past the newest sample, within the extrapolation cap.
    Extrap,
    /// Past the cap: the position stays where extrapolation ended.
    Hold,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Interp {
    pub pos: WorldPos,
    /// Q24.8 tiles per second; zero while held.
    pub vel: [i32; 2],
    /// 1 while fresh, ramps to 0 after the silence limit.
    pub alpha: f32,
    pub mode: InterpMode,
}

/// What [`InterpBuffer::push`] did with a sample.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PushResult {
    Added,
    /// Same `t` as the newest sample (a re-relayed held sample): not stored; the caller passes the
    /// arrival time to [`InterpBuffer::refresh`] to keep the key solid.
    Duplicate,
    /// Older than the newest sample: dropped.
    OutOfOrder,
}

#[derive(Clone, Copy)]
struct Sample {
    t: f64,
    pos: WorldPos,
    vel: [i32; 2],
}

const EMPTY: Sample = Sample {
    t: 0.0,
    pos: WorldPos { x: 0, y: 0 },
    vel: [0, 0],
};

struct Ring<K> {
    key: K,
    /// Oldest first, `samples[..len]`; shifted on overflow (`DEPTH` is tiny).
    samples: [Sample; DEPTH],
    len: usize,
    /// Latest host tick at which the newest sample is known to still hold: the newest `t`, or a
    /// later [`InterpBuffer::refresh`]. Silence is measured from here.
    valid_until: f64,
}

pub struct InterpBuffer<K> {
    ticks_per_ms: f64,
    hz: f64,
    rings: Vec<Ring<K>>,
}

impl<K: Ord + Copy> InterpBuffer<K> {
    pub fn new(tick_hz: u32) -> Self {
        let hz = tick_hz.max(1) as f64;
        InterpBuffer {
            ticks_per_ms: hz / 1000.0,
            hz,
            rings: Vec::new(),
        }
    }

    /// Reserves room for `n` keys so later first pushes cannot allocate.
    pub fn reserve_keys(&mut self, n: usize) {
        self.rings.reserve(n);
    }

    fn find(&self, key: &K) -> Result<usize, usize> {
        self.rings.binary_search_by(|r| r.key.cmp(key))
    }

    pub fn push(&mut self, key: K, t: f64, pos: WorldPos, vel: [i32; 2]) -> PushResult {
        let idx = match self.find(&key) {
            Ok(i) => i,
            Err(at) => {
                self.rings.insert(
                    at,
                    Ring {
                        key,
                        samples: [EMPTY; DEPTH],
                        len: 0,
                        valid_until: t,
                    },
                );
                at
            }
        };
        let r = &mut self.rings[idx];
        if r.len > 0 {
            let newest = r.samples[r.len - 1].t;
            if t == newest {
                return PushResult::Duplicate;
            }
            if t < newest {
                return PushResult::OutOfOrder;
            }
        }
        if r.len == DEPTH {
            r.samples.copy_within(1.., 0);
            r.len -= 1;
        }
        r.samples[r.len] = Sample { t, pos, vel };
        r.len += 1;
        if t > r.valid_until {
            r.valid_until = t;
        }
        PushResult::Added
    }

    /// A re-relayed held sample arrived at host tick `now`: the newest sample is still valid, so
    /// the silence timer restarts. No effect on an unknown key or an earlier `now`.
    pub fn refresh(&mut self, key: K, now: f64) {
        if let Ok(i) = self.find(&key)
            && now > self.rings[i].valid_until
        {
            self.rings[i].valid_until = now;
        }
    }

    pub fn remove(&mut self, key: K) {
        if let Ok(i) = self.find(&key) {
            self.rings.remove(i);
        }
    }

    /// Drops every key (rebase, resync); keeps capacity.
    pub fn clear(&mut self) {
        self.rings.clear();
    }

    pub fn len(&self) -> usize {
        self.rings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rings.is_empty()
    }

    /// The keys in order (for a caller that iterates every remote).
    pub fn key_at(&self, i: usize) -> Option<K> {
        self.rings.get(i).map(|r| r.key)
    }

    /// Position at `render_t` (host ticks). `None` for an unknown key, and once the fade has
    /// reached zero (a later push brings it back).
    pub fn sample(&self, key: K, render_t: f64) -> Option<Interp> {
        let r = &self.rings[self.find(&key).ok()?];
        if r.len == 0 {
            return None;
        }
        let alpha = self.alpha(render_t - r.valid_until);
        if alpha <= 0.0 {
            return None;
        }
        let s = &r.samples[..r.len];
        let newest = s[r.len - 1];
        if render_t >= newest.t {
            let ahead = render_t - newest.t;
            let cap = EXTRAPOLATION_CAP_MS * self.ticks_per_ms;
            let (used, mode) = if ahead <= cap {
                (ahead, InterpMode::Extrap)
            } else {
                (cap, InterpMode::Hold)
            };
            let secs = used / self.hz;
            let pos = WorldPos {
                x: newest
                    .pos
                    .x
                    .wrapping_add(round(newest.vel[0] as f64 * secs)),
                y: newest
                    .pos
                    .y
                    .wrapping_add(round(newest.vel[1] as f64 * secs)),
            };
            let vel = if mode == InterpMode::Hold {
                [0, 0]
            } else {
                newest.vel
            };
            return Some(Interp {
                pos,
                vel,
                alpha,
                mode,
            });
        }
        let oldest = s[0];
        if render_t <= oldest.t {
            return Some(Interp {
                pos: oldest.pos,
                vel: oldest.vel,
                alpha,
                mode: InterpMode::Interp,
            });
        }
        // Bracket: the last sample with t <= render_t is `a`, the next is `b`.
        let mut i = 0;
        while s[i + 1].t <= render_t {
            i += 1;
        }
        let (a, b) = (s[i], s[i + 1]);
        let h = (b.t - a.t) / self.hz; // seconds between the two samples
        let u = (render_t - a.t) / (b.t - a.t);
        let (u2, u3) = (u * u, u * u * u);
        let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
        let h10 = u3 - 2.0 * u2 + u;
        let h01 = -2.0 * u3 + 3.0 * u2;
        let h11 = u3 - u2;
        let d00 = 6.0 * u2 - 6.0 * u;
        let d10 = 3.0 * u2 - 4.0 * u + 1.0;
        let d01 = -d00;
        let d11 = 3.0 * u2 - 2.0 * u;
        let mut pos = [0i32; 2];
        let mut vel = [0i32; 2];
        for k in 0..2 {
            let (p0, p1) = (
                if k == 0 { a.pos.x } else { a.pos.y } as f64,
                if k == 0 { b.pos.x } else { b.pos.y } as f64,
            );
            let (v0, v1) = (a.vel[k] as f64, b.vel[k] as f64);
            let p = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
            let dp = (d00 * p0 + d10 * h * v0 + d01 * p1 + d11 * h * v1) / h;
            pos[k] = round(p);
            vel[k] = round(dp);
        }
        Some(Interp {
            pos: WorldPos {
                x: pos[0],
                y: pos[1],
            },
            vel,
            alpha,
            mode: InterpMode::Interp,
        })
    }

    /// `silence` is `render_t - valid_until` in ticks.
    fn alpha(&self, silence: f64) -> f32 {
        let ms = silence / self.ticks_per_ms;
        if ms <= SILENCE_LIMIT_MS {
            1.0
        } else {
            (1.0 - (ms - SILENCE_LIMIT_MS) / FADE_MS).max(0.0) as f32
        }
    }
}

/// Round to nearest, saturating at the `i32` range.
fn round(v: f64) -> i32 {
    v.round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 20 Hz: 1 tick = 50 ms. Q24.8: 256 = one tile.
    const HZ: u32 = 20;
    const T: f64 = 256.0;

    fn p(x: i32, y: i32) -> WorldPos {
        WorldPos { x, y }
    }
    fn pl(n: u32) -> InterpKey {
        InterpKey::Player(PlayerId(n))
    }
    fn buf() -> InterpBuffer<InterpKey> {
        InterpBuffer::new(HZ)
    }
    /// A straight line at 4 tiles/s, sampled every `step` ticks from tick 0.
    fn line(b: &mut InterpBuffer<InterpKey>, key: InterpKey, n: u32, step: f64) {
        for i in 0..n {
            let t = i as f64 * step;
            let x = (4.0 * T * t / HZ as f64) as i32;
            b.push(key, t, p(x, 0), [(4.0 * T) as i32, 0]);
        }
    }

    #[test]
    fn interp_hermite_hits_samples_and_is_c1() {
        let mut b = buf();
        // A curved path so the tangents matter: x = 100 t^2 (t in ticks), v = 200 t per tick.
        let per_s = HZ as f64;
        for i in 0..5 {
            let t = i as f64 * 2.0;
            b.push(
                pl(1),
                t,
                p((100.0 * t * t) as i32, 0),
                [(200.0 * t * per_s) as i32, 0],
            );
        }
        let k = pl(1);
        // Exact at every sample time (a < newest; the newest is the Extrap boundary).
        for i in 0..4 {
            let t = i as f64 * 2.0;
            let s = b.sample(k, t).unwrap();
            assert_eq!(s.pos.x, (100.0 * t * t) as i32);
            assert_eq!(s.mode, InterpMode::Interp);
        }
        // Reproduces a quadratic exactly (cubic Hermite) between samples, to rounding.
        let s = b.sample(k, 3.0).unwrap();
        assert!((s.pos.x - 900).abs() <= 1, "{}", s.pos.x);
        // C1: position and velocity are continuous across a knot (t = 4) from both sides.
        let below = b.sample(k, 4.0 - 1e-6).unwrap();
        let above = b.sample(k, 4.0 + 1e-6).unwrap();
        assert!((below.pos.x - above.pos.x).abs() <= 1);
        assert!((below.vel[0] - above.vel[0]).abs() <= 2 * per_s as i32);
        assert!((above.vel[0] as f64 - 200.0 * 4.0 * per_s).abs() <= 2.0 * per_s);
    }

    #[test]
    fn interp_extrapolates_then_holds() {
        let mut b = buf();
        line(&mut b, pl(1), 3, 2.0); // newest t = 4 ticks
        let k = pl(1);
        let v = (4.0 * T) as i32;
        let at_newest = b.sample(k, 4.0).unwrap();
        assert_eq!(at_newest.mode, InterpMode::Extrap);
        // 250 ms = 5 ticks: extrapolation reaches exactly the cap.
        let cap = b.sample(k, 9.0).unwrap();
        assert_eq!(cap.mode, InterpMode::Extrap);
        assert_eq!(cap.pos.x, at_newest.pos.x + (4.0 * T * 0.25) as i32);
        assert_eq!(cap.vel, [v, 0]);
        // Beyond: held at the cap position, zero velocity, however far render_t goes.
        let held = b.sample(k, 9.5).unwrap();
        assert_eq!(held.mode, InterpMode::Hold);
        assert_eq!(held.pos, cap.pos);
        assert_eq!(held.vel, [0, 0]);
        assert_eq!(b.sample(k, 30.0).unwrap().pos, cap.pos);
        // Before the oldest sample: clamped, still Interp.
        let early = b.sample(k, -3.0).unwrap();
        assert_eq!((early.pos.x, early.mode), (0, InterpMode::Interp));
    }

    #[test]
    fn interp_fades_after_silence_and_recovers() {
        let mut b = buf();
        line(&mut b, pl(1), 3, 2.0); // valid_until = 4
        let k = pl(1);
        let ms = |m: f64| 4.0 + m / 50.0;
        assert_eq!(b.sample(k, ms(2000.0)).unwrap().alpha, 1.0);
        let mid = b.sample(k, ms(2250.0)).unwrap().alpha;
        assert!((mid - 0.5).abs() < 1e-5, "{mid}");
        assert!(b.sample(k, ms(2499.0)).unwrap().alpha < 0.01);
        assert!(b.sample(k, ms(2500.0)).is_none());
        // A new sample brings it back at full alpha.
        b.push(k, ms(3000.0), p(9, 9), [0, 0]);
        let back = b.sample(k, ms(3000.0)).unwrap();
        assert_eq!(back.alpha, 1.0);
        assert_eq!(back.pos, p(9, 9));
    }

    #[test]
    fn interp_rerelay_refreshes_without_new_sample() {
        let mut b = buf();
        let k = pl(1);
        assert_eq!(b.push(k, 10.0, p(5, 5), [0, 0]), PushResult::Added);
        // The same sample_tick re-relayed every 500 ms for 5 s (100 ticks).
        for i in 1..=10 {
            assert_eq!(b.push(k, 10.0, p(5, 5), [0, 0]), PushResult::Duplicate);
            b.refresh(k, 10.0 + i as f64 * 10.0);
        }
        // Render time is 5 s past the sample: solid (resting), position unchanged.
        let s = b.sample(k, 110.0).unwrap();
        assert_eq!((s.alpha, s.pos), (1.0, p(5, 5)));
        // Still one sample: nothing was added.
        assert_eq!(b.rings[0].len, 1);
        // Without refreshes the same instant is long faded.
        let mut c = buf();
        c.push(k, 10.0, p(5, 5), [0, 0]);
        assert!(c.sample(k, 110.0).is_none());
        // An earlier refresh never shortens validity.
        b.refresh(k, 20.0);
        assert_eq!(b.sample(k, 110.0).unwrap().alpha, 1.0);
    }

    #[test]
    fn interp_drops_out_of_order() {
        let mut b = buf();
        let k = pl(1);
        b.push(k, 5.0, p(50, 0), [0, 0]);
        b.push(k, 7.0, p(70, 0), [0, 0]);
        assert_eq!(b.push(k, 6.0, p(999, 0), [0, 0]), PushResult::OutOfOrder);
        assert_eq!(b.push(k, 7.0, p(999, 0), [0, 0]), PushResult::Duplicate);
        assert_eq!(b.rings[0].len, 2);
        assert!(b.sample(k, 6.0).unwrap().pos.x < 100);
    }

    #[test]
    fn interp_ring_keeps_newest_depth_samples() {
        let mut b = buf();
        let k = pl(1);
        for i in 0..20 {
            b.push(k, i as f64, p(i * 10, 0), [0, 0]);
        }
        assert_eq!(b.rings[0].len, DEPTH);
        assert_eq!(b.rings[0].samples[0].t, 12.0);
        // Before the oldest kept sample: clamps to it.
        assert_eq!(b.sample(k, 0.0).unwrap().pos.x, 120);
    }

    #[test]
    fn interp_remove_and_clear() {
        let mut b = buf();
        line(&mut b, pl(1), 3, 1.0);
        line(&mut b, pl(2), 3, 1.0);
        assert_eq!(b.len(), 2);
        b.remove(pl(1));
        assert!(b.sample(pl(1), 1.0).is_none());
        assert!(b.sample(pl(2), 1.0).is_some());
        b.clear();
        assert!(b.is_empty());
        assert!(b.sample(pl(2), 1.0).is_none());
    }

    #[test]
    fn interp_entity_key_same_path() {
        let mut b = buf();
        let (pk, ek) = (pl(7), InterpKey::Entity(EntityId(7)));
        for i in 0..6 {
            let t = i as f64 * 2.0;
            let x = (300.0 * t + 40.0 * t * t) as i32;
            let v = [(300.0 + 80.0 * t) as i32 * HZ as i32, -50];
            for k in [pk, ek] {
                b.push(k, t, p(x, -x), v);
            }
        }
        b.refresh(pk, 13.0);
        b.refresh(ek, 13.0);
        let mut t = -1.0;
        while t < 30.0 {
            assert_eq!(b.sample(pk, t), b.sample(ek, t), "t = {t}");
            t += 0.37;
        }
    }
}
