//! M44 (docs/decisions/0076-transport-lines-engine-game-split.md §1): `Output::Merge` (side-load)
//! and `Output::Fork` (alternation by a per-line toggle) in `advance`, the update order over
//! two-target outputs, their codec, and the surgery redirects. Every boundary is pinned at speeds
//! 24, 72 and 96 (72 and 96 cross two items per tick), with literal positions (0069 §2): a merge
//! lands at `clamp(at - o, 0, len - 1)` iff `SPACING` is clear on both sides there; a fork tries
//! its preferred target's plain hand-off landing `len - o`, then the other, else the item waits;
//! the toggle flips only on a preferred delivery. M61: a fork pair (two inputs naming each other
//! as `partner`) takes turns: `fork_pair_*`.

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
    t.set_out(
        f,
        Output::Fork {
            a: la,
            b: lb,
            partner: None,
        },
    )
    .unwrap();
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
            partner: None,
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
            partner: None,
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
    t.set_out(
        l(2),
        Output::Fork {
            a: l(1),
            b: l(3),
            partner: None,
        },
    )
    .unwrap();
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

/// The toggle is state: encoded with the fork (bit 0 of its byte right after `partner`, M61), so a
/// flipped toggle changes the bytes and the hash, and decodes as it was; a byte above 3 (bit 1 is
/// M61's turn, `fork_pair_yield_bit_round_trips`) is malformed. A merge round-trips with its `at`;
/// malformed forks and merges are refused.
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
    // `A` holds the delivered item: +8); then id, len, speed, tag, a, b, partner (M61, 0: none):
    // the toggle at +23.
    let at = 4 + (27 + 8) + 27 + 23;
    assert_eq!(
        &bytes[at - 12..at],
        &[la.0.to_le_bytes(), lb.0.to_le_bytes(), [0; 4]].concat()[..]
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
    flipped[at] = 4;
    assert_eq!(
        decode(&flipped).err(),
        Some(CodecError::Malformed),
        "fork byte 4"
    );
    // A fork with a == b, and a merge into the line itself.
    let mut bad = bytes.clone();
    bad[at - 8..at - 4].copy_from_slice(&la.0.to_le_bytes());
    assert_eq!(decode(&bad).err(), Some(CodecError::Malformed), "a == b");
    let mut bad = bytes.clone();
    bad[at - 12..at - 8].copy_from_slice(&f.0.to_le_bytes());
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
    u.set_out(
        fast,
        Output::Fork {
            a: long,
            b: short,
            partner: None,
        },
    )
    .unwrap();
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

/// M61: a fork pair, a splitter lane: inputs `X` (fed kind 1) and `P` (fed kind 2), `speed` `s`,
/// 1024 long, each naming the other as `partner`, forking onto `a` and `b`. `p_first`: `P` takes
/// the lower id, so it advances first.
fn pair_world(
    s: u16,
    a: (u32, u16),
    b: (u32, u16),
    p_first: bool,
) -> (Transport, LineId, LineId, LineId, LineId) {
    let mut t = Transport::new(8, 512);
    let la = t.create(a.0, a.1).unwrap();
    let lb = t.create(b.0, b.1).unwrap();
    let (first, second) = (t.create(1024, s).unwrap(), t.create(1024, s).unwrap());
    let (x, p) = if p_first {
        (second, first)
    } else {
        (first, second)
    };
    // Both lone, then `X` paired with `P` (the engine links `P` back: `set_out`'s contract).
    for (l, q) in [(x, None), (p, None), (x, Some(p))] {
        let fork = Output::Fork {
            a: la,
            b: lb,
            partner: q,
        };
        t.set_out(l, fork).unwrap();
    }
    assert_eq!(
        t.out(p),
        Ok(Output::Fork {
            a: la,
            b: lb,
            partner: Some(x)
        }),
        "linked back"
    );
    (t, la, lb, x, p)
}

/// A slow open collector: 4096 long at speed 8, so a fork delivers onto it once every 8 ticks and
/// its items, front to back, are the delivery order.
const COLLECT: (u32, u16) = (4096, 8);

/// M61 (README, splitter input fairness): with both inputs saturated and `b` blocked, the open
/// output (`a`, as fast as the inputs and sinking) takes items from the two inputs alternately
/// whatever the update order (before M61 the input advanced first took every one), and at the full
/// rate (fix round 1): over ticks 100-700 it receives exactly what it receives from one saturated
/// input alone (225, 675 and 900 at speeds 24, 72 and 96), because a waiting item lands right
/// behind `a`'s rearmost item (spacing 64), not at `len - o` a whole tick later (spacing 72 at
/// speed 24: 1/3 a tick instead of 3/8), and an input that owes the turn still goes when its
/// landing leaves room for its partner's (two landings in one tick at 72 and 96).
#[test]
fn fork_pair_alternates_inputs() {
    let delivered =
        |t: &Transport, la: LineId| t.sunk(la).unwrap() + u64::from(t.count(la).unwrap());
    for s in SPEEDS {
        let mut alone = 0;
        for (p_first, fed) in [(false, false), (false, true), (true, true)] {
            let (mut t, la, lb, x, p) = pair_world(s, (4096, s), (256, 8), p_first);
            t.set_out(la, Output::Sink).unwrap();
            put(&mut t, lb, 9, &JAMMED);
            // Two inserts a tick: at speeds 72 and 96 an input carries more than one item a tick.
            // Each input's deliveries in the window: its accepted inserts less its growth.
            let (mut start, mut ins, mut held) = (0, [0u64; 2], [0u64; 2]);
            for tick in 0..700 {
                if tick == 100 {
                    start = delivered(&t, la);
                    held = [x, p].map(|l| u64::from(t.count(l).unwrap()));
                }
                for _ in 0..2 {
                    ins[0] += u64::from(t.insert_back(x, Item(1)).is_ok() && tick >= 100);
                    if fed {
                        ins[1] += u64::from(t.insert_back(p, Item(2)).is_ok() && tick >= 100);
                    }
                }
                t.advance();
            }
            let each = [x, p].map(|l| u64::from(t.count(l).unwrap()));
            let each = [0, 1].map(|k| ins[k] + held[k] - each[k]);
            assert_eq!(
                kinds(&t, lb),
                vec![9; 4],
                "speed {s} {p_first}: b stays blocked"
            );
            if !fed {
                alone = delivered(&t, la) - start;
                continue;
            }
            assert_eq!(
                delivered(&t, la) - start,
                alone,
                "speed {s} {p_first}: the full rate of one saturated input"
            );
            // Fix round 2: each input's share over the whole window, exactly (225, 675 and 900
            // split within one).
            let want = match s {
                24 => [113, 112],
                72 => [338, 337],
                _ => [450, 450],
            };
            // The input with the lower id (it advances first) has the one more.
            let want = if p_first { [want[1], want[0]] } else { want };
            assert_eq!(
                each, want,
                "speed {s} {p_first}: each input's deliveries, ticks 100-700"
            );
            let got = kinds(&t, la);
            let n = |k: u16| got.iter().filter(|&&i| i == k).count();
            assert!(got.len() >= 20, "speed {s} {p_first}: {got:?}");
            // At 24 strictly; at 72 and 96 an output takes two in some ticks, both inputs' in turn
            // (the update order then puts one twice in a row, never three times), so a sample
            // of the items on `a` may be off by two.
            assert!(
                got.windows(if s == 24 { 2 } else { 3 })
                    .all(|w| w.iter().any(|&k| k != w[0])),
                "speed {s} {p_first}: the inputs alternate: {got:?}"
            );
            assert!(
                n(1).abs_diff(n(2)) <= if s == 24 { 1 } else { 2 },
                "speed {s} {p_first}: {} and {}",
                n(1),
                n(2)
            );
        }
    }
}

/// M61 fix round 1: a pair shares one output toggle (Factorio's per-splitter alternation): after
/// a delivery from either side both lines' toggle bits are equal, `set_out` with a fork partner
/// starts on the partner's toggle, and both bits round-trip through the codec. With both outputs
/// open and both inputs saturated the pair passes straight through in lockstep: one input's items
/// all go to `a`, the other's all to `b`.
#[test]
fn fork_pair_shared_toggle() {
    for s in SPEEDS {
        for p_first in [false, true] {
            let (mut t, la, lb, x, p) = pair_world(s, (4096, s), (4096, s), p_first);
            for _ in 0..200 {
                let _ = t.insert_back(x, Item(1));
                let _ = t.insert_back(p, Item(2));
                t.advance();
                assert_eq!(t.toggle(x), t.toggle(p), "speed {s} {p_first}: one toggle");
            }
            let (ka, kb) = (kinds(&t, la), kinds(&t, lb));
            assert!(ka.len() >= 20 && kb.len() >= 20, "speed {s}: {ka:?} {kb:?}");
            let one = |v: &[u16]| v.iter().all(|&k| k == v[0]);
            assert!(
                one(&ka) && one(&kb) && ka[0] != kb[0],
                "speed {s} {p_first}: lockstep pass-through: {ka:?} {kb:?}"
            );
            let back = decode(&encode(&t)).unwrap();
            assert_eq!(
                (
                    back.toggle(x),
                    back.toggle(p),
                    back.fork_yield(x),
                    back.fork_yield(p)
                ),
                (t.toggle(x), t.toggle(p), t.fork_yield(x), t.fork_yield(p)),
                "speed {s}: both lines' bits round-trip"
            );
        }
    }
    // `set_out` with a fork partner copies its toggle.
    let (mut t, la, lb, x, p) = pair_world(24, OPEN, OPEN, false);
    t.insert_at(p, 0, Item(2)).unwrap();
    t.advance();
    assert_eq!(
        (t.toggle(x), t.toggle(p)),
        (Ok(true), Ok(true)),
        "P's delivery flipped both"
    );
    // `X` set lone leaves `P` lone with its toggle; a new input paired with `P` starts on it.
    let lone = Output::Fork {
        a: la,
        b: lb,
        partner: None,
    };
    t.set_out(x, lone).unwrap();
    let fresh = t.create(1024, 24).unwrap();
    let fork = Output::Fork {
        a: la,
        b: lb,
        partner: Some(p),
    };
    t.set_out(fresh, fork).unwrap();
    assert_eq!(
        t.toggle(fresh),
        Ok(true),
        "a new input starts on its partner's toggle"
    );
}

/// M61, 0079 §23 (c)'s shape on the engine: two fork pairs in series, each with its other output
/// blocked. Stage 1: `X1` (kind 1) and `P1` (kind 2) fork onto `O1`; stage 2: `Q` (kind 3, the
/// lower id) and `O1` fork onto the collector. Before M61 `Q` took every slot and kinds 1 and 2
/// never arrived; now `Q` and `O1` take turns and `O1` carries `X1`'s and `P1`'s in turn.
#[test]
fn fork_pair_no_starvation_through_two_forks() {
    let mut t = Transport::new(16, 1024);
    let collect = t.create(COLLECT.0, COLLECT.1).unwrap();
    let [j2, j1] = [0; 2].map(|_| t.create(256, 8).unwrap());
    let [q, o1, x1, p1] = [0; 4].map(|_| t.create(1024, 24).unwrap());
    for j in [j1, j2] {
        put(&mut t, j, 9, &JAMMED);
    }
    for (l, partner, a, b) in [
        (x1, None, o1, j1),
        (p1, None, o1, j1),
        (q, None, collect, j2),
        (o1, None, collect, j2),
        (x1, Some(p1), o1, j1),
        (q, Some(o1), collect, j2),
    ] {
        let fork = Output::Fork { a, b, partner };
        t.set_out(l, fork).unwrap();
    }
    for _ in 0..400 {
        for (l, k) in [(x1, 1), (p1, 2), (q, 3)] {
            let _ = t.insert_back(l, Item(k));
        }
        t.advance();
    }
    // Until `O1`'s first item reaches its front (1024 / 24 ticks), `Q` delivers alone; from then
    // on stage 2 alternates `Q` and `O1`, and `O1` carries stage 1's two inputs in turn.
    let got = kinds(&t, collect);
    let first = got.iter().position(|&k| k != 3).expect("stage 1 delivers");
    let steady = &got[first..];
    assert!(first <= 8 && steady.len() >= 30, "{got:?}");
    let (o, q): (Vec<u16>, Vec<u16>) = (
        steady.iter().step_by(2).copied().collect(),
        steady.iter().skip(1).step_by(2).copied().collect(),
    );
    assert!(q.iter().all(|&k| k == 3), "stage 2 takes turns: {got:?}");
    assert!(
        o.windows(2).all(|w| w[0] != w[1] && w[0] != 3 && w[1] != 3),
        "stage 1 takes turns: {got:?}"
    );
}

/// M61: a partner that holds no items is never due, so an input with one delivers exactly as a
/// lone fork does (the M44 rule), tick for tick, though its turn bit is set.
#[test]
fn fork_pair_single_input_unchanged() {
    for s in SPEEDS {
        let (mut t, la, lb, x, p) = pair_world(s, COLLECT, (4096, 24), false);
        let mut u = Transport::new(8, 512);
        let ua = u.create(COLLECT.0, COLLECT.1).unwrap();
        let ub = u.create(4096, 24).unwrap();
        let ux = u.create(1024, s).unwrap();
        u.create(1024, s).unwrap();
        let lone = Output::Fork {
            a: ua,
            b: ub,
            partner: None,
        };
        u.set_out(ux, lone).unwrap();
        for tick in 0..300 {
            let _ = t.insert_back(x, Item(1));
            let _ = u.insert_back(ux, Item(1));
            t.advance();
            u.advance();
            for (l, ul) in [(la, ua), (lb, ub), (x, ux)] {
                assert_eq!(items(&t, l), items(&u, ul), "speed {s} tick {tick}");
            }
            assert_eq!(t.toggle(x), u.toggle(ux), "speed {s} tick {tick}");
        }
        assert_eq!(t.count(p), Ok(0));
        assert!(
            t.count(la).unwrap() + t.count(lb).unwrap() > 30,
            "speed {s}"
        );
        assert_eq!(t.fork_yield(x), Ok(true), "speed {s}: the turn was taken");
        assert_eq!(t.fork_yield(p), Ok(false));
    }
}

/// M61: the turn bit is state: bit 1 of the fork byte (bit 0 the toggle), after the record's
/// `partner` id; it changes the bytes and the hash and decodes as it was; a byte above 3, a
/// partner naming the line itself or a missing line are malformed. `set_out` refuses the same
/// partners, and destroying the partner leaves a lone fork with its turn cleared.
#[test]
fn fork_pair_yield_bit_round_trips() {
    let (mut t, la, lb, x, p) = pair_world(24, OPEN, OPEN, false);
    t.insert_at(x, 0, Item(1)).unwrap();
    t.advance();
    assert_eq!(t.count(la), Ok(1), "delivered to a");
    assert_eq!((t.fork_yield(x), t.fork_yield(p)), (Ok(true), Ok(false)));
    let bytes = encode(&t);
    let back = decode(&bytes).unwrap();
    assert_eq!(encode(&back), bytes);
    assert_eq!((back.fork_yield(x), back.toggle(x)), (Ok(true), Ok(true)));
    assert_eq!(back.out(x), t.out(x), "the partner round-trips");
    // `X` is the third record: lines 1 and 2 are 27 bytes each, `A` holding the item (+8); then
    // id, len, speed, tag, a, b, partner: the fork byte at +23.
    let at = 4 + (27 + 8) + 27 + 23;
    assert_eq!(&bytes[at - 4..at], &p.0.to_le_bytes());
    assert_eq!(bytes[at], 3, "toggle and turn");
    let mut flipped = bytes.clone();
    flipped[at] = 1;
    let hash = |b: &[u8]| {
        let mut h = Fnv64::new();
        h.write(b);
        h.finish()
    };
    assert_ne!(hash(&flipped), hash(&bytes), "the turn changes the hash");
    let back = decode(&flipped).unwrap();
    assert_eq!((back.fork_yield(x), back.toggle(x)), (Ok(false), Ok(true)));
    flipped[at] = 4;
    assert_eq!(
        decode(&flipped).err(),
        Some(CodecError::Malformed),
        "byte 4"
    );
    for (bad_partner, what) in [(x.0, "itself"), (99, "missing")] {
        let mut bad = bytes.clone();
        bad[at - 4..at].copy_from_slice(&bad_partner.to_le_bytes());
        assert_eq!(
            decode(&bad).err(),
            Some(CodecError::Malformed),
            "a partner {what}"
        );
    }
    let fork = |partner| Output::Fork {
        a: la,
        b: lb,
        partner: Some(partner),
    };
    assert_eq!(t.set_out(x, fork(x)), Err(TransportError::Unsupported));
    assert_eq!(t.set_out(x, fork(LineId(99))), Err(TransportError::NoLine));
    t.destroy(p, &mut |_| {}).unwrap();
    assert_eq!(
        t.out(x),
        Ok(Output::Fork {
            a: la,
            b: lb,
            partner: None
        }),
        "a lone fork"
    );
    assert_eq!((t.fork_yield(x), t.toggle(x)), (Ok(false), Ok(true)));
}

/// A pair in a cycle (M61 fix round 2, the review's probe): `P` forks onto `a` and `j`, `a` forks
/// onto `r` and a sink `s`, `r` runs back into `P`, and `X` (outside the cycle, saturated) forks
/// onto `a` and `j` paired with `P`. `P` is the cycle's cut, so it advances before its own target
/// `a`, and `X` comes last (order `[j, s, P, r, a, X]` up to ids). Random ids, speeds and lengths
/// from `seed`; `None` if a `set_out` refuses (a target shorter than a feeder's speed).
fn cycle_world(seed: u64, paired: bool) -> Option<(Transport, [LineId; 6], bool)> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut below = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let mut t = Transport::new(64, 8192);
    let speeds = [8u16, 16, 24, 32, 48, 72, 96];
    let s_in = speeds[below(7) as usize];
    let s_x = if below(2) == 0 {
        s_in
    } else {
        speeds[below(7) as usize]
    };
    let mut roles = [0usize, 1, 2, 3, 4, 5];
    for i in (1..6).rev() {
        roles.swap(i, below(i as u64 + 1) as usize);
    }
    let mut ids = [LineId(0); 6];
    for &role in &roles {
        let (len, speed) = match role {
            0 => (256 + 64 * below(8) as u32, s_in),
            1 => (256 + 64 * below(8) as u32, s_x),
            2 => (128 + 32 * below(8) as u32, speeds[below(7) as usize]),
            3 => (256, 8),
            4 => (256 + 64 * below(8) as u32, speeds[below(7) as usize]),
            _ => (512, speeds[below(7) as usize]),
        };
        ids[role] = t.create(len.max(200), speed).unwrap();
    }
    let [p, xl, a, j, r, s] = ids;
    if below(2) == 0 {
        t.set_out(j, Output::Sink).unwrap();
    }
    t.set_out(s, Output::Sink).unwrap();
    let lone = |a, b| Output::Fork {
        a,
        b,
        partner: None,
    };
    t.set_out(a, lone(r, s)).ok()?;
    t.set_out(r, Output::Next(p)).ok()?;
    t.set_out(p, lone(a, j)).ok()?;
    t.set_out(xl, lone(a, j)).ok()?;
    if paired {
        let fork = Output::Fork {
            a,
            b: j,
            partner: Some(p),
        };
        t.set_out(xl, fork).unwrap();
    }
    Some((t, ids, below(2) == 0))
}

/// M61 fix round 2 (the review's HIGH finding): advancing a store and advancing its encoded and
/// decoded copy reach the same bytes, every tick, for a pair in a cycle over 399 random worlds
/// (seeds 16, 151 and 369 diverged at tick 22 when a credit left unpaid survived the tick).
#[test]
fn fork_pair_in_a_cycle_restores_exactly() {
    let mut worlds = 0;
    for seed in 1..400u64 {
        let Some((mut t, ids, feed_p)) = cycle_world(seed, true) else {
            continue;
        };
        worlds += 1;
        for tick in 0..600 {
            let _ = t.insert_back(ids[1], Item(1));
            if feed_p && tick < 100 {
                let _ = t.insert_back(ids[0], Item(2));
            }
            let mut u = decode(&encode(&t)).unwrap();
            t.advance();
            u.advance();
            assert_eq!(encode(&u), encode(&t), "seed {seed} tick {tick}");
        }
    }
    assert!(worlds > 300, "only {worlds} worlds built");
}

/// M61 fix rounds 2-4 (the reviews' lost slots): `P`, the cut of a cycle through `a`, advances
/// before `a` (order `P, r, a, X`), so it sees `a`'s tail before `a` moves. Every delivery onto
/// `a` is counted (each item carries its own kind; one on `a` that was not there the tick before
/// is a delivery) over ticks 200-700 for the pair and for two lone forks:
/// - `P` refused on the stale tail, `X` owing the turn: `P` already advanced, so `X` takes the slot
///   (round 2): 187 = 187 at speed 24; 562 = 562 (`a`'s full rate, 500 x 72 / 64) with `a` at 72,
///   `X` at 96 and `r` fed. There `X` fills `a` and `P` never delivers (never holds the turn), as
///   two lone forks: `P` sees no room before `a` moves.
/// - The rule's cost, measured (fix round 4 keeps it rather than risk starvation,
///   `fork_pair_never_starves_in_a_cycle`): with `X` at 24 and due while `P` owes, `P` goes ahead
///   only when its landing leaves `a` room as `a` stands, before its move. `a` at 72 with `P` at
///   72, `a` at 96 with `P` at 48: 375 against two lone forks' 499; `a` at 72 with `P` at 48: 374
///   against 417. `P` yields to the due `X`, its waiting item loses its tick and it is held to
///   `X`'s rate (187 + 187, or 188), while lone forks let `P` use the room `X` leaves. Round 3
///   counted the room `a`'s move frees (499 = 499 in the first two), but that estimate can
///   over-estimate (a blocked tail, a collapsed cut budget) and starve `X`; it was reverted.
/// - The reference game has one speed: there the pair and lone forks agree (187 = 187).
#[test]
fn fork_pair_in_a_cycle_keeps_the_slot() {
    let run = |paired: bool, (sa, sx, sr, ss, feed_r): (u16, u16, u16, u16, bool)| -> (u64, u32) {
        let mut t = Transport::new(16, 4096);
        let p = t.create(512, sr).unwrap();
        let a = t.create(512, sa).unwrap();
        let r = t.create(512, sr).unwrap();
        let x = t.create(512, sx).unwrap();
        let j = t.create(256, 8).unwrap();
        let s = t.create(512, ss).unwrap();
        put(&mut t, j, 9, &JAMMED);
        t.set_out(s, Output::Sink).unwrap();
        let lone = |a, b| Output::Fork {
            a,
            b,
            partner: None,
        };
        t.set_out(a, lone(r, s)).unwrap();
        t.set_out(r, Output::Next(p)).unwrap();
        t.set_out(p, lone(a, j)).unwrap();
        t.set_out(x, lone(a, j)).unwrap();
        if paired {
            let fork = Output::Fork {
                a,
                b: j,
                partner: Some(p),
            };
            t.set_out(x, fork).unwrap();
        }
        let o = order(&mut t);
        let at = |l: LineId| o.iter().position(|&i| i == l.0).unwrap();
        assert!(
            at(p) < at(r) && at(r) < at(a) && at(a) < at(x),
            "order {o:?}"
        );
        let mut seen: Vec<u16> = Vec::new();
        let (mut kind, mut delivered, mut owed) = (1u16, 0u64, 0u32);
        for tick in 0..700 {
            for l in [Some(x), feed_r.then_some(r)].into_iter().flatten() {
                for _ in 0..2 {
                    if t.insert_back(l, Item(kind)).is_ok() {
                        kind += 1;
                    }
                }
            }
            t.advance();
            if tick >= 200 && t.fork_yield(p) == Ok(true) {
                owed += 1;
            }
            let now = kinds(&t, a);
            if tick >= 200 {
                delivered += now.iter().filter(|k| !seen.contains(k)).count() as u64;
            }
            seen = now;
        }
        (delivered, owed)
    };
    // `(a, X, P and r, s, r fed)` speeds; the pair's and two lone forks' deliveries onto `a`,
    // and the ticks `P` held the turn.
    let cases = [
        ((24, 24, 24, 24, false), 187, 187, 0),
        ((72, 96, 24, 96, true), 562, 562, 0),
        ((72, 24, 72, 96, true), 375, 499, 125),
        ((96, 24, 48, 96, true), 375, 499, 125),
        ((72, 24, 48, 96, true), 374, 417, 125),
    ];
    for (case, pair, lone, owed) in cases {
        assert_eq!(run(true, case), (pair, owed), "{case:?}: the pair");
        assert_eq!(run(false, case).0, lone, "{case:?}: two lone forks");
    }
}

/// M61 fix round 4 (review 3): no input of a pair starves in a mixed-speed cycle. The world of
/// [`fork_pair_in_a_cycle_keeps_the_slot`] (`P` the cut of `P -> a -> r -> P`, advancing before
/// `a`; `X` outside, after `a`; `r` fed so `P` stays busy), `(a, X, P and r, s)` speeds. Over ticks
/// 200-700: every delivery onto `a` (a kind not on `a` the tick before) and `X`'s own (its accepted
/// inserts less its growth). `X`'s share is at least the smaller of its supply (one item per
/// `64 / speed` ticks, 187 at 24) and half the deliveries, and both inputs deliver. (a) The
/// collapsed cut budget: `P` at 96 crosses two items in some ticks, whose landings on `a`
/// (not moved yet) carry different budgets, so the second's is 0. (b) The blocked tail: a slower
/// `s` backs `a` up, so a landing behind `a`'s rearmost item moves only as far as that item does.
/// Round 3's estimate of the room `a`'s move frees over-estimated in (b) and starved `P`; the room
/// is now read as `a` stands.
#[test]
fn fork_pair_never_starves_in_a_cycle() {
    let run = |(sa, sx, sr, ss): (u16, u16, u16, u16), paired: bool| -> (u64, u64) {
        let mut t = Transport::new(16, 4096);
        let p = t.create(512, sr).unwrap();
        let a = t.create(512, sa).unwrap();
        let r = t.create(512, sr).unwrap();
        let x = t.create(512, sx).unwrap();
        let j = t.create(256, 8).unwrap();
        let s = t.create(512, ss).unwrap();
        put(&mut t, j, 9, &JAMMED);
        t.set_out(s, Output::Sink).unwrap();
        let fork = |a, b, partner| Output::Fork { a, b, partner };
        t.set_out(a, fork(r, s, None)).unwrap();
        t.set_out(r, Output::Next(p)).unwrap();
        t.set_out(p, fork(a, j, None)).unwrap();
        t.set_out(x, fork(a, j, None)).unwrap();
        if paired {
            t.set_out(x, fork(a, j, Some(p))).unwrap();
        }
        let o = order(&mut t);
        let at = |l: LineId| o.iter().position(|&i| i == l.0).unwrap();
        assert!(at(p) < at(a) && at(a) < at(x), "order {o:?}");
        let mut seen: Vec<u16> = Vec::new();
        let (mut kind, mut total, mut x_in, mut x_held) = (1u16, 0u64, 0u64, 0u64);
        for tick in 0..700 {
            if tick == 200 {
                x_held = u64::from(t.count(x).unwrap());
            }
            for l in [x, r] {
                for _ in 0..2 {
                    if t.insert_back(l, Item(kind)).is_ok() {
                        kind = kind.wrapping_add(1).max(1);
                        x_in += u64::from(l == x && tick >= 200);
                    }
                }
            }
            t.advance();
            let now = kinds(&t, a);
            if tick >= 200 {
                total += now.iter().filter(|k| !seen.contains(k)).count() as u64;
            }
            seen = now;
        }
        (total, x_in + x_held - u64::from(t.count(x).unwrap()))
    };
    // (a) the collapsed budget and (b) the blocked tail (`s` at 24 backs `a` up): (deliveries onto
    // `a`, `X`'s), each input getting half. Round 3's estimate starves `P` in (b): (187, 187), as
    // two lone forks do; (a) holds with it too (499, `X` 187) and stays as the pin.
    for (case, want) in [
        ((96, 24, 96, 96), (375, 187)),
        ((72, 24, 72, 24), (375, 187)),
    ] {
        let (total, xs) = run(case, true);
        assert_eq!((total, xs), want, "{case:?}: deliveries onto a, X's");
        assert!(xs >= 187.min(total / 2), "{case:?}: X's share");
        assert!(total - xs >= 187.min(total / 2), "{case:?}: P's share");
    }
    // The limit a turn cannot lift: with `s` at 8, `a` stays backed up and `P` (the cut, before
    // `a` moves) never finds room as `a` stands, paired or lone: every delivery is `X`'s.
    let limit = (72, 24, 72, 8);
    assert_eq!(
        (run(limit, true), run(limit, false)),
        ((62, 62), (62, 62)),
        "P sees no room"
    );
}

/// M61 fix round 2: the pair link is mutual over the same `{a, b}`. `set_out` pairs only with a
/// fork on the same targets, lone (linked back) or naming this line; a partner that is not a fork,
/// forks onto other targets or another order, or is paired elsewhere is `Unsupported`. Replacing a
/// paired fork (with `DeadEnd`, a lone fork, a fork onto other targets) leaves the partner a lone
/// fork with its turn cleared. Decode rejects a one-sided link, a partner on other targets, a
/// pair whose two turn bits are both set and (fix round 3) one whose two toggles differ.
#[test]
fn fork_pair_link_contract() {
    let fork = |a, b, partner| Output::Fork { a, b, partner };
    let un = Err(TransportError::Unsupported);
    let (mut t, la, lb, x, p) = pair_world(24, OPEN, OPEN, false);
    let z = t.create(1024, 24).unwrap();
    assert_eq!(
        t.set_out(z, fork(la, lb, Some(p))),
        un,
        "p is paired with x"
    );
    t.set_out(z, Output::DeadEnd).unwrap();
    assert_eq!(t.set_out(x, fork(la, lb, Some(z))), un, "z is not a fork");
    t.set_out(z, fork(lb, la, None)).unwrap();
    assert_eq!(
        t.set_out(x, fork(la, lb, Some(z))),
        un,
        "z forks the other way"
    );
    assert_eq!(
        t.out(x),
        Ok(fork(la, lb, Some(p))),
        "refusals change nothing"
    );
    // A delivery by `P` sets its turn; replacing `X`'s fork in any way frees `P`.
    let replacements = [
        Output::DeadEnd,
        fork(la, lb, None),
        fork(lb, la, None),
        Output::Next(la),
    ];
    for out in replacements {
        let (mut t, _, _, x, p) = pair_world(24, OPEN, OPEN, false);
        t.insert_at(p, 0, Item(2)).unwrap();
        t.advance();
        assert_eq!(t.fork_yield(p), Ok(true), "{out:?}: P owes");
        t.set_out(x, out).unwrap();
        assert_eq!(t.out(p), Ok(fork(la, lb, None)), "{out:?}: P is lone");
        assert_eq!(
            (t.fork_yield(p), t.toggle(p)),
            (Ok(false), Ok(true)),
            "{out:?}: its turn cleared, its toggle kept"
        );
    }
    // Decode: `X` is the third record, `P` the fourth (no items: 27 + 4 + 1 B a fork record more
    // than a plain one's 27: id, len, speed, tag, a, b, partner, fork byte, sunk, jam, runs).
    let bytes = encode(&t);
    let x_at = 4 + 27 + 27 + 23;
    let p_at = x_at + 1 + 8 + 4 + 4 + 23;
    assert_eq!(&bytes[p_at - 4..p_at], &x.0.to_le_bytes(), "P names X");
    let mut one_sided = bytes.clone();
    one_sided[p_at - 4..p_at].copy_from_slice(&0u32.to_le_bytes());
    let mut both_owe = bytes.clone();
    both_owe[x_at] |= 2;
    both_owe[p_at] |= 2;
    let mut toggles_differ = bytes.clone();
    toggles_differ[p_at] ^= 1;
    let mut other_targets = bytes.clone();
    // `P` forks onto `b, a`.
    other_targets[p_at - 12..p_at - 4]
        .copy_from_slice(&[lb.0.to_le_bytes(), la.0.to_le_bytes()].concat());
    assert!(decode(&bytes).is_ok());
    for (bad, what) in [
        (one_sided, "one-sided"),
        (both_owe, "both owe"),
        (toggles_differ, "toggles differ"),
        (other_targets, "other targets"),
    ] {
        assert_eq!(decode(&bad).err(), Some(CodecError::Malformed), "{what}");
    }
    let mut one_owes = bytes.clone();
    one_owes[p_at] |= 2;
    assert!(decode(&one_owes).is_ok(), "one turn bit is legal");
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
    assert_eq!(
        t.set_out(
            f,
            Output::Fork {
                a: b,
                b,
                partner: None
            }
        ),
        un
    );
    assert_eq!(
        t.set_out(
            f,
            Output::Fork {
                a: f,
                b,
                partner: None
            }
        ),
        un
    );
    assert_eq!(
        t.set_out(
            f,
            Output::Fork {
                a: b,
                b: LineId(99),
                partner: None,
            }
        ),
        Err(TransportError::NoLine)
    );
    assert_eq!(
        t.set_out(
            f,
            Output::Fork {
                a: b,
                b: a,
                partner: None
            }
        ),
        Err(TransportError::BadSpeed),
        "a fork target shorter than the feeder's speed"
    );
    // A merge landing is clamped, so a short merge target is fine.
    assert_eq!(t.set_out(f, Output::Merge { line: a, at: 5_000 }), Ok(()));
    t.set_speed(f, 8).unwrap();
    t.set_out(
        f,
        Output::Fork {
            a: b,
            b: a,
            partner: None,
        },
    )
    .unwrap();
    assert_eq!(t.set_speed(f, 101), Err(TransportError::BadSpeed));
    assert_eq!(t.set_speed(f, 100), Ok(()));
    // A changed output clears the toggle.
    t.insert_at(f, 0, Item(1)).unwrap();
    for _ in 0..3 {
        t.advance();
    }
    assert!(t.toggle(f).unwrap());
    t.set_out(
        f,
        Output::Fork {
            a,
            b,
            partner: None,
        },
    )
    .unwrap();
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
    t.set_out(
        f,
        Output::Fork {
            a: la,
            b: lb,
            partner: None,
        },
    )
    .unwrap();
    assert!(t.toggle(f).unwrap(), "the same fork keeps its toggle");
    t.advance();
    assert_eq!(
        t.order_recomputes(),
        recomputes,
        "the order was not recomputed"
    );
    assert_eq!(t.touched(f), Ok(false), "the line was not touched");
    // A real change still clears it, and recomputes the order once.
    t.set_out(
        f,
        Output::Fork {
            a: lb,
            b: la,
            partner: None,
        },
    )
    .unwrap();
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
    t.set_out(
        f,
        Output::Fork {
            a,
            b,
            partner: None,
        },
    )
    .unwrap();
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
    t.set_out(
        g,
        Output::Fork {
            a: c,
            b: back,
            partner: None,
        },
    )
    .unwrap();
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
        t.set_out(
            l(3),
            Output::Fork {
                a: l(1),
                b: l(2),
                partner: None,
            },
        )
        .unwrap();
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
        t.set_out(
            l(3),
            Output::Fork {
                a: l(1),
                b: l(2),
                partner: None,
            },
        )
        .unwrap();
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

/// 0079 §11 as amended in M44 (the cut budget): a cycle of three lines filled end to end with
/// items exactly `SPACING` apart (24 items on 3 x 512) rotates rigidly. Every item moves exactly
/// `speed` along the loop every tick and every gap, the cut's included, stays `SPACING`, at
/// speeds 24 and 72, for 100 ticks. Before the amendment the cut line's front item was bounded by
/// its target's rearmost item before that line moved, so a packed loop held at the cut.
#[test]
fn cut_packed_cycle_moves_every_item_speed() {
    for speed in [24u16, 72] {
        let mut t = Transport::new(8, 64);
        let lines: Vec<LineId> = (0..3).map(|_| t.create(512, speed).unwrap()).collect();
        for k in 0..3 {
            t.set_out(lines[k], Output::Next(lines[(k + 1) % 3]))
                .unwrap();
        }
        let mut kind = 1u16;
        for &l in &lines {
            for pos in (0..512).step_by(64) {
                t.insert_at(l, pos, Item(kind)).unwrap();
                kind += 1;
            }
        }
        let total = 3 * 512;
        // Loop coordinate: the position on line k plus the lengths of the lines it feeds into
        // before the loop closes (line k feeds k + 1).
        let coords = |t: &Transport| -> std::collections::BTreeMap<u16, u32> {
            let mut m = std::collections::BTreeMap::new();
            for (k, &l) in lines.iter().enumerate() {
                for (item, p) in items(t, l) {
                    m.insert(item, p + 512 * (2 - k as u32));
                }
            }
            m
        };
        let mut prev = coords(&t);
        for tick in 0..100 {
            t.advance();
            let now = coords(&t);
            assert_eq!(now.len(), 24, "speed {speed} tick {tick}: nothing lost");
            for (item, &c) in &now {
                let want = (prev[item] + total - u32::from(speed)) % total;
                assert_eq!(
                    c, want,
                    "speed {speed} tick {tick}: item {item} moved {speed}"
                );
            }
            let mut sorted: Vec<u32> = now.values().copied().collect();
            sorted.sort_unstable();
            for w in sorted.windows(2) {
                assert_eq!(w[1] - w[0], 64, "speed {speed} tick {tick}: spacing");
            }
            prev = now;
        }
    }
}

/// The cut budget for a merge landing across a cut (§16): it may still move `speed - moved` on
/// the target, `moved` being what it moved on its feeder. A feeder at speed 24 side-loads at 700
/// onto a line at speed 72 that has not moved yet: the landing then moves 48 behind the item
/// ahead (500 -> 428), and the item behind it moves its full 72.
#[test]
fn cut_merge_landing_moves_its_budget() {
    let l = LineId;
    let mut t = Transport::new(8, 64);
    t.create(512, 72).unwrap();
    t.create(512, 24).unwrap();
    t.create(1024, 72).unwrap();
    t.set_out(l(1), Output::Next(l(3))).unwrap();
    t.set_out(
        l(2),
        Output::Merge {
            line: l(3),
            at: 724,
        },
    )
    .unwrap();
    t.set_out(
        l(3),
        Output::Fork {
            a: l(1),
            b: l(2),
            partner: None,
        },
    )
    .unwrap();
    assert_eq!(order(&mut t), vec![1, 2, 3]);
    t.insert_at(l(2), 0, Item(2)).unwrap();
    put(&mut t, l(3), 5, &[500, 900]);
    t.advance();
    assert_eq!(items(&t, l(3)), vec![(5, 428), (2, 652), (5, 828)]);
}

/// M44 cut review (finding 2): the fallback. A packed loop of 3 x 512 (24 items) whose second line
/// was rescaled 512 -> 505 holds seven pairs squashed by 1: it is overfull by 7, and each dry pass
/// around it moves the front 7 less than the one before (`speed`, `speed - 7`, ...), so no fixed
/// point is reached in four passes and the cut line sees its target as it stands. The same at 3 x
/// 2048, speed 300, rescaled to 1976 (overfull by 72: 300, 228, 156, 84, ...), where a lead taken
/// from the fourth pass would let the landing overrun the target's real tail by more than
/// `SPACING`. The loop holds:
/// line 1's front item stays at 0 every tick. At the end of every tick every stored gap is above
/// `-SPACING`, and the store encodes, decodes and then advances byte-identically for 20 ticks. At
/// speeds 24, 72, 96 and 300.
#[test]
fn cut_fallback_holds_and_stays_valid() {
    for (len, speed, squeezed) in [
        (512, 24u16, 505),
        (512, 72, 505),
        (512, 96, 505),
        (2048, 300, 1976),
    ] {
        let mut t = Transport::new(8, 128);
        let lines: Vec<LineId> = (0..3).map(|_| t.create(len, speed).unwrap()).collect();
        for k in 0..3 {
            t.set_out(lines[k], Output::Next(lines[(k + 1) % 3]))
                .unwrap();
        }
        let mut kind = 1u16;
        for &l in &lines {
            for pos in (0..len).step_by(64) {
                t.insert_at(l, pos, Item(kind)).unwrap();
                kind += 1;
            }
        }
        t.rescale(lines[1], squeezed).unwrap();
        assert!(positions(&t, lines[1])[1] < 64, "squashed");
        for tick in 0..30 {
            let before = t.cut_fallbacks();
            t.advance();
            assert_eq!(
                t.cut_fallbacks(),
                before + 1,
                "speed {speed} tick {tick}: no fixed point, fallback"
            );
            assert_eq!(
                t.front(lines[0]).unwrap(),
                Some((Item(1), 0)),
                "speed {speed} tick {tick}: the cut's front holds"
            );
            for &l in &lines {
                t.runs_in(l, &mut |_, _, gap| {
                    assert!(gap > -64, "speed {speed} tick {tick}: gap {gap}");
                })
                .unwrap();
            }
        }
        let mut back = decode(&encode(&t)).expect("a fallback world restores");
        for tick in 0..20 {
            t.advance();
            back.advance();
            assert_eq!(
                encode(&back),
                encode(&t),
                "speed {speed}: restored tick {tick}"
            );
        }
    }
}

/// M44 cut review (finding 6): two landings across a cut onto one line in one tick with different
/// budgets. Line 1 hands its item (bounded by line 3's unmoved tail at 940: it moves 50, budget
/// 22) to the back of line 3, and line 2 side-loads at 700 (it moves 24, budget 48): the budgets
/// disagree, so both landings move 0 more. Every item still moves at most its speed and stays
/// `SPACING` clear.
#[test]
fn cut_caps_disagree_fall_to_zero() {
    let l = LineId;
    let mut t = Transport::new(8, 64);
    t.create(512, 72).unwrap();
    t.create(512, 24).unwrap();
    t.create(1024, 72).unwrap();
    t.set_out(l(1), Output::Next(l(3))).unwrap();
    t.set_out(
        l(2),
        Output::Merge {
            line: l(3),
            at: 724,
        },
    )
    .unwrap();
    t.set_out(
        l(3),
        Output::Fork {
            a: l(1),
            b: l(2),
            partner: None,
        },
    )
    .unwrap();
    assert_eq!(order(&mut t), vec![1, 2, 3]);
    t.insert_at(l(1), 30, Item(1)).unwrap();
    t.insert_at(l(2), 0, Item(2)).unwrap();
    put(&mut t, l(3), 5, &[300, 940]);
    t.advance();
    // 300 -> 228; the side-load stays at 700; 940 -> 868; the hand-off stays at 1024 - 20.
    assert_eq!(
        items(&t, l(3)),
        vec![(5, 228), (2, 700), (5, 868), (1, 1004)]
    );
}

/// M44 cut review (finding 3), a measurement for M45/M56 and not a gate: the dry passes' node
/// visits per tick on a stalled 4-line loop of 16,000 runs (4 x 1,000 tiles packed with
/// alternating kinds; one line rescaled by -1 makes it overfull, so every pass walks every run and
/// the cut falls back after four). Prints the count (`dry_visits`, a per-thread counter).
#[test]
fn slow_cut_dry_pass_visits() {
    let mut t = Transport::new(8, 20_000);
    let len = 1_000 * 256;
    let lines: Vec<LineId> = (0..4).map(|_| t.create(len, 24).unwrap()).collect();
    for k in 0..4 {
        t.set_out(lines[k], Output::Next(lines[(k + 1) % 4]))
            .unwrap();
    }
    for &l in &lines {
        for k in 0..len / 64 {
            t.insert_at(l, 64 * k, Item(1 + (k % 2) as u16)).unwrap();
        }
    }
    t.rescale(lines[1], len - 1).unwrap();
    let mut runs = 0u32;
    for &l in &lines {
        t.runs_in(l, &mut |_, _, _| runs += 1).unwrap();
    }
    let before = (engine::transport::dry_visits(), t.cut_fallbacks());
    for _ in 0..10 {
        t.advance();
    }
    let visits = (engine::transport::dry_visits() - before.0) / 10;
    assert_eq!(
        t.cut_fallbacks() - before.1,
        10,
        "stalled: falls back every tick"
    );
    println!("cut dry passes: {visits} node visits per tick on a stalled loop of {runs} runs");
}
