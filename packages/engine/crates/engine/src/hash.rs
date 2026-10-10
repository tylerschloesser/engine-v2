//! 64-bit FNV-1a (docs/decisions/0002 §3). Detects bugs, not adversaries. The state hash is this
//! hasher fed by the same [`crate::codec`] writers that produce snapshot bytes
//! ([`hash_value`], `impl ByteSink for Fnv64`): hashing is encoding into a sink that has no
//! buffer.

use crate::bytes::ByteSink;
use crate::codec::Codec;

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fnv64(u64);

impl Fnv64 {
    pub const fn new() -> Self {
        Fnv64(OFFSET)
    }

    #[inline]
    pub fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(PRIME);
        }
    }

    /// Little-endian, so the hash does not depend on the host's byte order.
    #[inline]
    pub fn write_u32(&mut self, v: u32) {
        self.write(&v.to_le_bytes());
    }

    #[inline]
    pub fn write_u64(&mut self, v: u64) {
        self.write(&v.to_le_bytes());
    }

    pub const fn finish(&self) -> u64 {
        self.0
    }
}

impl Default for Fnv64 {
    fn default() -> Self {
        Self::new()
    }
}

impl ByteSink for Fnv64 {
    #[inline]
    fn put(&mut self, bytes: &[u8]) {
        self.write(bytes);
    }
}

/// SplitMix64 finalizer (Phase 1 `determinism-hash` spike): spreads a hash or counter into a
/// well-mixed 64-bit value, e.g. for RNG seeding (M12) or bucketing.
#[inline]
pub fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// A type that knows how to hash itself into an [`Fnv64`], by feeding it the same canonical
/// writers used for snapshot bytes ([`crate::codec::encode_to`]) rather than deriving a second,
/// divergent notion of "the state" (0002 §3). `M07`, `M12`, `M21` and `M22` implement this for
/// their aggregate state types; a plain [`Codec`] value hashes through [`hash_value`] instead,
/// which needs no impl of this trait.
pub trait StateHash {
    fn hash_state(&self, h: &mut Fnv64);
}

/// The state hash of one [`Codec`] value: FNV-1a over exactly the bytes [`crate::codec::encode`]
/// would have written, without ever buffering them.
pub fn hash_value<T: Codec>(value: &T) -> u64 {
    let mut h = Fnv64::new();
    crate::codec::encode_to(value, &mut h).expect("hashing into Fnv64 cannot fail");
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(bytes: &[u8]) -> u64 {
        let mut h = Fnv64::new();
        h.write(bytes);
        h.finish()
    }

    // Vectors: http://www.isthe.com/chongo/tech/comp/fnv/ (FNV-1a, 64-bit).
    #[test]
    fn fnv64_vectors() {
        assert_eq!(of(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(of(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(of(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn fnv64_integers_are_little_endian() {
        let mut a = Fnv64::new();
        a.write_u32(0x0403_0201);
        a.write_u64(0x0c0b_0a09_0807_0605);
        assert_eq!(a.finish(), of(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    }

    #[test]
    fn fnv64_is_a_byte_sink() {
        let mut a = Fnv64::new();
        ByteSink::put(&mut a, b"abc");
        let mut b = Fnv64::new();
        b.write(b"abc");
        assert_eq!(a.finish(), b.finish());
    }

    /// 0002 §2: integer arithmetic on hashed state is written `wrapping_*` explicitly. The test
    /// profile keeps overflow checks on, so a bare `*` or `+` in `Fnv64` or `mix64` panics on these
    /// all-ones inputs; the results are compared with the same arithmetic done in `u128`.
    #[test]
    fn hashing_wraps_explicitly_on_all_ones_inputs() {
        let mut h = Fnv64::new();
        h.write(&[0xFF; 64]);
        h.write_u64(u64::MAX);
        h.write_u32(u32::MAX);
        let mut want: u64 = 0xcbf2_9ce4_8422_2325;
        for _ in 0..(64 + 8 + 4) {
            want = (((want ^ 0xFF) as u128 * 0x0000_0100_0000_01b3_u128) & u128::from(u64::MAX))
                as u64;
        }
        assert_eq!(h.finish(), want);

        let mut z = u64::MAX;
        z ^= z >> 30;
        z = ((z as u128 * 0xBF58_476D_1CE4_E5B9_u128) & u128::from(u64::MAX)) as u64;
        z ^= z >> 27;
        z = ((z as u128 * 0x94D0_49BB_1331_11EB_u128) & u128::from(u64::MAX)) as u64;
        assert_eq!(mix64(u64::MAX), z ^ (z >> 31));
    }
}
