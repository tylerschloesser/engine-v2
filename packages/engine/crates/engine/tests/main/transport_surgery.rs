//! M43 (docs/decisions/0076-transport-lines-engine-game-split.md §3, 0079 §8-§11): line surgery and
//! the item primitives on small lines, with items at every boundary case. Expectations are literal
//! positions and runs (0069 §2), worked by hand from the rule in each test's doc comment.
//!
//! - `surgery_split_partitions_items_and_spacing`, `surgery_join_preserves_gaps`: a cut between
//!   runs, inside a run and exactly on an item; a split line advances exactly like the unsplit one.
//! - `surgery_extend_front_is_o1_positions`, `surgery_shrink_refuses_with_items`.
//! - `surgery_rescale_floors_and_keeps_squashed`: 12 §3e's 295 -> 256 example, and the squash rule
//!   resolving the squashed pairs tick by tick.
//! - `surgery_destroy_redirects_outputs`.
//! - `items_insert_at_room_rule`, `items_remove_at_nearest` (with `front`/`take_front`).

use engine::bytes::{ByteReader, SliceSink};
use engine::transport::{
    Geometry, Item, LineId, MAX_LEN, Output, Segment, Transport, TransportError, TransportRead,
    TransportWrite,
};
use engine::world::{TilePos, WorldPos};

fn items(t: &Transport, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    t.items_in(l, &mut |item, pos| v.push((item.0, pos)))
        .expect("the line exists");
    v
}

fn runs(t: &Transport, l: LineId) -> Vec<(u16, u16, i32)> {
    let mut v = Vec::new();
    t.runs_in(l, &mut |i, c, g| v.push((i.0, c, g))).unwrap();
    v
}

fn encode(t: &Transport) -> Vec<u8> {
    let mut buf = vec![0u8; 1 << 16];
    let mut sink = SliceSink::new(&mut buf);
    t.write_canonical(&mut sink);
    let n = sink.finish().expect("fits");
    buf.truncate(n);
    buf
}

fn round_trip(t: &Transport) -> Transport {
    let bytes = encode(t);
    let mut back = Transport::new(64, 4096);
    back.read_canonical(&mut ByteReader::new(&bytes))
        .expect("decodes");
    assert_eq!(encode(&back), bytes, "re-encodes to the same bytes");
    back
}

/// A line of `len` at `speed` with `(item, pos)` placed by `insert_at`.
fn line_with(t: &mut Transport, len: u32, speed: u16, at: &[(u16, u32)]) -> LineId {
    let l = t.create(len, speed).unwrap();
    for &(item, pos) in at {
        t.insert_at(l, pos, Item(item)).unwrap();
    }
    l
}

fn straight(len: u32, from: (i32, i32), to: (i32, i32)) -> Segment {
    Segment {
        len,
        geometry: Geometry::Straight {
            from: WorldPos {
                x: from.0,
                y: from.1,
            },
            to: WorldPos { x: to.0, y: to.1 },
        },
    }
}

/// `split(line, at)`: items at `pos < at` stay, the rest move to the new back line at `pos - at`;
/// a run straddling the cut is split; the back line's first gap is its first position minus `at`.
/// Line `a` (1024, speed 24): a packed kind-1 run at 0, 64, 128; kind 2 at 300, 364, 428; kind 3
/// at 900. The new line is the back part, fed by `a`'s old feeders, and outputs `Next(a)`.
#[test]
fn surgery_split_partitions_items_and_spacing() {
    let all = [
        (1, 0),
        (1, 64),
        (1, 128),
        (2, 300),
        (2, 364),
        (2, 428),
        (3, 900),
    ];
    // A cut between runs (at 200), inside a run (at 330: 300 stays, 364 and 428 go), exactly on
    // an item (at 364: it goes back, to 0), exactly on a run's last item (at 128 and 428, M43
    // review: it goes back, never stays at `pos == len`).
    for (at, front, back, back_runs) in [
        (
            128u32,
            &all[..2],
            vec![(1, 0), (2, 172), (2, 236), (2, 300), (3, 772)],
            vec![(1, 1, 0), (2, 3, 108), (3, 1, 408)],
        ),
        (
            428,
            &all[..5],
            vec![(2, 0), (3, 472)],
            vec![(2, 1, 0), (3, 1, 408)],
        ),
        (
            200,
            &all[..3],
            vec![(2, 100), (2, 164), (2, 228), (3, 700)],
            vec![(2, 3, 100), (3, 1, 408)],
        ),
        (
            330,
            &all[..4],
            vec![(2, 34), (2, 98), (3, 570)],
            vec![(2, 2, 34), (3, 1, 408)],
        ),
        (
            364,
            &all[..4],
            vec![(2, 0), (2, 64), (3, 536)],
            vec![(2, 2, 0), (3, 1, 408)],
        ),
    ] {
        let mut t = Transport::new(16, 256);
        let a = line_with(&mut t, 1024, 24, &all);
        let feeder = t.create(512, 24).unwrap();
        t.set_out(feeder, Output::Next(a)).unwrap();
        t.set_out(a, Output::Sink).unwrap();
        let b = t.split(a, at).unwrap();
        assert_eq!(b, LineId(3), "the new line takes the next id");
        assert_eq!(items(&t, a), front.to_vec(), "cut at {at}: front part");
        assert_eq!(items(&t, b), back, "cut at {at}: back part");
        assert_eq!(runs(&t, b), back_runs, "cut at {at}: back runs");
        assert_eq!((t.len(a), t.len(b)), (Ok(at), Ok(1024 - at)));
        assert_eq!(
            (t.count(a), t.count(b)),
            (Ok(front.len() as u32), Ok(back.len() as u32))
        );
        assert_eq!(t.items_len(), 7, "no item created or lost");
        assert_eq!(
            t.out(a),
            Ok(Output::Sink),
            "the front part keeps the output"
        );
        assert_eq!(t.out(b), Ok(Output::Next(a)));
        assert_eq!(
            t.out(feeder),
            Ok(Output::Next(b)),
            "feeders now feed the back part"
        );
        let back_copy = round_trip(&t);
        assert_eq!(items(&back_copy, b), back);
    }

    // Refusals change nothing: a part not longer than the speed, a feeder faster than the back
    // part is long, the line cap.
    let mut t = Transport::new(3, 256);
    let a = line_with(&mut t, 1024, 24, &all);
    let fast = t.create(512, 200).unwrap();
    t.set_out(fast, Output::Next(a)).unwrap();
    let before = encode(&t);
    for at in [0, 24, 1000, 1024, 2000] {
        assert_eq!(t.split(a, at), Err(TransportError::BadSpeed), "at {at}");
    }
    assert_eq!(
        t.split(a, 900),
        Err(TransportError::BadSpeed),
        "a 124-long back part, fed at 200"
    );
    assert_eq!(encode(&t), before, "a refused split writes nothing");
    t.split(a, 512).unwrap();
    assert_eq!(t.split(a, 256), Err(TransportError::Full), "max_lines");
    assert_eq!(t.split(LineId(9), 256), Err(TransportError::NoLine));

    // A split line advances exactly like the unsplit one: the hand-off lands at `target.len + p`,
    // the continuous coordinate, and the squash rule reads the target's tail the same way.
    let (mut one, mut two) = (Transport::new(4, 256), Transport::new(4, 256));
    let l1 = line_with(
        &mut one,
        2048,
        24,
        &[(1, 100), (2, 700), (2, 764), (3, 1500)],
    );
    let l2 = line_with(
        &mut two,
        2048,
        24,
        &[(1, 100), (2, 700), (2, 764), (3, 1500)],
    );
    let back = two.split(l2, 730).unwrap();
    for tick in 0..120 {
        if tick % 3 == 0 {
            let r1 = one.insert_back(l1, Item(4));
            assert_eq!(two.insert_back(back, Item(4)), r1, "tick {tick}");
        }
        one.advance();
        two.advance();
        let mut joined = items(&two, l2);
        joined.extend(items(&two, back).into_iter().map(|(i, p)| (i, p + 730)));
        assert_eq!(joined, items(&one, l1), "tick {tick}");
    }
}

/// `join(front, back)`: `back`'s items land at `pos + front.len` with every gap kept; the boundary
/// pair merges when packed and the same kind; a squashed boundary pair (closer than `SPACING`
/// across the old hand-off, legal there, 0077 A6b (i)) is kept as a negative gap.
#[test]
fn surgery_join_preserves_gaps() {
    let mut t = Transport::new(16, 256);
    let a = line_with(&mut t, 512, 24, &[(1, 0), (1, 64), (2, 448)]);
    let b = line_with(&mut t, 512, 24, &[(2, 0), (2, 64), (3, 300)]);
    let feeder = t.create(256, 24).unwrap();
    t.set_out(feeder, Output::Next(b)).unwrap();
    assert_eq!(t.join(a, b), Err(TransportError::NotLinked));
    t.set_out(b, Output::Next(a)).unwrap();
    t.join(a, b).unwrap();
    assert_eq!(
        items(&t, a),
        vec![(1, 0), (1, 64), (2, 448), (2, 512), (2, 576), (3, 812)]
    );
    // 448 -> 512 is packed and the same kind: one run of three.
    assert_eq!(runs(&t, a), vec![(1, 2, 0), (2, 3, 320), (3, 1, 172)]);
    assert_eq!((t.len(a), t.count(a)), (Ok(1024), Ok(6)));
    assert_eq!(t.out(b), Err(engine::game::Unknown), "back is destroyed");
    assert_eq!(
        t.out(feeder),
        Ok(Output::Next(a)),
        "back's feeders feed front"
    );
    assert_eq!(t.lines_len(), 2);

    // A gapped boundary keeps its gap; a different kind never merges.
    let mut t = Transport::new(16, 256);
    let a = line_with(&mut t, 256, 24, &[(1, 100)]);
    let b = line_with(&mut t, 256, 24, &[(1, 70), (2, 134)]);
    t.set_out(b, Output::Next(a)).unwrap();
    t.join(a, b).unwrap();
    assert_eq!(items(&t, a), vec![(1, 100), (1, 326), (2, 390)]);
    assert_eq!(runs(&t, a), vec![(1, 1, 100), (1, 1, 162), (2, 1, 0)]);

    // Squashed across the old hand-off: `a`'s tail at 250, `b`'s front at 0 (distance 6).
    let mut t = Transport::new(16, 256);
    let a = line_with(&mut t, 256, 8, &[(1, 186), (1, 250)]);
    let b = line_with(&mut t, 256, 8, &[(2, 0), (2, 64)]);
    t.set_out(b, Output::Next(a)).unwrap();
    t.join(a, b).unwrap();
    assert_eq!(items(&t, a), vec![(1, 186), (1, 250), (2, 256), (2, 320)]);
    assert_eq!(runs(&t, a), vec![(1, 2, 186), (2, 2, -58)]);
    round_trip(&t);
    // The squash rule (speed 8): 256 waits while inside `leader + 64` (and 320 behind it), moves
    // the 6 that reopen at tick 8, then everything flows and packs against the dead end.
    let mut at = Vec::new();
    for _ in 0..60 {
        t.advance();
        at.push(items(&t, a));
    }
    assert_eq!(at[0], vec![(1, 178), (1, 242), (2, 256), (2, 320)]);
    assert_eq!(at[6], vec![(1, 130), (1, 194), (2, 256), (2, 320)]);
    assert_eq!(at[7], vec![(1, 122), (1, 186), (2, 250), (2, 314)]);
    assert_eq!(at[8], vec![(1, 114), (1, 178), (2, 242), (2, 306)]);
    assert_eq!(at[59], vec![(1, 0), (1, 64), (2, 128), (2, 192)]);

    // A two-line loop cannot join (the joined line would feed itself); unknown lines.
    let mut t = Transport::new(16, 256);
    let a = t.create(256, 8).unwrap();
    let b = t.create(256, 8).unwrap();
    t.set_out(a, Output::Next(b)).unwrap();
    t.set_out(b, Output::Next(a)).unwrap();
    assert_eq!(t.join(a, b), Err(TransportError::Unsupported));
    assert_eq!(t.join(a, LineId(9)), Err(TransportError::NoLine));

    // Split then join is the identity on items and runs.
    let mut t = Transport::new(16, 256);
    let a = line_with(
        &mut t,
        1024,
        24,
        &[(1, 0), (1, 64), (1, 128), (1, 192), (2, 600)],
    );
    let before = runs(&t, a);
    let b = t.split(a, 100).unwrap();
    t.join(a, b).unwrap();
    assert_eq!(runs(&t, a), before);
}

/// `extend_front(by)` adds `by` to every position by changing one number (the front run's gap):
/// every other run is untouched. `extend_back` changes only `len`. Both refuse past `MAX_LEN`.
#[test]
fn surgery_extend_front_is_o1_positions() {
    let mut t = Transport::new(4, 256);
    let a = line_with(&mut t, 1024, 24, &[(1, 10), (1, 74), (2, 300), (3, 900)]);
    let before = runs(&t, a);
    t.extend_front(a, 256).unwrap();
    assert_eq!(items(&t, a), vec![(1, 266), (1, 330), (2, 556), (3, 1156)]);
    let after = runs(&t, a);
    assert_eq!(after[0], (1, 2, 266));
    assert_eq!(after[1..], before[1..], "only the front gap changed");
    assert_eq!(t.len(a), Ok(1280));
    t.extend_back(a, 512).unwrap();
    assert_eq!(items(&t, a), vec![(1, 266), (1, 330), (2, 556), (3, 1156)]);
    assert_eq!(t.len(a), Ok(1792));
    // The extended back takes items again: `insert_back` lands at `len - speed`.
    t.insert_back(a, Item(4)).unwrap();
    assert_eq!(items(&t, a).last(), Some(&(4, 1792 - 24)));
    assert_eq!(t.extend_back(a, MAX_LEN), Err(TransportError::TooLong));
    assert_eq!(
        t.extend_front(a, MAX_LEN - 1792 + 1),
        Err(TransportError::TooLong)
    );
    t.extend_back(a, MAX_LEN - 1792).unwrap();
    assert_eq!(t.len(a), Ok(MAX_LEN));
    let e = t.create(256, 24).unwrap();
    t.extend_front(e, 0).unwrap();
    assert_eq!(t.len(e), Ok(256));
    round_trip(&t);
}

/// `shrink_front(by)` needs the front item at `>= by`; `shrink_back(by)` the rearmost at
/// `<= len - by - 1`: else `NotEmpty`, nothing written. Both keep `speed < len` and every feeder's
/// speed at most `len` (0079 §8: `BadSpeed`).
#[test]
fn surgery_shrink_refuses_with_items() {
    let mut t = Transport::new(4, 256);
    let a = line_with(&mut t, 1024, 24, &[(1, 100), (2, 700)]);
    let before = encode(&t);
    assert_eq!(t.shrink_front(a, 101), Err(TransportError::NotEmpty));
    assert_eq!(
        t.shrink_back(a, 324),
        Err(TransportError::NotEmpty),
        "700 > 1024 - 324 - 1"
    );
    assert_eq!(encode(&t), before, "a refused shrink writes nothing");
    t.shrink_back(a, 323).unwrap();
    assert_eq!(
        (t.len(a), items(&t, a)),
        (Ok(701), vec![(1, 100), (2, 700)])
    );
    t.shrink_front(a, 100).unwrap();
    assert_eq!((t.len(a), items(&t, a)), (Ok(601), vec![(1, 0), (2, 600)]));
    assert_eq!(runs(&t, a), vec![(1, 1, 0), (2, 1, 536)]);
    // `speed < len`: a 601-long line at speed 24 shrinks to 25, not to 24.
    let e = t.create(601, 24).unwrap();
    assert_eq!(t.shrink_back(e, 577), Err(TransportError::BadSpeed));
    assert_eq!(t.shrink_front(e, 2000), Err(TransportError::BadSpeed));
    t.shrink_front(e, 576).unwrap();
    assert_eq!(t.len(e), Ok(25));
    // A feeder at 200 needs its target at least 200 long.
    let f = t.create(1024, 24).unwrap();
    let fast = t.create(512, 200).unwrap();
    t.set_out(fast, Output::Next(f)).unwrap();
    assert_eq!(t.shrink_back(f, 825), Err(TransportError::BadSpeed));
    t.shrink_back(f, 824).unwrap();
    assert_eq!(t.len(f), Ok(200));
    assert_eq!(t.shrink_front(LineId(99), 1), Err(TransportError::NoLine));
}

/// `rescale(line, new)` maps each position to `floor(pos x new / old)` (12 §3e). The measured
/// example: a curve's outer lane (295) with items at 0, 64, 128, 192 reshaped to straight (256)
/// puts them at 0, 55, 111, 166: three squashed pairs, kept (negative gaps). On a `Sink` at speed
/// 8 the squash rule resolves them: a rear item inside `leader + SPACING` does not move, so
/// 55/111/166 wait and start one by one as their leaders pull 64 ahead.
#[test]
fn surgery_rescale_floors_and_keeps_squashed() {
    let mut t = Transport::new(8, 256);
    let a = line_with(&mut t, 295, 8, &[(1, 0), (1, 64), (1, 128), (1, 192)]);
    t.rescale(a, 256).unwrap();
    assert_eq!(items(&t, a), vec![(1, 0), (1, 55), (1, 111), (1, 166)]);
    assert_eq!(
        runs(&t, a),
        vec![(1, 1, 0), (1, 1, -9), (1, 1, -8), (1, 1, -9)]
    );
    assert_eq!(t.len(a), Ok(256));
    let back = round_trip(&t);
    assert_eq!(items(&back, a), items(&t, a));
    t.set_out(a, Output::Sink).unwrap();
    let want: [&[(u16, u32)]; 5] = [
        &[(1, 55), (1, 111), (1, 166)],
        &[(1, 47), (1, 111), (1, 166)],
        &[(1, 39), (1, 103), (1, 166)],
        &[(1, 31), (1, 95), (1, 159)],
        &[(1, 23), (1, 87), (1, 151)],
    ];
    for (tick, w) in want.iter().enumerate() {
        t.advance();
        assert_eq!(items(&t, a), w.to_vec(), "tick {tick}");
    }
    assert_eq!(runs(&t, a), vec![(1, 3, 23)], "resolved and merged");

    // Five items (a full 295 lane) still fit at 256: 0, 55, 111, 166, 222.
    let mut t = Transport::new(8, 256);
    let a = line_with(
        &mut t,
        295,
        8,
        &[(2, 0), (2, 64), (2, 128), (2, 192), (2, 256)],
    );
    t.rescale(a, 256).unwrap();
    assert_eq!(
        items(&t, a),
        vec![(2, 0), (2, 55), (2, 111), (2, 166), (2, 222)]
    );
    // Growing never squashes: 256 -> 295 floors 0, 64, 128, 192 to 0, 73, 147, 221.
    let b = line_with(&mut t, 256, 8, &[(1, 0), (1, 64), (1, 128), (1, 192)]);
    t.rescale(b, 295).unwrap();
    assert_eq!(items(&t, b), vec![(1, 0), (1, 73), (1, 147), (1, 221)]);
    assert_eq!(
        runs(&t, b),
        vec![(1, 1, 0), (1, 1, 9), (1, 1, 10), (1, 1, 10)]
    );
    // Two items on one position: refused, nothing written; and the length rules.
    let c = line_with(&mut t, 1024, 4, &[(1, 0), (1, 64), (1, 128)]);
    let before = encode(&t);
    assert_eq!(t.rescale(c, 8), Err(TransportError::NoRoom));
    assert_eq!(t.rescale(c, 4), Err(TransportError::BadSpeed));
    assert_eq!(t.rescale(c, MAX_LEN + 1), Err(TransportError::TooLong));
    assert_eq!(encode(&t), before);
    t.rescale(c, 16).unwrap();
    assert_eq!(items(&t, c), vec![(1, 0), (1, 1), (1, 2)]);
}

/// M43 review (finding 5): a split through or behind unresolved squashed pairs (a line rescaled
/// 1180 -> 1024 with 19 items packed from 0: every pair squashed, gaps -8 or -9) advances exactly
/// like the unsplit line, tick by tick on a speed-8 sink, and an encode/decode of the split store
/// advances like the live one. Both parts must keep the `squashed` flag: without it the early
/// exit would move a squashed item at full speed behind a leader that moved.
#[test]
fn surgery_split_keeps_squashed_pairs() {
    let packed: Vec<(u16, u32)> = (0..19).map(|k| (1 + (k % 2) as u16, 64 * k)).collect();
    for at in [60u32, 100, 140, 300, 700, 1000] {
        let (mut one, mut two) = (Transport::new(8, 256), Transport::new(8, 256));
        let l1 = line_with(&mut one, 1180, 8, &packed);
        let l2 = line_with(&mut two, 1180, 8, &packed);
        for (t, l) in [(&mut one, l1), (&mut two, l2)] {
            t.rescale(l, 1024).unwrap();
            t.set_out(l, Output::Sink).unwrap();
        }
        assert!(
            runs(&one, l1).iter().skip(1).all(|r| r.2 < 0),
            "all squashed"
        );
        let back = two.split(l2, at).unwrap();
        let mut restored = round_trip(&two);
        for tick in 0..160 {
            one.advance();
            two.advance();
            restored.advance();
            let mut joined = items(&two, l2);
            joined.extend(items(&two, back).into_iter().map(|(i, p)| (i, p + at)));
            assert_eq!(joined, items(&one, l1), "cut at {at}, tick {tick}");
            assert_eq!(
                encode(&restored),
                encode(&two),
                "cut at {at}, tick {tick}: restored"
            );
        }
        assert!(
            one.count(l1).unwrap() < 10,
            "the line drained into the sink"
        );
    }
}

/// `destroy` returns how many items it removed (and hands each to the callback), turns every
/// `Next(line)` into `DeadEnd`, frees the slot (the id is never reused) and drops the line's
/// segments and tile-index entries.
#[test]
fn surgery_destroy_redirects_outputs() {
    let mut t = Transport::new(8, 256);
    let a = line_with(&mut t, 512, 24, &[(1, 0)]);
    let b = line_with(&mut t, 512, 24, &[(2, 100), (3, 200), (3, 264)]);
    let c = t.create(512, 24).unwrap();
    let d = t.create(512, 24).unwrap();
    t.set_out(b, Output::Next(a)).unwrap();
    t.set_out(c, Output::Next(b)).unwrap();
    t.set_out(d, Output::Next(b)).unwrap();
    t.set_segments(b, &[straight(512, (0, 0), (512, 0))])
        .unwrap();
    let mut seen = Vec::new();
    t.lines_at(TilePos::new(1, 0), &mut |l, o| seen.push((l, o)))
        .unwrap();
    assert_eq!(seen, vec![(b, 256)]);
    t.advance(); // a fresh epoch: nothing below was touched by the set-up
    let mut got = Vec::new();
    assert_eq!(t.destroy(b, &mut |i| got.push(i.0)), Ok(3));
    assert_eq!(got, vec![2, 3, 3]);
    assert_eq!(
        (t.out(c), t.out(d)),
        (Ok(Output::DeadEnd), Ok(Output::DeadEnd))
    );
    assert_eq!(t.out(a), Ok(Output::DeadEnd));
    // M43 review (finding 8): a feeder whose output the destroy changed is touched (M47 reads it);
    // `a` (held at its dead end, not a feeder) is not.
    t.advance();
    assert_eq!((t.touched(c), t.touched(d)), (Ok(true), Ok(true)));
    assert_eq!(t.touched(a), Ok(false));
    assert_eq!(t.items_len(), 1);
    assert_eq!(t.out(b), Err(engine::game::Unknown));
    seen.clear();
    t.lines_at(TilePos::new(1, 0), &mut |l, o| seen.push((l, o)))
        .unwrap();
    assert_eq!(seen, vec![], "the destroyed line's tile entries are gone");
    let mut index = Vec::new();
    t.tile_index_into(&mut index);
    assert!(index.is_empty());
    let e = t.create(512, 24).unwrap();
    assert_eq!(e, LineId(5), "ids are never reused");
    assert_eq!(
        t.segments(e, &mut |_| panic!("a new line has none")),
        Ok(())
    );
    assert_eq!(t.destroy(b, &mut |_| {}), Err(TransportError::NoLine));
    round_trip(&t);
}

/// `insert_at(pos)` lands exactly at `pos` with `SPACING` clear on both sides (63 is too close, 64
/// is not), `pos <= len - 1`; `Full` at `max_items`, `BadItem` for `Item(0)`.
#[test]
fn items_insert_at_room_rule() {
    let mut t = Transport::new(4, 4);
    let a = line_with(&mut t, 512, 24, &[(1, 200)]);
    for pos in [137, 263, 200, 230] {
        assert_eq!(
            t.insert_at(a, pos, Item(2)),
            Err(TransportError::NoRoom),
            "{pos}"
        );
    }
    t.insert_at(a, 136, Item(2)).unwrap();
    t.insert_at(a, 264, Item(2)).unwrap();
    assert_eq!(
        t.insert_at(a, 512, Item(2)),
        Err(TransportError::NoRoom),
        "past len - 1"
    );
    t.insert_at(a, 511, Item(3)).unwrap();
    assert_eq!(items(&t, a), vec![(2, 136), (1, 200), (2, 264), (3, 511)]);
    assert_eq!(t.insert_at(a, 0, Item(3)), Err(TransportError::Full));
    t.remove_at(a, 511).unwrap();
    assert_eq!(t.insert_at(a, 0, Item(0)), Err(TransportError::BadItem));
    t.insert_at(a, 0, Item(3)).unwrap();
    assert_eq!(t.front(a), Ok(Some((Item(3), 0))));
}

/// `remove_at(pos)` takes the nearest item within `SPACING / 2` (the front one on a tie), none
/// beyond; on a squashed pair the strictly nearer one even when it is the rear one. `take_front`
/// removes the front item and leaves every other position as it was.
#[test]
fn items_remove_at_nearest() {
    let mut t = Transport::new(4, 256);
    let a = line_with(&mut t, 1024, 24, &[(1, 100), (2, 164), (3, 300)]);
    assert_eq!(
        t.remove_at(a, 132),
        Ok(Some(Item(1))),
        "a tie: the front one"
    );
    assert_eq!(t.remove_at(a, 132), Ok(Some(Item(2))));
    assert_eq!(t.remove_at(a, 267), Ok(None), "33 away");
    assert_eq!(t.remove_at(a, 268), Ok(Some(Item(3))));
    // A squashed pair from a rescale: 0, 55, 111, 166.
    let b = line_with(&mut t, 295, 8, &[(1, 0), (2, 64), (3, 128), (4, 192)]);
    t.rescale(b, 256).unwrap();
    assert_eq!(
        t.remove_at(b, 90),
        Ok(Some(Item(3))),
        "111 is nearer than 55"
    );
    assert_eq!(items(&t, b), vec![(1, 0), (2, 55), (4, 166)]);
    assert_eq!(runs(&t, b), vec![(1, 1, 0), (2, 1, -9), (4, 1, 47)]);
    // `front` and `take_front`.
    assert_eq!(t.front(b), Ok(Some((Item(1), 0))));
    assert_eq!(t.take_front(b), Ok(Some(Item(1))));
    assert_eq!(items(&t, b), vec![(2, 55), (4, 166)]);
    assert_eq!(runs(&t, b), vec![(2, 1, 55), (4, 1, 47)]);
    let c = line_with(&mut t, 1024, 24, &[(5, 10), (5, 74), (5, 138)]);
    assert_eq!(t.take_front(c), Ok(Some(Item(5))));
    assert_eq!(items(&t, c), vec![(5, 74), (5, 138)]);
    assert_eq!(runs(&t, c), vec![(5, 2, 74)]);
    t.take_front(c).unwrap();
    t.take_front(c).unwrap();
    assert_eq!((t.take_front(c), t.front(c)), (Ok(None), Ok(None)));
    assert_eq!(t.take_front(LineId(77)), Err(TransportError::NoLine));
    round_trip(&t);
}
