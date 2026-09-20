//! Black-box `Codec` tests: only the public API of `engine::{bytes, codec, hash}`. The tests that
//! need `codec::encode_to_with`'s crate-private `strict` switch live inline in `src/codec.rs`
//! (docs/plan/05-codec-and-state-hash.md, Order of work 3 and 7).

use engine::codec::{self, CodecError};
use engine::hash::{self, Fnv64};

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
enum Kind {
    Idle,
    Moving { dx: i32, dy: i32 },
}

/// The `codec_roundtrip_plain_data` / `golden_codec_sample` sample: ints, an enum, `Option`, a
/// fixed array, and finite f32/f64 (0011's `Action`/`Entity`/`Player`/`Global` bound: no `Vec`,
/// `String` or `Box`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Sample {
    id: u32,
    offset: i32,
    kind: Kind,
    note: Option<u16>,
    grid: [u8; 3],
    x: f32,
    y: f64,
}

fn sample() -> Sample {
    Sample {
        id: 7,
        offset: -12,
        kind: Kind::Moving { dx: 3, dy: -4 },
        note: Some(9),
        grid: [1, 2, 3],
        x: 1.5,
        y: -2.25,
    }
}

#[test]
fn codec_roundtrip_plain_data() {
    let value = sample();
    let mut buf = [0u8; 64];
    let n = codec::encode(&value, &mut buf).unwrap();
    let (decoded, rest): (Sample, _) = codec::decode(&buf[..n]).unwrap();
    assert_eq!(decoded, value);
    assert!(rest.is_empty());
    assert_eq!(codec::encoded_len(&value), n);
}

#[test]
fn decode_returns_rest() {
    let mut buf = [0u8; 32];
    let n1 = codec::encode(&7u32, &mut buf[..]).unwrap();
    let mut tail_buf = [0u8; 32];
    let n2 = codec::encode(&99u16, &mut tail_buf).unwrap();
    buf[n1..n1 + n2].copy_from_slice(&tail_buf[..n2]);

    let (v, rest): (u32, _) = codec::decode(&buf[..n1 + n2]).unwrap();
    assert_eq!(v, 7);
    assert_eq!(rest, &tail_buf[..n2]);
}

#[test]
fn hash_value_equals_hash_of_encoded_bytes() {
    let value = sample();
    let mut buf = [0u8; 64];
    let n = codec::encode(&value, &mut buf).unwrap();
    let mut h = Fnv64::new();
    h.write(&buf[..n]);
    assert_eq!(hash::hash_value(&value), h.finish());
}

/// Both quiet-NaN signs, a payload NaN, a signalling NaN, +-0 and +-inf, f32 and f64. NaN inputs
/// are built with `from_bits` (never `to_bits`, which 0002 §2 bans on a value that could be NaN);
/// expected outputs are literal bit patterns, so this test never reads a float's bits either.
#[test]
fn canon_bits_table() {
    // f32
    assert_eq!(
        codec::canon_f32_bits(f32::from_bits(0x7fc0_0000)),
        0x7fc0_0000
    ); // quiet NaN
    assert_eq!(
        codec::canon_f32_bits(f32::from_bits(0xffc0_0000)),
        0x7fc0_0000
    ); // quiet NaN, negative sign
    assert_eq!(
        codec::canon_f32_bits(f32::from_bits(0x7fc0_1234)),
        0x7fc0_0000
    ); // payload NaN
    assert_eq!(
        codec::canon_f32_bits(f32::from_bits(0x7f80_0001)),
        0x7fc0_0000
    ); // signalling NaN
    assert_eq!(codec::canon_f32_bits(0.0f32), 0x0000_0000);
    assert_eq!(codec::canon_f32_bits(-0.0f32), 0x8000_0000);
    assert_eq!(codec::canon_f32_bits(f32::INFINITY), 0x7f80_0000);
    assert_eq!(codec::canon_f32_bits(f32::NEG_INFINITY), 0xff80_0000);
    // f64
    assert_eq!(
        codec::canon_f64_bits(f64::from_bits(0x7ff8_0000_0000_0000)),
        0x7ff8_0000_0000_0000
    );
    assert_eq!(
        codec::canon_f64_bits(f64::from_bits(0xfff8_0000_0000_0000)),
        0x7ff8_0000_0000_0000
    );
    assert_eq!(
        codec::canon_f64_bits(f64::from_bits(0x7ff8_1234_0000_0000)),
        0x7ff8_0000_0000_0000
    );
    assert_eq!(
        codec::canon_f64_bits(f64::from_bits(0x7ff0_0000_0000_0001)),
        0x7ff8_0000_0000_0000
    );
    assert_eq!(codec::canon_f64_bits(0.0f64), 0x0000_0000_0000_0000);
    assert_eq!(codec::canon_f64_bits(-0.0f64), 0x8000_0000_0000_0000);
    assert_eq!(codec::canon_f64_bits(f64::INFINITY), 0x7ff0_0000_0000_0000);
    assert_eq!(
        codec::canon_f64_bits(f64::NEG_INFINITY),
        0xfff0_0000_0000_0000
    );
}

// `encode`'s strict flag is `cfg!(debug_assertions)` (Planning decisions 3): under the dev/test
// profile this repo always builds with, only `codec_nan_debug_asserts` runs today;
// `codec_nan_release_canonical` is exercised once M36 runs the suite on the release profile.

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "non-finite")]
fn codec_nan_debug_asserts() {
    let mut buf = [0u8; 8];
    let _ = codec::encode(&f32::NAN, &mut buf);
}

#[cfg(not(debug_assertions))]
#[test]
fn codec_nan_release_canonical() {
    let mut buf = [0u8; 8];
    let n = codec::encode(&f32::from_bits(0xffc0_1234), &mut buf).unwrap();
    assert_eq!(&buf[..n], &0x7fc0_0000u32.to_le_bytes());
}

#[test]
fn decode_canonical_rejects_nan_payload() {
    // Raw postcard bytes for a non-canonical NaN f32 (4 little-endian bytes, no varint).
    let bytes = 0x7fc0_1234u32.to_le_bytes();
    assert_eq!(
        codec::decode_canonical::<f32>(&bytes),
        Err(CodecError::NonCanonical)
    );
}

#[test]
fn decode_canonical_rejects_overlong_varint() {
    // u64 0, canonically one byte [0x00]; here padded with an extra continuation byte. Postcard's
    // decoder accepts it (it does not police canonicality), so only the re-encode-and-compare
    // step catches it.
    let bytes = [0x80u8, 0x00u8];
    assert_eq!(
        codec::decode_canonical::<u64>(&bytes),
        Err(CodecError::NonCanonical)
    );
}

#[test]
fn decode_canonical_rejects_trailing() {
    let mut buf = [0u8; 8];
    let n = codec::encode(&7u32, &mut buf).unwrap();
    let mut with_trailing = buf[..n].to_vec();
    with_trailing.push(0xff);
    assert_eq!(
        codec::decode_canonical::<u32>(&with_trailing),
        Err(CodecError::Trailing)
    );
}

#[test]
fn decode_canonical_accepts_canonical_bytes() {
    let value = sample();
    let mut buf = [0u8; 64];
    let n = codec::encode(&value, &mut buf).unwrap();
    assert_eq!(codec::decode_canonical::<Sample>(&buf[..n]), Ok(value));
}

#[test]
fn golden_codec_sample() {
    let value = sample();
    let mut buf = [0u8; 64];
    let n = codec::encode(&value, &mut buf).unwrap();
    engine::assert_golden_bytes!("codec_sample", &buf[..n]);
    engine::assert_golden_hash!("codec_sample_hash", hash::hash_value(&value));
}
