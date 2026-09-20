//! Own test binary (docs/plan/05-codec-and-state-hash.md Tests added: `no_alloc_codec`), so the
//! counting `#[global_allocator]` sees only this file's work: `codec::encode`, `codec::decode` and
//! `hash::hash_value` of a plain-data value leave `abi::arena::live_bytes()` unchanged and
//! allocate nothing in between, the native guard the browser zero-GC tests (M04) rely on.

use engine::abi::Arena;
use engine::{codec, hash};

#[global_allocator]
static ALLOCATOR: Arena = Arena;

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Sample {
    a: u32,
    b: i32,
    c: Option<u16>,
    d: [f32; 2],
    e: bool,
}

fn sample() -> Sample {
    Sample {
        a: 7,
        b: -3,
        c: Some(9),
        d: [1.5, -2.25],
        e: true,
    }
}

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[test]
fn no_alloc_codec() {
    let value = sample();
    let mut buf = [0u8; 64];

    let before = live();
    let n = codec::encode(&value, &mut buf).unwrap();
    assert_eq!(live(), before, "codec::encode allocated");

    let before = live();
    let (decoded, _rest): (Sample, _) = codec::decode(&buf[..n]).unwrap();
    assert_eq!(live(), before, "codec::decode allocated");
    assert_eq!(decoded.a, value.a);

    let before = live();
    let h = hash::hash_value(&value);
    assert_eq!(live(), before, "hash::hash_value allocated");
    assert_ne!(h, 0);
}
