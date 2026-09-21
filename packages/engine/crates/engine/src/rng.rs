//! `SimRng`: hand-rolled PCG32 (docs/decisions/0002-determinism-same-wasm-everywhere.md
//! "Randomness": "engine-owned `SimRng` (hand-rolled PCG32, integer-only range sampling,
//! `fork(stream)`), state stored in the snapshot, reachable only through the host's write context;
//! a predicted `apply` that asks for it declines to predict"). The write context
//! (`WorldWrite::rng`) and snapshot embedding are M12b's; this module only builds the generator
//! itself, `Codec` like any other plain-data field.

const MULTIPLIER: u64 = 6_364_136_223_846_793_005;

/// PCG32 (O'Neill 2014, XSH-RR output function): 64-bit state, 64-bit stream selector ("increment"),
/// 32-bit output. Two streams from the same seed never collide (`fork`); the same `(state, inc)`
/// always produces the same sequence, on every target (only `+ - * wrapping_*` and shifts, per
/// `.claude/rules/determinism.md`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct SimRng {
    state: u64,
    inc: u64,
}

impl SimRng {
    /// Seeds a fresh generator on stream 0.
    pub fn new(seed: u64) -> Self {
        Self::seed_seq(seed, 0)
    }

    /// Seeds a generator on an explicit stream (PCG's multi-stream property): two `seed_seq` calls
    /// with the same `seed` but different `stream` never share a state sequence. `stream`'s low
    /// bit is ignored (`inc` is forced odd, as PCG requires).
    pub fn seed_seq(seed: u64, stream: u64) -> Self {
        let mut rng = SimRng {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.step();
        rng.state = rng.state.wrapping_add(seed);
        rng.step();
        rng
    }

    #[inline]
    fn step(&mut self) {
        self.state = self.state.wrapping_mul(MULTIPLIER).wrapping_add(self.inc);
    }

    /// The next 32-bit output (PCG-XSH-RR: xorshift high bits down, then a variable rotate by the
    /// top 5 bits of the pre-advance state).
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.step();
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// A uniform value in `[0, bound)`, unbiased by rejection sampling (0002's "integer-only range
    /// sampling"; the classic PCG `boundedrand` threshold method -- no `%` bias because the
    /// rejected prefix is exactly `2^32 mod bound` values wide). `bound == 0` always returns `0`.
    pub fn below(&mut self, bound: u32) -> u32 {
        if bound == 0 {
            return 0;
        }
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % bound;
            }
        }
    }

    /// Derives an independent child stream (0002's `fork(stream)`): deterministic in `self`'s
    /// state, so replay reproduces every fork; two different `stream` values on the same parent
    /// state never collide (PCG's multi-stream property, carried by `seed_seq`).
    pub fn fork(&mut self, stream: u64) -> SimRng {
        let seed = self.next_u32() as u64 | ((self.next_u32() as u64) << 32);
        SimRng::seed_seq(seed, stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned sequence (computed from this exact implementation with `cargo test -p engine --lib
    /// rng::tests::simrng_golden_sequence -- --nocapture` and printed; see
    /// docs/plan/12-store-and-game-trait.md Deviations for how). A change here means the PCG32
    /// implementation changed, which changes every RNG-dependent golden.
    #[test]
    fn simrng_golden_sequence() {
        let mut rng = SimRng::new(0x5EED_1234_ABCD_0042);
        let got: Vec<u32> = (0..8).map(|_| rng.next_u32()).collect();
        assert_eq!(
            got,
            vec![
                0xacf6_4617,
                0x61de_8173,
                0xee05_98b5,
                0x8507_040c,
                0x6151_5ef0,
                0xfb8e_46aa,
                0x2895_2f0b,
                0xcea6_48b0,
            ]
        );
    }

    #[test]
    fn same_seed_same_sequence() {
        let mut a = SimRng::new(42);
        let mut b = SimRng::new(42);
        for _ in 0..16 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = SimRng::new(1);
        let mut b = SimRng::new(2);
        let sa: Vec<u32> = (0..8).map(|_| a.next_u32()).collect();
        let sb: Vec<u32> = (0..8).map(|_| b.next_u32()).collect();
        assert_ne!(sa, sb);
    }

    #[test]
    fn below_is_unbiased_range_and_covers_it() {
        let mut rng = SimRng::new(7);
        let mut seen = [false; 5];
        for _ in 0..2000 {
            let v = rng.below(5);
            assert!(v < 5);
            seen[v as usize] = true;
        }
        assert!(
            seen.iter().all(|&s| s),
            "every value in [0, 5) must appear: {seen:?}"
        );
        assert_eq!(rng.below(0), 0);
        assert_eq!(rng.below(1), 0);
    }

    #[test]
    fn fork_is_deterministic_and_stream_dependent() {
        let mut a = SimRng::new(99);
        let mut b = SimRng::new(99);
        let mut fa = a.fork(1);
        let mut fb = b.fork(1);
        for _ in 0..8 {
            assert_eq!(fa.next_u32(), fb.next_u32());
        }

        let mut c = SimRng::new(99);
        let mut f1 = c.fork(1);
        let mut f2 = c.fork(2);
        let s1: Vec<u32> = (0..8).map(|_| f1.next_u32()).collect();
        let s2: Vec<u32> = (0..8).map(|_| f2.next_u32()).collect();
        assert_ne!(s1, s2, "different streams must diverge");
    }

    #[test]
    fn simrng_is_codec() {
        let mut rng = SimRng::new(123);
        rng.next_u32();
        let mut buf = [0u8; 32];
        let n = crate::codec::encode(&rng, &mut buf).unwrap();
        let (decoded, rest) = crate::codec::decode::<SimRng>(&buf[..n]).unwrap();
        assert!(rest.is_empty());
        assert_eq!(rng, decoded);
    }
}
