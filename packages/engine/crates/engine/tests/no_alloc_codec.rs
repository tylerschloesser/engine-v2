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

fn live() -> isize {
    engine::abi::arena::thread_live_bytes()
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

/// The instrument itself (docs/plan/30c-ci-reds-after-m30.md, red A): every `no_alloc_*` binary
/// measures `thread_live_bytes()`, which counts the calling thread only. Another thread's
/// allocation landing inside the window (on CI: libtest's main thread, which keeps allocating
/// right after it spawns the test thread and, starved, lands in the first window) moves the
/// process-wide `live_bytes()` but not the measurement, while an allocation on the measuring
/// thread still does.
#[test]
fn instrument_counts_the_measuring_thread_only() {
    use engine::abi::arena::live_bytes;
    use std::sync::atomic::{AtomicIsize, AtomicU8, Ordering::SeqCst};
    static STAGE: AtomicU8 = AtomicU8::new(0);
    static OTHER_DELTA: AtomicIsize = AtomicIsize::new(0);

    let other = std::thread::spawn(|| {
        STAGE.store(1, SeqCst); // past thread start-up, whose own frees would blur the check
        while STAGE.load(SeqCst) != 2 {
            std::thread::yield_now();
        }
        // Held past the measurement, like the harness's own bookkeeping.
        let before = live();
        std::mem::forget(Vec::<u8>::with_capacity(900));
        OTHER_DELTA.store(live() - before, SeqCst);
        STAGE.store(3, SeqCst);
    });
    while STAGE.load(SeqCst) != 1 {
        std::thread::yield_now();
    }

    let (thread_before, process_before) = (live(), live_bytes());
    STAGE.store(2, SeqCst);
    while STAGE.load(SeqCst) != 3 {
        std::thread::yield_now();
    }
    let (thread_after, process_after) = (live(), live_bytes());
    assert_eq!(
        OTHER_DELTA.load(SeqCst),
        900,
        "the other thread counts its own allocation"
    );
    assert!(
        process_after > process_before,
        "the other thread's allocation shows in the process-wide count"
    );
    assert_eq!(
        thread_after, thread_before,
        "another thread's allocation moved the measuring thread's count"
    );

    let before = live();
    std::mem::forget(Vec::<u8>::with_capacity(9));
    assert_eq!(
        live() - before,
        9,
        "an allocation on this thread must count"
    );

    other.join().unwrap();
}
