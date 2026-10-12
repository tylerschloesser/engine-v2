//! M44 (docs/decisions/0076-transport-lines-engine-game-split.md §1): `Output::Merge` (side-load)
//! and `Output::Fork` (alternation by a per-line toggle) in `advance`, the update order over
//! two-target outputs, their codec, and the surgery redirects. Every boundary is pinned at speeds
//! 24, 72 and 96 (72 and 96 cross two items per tick), with literal positions (0069 §2): a merge
//! lands at `clamp(at - o, 0, len - 1)` iff `SPACING` is clear on both sides there; a fork tries
//! its preferred target's plain hand-off landing `len - o`, then the other, else the item waits;
//! the toggle flips only on a preferred delivery.

use engine::bytes::{ByteReader, SliceSink};
use engine::codec::CodecError;
use engine::hash::Fnv64;
use engine::transport::{
    Item, LineId, Output, Transport, TransportError, TransportRead, TransportWrite,
};

const SPEEDS: [u16; 3] = [24, 72, 96];

fn items(t: &Transport, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    t.items_in(l, &mut |i, p| v.push((i.0, p))).unwrap();
    v
}

fn positions(t: &Transport, l: LineId) -> Vec<u32> {
    items(t, l).into_iter().map(|(_, p)| p).collect()
}

fn put(t: &mut Transport, l: LineId, item: u16, at: &[u32]) {
    for &p in at {
        t.insert_at(l, p, Item(item)).unwrap();
    }
}

fn encode(t: &Transport) -> Vec<u8> {
    let mut buf = vec![0u8; 1 << 16];
    let mut sink = SliceSink::new(&mut buf);
    t.write_canonical(&mut sink);
    let n = sink.finish().expect("fits");
    buf.truncate(n);
    buf
}

fn decode(bytes: &[u8]) -> Result<Transport, CodecError> {
    let mut t = Transport::new(64, 4096);
    t.read_canonical(&mut ByteReader::new(bytes))?;
    Ok(t)
}

fn order(t: &mut Transport) -> Vec<u32> {
    let mut v = Vec::new();
    t.order_into(&mut v);
    v.into_iter().map(|l| l.0).collect()
}

/// A merge target `T` (512 long, speed 1, dead end: its items at 0, 64 and 128 never move, one at
/// 300 moves to 299 before the feeder crosses) and a feeder `F` (speed `s`, item 9 at `from`).
fn merge_world(s: u16, at: u32, t_items: &[u32], from: u32) -> (Transport, LineId, LineId) {
    let mut t = Transport::new(8, 64);
    let tgt = t.create(512, 1).unwrap();
    let f = t.create(512, s).unwrap();
    t.set_out(f, Output::Merge { line: tgt, at }).unwrap();
    put(&mut t, tgt, 1, t_items);
    put(&mut t, f, 9, &[from]);
    (t, tgt, f)
}

/// The landing `at - o` (clamped) and the room rule at every boundary. `F`'s item at 0 crosses with
/// overshoot `o = s`, so `at = L + s` aims at `L`.
#[test]
fn merge_landing_and_room_rule() {
    for s in SPEEDS {
        let s32 = u32::from(s);
        // Clamped to 0, and to `len - 1`.
        let (mut t, tgt, f) = merge_world(s, 10, &[], 0);
        t.advance();
        assert_eq!(items(&t, tgt), vec![(9, 0)], "speed {s}: clamped to 0");
        assert_eq!(items(&t, f), vec![], "speed {s}: transferred");
        let (mut t, tgt, _) = merge_world(s, 10_000, &[], 0);
        t.advance();
        assert_eq!(
            positions(&t, tgt),
            vec![511],
            "speed {s}: clamped to len - 1"
        );
        // Exact: from 5 the overshoot is `s - 5`, so `at = 200 + s` lands at 205.
        let (mut t, tgt, _) = merge_world(s, 200 + s32, &[], 5);
        t.advance();
        assert_eq!(positions(&t, tgt), vec![205], "speed {s}: at - o");
        // Room: the target holds 0, 64, 128 and 299 when the feeder crosses.
        let blocked = [0, 64, 128, 300];
        for (land, ok, why) in [
            (128, false, "exactly occupied"),
            (191, false, "clear behind only (63 from 128)"),
            (192, true, "exactly SPACING from 128"),
            (235, true, "exactly SPACING from 299"),
            (236, false, "clear in front only (63 from 299)"),
        ] {
            let (mut t, tgt, f) = merge_world(s, land + s32, &blocked, 0);
            t.advance();
            if ok {
                let mut want = vec![0, 64, 128, land, 299];
                want.sort_unstable();
                assert_eq!(positions(&t, tgt), want, "speed {s}: landing {land}: {why}");
                assert_eq!(items(&t, f), vec![], "speed {s}: landing {land}");
            } else {
                assert_eq!(
                    positions(&t, tgt),
                    vec![0, 64, 128, 299],
                    "speed {s}: landing {land}: {why}"
                );
                assert_eq!(
                    items(&t, f),
                    vec![(9, 0)],
                    "speed {s}: landing {land}: the item waits at 0"
                );
            }
        }
    }
}

/// A refused item waits at position 0 and the stream behind it squashes by the ordinary rule; once
/// the target has room the waiting item transfers and the next one is free to move.
#[test]
fn merge_waits_and_squashes() {
    for (s, ticks) in [
        // `F` positions after ticks 1 and 2 (target blocked), then after tick 3 (unblocked).
        (24u16, [[0, 76, 276], [0, 64, 252], [40, 228, 0]]),
        (96, [[0, 64, 204], [0, 64, 128], [0, 64, 128]]),
    ] {
        let mut t = Transport::new(8, 64);
        // A packed dead end: 0, 64, 128, 192 never move; a landing in [4, 76] has no room.
        let tgt = t.create(256, 8).unwrap();
        put(&mut t, tgt, 1, &[0, 64, 128, 192]);
        let f = t.create(1024, s).unwrap();
        t.set_out(f, Output::Merge { line: tgt, at: 100 }).unwrap();
        t.insert_at(f, 0, Item(7)).unwrap();
        t.insert_at(f, 100, Item(8)).unwrap();
        t.insert_at(f, 300, Item(9)).unwrap();
        for (k, want) in ticks.iter().take(2).enumerate() {
            t.advance();
            assert_eq!(positions(&t, f), want.to_vec(), "speed {s}: tick {}", k + 1);
            assert_eq!(positions(&t, tgt), vec![0, 64, 128, 192], "speed {s}");
        }
        let packed = if s == 24 { 64 } else { 128 };
        assert_eq!(
            t.jam(f).unwrap(),
            Some(packed),
            "speed {s}: the front is held"
        );
        // Room around 100 - o: 64 and 128 leave (192 then moves to 184 on the target's advance).
        t.remove_at(tgt, 64).unwrap();
        t.remove_at(tgt, 128).unwrap();
        t.advance();
        if s == 24 {
            assert_eq!(items(&t, tgt), vec![(1, 0), (7, 76), (1, 184)], "speed 24");
            assert_eq!(
                positions(&t, f),
                ticks[2][..2].to_vec(),
                "speed 24: the follower is free once the front left"
            );
        } else {
            // o = 96: landing 4 is 4 from the item at 0: still refused.
            assert_eq!(positions(&t, tgt), vec![0, 184], "speed 96");
            assert_eq!(
                positions(&t, f),
                ticks[2].to_vec(),
                "speed 96: still waiting"
            );
        }
    }
}

/// Speeds 72 and 96 cross two items in one tick, each tried against the target as the previous
/// landing left it; the item behind a transferred one is not held by it.
#[test]
fn merge_big_step_two_items() {
    for (s, a, b, rest) in [(72u16, 428, 492, 56), (96, 404, 468, 32)] {
        let mut t = Transport::new(8, 64);
        let tgt = t.create(1024, 8).unwrap();
        let f = t.create(512, s).unwrap();
        t.set_out(f, Output::Merge { line: tgt, at: 500 }).unwrap();
        for (k, p) in [0, 64, 128].into_iter().enumerate() {
            t.insert_at(f, p, Item(k as u16 + 1)).unwrap();
        }
        t.advance();
        assert_eq!(
            items(&t, tgt),
            vec![(1, a), (2, b)],
            "speed {s}: two landings"
        );
        assert_eq!(items(&t, f), vec![(3, rest)], "speed {s}");
        // The first lands clamped at 0; the second (landing `40 - o2`, under 64 from it) waits.
        let mut t = Transport::new(8, 64);
        let tgt = t.create(1024, 8).unwrap();
        let f = t.create(512, s).unwrap();
        t.set_out(f, Output::Merge { line: tgt, at: 40 }).unwrap();
        for (k, p) in [0, 64, 128].into_iter().enumerate() {
            t.insert_at(f, p, Item(k as u16 + 1)).unwrap();
        }
        t.advance();
        assert_eq!(
            items(&t, tgt),
            vec![(1, 0)],
            "speed {s}: the second is refused"
        );
        assert_eq!(
            items(&t, f),
            vec![(2, 0), (3, 64)],
            "speed {s}: it waits at 0"
        );
    }
    // A squashed pair (0 and 56 after a rescale) at speed 24: the follower moves the full 24 to
    // 32; behind a `Next` hand-off it would stop at 40 (`-24 + SPACING`).
    let mut t = Transport::new(8, 64);
    let tgt = t.create(1024, 8).unwrap();
    let f = t.create(512, 24).unwrap();
    t.set_out(f, Output::Merge { line: tgt, at: 500 }).unwrap();
    put(&mut t, f, 1, &[0, 64]);
    t.rescale(f, 448).unwrap();
    assert_eq!(positions(&t, f), vec![0, 56]);
    t.advance();
    assert_eq!(positions(&t, tgt), vec![476]);
    assert_eq!(
        positions(&t, f),
        vec![32],
        "not held by the transferred item"
    );
}

/// A fork world: `F` (speed `s`, 1024 long) forks onto `A` and `B`, each `len` long at `speed`.
fn fork_world(s: u16, a: (u32, u16), b: (u32, u16)) -> (Transport, LineId, LineId, LineId) {
    let mut t = Transport::new(8, 256);
    let la = t.create(a.0, a.1).unwrap();
    let lb = t.create(b.0, b.1).unwrap();
    let f = t.create(1024, s).unwrap();
    t.set_out(f, Output::Fork { a: la, b: lb }).unwrap();
    (t, la, lb, f)
}

fn kinds(t: &Transport, l: LineId) -> Vec<u16> {
    items(t, l).into_iter().map(|(i, _)| i).collect()
}

/// Packed from the front of a 256-long dead end: no plain hand-off landing (`256 - o`) has room.
const JAMMED: [u32; 4] = [0, 64, 128, 192];
/// Fast open targets: 4096 long at speed 200, so every landing has room.
const OPEN: (u32, u16) = (4096, 200);

/// Six items (kinds 1-6, packed) alternate `a`, `b`, ...; with `a` jammed every item is diverted
/// to `b` and the toggle holds (`false`: still preferring `a`); once `a` has room the next item
/// goes there and the toggle flips, and the one after goes to `b` and flips it back.
#[test]
fn fork_alternates_and_flips_on_preferred_only() {
    for s in SPEEDS {
        let (mut t, la, lb, f) = fork_world(s, OPEN, OPEN);
        for k in 0..6u16 {
            t.insert_at(f, 64 * u32::from(k), Item(k + 1)).unwrap();
        }
        for _ in 0..40 {
            t.advance();
            let delivered = t.count(la).unwrap() + t.count(lb).unwrap();
            assert_eq!(
                t.toggle(f).unwrap(),
                delivered % 2 == 1,
                "speed {s}: the toggle names the side after the last one"
            );
        }
        assert_eq!(kinds(&t, la), vec![1, 3, 5], "speed {s}: a");
        assert_eq!(kinds(&t, lb), vec![2, 4, 6], "speed {s}: b");

        let (mut t, la, lb, f) = fork_world(s, (256, 8), OPEN);
        put(&mut t, la, 9, &JAMMED);
        for k in 0..3u16 {
            t.insert_at(f, 64 * u32::from(k), Item(k + 1)).unwrap();
        }
        for tick in 0..20 {
            t.advance();
            assert!(
                !t.toggle(f).unwrap(),
                "speed {s}: tick {tick}: a diverted item never flips the toggle"
            );
        }
        assert_eq!(kinds(&t, lb), vec![1, 2, 3], "speed {s}: all diverted to b");
        // `a` gets room for one landing (its tail at 64: `256 - o >= 128`).
        t.remove_at(la, 128).unwrap();
        t.remove_at(la, 192).unwrap();
        t.insert_at(f, 0, Item(4)).unwrap();
        t.insert_at(f, 64, Item(5)).unwrap();
        for _ in 0..20 {
            t.advance();
        }
        assert_eq!(
            kinds(&t, la),
            vec![9, 9, 4],
            "speed {s}: preferred a once it has room"
        );
        assert_eq!(kinds(&t, lb), vec![1, 2, 3, 5], "speed {s}: then b");
        assert!(!t.toggle(f).unwrap(), "speed {s}: flipped twice");
    }
}

/// With the preferred side (`b`, after one delivery to `a`) jammed, every later item goes to `a`
/// and the toggle stays on `b`.
#[test]
fn fork_blocked_side_routes_to_other() {
    for s in SPEEDS {
        let (mut t, la, lb, f) = fork_world(s, OPEN, (256, 8));
        put(&mut t, lb, 9, &JAMMED);
        for k in 0..4u16 {
            t.insert_at(f, 64 * u32::from(k), Item(k + 1)).unwrap();
        }
        t.advance();
        assert!(
            t.toggle(f).unwrap(),
            "speed {s}: the first went to a, b is preferred"
        );
        for _ in 0..20 {
            t.advance();
            assert!(
                t.toggle(f).unwrap(),
                "speed {s}: diverted items hold the toggle"
            );
        }
        assert_eq!(kinds(&t, la), vec![1, 2, 3, 4], "speed {s}");
        assert_eq!(positions(&t, lb), JAMMED.to_vec(), "speed {s}");
    }
}

/// Both sides jammed: the item waits at 0, the stream squashes behind it, the toggle holds; when
/// the non-preferred side gets room the item goes there and the toggle still holds.
#[test]
fn fork_both_blocked_waits() {
    // At 96 the next item crosses in the same tick and also finds room on `b` (`160 + 64 <= 224`).
    for (s, behind, to_b) in [
        (24u16, [[76, 276], [64, 252]], 1),
        (96, [[64, 204], [64, 128]], 2),
    ] {
        let (mut t, la, lb, f) = fork_world(s, (256, 8), (256, 8));
        put(&mut t, la, 9, &JAMMED);
        put(&mut t, lb, 9, &JAMMED);
        put(&mut t, f, 1, &[0, 100, 300]);
        for want in behind {
            t.advance();
            assert_eq!(
                positions(&t, f),
                [&[0][..], &want[..]].concat(),
                "speed {s}"
            );
            assert!(!t.toggle(f).unwrap(), "speed {s}: nothing delivered");
        }
        t.remove_at(lb, 128).unwrap();
        t.remove_at(lb, 192).unwrap();
        t.advance();
        assert_eq!(
            t.count(lb).unwrap(),
            2 + to_b,
            "speed {s}: the waiting item went to b"
        );
        assert_eq!(t.count(la).unwrap(), 4, "speed {s}");
        assert!(
            !t.toggle(f).unwrap(),
            "speed {s}: b was not preferred: no flip"
        );
    }
}

/// Two items cross in one tick: the first to the preferred side (flip), the second to the newly
/// preferred one (flip back); with `b` jammed both go to `a`, `SPACING` apart.
#[test]
fn fork_big_step() {
    for (s, a, b, rest) in [(72u16, 440, 504, 56), (96, 416, 480, 32)] {
        let (mut t, la, lb, f) = fork_world(s, (512, 8), (512, 8));
        for (k, p) in [0, 64, 128].into_iter().enumerate() {
            t.insert_at(f, p, Item(k as u16 + 1)).unwrap();
        }
        t.advance();
        assert_eq!(items(&t, la), vec![(1, a)], "speed {s}");
        assert_eq!(items(&t, lb), vec![(2, b)], "speed {s}");
        assert_eq!(items(&t, f), vec![(3, rest)], "speed {s}");
        assert!(
            !t.toggle(f).unwrap(),
            "speed {s}: flipped twice in one tick"
        );

        let (mut t, la, lb, f) = fork_world(s, (512, 8), (256, 8));
        put(&mut t, lb, 9, &JAMMED);
        for (k, p) in [0, 64, 128].into_iter().enumerate() {
            t.insert_at(f, p, Item(k as u16 + 1)).unwrap();
        }
        t.advance();
        assert_eq!(items(&t, la), vec![(1, a), (2, b)], "speed {s}: both to a");
        assert!(t.toggle(f).unwrap(), "speed {s}: one preferred delivery");
    }
}

/// Speeds 24, 72 and 96 through a plain `Next` too: 72 and 96 hand off two items per tick.
#[test]
fn next_big_step_hands_off_two_items() {
    for (s, landed, rest) in [
        (24u16, vec![488], vec![40, 104]),
        (72, vec![440, 504], vec![56]),
        (96, vec![416, 480], vec![32]),
    ] {
        let mut t = Transport::new(8, 64);
        let tgt = t.create(512, 8).unwrap();
        let f = t.create(512, s).unwrap();
        t.set_out(f, Output::Next(tgt)).unwrap();
        put(&mut t, f, 1, &[0, 64, 128]);
        t.advance();
        assert_eq!(positions(&t, tgt), landed, "speed {s}");
        assert_eq!(positions(&t, f), rest, "speed {s}");
    }
}

/// A fork advances after both its targets, a merge after its target (literal orders: roots in
/// ascending id, `a` before `b`).
#[test]
fn order_fork_feeds_both() {
    let mut t = Transport::new(8, 8);
    for _ in 0..5 {
        t.create(256, 8).unwrap();
    }
    t.set_out(
        LineId(1),
        Output::Fork {
            a: LineId(3),
            b: LineId(4),
        },
    )
    .unwrap();
    t.set_out(
        LineId(2),
        Output::Merge {
            line: LineId(5),
            at: 100,
        },
    )
    .unwrap();
    assert_eq!(
        order(&mut t),
        vec![3, 4, 1, 5, 2],
        "both targets before the fork"
    );
    t.set_out(
        LineId(1),
        Output::Fork {
            a: LineId(4),
            b: LineId(3),
        },
    )
    .unwrap();
    assert_eq!(order(&mut t), vec![4, 3, 1, 5, 2]);
}

/// A strongly connected set with a fork in it: 1 -> 2, 2 forks to 1 and 3, 3 -> 4 -> 2. Cut at 1
/// (lowest), then depth-first post-order from it: 4, 3, 2. The cut links are 1 -> 2 (the lowest
/// id's output) and 4 -> 2 (a back edge); 2 -> 1 lands on line 1, which has already advanced.
/// Items circulate without loss and the store round-trips.
#[test]
fn order_cycle_with_a_fork() {
    let mut t = Transport::new(8, 64);
    for _ in 0..4 {
        t.create(512, 24).unwrap();
    }
    let l = LineId;
    t.set_out(l(1), Output::Next(l(2))).unwrap();
    t.set_out(l(2), Output::Fork { a: l(1), b: l(3) }).unwrap();
    t.set_out(l(3), Output::Next(l(4))).unwrap();
    t.set_out(l(4), Output::Next(l(2))).unwrap();
    assert_eq!(order(&mut t), vec![1, 4, 3, 2]);
    for (k, line) in [1, 2, 3, 4].into_iter().enumerate() {
        t.insert_at(l(line), 64 * k as u32, Item(k as u16 + 1))
            .unwrap();
    }
    let mut toggles = 0;
    for _ in 0..300 {
        let before = t.toggle(l(2)).unwrap();
        t.advance();
        toggles += u32::from(t.toggle(l(2)).unwrap() != before);
        let n: u32 = (1..=4).map(|k| t.count(l(k)).unwrap()).sum();
        assert_eq!(n, 4, "nothing lost");
    }
    assert!(
        toggles >= 10,
        "the fork in the loop alternated only {toggles} times"
    );
    let back = decode(&encode(&t)).unwrap();
    assert_eq!(encode(&back), encode(&t));
}

/// The toggle is state: encoded with the fork (its byte right after `b`), so a flipped toggle
/// changes the bytes and the hash, and decodes as it was; a byte other than 0 or 1 is malformed.
/// A merge round-trips with its `at`; malformed forks and merges are refused.
#[test]
fn codec_covers_toggle() {
    let (mut t, la, lb, f) = fork_world(24, OPEN, OPEN);
    let m = t.create(512, 24).unwrap();
    t.set_out(m, Output::Merge { line: la, at: 300 }).unwrap();
    t.insert_at(f, 0, Item(1)).unwrap();
    t.advance();
    assert!(t.toggle(f).unwrap(), "one delivery to a");
    let bytes = encode(&t);
    let back = decode(&bytes).unwrap();
    assert!(back.toggle(f).unwrap(), "the toggle round-trips");
    assert_eq!(back.out(m).unwrap(), Output::Merge { line: la, at: 300 });
    assert_eq!(encode(&back), bytes);
    // Line 3 (`f`) is the third record: lines 1 and 2 are 27 bytes each (no items, no segments,
    // `A` holds the delivered item: +8); then id, len, speed, tag, a, b: the toggle at +19.
    let at = 4 + (27 + 8) + 27 + 19;
    assert_eq!(
        &bytes[at - 8..at],
        &[la.0.to_le_bytes(), lb.0.to_le_bytes()].concat()[..]
    );
    assert_eq!(bytes[at], 1);
    let mut flipped = bytes.clone();
    flipped[at] = 0;
    let hash = |b: &[u8]| {
        let mut h = Fnv64::new();
        h.write(b);
        h.finish()
    };
    assert_ne!(
        hash(&flipped),
        hash(&bytes),
        "a flipped toggle changes the hash"
    );
    assert!(!decode(&flipped).unwrap().toggle(f).unwrap());
    flipped[at] = 2;
    assert_eq!(
        decode(&flipped).err(),
        Some(CodecError::Malformed),
        "toggle 2"
    );
    // A fork with a == b, and a merge into the line itself.
    let mut bad = bytes.clone();
    bad[at - 4..at].copy_from_slice(&la.0.to_le_bytes());
    assert_eq!(decode(&bad).err(), Some(CodecError::Malformed), "a == b");
    let mut bad = bytes.clone();
    bad[at - 8..at - 4].copy_from_slice(&f.0.to_le_bytes());
    assert_eq!(
        decode(&bad).err(),
        Some(CodecError::Malformed),
        "a fork into itself"
    );
    // A fork target shorter than the feeder's speed (0079 §8).
    let mut u = Transport::new(8, 8);
    let short = u.create(100, 8).unwrap();
    let long = u.create(1000, 8).unwrap();
    let fast = u.create(1000, 99).unwrap();
    u.set_out(fast, Output::Fork { a: long, b: short }).unwrap();
    u.set_speed(fast, 100).unwrap();
    let mut b = encode(&u);
    // Lines 1 and 2 are 27 bytes each; line 3's speed sits after its id and len.
    let speed_at = 4 + 27 * 2 + 8;
    b[speed_at..speed_at + 2].copy_from_slice(&101u16.to_le_bytes());
    assert_eq!(
        decode(&b).err(),
        Some(CodecError::Malformed),
        "short fork target"
    );
}

/// `set_out` and `set_speed` refusals for the two outputs.
#[test]
fn outputs_refusals() {
    let mut t = Transport::new(8, 8);
    let a = t.create(100, 8).unwrap();
    let b = t.create(1000, 8).unwrap();
    let f = t.create(1000, 200).unwrap();
    let un = Err(TransportError::Unsupported);
    assert_eq!(t.set_out(f, Output::Merge { line: f, at: 0 }), un);
    assert_eq!(t.set_out(f, Output::Fork { a: b, b }), un);
    assert_eq!(t.set_out(f, Output::Fork { a: f, b }), un);
    assert_eq!(
        t.set_out(
            f,
            Output::Fork {
                a: b,
                b: LineId(99)
            }
        ),
        Err(TransportError::NoLine)
    );
    assert_eq!(
        t.set_out(f, Output::Fork { a: b, b: a }),
        Err(TransportError::BadSpeed),
        "a fork target shorter than the feeder's speed"
    );
    // A merge landing is clamped, so a short merge target is fine.
    assert_eq!(t.set_out(f, Output::Merge { line: a, at: 5_000 }), Ok(()));
    t.set_speed(f, 8).unwrap();
    t.set_out(f, Output::Fork { a: b, b: a }).unwrap();
    assert_eq!(t.set_speed(f, 101), Err(TransportError::BadSpeed));
    assert_eq!(t.set_speed(f, 100), Ok(()));
    // A changed output clears the toggle.
    t.insert_at(f, 0, Item(1)).unwrap();
    for _ in 0..3 {
        t.advance();
    }
    assert!(t.toggle(f).unwrap());
    t.set_out(f, Output::Fork { a, b }).unwrap();
    assert!(!t.toggle(f).unwrap());
}

/// M44 review (finding 4): `set_out` with the line's current output is a no-op: the toggle is
/// kept, the order is not recomputed and the line is not touched (a game re-applying a region's
/// outputs must not bias its forks to `a`).
#[test]
fn outputs_same_set_out_is_a_no_op() {
    let (mut t, la, lb, f) = fork_world(24, OPEN, OPEN);
    t.insert_at(f, 0, Item(1)).unwrap();
    for _ in 0..3 {
        t.advance();
    }
    assert!(t.toggle(f).unwrap(), "one delivery to a");
    assert_eq!(t.count(f).unwrap(), 0);
    let recomputes = t.order_recomputes();
    t.set_out(f, Output::Fork { a: la, b: lb }).unwrap();
    assert!(t.toggle(f).unwrap(), "the same fork keeps its toggle");
    t.advance();
    assert_eq!(
        t.order_recomputes(),
        recomputes,
        "the order was not recomputed"
    );
    assert_eq!(t.touched(f), Ok(false), "the line was not touched");
    // A real change still clears it, and recomputes the order once.
    t.set_out(f, Output::Fork { a: lb, b: la }).unwrap();
    assert!(!t.toggle(f).unwrap());
    t.advance();
    assert_eq!(t.order_recomputes(), recomputes + 1);
    assert_eq!(t.touched(f), Ok(true));
}

/// The surgery redirects (`surgery.rs` module doc): a destroyed fork target leaves `Next(other)`,
/// a destroyed merge target `DeadEnd`; a split moves a merge to the back part only when its entry
/// point is behind the cut; a join adds the front's length to a merge's `at` and collapses a fork
/// whose targets became one line; a join whose front side-loads onto the back is refused.
#[test]
fn outputs_follow_surgery() {
    let mut t = Transport::new(16, 64);
    let a = t.create(512, 8).unwrap();
    let b = t.create(512, 8).unwrap();
    let c = t.create(512, 8).unwrap();
    let f = t.create(512, 8).unwrap();
    let m_back = t.create(512, 8).unwrap();
    let m_front = t.create(512, 8).unwrap();
    let n = t.create(512, 8).unwrap();
    t.set_out(f, Output::Fork { a, b }).unwrap();
    t.set_out(m_back, Output::Merge { line: c, at: 300 })
        .unwrap();
    t.set_out(m_front, Output::Merge { line: c, at: 50 })
        .unwrap();
    t.set_out(n, Output::Next(c)).unwrap();
    t.insert_at(f, 0, Item(1)).unwrap();
    t.advance();
    assert!(t.toggle(f).unwrap());
    // Destroy a fork target.
    t.destroy(a, &mut |_| {}).unwrap();
    assert_eq!(t.out(f).unwrap(), Output::Next(b));
    assert!(!t.toggle(f).unwrap(), "a plain hand-off has no toggle");
    // Split the merge target at 200.
    let d = t.split(c, 200).unwrap();
    assert_eq!(t.out(m_back).unwrap(), Output::Merge { line: d, at: 100 });
    assert_eq!(t.out(m_front).unwrap(), Output::Merge { line: c, at: 50 });
    assert_eq!(t.out(n).unwrap(), Output::Next(d));
    // Join it back.
    t.join(c, d).unwrap();
    assert_eq!(t.out(m_back).unwrap(), Output::Merge { line: c, at: 300 });
    assert_eq!(t.out(n).unwrap(), Output::Next(c));
    // A fork onto both halves of a joined pair becomes a plain hand-off.
    let g = t.create(512, 8).unwrap();
    let back = t.split(c, 256).unwrap();
    t.set_out(g, Output::Fork { a: c, b: back }).unwrap();
    t.join(c, back).unwrap();
    assert_eq!(t.out(g).unwrap(), Output::Next(c));
    // A join whose front side-loads onto its back would feed itself.
    let back = t.split(c, 256).unwrap();
    t.set_out(c, Output::Merge { line: back, at: 10 }).unwrap();
    assert_eq!(t.join(c, back), Err(TransportError::Unsupported));
    // Destroy a merge target.
    t.destroy(back, &mut |_| {}).unwrap();
    assert_eq!(t.out(c).unwrap(), Output::DeadEnd);
    assert_eq!(
        t.out(m_back).unwrap(),
        Output::DeadEnd,
        "its entry point was on the back part"
    );
    assert_eq!(t.out(m_front).unwrap(), Output::Merge { line: c, at: 50 });
    let back = decode(&encode(&t)).unwrap();
    assert_eq!(encode(&back), encode(&t));

    // M44 review (finding 3): an entry point exactly at the cut moves to the back part's 0.
    let mut t = Transport::new(16, 64);
    let tgt = t.create(512, 8).unwrap();
    let m = t.create(512, 8).unwrap();
    t.set_out(m, Output::Merge { line: tgt, at: 200 }).unwrap();
    let d = t.split(tgt, 200).unwrap();
    assert_eq!(
        t.out(m).unwrap(),
        Output::Merge { line: d, at: 0 },
        "at == cut"
    );
    t.join(tgt, d).unwrap();
    assert_eq!(t.out(m).unwrap(), Output::Merge { line: tgt, at: 200 });
    // M44 review (finding 2): the entry point follows the target's positions. `extend_front` and
    // `shrink_front` shift it, `rescale` scales it (floor), the back edits leave it, and an entry
    // point that falls off the front leaves a dead end.
    type Step = fn(&mut Transport, LineId) -> Result<(), TransportError>;
    let steps: [(&str, Step, Output); 6] = [
        (
            "extend_front 256",
            |t, l| t.extend_front(l, 256),
            Output::Merge {
                line: LineId(1),
                at: 456,
            },
        ),
        (
            "extend_back 256",
            |t, l| t.extend_back(l, 256),
            Output::Merge {
                line: LineId(1),
                at: 456,
            },
        ),
        (
            "shrink_back 256",
            |t, l| t.shrink_back(l, 256),
            Output::Merge {
                line: LineId(1),
                at: 456,
            },
        ),
        (
            "shrink_front 56",
            |t, l| t.shrink_front(l, 56),
            Output::Merge {
                line: LineId(1),
                at: 400,
            },
        ),
        (
            "rescale 712 -> 534",
            |t, l| t.rescale(l, 534),
            Output::Merge {
                line: LineId(1),
                at: 300,
            },
        ),
        (
            "shrink_front 301",
            |t, l| t.shrink_front(l, 301),
            Output::DeadEnd,
        ),
    ];
    for (what, step, want) in steps {
        step(&mut t, tgt).unwrap();
        assert_eq!(t.out(m).unwrap(), want, "{what}");
    }
    let back = decode(&encode(&t)).unwrap();
    assert_eq!(encode(&back), encode(&t));
}

/// A merge across a cycle's cut (0079 §11 for `Merge`): 1 -> 3 (`Next`), 2 -> 3 (`Merge`), 3 forks
/// to 1 and 2, so 1 and 2 advance before 3 and land on it before it moves. A landing stays where
/// it landed that tick, in front of the cut's back landings (joining them), in the middle of the
/// line, or at its front, and the items behind it are held by it (squash rule).
#[test]
fn merge_across_a_cut_stays_and_holds() {
    let l = LineId;
    // (`at`, line 1's item, line 3's items, line 3 after one tick).
    type Case = (u32, bool, &'static [u32], &'static [(u16, u32)]);
    let cases: [Case; 3] = [
        (800, true, &[500], &[(5, 476), (2, 776), (1, 1000)]),
        (724, false, &[500, 900], &[(5, 476), (2, 700), (5, 876)]),
        (724, false, &[770], &[(2, 700), (5, 764)]),
    ];
    for (at, feed_next, on_target, want) in cases {
        let mut t = Transport::new(8, 64);
        t.create(512, 24).unwrap();
        t.create(512, 24).unwrap();
        t.create(1024, 24).unwrap();
        t.set_out(l(1), Output::Next(l(3))).unwrap();
        t.set_out(l(2), Output::Merge { line: l(3), at }).unwrap();
        t.set_out(l(3), Output::Fork { a: l(1), b: l(2) }).unwrap();
        assert_eq!(order(&mut t), vec![1, 2, 3]);
        if feed_next {
            t.insert_at(l(1), 0, Item(1)).unwrap();
        }
        t.insert_at(l(2), 0, Item(2)).unwrap();
        put(&mut t, l(3), 5, on_target);
        t.advance();
        assert_eq!(items(&t, l(3)), want.to_vec(), "at {at}, {on_target:?}");
        assert_eq!(t.count(l(2)).unwrap(), 0, "at {at}: transferred");
        // The next tick moves everything again, landings included.
        let before = positions(&t, l(3));
        t.advance();
        let after = positions(&t, l(3));
        assert!(
            after.iter().zip(&before).all(|(a, b)| a < b),
            "at {at}: {before:?} -> {after:?}"
        );
        let back = decode(&encode(&t)).unwrap();
        assert_eq!(encode(&back), encode(&t));
    }
}

/// M44 review (finding 6): a merge landing across a cut that sits packed against a same-kind run
/// of the cut's back block merges into it (canonical form): line 1's item lands at 1000 on line 3
/// (not advanced yet), line 2's merge lands at 936, exactly `SPACING` ahead, same kind. One run,
/// and the store encodes exactly like one where the same items were placed with `insert_at`.
#[test]
fn merge_across_a_cut_joins_a_packed_block() {
    let l = LineId;
    let build = || {
        let mut t = Transport::new(8, 64);
        t.create(512, 24).unwrap();
        t.create(512, 24).unwrap();
        t.create(1024, 24).unwrap();
        t.set_out(l(1), Output::Next(l(3))).unwrap();
        t.set_out(
            l(2),
            Output::Merge {
                line: l(3),
                at: 960,
            },
        )
        .unwrap();
        t.set_out(l(3), Output::Fork { a: l(1), b: l(2) }).unwrap();
        t
    };
    let mut t = build();
    t.insert_at(l(1), 0, Item(1)).unwrap();
    t.insert_at(l(2), 0, Item(1)).unwrap();
    t.insert_at(l(3), 500, Item(5)).unwrap();
    t.advance();
    assert_eq!(items(&t, l(3)), vec![(5, 476), (1, 936), (1, 1000)]);
    let mut runs = Vec::new();
    t.runs_in(l(3), &mut |i, n, g| runs.push((i.0, n, g)))
        .unwrap();
    assert_eq!(
        runs,
        vec![(5, 1, 476), (1, 2, 396)],
        "one run for the packed pair"
    );
    let mut fresh = build();
    for (item, pos) in [(5, 476), (1, 936), (1, 1000)] {
        fresh.insert_at(l(3), pos, Item(item)).unwrap();
    }
    assert_eq!(encode(&t), encode(&fresh), "canonical: as if registered");
}

/// M44 review (finding 1), a measurement and not a gate: M45's input for the per-merge cursor
/// decision (`tick.beltsLargeMs`). A 1,000-tile main line (256,000 positions, speed 24) packed
/// with 4,000 items of alternating kinds (4,000 runs) and held at a dead end, with 50 side-loads
/// blocked near its back (entry points in its last 50 tiles, each feeder's front item waiting at
/// 0): every tick each blocked merge re-checks its room, walking the main line from its nearer
/// end (`Transport::locate`). Prints the median `advance` time over 200 ticks in release; a
/// debug build re-runs itself as `cargo test --release -p engine --features testing --test main
/// -- --exact transport_outputs::slow_blocked_sideloads_cost --nocapture`.
#[test]
fn slow_blocked_sideloads_cost() {
    const NAME: &str = "transport_outputs::slow_blocked_sideloads_cost";
    if cfg!(debug_assertions) {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let out = std::process::Command::new(cargo)
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.."))
            .args([
                "test",
                "--release",
                "-p",
                "engine",
                "--features",
                "testing",
                "--test",
                "main",
                "--",
                "--exact",
                NAME,
                "--nocapture",
            ])
            .output()
            .expect("spawning cargo test --release");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "release run failed:\n{text}");
        let line = text
            .lines()
            .find(|l| l.starts_with("blocked side-loads:"))
            .unwrap_or_else(|| panic!("no result line in:\n{text}"));
        println!("{line}");
        return;
    }
    let mut t = Transport::new(64, 8_192);
    let len = 1_000 * 256;
    let main = t.create(len, 24).unwrap();
    for k in 0..len / 64 {
        t.insert_at(main, 64 * k, Item(1 + (k % 2) as u16)).unwrap();
    }
    let mut feeders = Vec::new();
    for k in 0..50 {
        let f = t.create(512, 24).unwrap();
        let at = len - 1 - 256 * k - 100;
        t.set_out(f, Output::Merge { line: main, at }).unwrap();
        t.insert_at(f, 0, Item(3)).unwrap();
        feeders.push(f);
    }
    let mut runs = 0u32;
    t.runs_in(main, &mut |_, _, _| runs += 1).unwrap();
    assert_eq!(runs, 4_000);
    let mut times = Vec::new();
    for _ in 0..200 {
        // Timed for a human; never reaches state or an assertion.
        #[allow(clippy::disallowed_types)]
        let start = std::time::Instant::now();
        t.advance();
        times.push(start.elapsed());
    }
    for f in feeders {
        assert_eq!(items(&t, f), vec![(3, 0)], "every side-load stayed blocked");
    }
    times.sort_unstable();
    println!(
        "blocked side-loads: advance median {:.1} us of 200 (min {:.1}, max {:.1}); 4,000 runs, 50 merges",
        times[100].as_secs_f64() * 1e6,
        times[0].as_secs_f64() * 1e6,
        times[199].as_secs_f64() * 1e6
    );
}
