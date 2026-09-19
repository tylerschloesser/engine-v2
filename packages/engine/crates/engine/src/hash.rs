//! 64-bit FNV-1a (docs/decisions/0002 §3). Detects bugs, not adversaries. M05 builds the state
//! hash on it.

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
}
