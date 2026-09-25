//! Hand-written, table-driven CRC-32 (0017 §7 crate policy: no new crate for this). Standard
//! CRC-32/ISO-HDLC (the `zlib`/Ethernet polynomial, reflected in and out, initial `0xFFFF_FFFF`,
//! final XOR `0xFFFF_FFFF`) -- the same variant every common CRC-32 tool implements, checked below
//! against the published check value for `"123456789"`.

const POLY: u32 = 0xEDB8_8320;

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { POLY ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = build_table();

/// CRC-32 of `bytes` (CRC-32/ISO-HDLC). Used to protect a log frame's body and a snapshot's
/// payload (0005 Formats): a mismatch means truncated or corrupt bytes, never a hash the engine
/// should trust.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        let idx = ((crc ^ b as u32) & 0xFF) as usize;
        crc = TABLE[idx] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The standard CRC-32/ISO-HDLC check value: http://reveng.sourceforge.net/crc-catalogue/17plus.htm
    #[test]
    fn crc32_matches_published_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn crc32_empty_is_zero() {
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn crc32_detects_a_single_bit_flip() {
        let a = crc32(b"the quick brown fox");
        let mut flipped = b"the quick brown fox".to_vec();
        flipped[3] ^= 0x01;
        assert_ne!(a, crc32(&flipped));
    }
}
