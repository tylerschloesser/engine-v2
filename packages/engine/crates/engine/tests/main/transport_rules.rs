//! M42 (docs/decisions/0076-transport-lines-engine-game-split.md, 0077 Amendment A6): the
//! production `engine::transport` against M40's rule table and the store's own invariants.
//!
//! - `transport_rule_cases`: the 20 hand-computed cases of M40's `repr_rule_cases`
//!   (`fixtures/belts/tests/spike_repr.rs` `cases()`, the rule of `tests/common/repr.rs`), same
//!   table, driving `Transport` through `create`/`set_out`/`insert_at`/`insert_back`/`remove_at`/
//!   `advance` and reading back through `items_in`. A case's lines are created in table order, so
//!   table index `i` is `LineId(i + 1)`; items at rest are placed with `insert_at`.
//! - `transport_order_*`: reverse topological order, cycles cut at the lowest id.
//! - `transport_codec_round_trip_and_rejects_spacing_violation`, `transport_full_at_caps`.

use engine::bytes::{ByteReader, SliceSink};
use engine::transport::{
    Item, LineId, Output, SPACING, Transport, TransportError, TransportRead, TransportWrite,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Out {
    DeadEnd,
    Next(u32),
    Sink,
    /// M44: `(target, at)` (the reference test only; the rule table has none).
    Merge(u32, u32),
    /// M44: `(a, b)`.
    Fork(u32, u32),
}

#[derive(Clone)]
enum Op {
    Tick,
    Back(u32, u16, Result<(), TransportError>),
    At(u32, u32, u16, Result<(), TransportError>),
    Remove(u32, u32, Option<u16>),
    Expect(u32, &'static [(u16, u32)]),
    Sunk(u64),
}
use Op::*;

struct LineSpec {
    len: u32,
    speed: u16,
    out: Out,
    items: &'static [(u16, u32)],
}

struct Case {
    name: &'static str,
    lines: Vec<LineSpec>,
    ops: Vec<Op>,
}

fn line(len: u32, speed: u16, out: Out, items: &'static [(u16, u32)]) -> LineSpec {
    LineSpec {
        len,
        speed,
        out,
        items,
    }
}

const OK: Result<(), TransportError> = Ok(());
const NO_ROOM: Result<(), TransportError> = Err(TransportError::NoRoom);

/// M40's table, verbatim (`spike_repr.rs` `cases()`), in this file's own types.
fn cases() -> Vec<Case> {
    use Out::{DeadEnd, Next, Sink};
    vec![
        Case {
            name: "free move",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 500)])],
            ops: vec![Tick, Expect(0, &[(1, 476)])],
        },
        Case {
            name: "dead end stops at 0",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 10)])],
            ops: vec![Tick, Expect(0, &[(1, 0)]), Tick, Expect(0, &[(1, 0)])],
        },
        Case {
            name: "squash against the leader's new position",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 10), (2, 80), (3, 200)])],
            ops: vec![
                Tick,
                Expect(0, &[(1, 0), (2, 64), (3, 176)]),
                Tick,
                Expect(0, &[(1, 0), (2, 64), (3, 152)]),
            ],
        },
        Case {
            name: "squash advance min(speed, gap_after - 64) at speed 8",
            lines: vec![line(512, 8, DeadEnd, &[(1, 4), (2, 70)])],
            ops: vec![Tick, Expect(0, &[(1, 0), (2, 64)])],
        },
        Case {
            name: "squashed pair across a hand-off holds, then closes to 64",
            lines: vec![
                line(512, 8, DeadEnd, &[(1, 300)]),
                line(512, 8, Next(0), &[(2, 0)]),
            ],
            ops: vec![
                At(0, 458, 3, OK),
                Tick,
                Expect(0, &[(1, 292), (3, 450)]),
                Expect(1, &[(2, 0)]),
                Tick,
                Expect(0, &[(1, 284), (3, 442), (2, 506)]),
                Expect(1, &[]),
            ],
        },
        Case {
            name: "speed 72: two items of one run cross and merge on landing",
            lines: vec![
                line(512, 72, DeadEnd, &[]),
                line(512, 72, Next(0), &[(1, 0), (1, 64), (1, 128)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 440), (1, 504)]),
                Expect(1, &[(1, 56)]),
                Tick,
                Expect(0, &[(1, 368), (1, 432), (1, 496)]),
                Expect(1, &[]),
            ],
        },
        Case {
            name: "insert_at refuses at 63, remove_at misses at 33",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100)])],
            ops: vec![
                At(0, 163, 2, NO_ROOM),
                At(0, 37, 2, NO_ROOM),
                Remove(0, 133, None),
                Remove(0, 67, None),
                Expect(0, &[(1, 100)]),
            ],
        },
        Case {
            name: "hand-off into an empty line",
            lines: vec![
                line(512, 24, DeadEnd, &[]),
                line(512, 24, Next(0), &[(1, 10)]),
            ],
            ops: vec![Tick, Expect(0, &[(1, 498)]), Expect(1, &[])],
        },
        Case {
            name: "hand-off squashed against the target's tail",
            lines: vec![
                line(512, 24, DeadEnd, &[(1, 470)]),
                line(512, 24, Next(0), &[(2, 10)]),
            ],
            ops: vec![Tick, Expect(0, &[(1, 446), (2, 510)]), Expect(1, &[])],
        },
        Case {
            name: "hand-off blocked by a full target",
            lines: vec![
                line(256, 24, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                line(512, 24, Next(0), &[(2, 0), (3, 64), (4, 300)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                Expect(1, &[(2, 0), (3, 64), (4, 276)]),
            ],
        },
        Case {
            name: "speed 72: two items cross in one tick",
            lines: vec![
                line(512, 72, DeadEnd, &[]),
                line(512, 72, Next(0), &[(1, 0), (2, 64), (3, 128)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 440), (2, 504)]),
                Expect(1, &[(3, 56)]),
                Tick,
                Expect(0, &[(1, 368), (2, 432), (3, 496)]),
                Expect(1, &[]),
            ],
        },
        Case {
            name: "speed 72: dead end",
            lines: vec![line(512, 72, DeadEnd, &[(1, 30), (2, 100)])],
            ops: vec![Tick, Expect(0, &[(1, 0), (2, 64)])],
        },
        Case {
            name: "sink deletes and counts",
            lines: vec![line(512, 24, Sink, &[(1, 10), (2, 74), (3, 200)])],
            ops: vec![Tick, Expect(0, &[(2, 50), (3, 176)]), Sunk(1)],
        },
        Case {
            name: "speed 72: sink takes two in one tick",
            lines: vec![line(512, 72, Sink, &[(1, 0), (2, 64), (3, 200)])],
            ops: vec![Tick, Expect(0, &[(3, 128)]), Sunk(2)],
        },
        Case {
            name: "insert_back lands at max(len - speed, tail + 64)",
            lines: vec![line(512, 24, DeadEnd, &[])],
            ops: vec![
                Back(0, 1, OK),
                Expect(0, &[(1, 488)]),
                Back(0, 2, NO_ROOM),
                Tick,
                Back(0, 2, NO_ROOM),
                Tick,
                Back(0, 2, OK),
                Expect(0, &[(1, 440), (2, 504)]),
            ],
        },
        Case {
            name: "a compression front packs a dead end",
            lines: vec![line(
                512,
                24,
                DeadEnd,
                &[(1, 100), (1, 200), (1, 300), (2, 400)],
            )],
            ops: [
                vec![Tick; 20],
                vec![
                    Expect(0, &[(1, 0), (1, 64), (1, 128), (2, 192)]),
                    Back(0, 3, OK),
                    Expect(0, &[(1, 0), (1, 64), (1, 128), (2, 192), (3, 488)]),
                ],
            ]
            .concat(),
        },
        Case {
            name: "a jam released from the front",
            lines: vec![
                line(256, 24, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                line(256, 24, Next(0), &[(2, 0), (3, 64), (4, 128), (5, 192)]),
            ],
            ops: vec![
                Tick,
                Remove(0, 0, Some(1)),
                Tick,
                Expect(0, &[(1, 40), (1, 104), (1, 168), (2, 232)]),
                Expect(1, &[(3, 40), (4, 104), (5, 168)]),
            ],
        },
        Case {
            name: "insert_at needs 64 clear on both sides",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100), (2, 300)])],
            ops: vec![
                At(0, 164, 3, OK),
                At(0, 200, 4, NO_ROOM),
                At(0, 236, 4, OK),
                At(0, 300, 6, NO_ROOM),
                At(0, 1024, 5, NO_ROOM),
                At(0, 1023, 5, OK),
                At(0, 50, 6, NO_ROOM),
                At(0, 36, 6, OK),
                Expect(
                    0,
                    &[(6, 36), (1, 100), (3, 164), (4, 236), (2, 300), (5, 1023)],
                ),
            ],
        },
        Case {
            name: "insert_at and remove_at inside a packed same-item stretch",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 0), (1, 128), (1, 192)])],
            ops: vec![
                At(0, 64, 1, OK),
                Expect(0, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                Remove(0, 100, Some(1)),
                Expect(0, &[(1, 0), (1, 64), (1, 192)]),
                Remove(0, 32, Some(1)),
                Expect(0, &[(1, 64), (1, 192)]),
                At(0, 128, 2, OK),
                At(0, 0, 1, OK),
                Expect(0, &[(1, 0), (1, 64), (2, 128), (1, 192)]),
                Tick,
                Expect(0, &[(1, 0), (1, 64), (2, 128), (1, 192)]),
            ],
        },
        Case {
            name: "remove_at takes the nearest within 32",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100), (2, 300)])],
            ops: vec![
                Remove(0, 310, Some(2)),
                Remove(0, 50, None),
                Remove(0, 132, Some(1)),
                Expect(0, &[]),
            ],
        },
    ]
}

fn id(i: u32) -> LineId {
    LineId(i + 1)
}

fn items(t: &Transport, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    t.items_in(l, &mut |item, pos| v.push((item.0, pos)))
        .expect("the line exists");
    v
}

/// Builds a case's lines: created in table order (index `i` is `LineId(i + 1)`), outputs set
/// after every line exists, items at rest placed with `insert_at`.
fn build(lines: &[LineSpec]) -> Transport {
    let mut t = Transport::new(64, 4096);
    for (i, s) in lines.iter().enumerate() {
        assert_eq!(t.create(s.len, s.speed), Ok(id(i as u32)));
    }
    for (i, s) in lines.iter().enumerate() {
        t.set_out(id(i as u32), to_output(s.out)).expect("set_out");
        for &(item, pos) in s.items {
            t.insert_at(id(i as u32), pos, Item(item))
                .expect("items at rest are spaced");
        }
    }
    t
}

fn run_case(c: &Case) {
    let mut t = build(&c.lines);
    for (i, op) in c.ops.iter().enumerate() {
        let at = format!("'{}' op {i}", c.name);
        match *op {
            Tick => {
                t.advance();
            }
            Back(l, item, want) => {
                assert_eq!(t.insert_back(id(l), Item(item)), want, "{at}: insert_back")
            }
            At(l, pos, item, want) => assert_eq!(
                t.insert_at(id(l), pos, Item(item)),
                want,
                "{at}: insert_at {pos}"
            ),
            Remove(l, pos, want) => assert_eq!(
                t.remove_at(id(l), pos),
                Ok(want.map(Item)),
                "{at}: remove_at {pos}"
            ),
            Expect(l, want) => {
                assert_eq!(items(&t, id(l)), want, "{at}: line {l} (item, pos)")
            }
            Sunk(n) => {
                let sunk: u64 = (0..c.lines.len() as u32)
                    .map(|l| t.sunk(id(l)).unwrap())
                    .sum();
                assert_eq!(sunk, n, "{at}: sunk");
            }
        }
    }
    // Every case's end state round-trips through the codec unchanged.
    let back = round_trip(&t);
    for l in 0..c.lines.len() as u32 {
        assert_eq!(items(&back, id(l)), items(&t, id(l)), "'{}': codec", c.name);
    }
}

#[test]
fn transport_rule_cases() {
    let cases = cases();
    assert_eq!(cases.len(), 20, "M40's table has 20 cases");
    for c in &cases {
        run_case(c);
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

fn round_trip(t: &Transport) -> Transport {
    let bytes = encode(t);
    let mut back = Transport::new(64, 4096);
    back.read_canonical(&mut ByteReader::new(&bytes))
        .expect("decodes");
    assert_eq!(encode(&back), bytes, "re-encodes to the same bytes");
    back
}

fn order(t: &mut Transport) -> Vec<u32> {
    let mut v = Vec::new();
    t.order_into(&mut v);
    v.into_iter().map(|l| l.0).collect()
}

/// Two chains and a tree: every line advances after the line it feeds. Literal expectations
/// (0069 §2): roots in ascending id, then depth-first through their feeders.
#[test]
fn transport_order_reverse_topological() {
    let mut t = Transport::new(64, 64);
    // Lines 1..=7. 3 -> 2 -> 1 (1 sinks); 5 -> 4, 6 -> 4 (4 dead-ends); 7 alone.
    for _ in 0..7 {
        t.create(512, 24).unwrap();
    }
    let next = |t: &mut Transport, a: u32, b: u32| {
        t.set_out(LineId(a), Output::Next(LineId(b))).unwrap();
    };
    t.set_out(LineId(1), Output::Sink).unwrap();
    next(&mut t, 2, 1);
    next(&mut t, 3, 2);
    next(&mut t, 5, 4);
    next(&mut t, 6, 4);
    let o = order(&mut t);
    assert_eq!(o, vec![1, 2, 3, 4, 5, 6, 7], "targets before feeders");
    let rank = |l: u32| o.iter().position(|&x| x == l).unwrap();
    for (from, to) in [(2, 1), (3, 2), (5, 4), (6, 4)] {
        assert!(rank(from) > rank(to), "line {from} before its target {to}");
    }
    // Re-pointing an output marks the graph dirty: 1 now feeds 7, so 7 goes first.
    next(&mut t, 1, 7);
    let o = order(&mut t);
    assert_eq!(o, vec![7, 1, 2, 3, 4, 5, 6], "7 now fed by 1 goes first");

    // The order is what `advance` uses: a two-line chain hands off onto a target that has already
    // moved this tick (it lands at `len - overshoot`, not squashed by the target's old tail).
    let mut t = Transport::new(8, 64);
    let feeder = t.create(512, 24).unwrap(); // created first: the lower id
    let target = t.create(512, 24).unwrap();
    t.set_out(feeder, Output::Next(target)).unwrap();
    t.insert_at(target, 400, Item(1)).unwrap(); // moves to 376 this tick
    t.insert_at(feeder, 10, Item(2)).unwrap(); // crosses: 10 - 24 = -14, lands at 498
    t.advance();
    assert_eq!(
        items(&t, target),
        vec![(1, 376), (2, 498)],
        "the target moved first (feeder first would move the landed item on to 474)"
    );
}

/// A cycle is cut at its lowest `LineId`: that line advances first, then the line feeding it, and
/// so on backwards around the cycle. A line feeding the cycle comes after it.
#[test]
fn transport_order_cuts_cycles_at_lowest_id() {
    let mut t = Transport::new(64, 64);
    for _ in 0..5 {
        t.create(512, 24).unwrap();
    }
    // Cycle 4 -> 2 -> 5 -> 4 (lowest id 2), fed by 3; 1 alone.
    let next = |t: &mut Transport, a: u32, b: u32| {
        t.set_out(LineId(a), Output::Next(LineId(b))).unwrap();
    };
    next(&mut t, 4, 2);
    next(&mut t, 2, 5);
    next(&mut t, 5, 4);
    next(&mut t, 3, 4);
    assert_eq!(
        order(&mut t),
        vec![1, 2, 4, 5, 3],
        "cut at 2: 2 first, then 4 (feeds 2), then 5 (feeds 4); 3 feeds the cycle"
    );
    // `Next` into the line itself is not a hand-off M42 runs.
    assert_eq!(
        t.set_out(LineId(1), Output::Next(LineId(1))),
        Err(TransportError::Unsupported)
    );
    // Items circulate around a cycle without loss, and the store stays consistent.
    let mut t = Transport::new(8, 64);
    let a = t.create(256, 24).unwrap();
    let b = t.create(256, 24).unwrap();
    t.set_out(a, Output::Next(b)).unwrap();
    t.set_out(b, Output::Next(a)).unwrap();
    t.insert_at(a, 0, Item(1)).unwrap();
    t.insert_at(b, 100, Item(2)).unwrap();
    for _ in 0..200 {
        t.advance();
    }
    assert_eq!(t.count(a).unwrap() + t.count(b).unwrap(), 2, "nothing lost");
    round_trip(&t);
}

/// Every field round-trips; a later run's `dist` of 0 (two items at one position), a position past
/// `len - 1`, an empty run and `Item(0)` are rejected. M43: a `dist` in `[1, SPACING)` is a
/// squashed pair (`rescale`/`join` keep them), legal state that decodes as a negative gap.
#[test]
fn transport_codec_round_trip_and_rejects_spacing_violation() {
    let mut t = Transport::new(16, 256);
    let a = t.create(1024, 24).unwrap();
    let b = t.create(512, 72).unwrap();
    let c = t.create(300, 8).unwrap();
    t.set_out(b, Output::Next(a)).unwrap();
    t.set_out(c, Output::Sink).unwrap();
    for (pos, item) in [(0, 1), (64, 1), (200, 2), (264, 2), (700, 3)] {
        t.insert_at(a, pos, Item(item)).unwrap();
    }
    t.insert_back(b, Item(4)).unwrap();
    t.insert_at(c, 5, Item(5)).unwrap();
    t.advance(); // c's item sinks (5 - 8 < 0); a is stopped at the front, so its jam cursor is set
    let destroyed = t.create(400, 4).unwrap();
    t.destroy(destroyed, &mut |_| {}).unwrap();
    let back = round_trip(&t);
    for l in [a, b, c] {
        assert_eq!(items(&back, l), items(&t, l));
        assert_eq!(back.out(l), t.out(l));
        assert_eq!(back.speed(l), t.speed(l));
        assert_eq!(back.len(l), t.len(l));
        assert_eq!(back.sunk(l), t.sunk(l));
    }
    assert_eq!(back.sunk(c), Ok(1));
    assert_eq!(back.next_id(), 5, "next_id survives a destroy");
    assert_eq!(back.out(destroyed), Err(engine::game::Unknown));
    // The decoded store advances exactly like the original.
    let (mut t1, mut t2) = (t, back);
    for _ in 0..40 {
        t1.advance();
        t2.advance();
        assert_eq!(encode(&t1), encode(&t2), "restored store diverged");
    }

    // A one-line store with two runs, then each corruption in turn.
    let mut s = Transport::new(4, 16);
    let l = s.create(512, 24).unwrap();
    s.insert_at(l, 10, Item(1)).unwrap();
    s.insert_at(l, 200, Item(2)).unwrap();
    let good = encode(&s);
    // Layout: line_count 4 | id 4 | len 4 | speed 2 | out 1 | sunk 8 | jam 4 | runs 4 |
    // run0: item 2 count 2 dist 4 | run1: item 2 count 2 dist 4 | next_id 4.
    let run0 = 4 + 4 + 4 + 2 + 1 + 8 + 4 + 4;
    let run1 = run0 + 8;
    assert_eq!(
        u32::from_le_bytes(good[run1 + 4..run1 + 8].try_into().unwrap()),
        200 - 10,
        "run1's dist: the distance from the item ahead"
    );
    let corrupt = |at: usize, v: &[u8]| {
        let mut b = good.clone();
        b[at..at + v.len()].copy_from_slice(v);
        let mut t = Transport::new(4, 16);
        t.read_canonical(&mut ByteReader::new(&b))
    };
    assert!(corrupt(0, &[]).is_ok(), "the uncorrupted bytes decode");
    assert_eq!(
        corrupt(run1 + 4, &0u32.to_le_bytes()).err(),
        Some(engine::codec::CodecError::Malformed),
        "two items at one position"
    );
    let mut squashed = good.clone();
    squashed[run1 + 4..run1 + 8].copy_from_slice(&(SPACING - 1).to_le_bytes());
    let mut sq = Transport::new(4, 16);
    sq.read_canonical(&mut ByteReader::new(&squashed))
        .expect("a squashed pair (M43) decodes");
    assert_eq!(runs(&sq, l), vec![(1, 1, 10), (2, 1, -1)], "a negative gap");
    assert_eq!(encode(&sq), squashed, "and re-encodes byte for byte");
    assert!(
        corrupt(run1 + 4, &SPACING.to_le_bytes()).is_ok(),
        "exactly SPACING apart is legal"
    );
    assert!(
        corrupt(run1 + 4, &(512u32 - 10).to_le_bytes()).is_err(),
        "an item at len is past the end"
    );
    assert!(corrupt(run0 + 2, &0u16.to_le_bytes()).is_err(), "count 0");
    assert!(corrupt(run0, &0u16.to_le_bytes()).is_err(), "Item(0)");
    assert!(corrupt(4 + 4 + 4, &0u16.to_le_bytes()).is_err(), "speed 0");
}

/// `create` is `Full` at `max_lines` and `insert_*` at `max_items`; destroying frees both.
#[test]
fn transport_full_at_caps() {
    let mut t = Transport::new(3, 5);
    let a = t.create(1024, 24).unwrap();
    let b = t.create(1024, 24).unwrap();
    let c = t.create(1024, 24).unwrap();
    assert_eq!(t.create(1024, 24), Err(TransportError::Full), "line cap");
    assert_eq!(
        t.create(24, 24),
        Err(TransportError::Full),
        "Full before BadSpeed"
    );
    for pos in [0, 100, 200] {
        t.insert_at(a, pos, Item(1)).unwrap();
    }
    t.insert_back(b, Item(2)).unwrap();
    t.insert_at(c, 0, Item(3)).unwrap();
    assert_eq!(t.items_len(), 5);
    assert_eq!(
        t.insert_back(c, Item(3)),
        Err(TransportError::Full),
        "item cap"
    );
    assert_eq!(
        t.insert_at(b, 0, Item(3)),
        Err(TransportError::Full),
        "item cap"
    );
    let mut got = Vec::new();
    t.destroy(a, &mut |i| got.push(i.0)).unwrap();
    assert_eq!(got, vec![1, 1, 1], "destroy hands back the line's items");
    assert_eq!(t.items_len(), 2);
    let d = t.create(1024, 24).unwrap();
    assert_eq!(d, LineId(4), "ids are never reused");
    t.insert_back(d, Item(4)).unwrap();
    assert_eq!(t.create(1024, 24), Err(TransportError::Full));
    // The other refusals.
    let mut u = Transport::new(4, 4);
    assert_eq!(u.create(24, 24), Err(TransportError::BadSpeed));
    assert_eq!(u.create(24, 0), Err(TransportError::BadSpeed));
    let l = u.create(25, 24).unwrap();
    assert_eq!(u.set_speed(l, 25), Err(TransportError::BadSpeed));
    assert_eq!(u.insert_back(l, Item(0)), Err(TransportError::BadItem));
    assert_eq!(
        u.set_out(l, Output::Fork { a: l, b: l }),
        Err(TransportError::Unsupported),
        "a fork into itself"
    );
    assert_eq!(
        u.insert_back(LineId(9), Item(1)),
        Err(TransportError::NoLine)
    );
}

/// A per-item reference of the same rule (M40's candidate A, written plainly): every line a `Vec`
/// of `(item, pos)` front to back, with its own update order (a recursive Tarjan, not production's
/// iterative `order_into`) and its own reading of the cycle cut (0079 §11 as amended in M44: an
/// item moves at most `speed` in one tick; the first line of a simple `Next` cycle sees its target
/// as it will be after it moves, by dry passes over the per-item lists; an item that crossed the
/// cut moves only the budget it has left). M44: `Merge` and `Fork` written from 0076 §1 and the
/// `Output` docs, not from `advance.rs`.
struct Reference {
    lines: Vec<Option<RefLine>>, // by `LineId - 1`; `None` once destroyed
    sunk: u64,
    /// Items that crossed a cycle cut (non-vacuity of the cut rule).
    cut_landings: u64,
    /// M44 non-vacuity counts, see [`Stat`].
    stats: [u64; 8],
    /// What the item crossing now moved on its feeder this tick.
    moved: i64,
}

/// Indices into `Reference::stats`.
#[derive(Clone, Copy, Debug)]
enum Stat {
    MergeLanded,
    MergeRefused,
    /// A merge landing across a cut in front of the target's rearmost item.
    MergeCutMid,
    ForkPreferred,
    ForkDiverted,
    ForkWaited,
    /// A tick in which one merge or fork line transferred two or more items.
    BigStep,
    /// A fork or merge landing across a cut.
    CutTransfer,
}

struct RefLine {
    len: i64,
    speed: i64,
    out: Out,
    toggle: bool,
    items: Vec<(u16, i64)>,
    /// Positions of the items that crossed a cut onto this line this tick: they move at most
    /// `cap` more (0079 §11 as amended in M44: an item moves at most `speed` in one tick).
    fresh: Vec<i64>,
    /// How many items at the back crossed a cut onto this line this tick (identified by place, not
    /// position: a landing seen against the target's moved tail may share a position with an item
    /// that has not moved yet).
    fresh_back: usize,
    /// `speed - moved` of this tick's cut landings (`moved`: what they moved on their feeder); 0
    /// when two landings disagree.
    cap: Option<i64>,
}

const SP: i64 = SPACING as i64;
const NO_LEADER: i64 = i64::MIN / 4;

impl Reference {
    fn new() -> Self {
        Reference {
            lines: Vec::new(),
            sunk: 0,
            cut_landings: 0,
            stats: [0; 8],
            moved: 0,
        }
    }

    fn line(&self, l: usize) -> &RefLine {
        self.lines[l].as_ref().expect("a live line")
    }

    fn line_mut(&mut self, l: usize) -> &mut RefLine {
        self.lines[l].as_mut().expect("a live line")
    }

    fn create(&mut self, len: i64, speed: i64) {
        self.lines.push(Some(RefLine {
            len,
            speed,
            out: Out::DeadEnd,
            toggle: false,
            items: Vec::new(),
            fresh: Vec::new(),
            fresh_back: 0,
            cap: None,
        }));
    }

    fn succs(&self, l: usize) -> Vec<usize> {
        match self.line(l).out {
            Out::Next(t) | Out::Merge(t, _) => vec![t as usize],
            Out::Fork(a, b) => vec![a as usize, b as usize],
            Out::DeadEnd | Out::Sink => vec![],
        }
    }

    /// Reverse topological, Tarjan's components with roots in ascending id and links in output
    /// order (`a` before `b`). A component of several lines: its lowest id first, then the others in
    /// depth-first post-order from it within the component.
    fn order(&self) -> Vec<usize> {
        struct Tarjan<'a> {
            r: &'a Reference,
            index: Vec<Option<usize>>,
            low: Vec<usize>,
            on_stack: Vec<bool>,
            stack: Vec<usize>,
            counter: usize,
            out: Vec<usize>,
        }
        impl Tarjan<'_> {
            fn strong(&mut self, v: usize) {
                self.index[v] = Some(self.counter);
                self.low[v] = self.counter;
                self.counter += 1;
                self.stack.push(v);
                self.on_stack[v] = true;
                for w in self.r.succs(v) {
                    match self.index[w] {
                        None => {
                            self.strong(w);
                            self.low[v] = self.low[v].min(self.low[w]);
                        }
                        Some(iw) if self.on_stack[w] => self.low[v] = self.low[v].min(iw),
                        Some(_) => {}
                    }
                }
                if Some(self.low[v]) != self.index[v] {
                    return;
                }
                let at = self.stack.iter().position(|&x| x == v).unwrap();
                let comp = self.stack.split_off(at);
                for &x in &comp {
                    self.on_stack[x] = false;
                }
                let lowest = *comp.iter().min().unwrap();
                self.out.push(lowest);
                let mut seen = vec![lowest];
                self.post(lowest, &comp, &mut seen);
            }

            fn post(&mut self, x: usize, comp: &[usize], seen: &mut Vec<usize>) {
                for w in self.r.succs(x) {
                    if comp.contains(&w) && !seen.contains(&w) {
                        seen.push(w);
                        self.post(w, comp, seen);
                        self.out.push(w);
                    }
                }
            }
        }
        let n = self.lines.len();
        let mut tj = Tarjan {
            r: self,
            index: vec![None; n],
            low: vec![0; n],
            on_stack: vec![false; n],
            stack: Vec::new(),
            counter: 0,
            out: Vec::new(),
        };
        for v in 0..n {
            if self.lines[v].is_some() && tj.index[v].is_none() {
                tj.strong(v);
            }
        }
        tj.out
    }

    /// Where line `k`'s rearmost item ends if `k` advanced with front leader `leader`, as its
    /// feeder's leader (`NO_LEADER`: `k` is or ends empty); nothing written.
    fn dry(&self, k: usize, mut leader: i64) -> i64 {
        let line = self.line(k);
        for &(_, pos) in &line.items {
            let bound = leader + SP;
            leader = if pos < bound {
                pos
            } else {
                (pos - line.speed).max(bound)
            };
        }
        if line.items.is_empty() || leader < 0 {
            NO_LEADER
        } else {
            leader - line.len
        }
    }

    /// 0079 §11 as amended in M44: the first line of a simple `Next` cycle (`order[i]`, its
    /// target not advanced yet) sees its target as it will be after it moves: the least
    /// constrained fixed point of dry passes around the cycle in update order, from no leader, at
    /// most four passes; `None` otherwise (the target as it stands).
    fn cut_leader(&self, order: &[usize], i: usize, advanced: &[bool]) -> Option<i64> {
        let l = order[i];
        let Out::Next(t) = self.line(l).out else {
            return None;
        };
        let t = t as usize;
        if advanced[t] || self.line(t).items.is_empty() {
            return None;
        }
        let mut cycle = vec![l];
        let mut x = t;
        while x != l {
            let Out::Next(y) = self.line(x).out else {
                return None;
            };
            cycle.push(x);
            x = y as usize;
            if cycle.len() > self.lines.len() {
                return None;
            }
        }
        // Update order: `L0`, then backwards against the links.
        let want: Vec<usize> = std::iter::once(l)
            .chain(cycle[1..].iter().rev().copied())
            .collect();
        if order.get(i..i + want.len()) != Some(&want[..]) {
            return None;
        }
        let mut lead = NO_LEADER;
        for _ in 0..4 {
            let next = want.iter().fold(lead, |ld, &k| self.dry(k, ld));
            if next == lead {
                return Some(lead);
            }
            lead = next;
        }
        None
    }

    fn advance(&mut self) {
        let mut advanced = vec![false; self.lines.len()];
        let order = self.order();
        for (i, &l) in order.iter().enumerate() {
            let (speed, out) = (self.line(l).speed, self.line(l).out);
            let cut = self.cut_leader(&order, i, &advanced);
            let mut leader = match out {
                Out::DeadEnd => -SP,
                Out::Sink | Out::Merge(..) | Out::Fork(..) => NO_LEADER,
                Out::Next(_) if cut.is_some() => cut.expect("checked"),
                Out::Next(t) => {
                    let t = self.line(t as usize);
                    t.items.last().map_or(NO_LEADER, |&(_, p)| p - t.len)
                }
            };
            let fresh = std::mem::take(&mut self.line_mut(l).fresh);
            let fresh_back = std::mem::take(&mut self.line_mut(l).fresh_back);
            let cap = self.line_mut(l).cap.take().unwrap_or(0);
            let mut transfers = 0;
            let mut k = 0;
            while k < self.line(l).items.len() {
                let (item, pos) = self.line(l).items[k];
                let bound = leader + SP;
                let back = k >= self.line(l).items.len() - fresh_back;
                if back || fresh.contains(&pos) {
                    // Crossed a cut onto this line this tick: moves what is left of its budget,
                    // never across this line's front.
                    let p = if pos < bound {
                        pos
                    } else {
                        (pos - cap).max(bound).max(0)
                    };
                    self.line_mut(l).items[k].1 = p;
                    leader = p;
                    k += 1;
                    continue;
                }
                let mut p = if pos < bound {
                    pos
                } else {
                    (pos - speed).max(bound)
                };
                if p < 0 {
                    self.moved = pos - p;
                    let landed = match out {
                        Out::Merge(t, at) => self.merge(t as usize, at, -p, item, &advanced),
                        Out::Fork(..) => self.fork(l, -p, item, &advanced),
                        _ => true,
                    };
                    if !landed {
                        p = 0;
                    }
                }
                if p >= 0 {
                    self.line_mut(l).items[k].1 = p;
                    leader = p;
                    k += 1;
                    continue;
                }
                self.line_mut(l).items.remove(k);
                leader = p;
                match out {
                    Out::Sink => self.sunk += 1,
                    Out::Next(t) => {
                        let t = t as usize;
                        let tlen = self.line(t).len;
                        self.line_mut(t).items.push((item, tlen + p));
                        if !advanced[t] {
                            self.line_mut(t).fresh_back += 1;
                            self.cut_budget(t);
                            self.cut_landings += 1;
                        }
                    }
                    Out::Merge(..) | Out::Fork(..) => {
                        // It left this line: the next item has no leader.
                        leader = NO_LEADER;
                        transfers += 1;
                    }
                    Out::DeadEnd => unreachable!("a dead end bounds p at 0"),
                }
            }
            if transfers >= 2 {
                self.stats[Stat::BigStep as usize] += 1;
            }
            advanced[l] = true;
        }
    }

    /// A landing across a cut on `t`: its budget is `t.speed - moved`; two landings with
    /// different budgets in one tick leave 0.
    fn cut_budget(&mut self, t: usize) {
        let moved = self.moved;
        let line = self.line_mut(t);
        let cap = (line.speed - moved).max(0);
        line.cap = Some(match line.cap {
            None => cap,
            Some(c) if c == cap => cap,
            Some(_) => 0,
        });
    }

    /// A side-load (0076 §1): `at - o` clamped to the target, iff no item of the target is closer
    /// than `SPACING` to it.
    fn merge(&mut self, t: usize, at: u32, o: i64, item: u16, advanced: &[bool]) -> bool {
        let tl = self.line(t);
        let pos = (i64::from(at) - o).clamp(0, tl.len - 1);
        if tl.items.iter().any(|&(_, q)| (q - pos).abs() < SP) {
            self.stats[Stat::MergeRefused as usize] += 1;
            return false;
        }
        let mid = tl.items.last().is_some_and(|&(_, q)| q > pos);
        let k = tl.items.partition_point(|&(_, q)| q < pos);
        let in_back = k >= tl.items.len() - tl.fresh_back;
        self.line_mut(t).items.insert(k, (item, pos));
        if !advanced[t] {
            if in_back {
                self.line_mut(t).fresh_back += 1;
            } else {
                self.line_mut(t).fresh.push(pos);
            }
            self.cut_budget(t);
            self.stats[Stat::CutTransfer as usize] += 1;
            if mid {
                self.stats[Stat::MergeCutMid as usize] += 1;
            }
        }
        self.stats[Stat::MergeLanded as usize] += 1;
        true
    }

    /// The preferred target's plain hand-off landing, else the other's, else none; the toggle
    /// flips on a preferred delivery only.
    fn fork(&mut self, l: usize, o: i64, item: u16, advanced: &[bool]) -> bool {
        let Out::Fork(a, b) = self.line(l).out else {
            unreachable!()
        };
        let toggle = self.line(l).toggle;
        let (pref, other) = if toggle { (b, a) } else { (a, b) };
        for (k, t) in [pref as usize, other as usize].into_iter().enumerate() {
            let tl = self.line(t);
            let pos = tl.len - o;
            if tl.items.last().is_some_and(|&(_, q)| q + SP > pos) {
                continue;
            }
            self.line_mut(t).items.push((item, pos));
            if !advanced[t] {
                self.line_mut(t).fresh_back += 1;
                self.cut_budget(t);
                self.stats[Stat::CutTransfer as usize] += 1;
            }
            if k == 0 {
                self.line_mut(l).toggle = !toggle;
                self.stats[Stat::ForkPreferred as usize] += 1;
            } else {
                self.stats[Stat::ForkDiverted as usize] += 1;
            }
            return true;
        }
        self.stats[Stat::ForkWaited as usize] += 1;
        false
    }

    fn insert_back(&mut self, l: usize, item: u16) -> Result<(), TransportError> {
        let line = self.line_mut(l);
        let (len, speed) = (line.len, line.speed);
        let land = line.items.last().map_or(len - speed, |&(_, t)| {
            (len - speed).max(t + i64::from(SPACING))
        });
        if land > len - 1 {
            return Err(TransportError::NoRoom);
        }
        line.items.push((item, land));
        Ok(())
    }

    fn insert_at(&mut self, l: usize, pos: i64, item: u16) -> Result<(), TransportError> {
        let line = self.line_mut(l);
        if pos > line.len - 1
            || line
                .items
                .iter()
                .any(|&(_, p)| (p - pos).abs() < i64::from(SPACING))
        {
            return Err(TransportError::NoRoom);
        }
        let k = line.items.partition_point(|&(_, p)| p < pos);
        line.items.insert(k, (item, pos));
        Ok(())
    }

    fn remove_at(&mut self, l: usize, pos: i64) -> Option<u16> {
        let items = &mut self.line_mut(l).items;
        let mut best: Option<(usize, i64)> = None;
        for (k, &(_, p)) in items.iter().enumerate() {
            let d = (p - pos).abs();
            if d <= i64::from(SPACING) / 2 && best.is_none_or(|(_, bd)| d < bd) {
                best = Some((k, d));
            }
        }
        best.map(|(k, _)| items.remove(k).0)
    }

    /// `set_out`'s refusals, written from the rule: no output into itself, a fork's two targets
    /// distinct, `Next` and fork targets at least `speed` long (the hand-off bound; a merge
    /// landing is clamped). A new output clears the toggle.
    fn set_out(&mut self, l: usize, out: Out) -> Result<(), TransportError> {
        let speed = self.line(l).speed;
        let short = |t: u32| self.line(t as usize).len < speed;
        match out {
            Out::Next(t) | Out::Merge(t, _) if t as usize == l => {
                return Err(TransportError::Unsupported);
            }
            Out::Fork(a, b) if a as usize == l || b as usize == l || a == b => {
                return Err(TransportError::Unsupported);
            }
            Out::Next(t) if short(t) => return Err(TransportError::BadSpeed),
            Out::Fork(a, b) if short(a) || short(b) => return Err(TransportError::BadSpeed),
            _ => {}
        }
        let line = self.line_mut(l);
        if line.out != out {
            line.out = out;
            line.toggle = false;
        }
        Ok(())
    }

    fn set_speed(&mut self, l: usize, speed: i64) -> Result<(), TransportError> {
        let line = self.line(l);
        let short = |t: u32| self.line(t as usize).len < speed;
        let short_target = match line.out {
            Out::Next(t) => short(t),
            Out::Fork(a, b) => short(a) || short(b),
            _ => false,
        };
        if speed >= line.len || short_target {
            return Err(TransportError::BadSpeed);
        }
        self.line_mut(l).speed = speed;
        Ok(())
    }

    fn destroy(&mut self, l: usize) -> Vec<u16> {
        let gone = self.lines[l].take().expect("a live line");
        let l = l as u32;
        for line in self.lines.iter_mut().flatten() {
            match line.out {
                Out::Next(t) | Out::Merge(t, _) if t == l => line.out = Out::DeadEnd,
                Out::Fork(a, b) if a == l || b == l => {
                    line.out = Out::Next(if a == l { b } else { a });
                    line.toggle = false;
                }
                _ => {}
            }
        }
        gone.items.into_iter().map(|(i, _)| i).collect()
    }
}

/// M43's surgery on the reference, written from 0076 §3 and the doc comments of
/// `TransportWrite` (not from `surgery.rs`): items are `(item, pos)` front to back, so a squashed
/// pair is just two positions closer than `SPACING`, which the reference's own rule resolves.
/// M44: the redirects of `surgery.rs`'s module doc for `Merge` and `Fork`.
impl Reference {
    /// Whether `x` feeds `l` under the hand-off bound (`Next` or either fork target).
    fn feeds(&self, x: &RefLine, l: usize) -> bool {
        let _ = self;
        let l = l as u32;
        match x.out {
            Out::Next(t) => t == l,
            Out::Fork(a, b) => a == l || b == l,
            _ => false,
        }
    }

    /// `speed < len` and every feeder at most `len` per tick (0079 §8).
    fn len_ok(&self, l: usize, len: i64) -> Result<(), TransportError> {
        let feeders_fit = self
            .lines
            .iter()
            .flatten()
            .all(|x| !self.feeds(x, l) || x.speed <= len);
        if len <= self.line(l).speed || !feeders_fit {
            return Err(TransportError::BadSpeed);
        }
        Ok(())
    }

    /// Every output naming `from` names `to`; a merge's entry point maps through `at_map` (`None`:
    /// it stays on `from`); a fork left with one target twice becomes `Next`.
    fn redirect(&mut self, from: usize, to: usize, at_map: impl Fn(u32) -> Option<u32>) {
        let (from, to) = (from as u32, to as u32);
        for x in self.lines.iter_mut().flatten() {
            match x.out {
                Out::Next(t) if t == from => x.out = Out::Next(to),
                Out::Merge(t, at) if t == from => {
                    if let Some(at) = at_map(at) {
                        x.out = Out::Merge(to, at);
                    }
                }
                Out::Fork(a, b) if a == from || b == from => {
                    let (a, b) = (
                        if a == from { to } else { a },
                        if b == from { to } else { b },
                    );
                    if a == b {
                        x.out = Out::Next(a);
                        x.toggle = false;
                    } else {
                        x.out = Out::Fork(a, b);
                    }
                }
                _ => {}
            }
        }
    }

    fn split(&mut self, l: usize, at: i64) -> Result<usize, TransportError> {
        let (len, speed) = (self.line(l).len, self.line(l).speed);
        if at <= speed || at >= len {
            return Err(TransportError::BadSpeed);
        }
        self.len_ok(l, len - at)?;
        let n = self.lines.len();
        let line = self.line_mut(l);
        let k = line.items.partition_point(|&(_, p)| p < at);
        let back = line.items.split_off(k);
        line.len = at;
        let cut = at as u32;
        self.redirect(l, n, |m| m.checked_sub(cut));
        self.lines.push(Some(RefLine {
            len: len - at,
            speed,
            out: Out::Next(l as u32),
            toggle: false,
            items: back.into_iter().map(|(i, p)| (i, p - at)).collect(),
            fresh: Vec::new(),
            fresh_back: 0,
            cap: None,
        }));
        Ok(n)
    }

    fn join(&mut self, front: usize, back: usize) -> Result<(), TransportError> {
        if !matches!(self.line(back).out, Out::Next(f) if f as usize == front) {
            return Err(TransportError::NotLinked);
        }
        let b = back as u32;
        let feeds_back = match self.line(front).out {
            Out::Next(t) | Out::Merge(t, _) => t == b,
            Out::Fork(x, y) => x == b || y == b,
            _ => false,
        };
        if feeds_back {
            return Err(TransportError::Unsupported);
        }
        let gone = self.lines[back].take().expect("a live line");
        let f = self.line_mut(front);
        let flen = f.len;
        f.items
            .extend(gone.items.into_iter().map(|(i, p)| (i, p + flen)));
        f.len += gone.len;
        self.redirect(back, front, |m| Some(m.saturating_add(flen as u32)));
        Ok(())
    }

    /// A merge's entry point follows its target's positions; `None`: it fell off (`DeadEnd`).
    fn move_merge_points(&mut self, target: usize, f: impl Fn(u32) -> Option<u32>) {
        for x in self.lines.iter_mut().flatten() {
            if let Out::Merge(t, at) = x.out
                && t as usize == target
            {
                x.out = f(at).map_or(Out::DeadEnd, |at| Out::Merge(t, at));
            }
        }
    }

    fn extend(&mut self, l: usize, by: i64, at_front: bool) {
        if at_front {
            self.move_merge_points(l, |at| Some(at.saturating_add(by as u32)));
        }
        let line = self.line_mut(l);
        line.len += by;
        if at_front {
            for it in &mut line.items {
                it.1 += by;
            }
        }
    }

    fn shrink(&mut self, l: usize, by: i64, at_front: bool) -> Result<(), TransportError> {
        let new_len = self.line(l).len - by;
        self.len_ok(l, new_len)?;
        let line = self.line_mut(l);
        let off = match (at_front, line.items.first(), line.items.last()) {
            (true, Some(&(_, p)), _) => p < by,
            (false, _, Some(&(_, p))) => p > new_len - 1,
            _ => false,
        };
        if off {
            return Err(TransportError::NotEmpty);
        }
        line.len = new_len;
        if at_front {
            for it in &mut line.items {
                it.1 -= by;
            }
            self.move_merge_points(l, |at| at.checked_sub(by as u32));
        }
        Ok(())
    }

    /// `floor(pos x new / old)`; `NoRoom` if two items would share a position. Returns whether a
    /// pair ended up closer than `SPACING` (a squashed pair).
    fn rescale(&mut self, l: usize, new_len: i64) -> Result<bool, TransportError> {
        self.len_ok(l, new_len)?;
        let line = self.line_mut(l);
        let old = line.len;
        let scaled: Vec<i64> = line.items.iter().map(|&(_, p)| p * new_len / old).collect();
        if scaled.windows(2).any(|w| w[1] <= w[0]) {
            return Err(TransportError::NoRoom);
        }
        for (it, p) in line.items.iter_mut().zip(&scaled) {
            it.1 = *p;
        }
        line.len = new_len;
        let squashed = scaled.windows(2).any(|w| w[1] - w[0] < i64::from(SPACING));
        self.move_merge_points(l, |at| {
            Some((i64::from(at) * new_len / old).min(i64::from(u32::MAX)) as u32)
        });
        Ok(squashed)
    }
}

fn to_output(out: Out) -> Output {
    match out {
        Out::DeadEnd => Output::DeadEnd,
        Out::Sink => Output::Sink,
        Out::Next(a) => Output::Next(LineId(a + 1)),
        Out::Merge(t, at) => Output::Merge {
            line: LineId(t + 1),
            at,
        },
        Out::Fork(a, b) => Output::Fork {
            a: LineId(a + 1),
            b: LineId(b + 1),
        },
    }
}

/// The production store against the per-item reference, which owns its own update order: seeded
/// random chains with mixed speeds (8, 24 and 72 in one path) and lengths down to half a tile,
/// sinks, dead ends, a three-line cycle; 40 random `insert_back`/`insert_at`/`remove_at` every tick
/// and, on random ticks, `set_out`, `set_speed`, `create` and `destroy` (each refusal compared
/// too); every live line compared every tick for 400 ticks, and the codec round trip at the end.
/// M43 adds surgery outside the cycle: a `split` or a `join` every 20 ticks, an `extend_*` or a
/// `shrink_*` every 30, a `rescale` every 50 (squashed pairs included), each refusal compared.
/// M44 adds `Merge` and `Fork`: eight feeders at speeds 24, 72 and 96 merging or forking into the
/// chains, a cycle cut on a merge (landings in the middle of a line that has not advanced) and a
/// cycle cut on a fork, a random `set_out` to and from both outputs on a third of the ticks (each
/// refusal compared), every toggle and output (the surgery redirects) compared every tick, and
/// counts proving each branch ran.
#[test]
fn transport_matches_per_item_reference() {
    let mut rng = engine::rng::SimRng::new(11);
    let mut t = Transport::new(512, 1 << 16);
    let mut r = Reference::new();
    let speeds = [8i64, 24, 72];
    let lens = [128i64, 256, 512, 1024, 1536];
    let create = |t: &mut Transport, r: &mut Reference, len: i64, speed: i64| {
        let id = t.create(len as u32, speed as u16).unwrap();
        assert_eq!(id.0 as usize, r.lines.len() + 1);
        r.create(len, speed);
        (id.0 - 1) as usize
    };
    let set_out = |t: &mut Transport, r: &mut Reference, l: usize, out: Out| {
        let want = r.set_out(l, out);
        assert_eq!(
            t.set_out(LineId(l as u32 + 1), to_output(out)),
            want,
            "set_out {l}"
        );
        want
    };
    let mut bound_refusals = 0u32;
    // Successful splits, joins, extends, shrinks; shrinks refused `NotEmpty`; squashing rescales.
    let mut surgery = [0u32; 6];
    // Its own stream, so the M42 part of the script draws what it drew before M43.
    let mut srng = engine::rng::SimRng::new(43);
    while r.lines.len() < 60 {
        let chain = 1 + rng.below(4) as usize;
        let ends = [Out::DeadEnd, Out::Sink];
        let end = ends[rng.below(2) as usize];
        let mut ahead: Option<usize> = None;
        for _ in 0..chain {
            let len = lens[rng.below(5) as usize];
            let speed = speeds[rng.below(3) as usize];
            let l = create(&mut t, &mut r, len, speed);
            let out = ahead.map_or(end, |a| Out::Next(a as u32));
            set_out(&mut t, &mut r, l, out).unwrap();
            ahead = Some(l);
        }
    }
    // A three-line cycle with mixed speeds, the fastest on the cut (its lowest id).
    let c: Vec<usize> = (0..3)
        .map(|k| create(&mut t, &mut r, 512, speeds[2 - k]))
        .collect();
    for k in 0..3 {
        set_out(&mut t, &mut r, c[k], Out::Next(c[(k + 1) % 3] as u32)).unwrap();
    }
    // M44, on its own stream. A cycle cut on a merge: x (lowest id, speed 96) side-loads into the
    // middle of y, which runs into z and back to x; y is fed at its back, so x's landings on y
    // (which has not advanced yet) fall in front of y's rearmost item.
    let mut orng = engine::rng::SimRng::new(44);
    let m: Vec<usize> = [(512, 96), (1024, 24), (512, 72)]
        .into_iter()
        .map(|(len, speed)| create(&mut t, &mut r, len, speed))
        .collect();
    set_out(&mut t, &mut r, m[0], Out::Merge(m[1] as u32, 700)).unwrap();
    set_out(&mut t, &mut r, m[1], Out::Next(m[2] as u32)).unwrap();
    set_out(&mut t, &mut r, m[2], Out::Next(m[0] as u32)).unwrap();
    // A cycle cut on a fork: f (lowest, speed 96) forks to a and b; a runs back to f, b side-loads
    // onto a.
    let fk: Vec<usize> = [(512, 96), (512, 72), (768, 24)]
        .into_iter()
        .map(|(len, speed)| create(&mut t, &mut r, len, speed))
        .collect();
    set_out(&mut t, &mut r, fk[0], Out::Fork(fk[1] as u32, fk[2] as u32)).unwrap();
    set_out(&mut t, &mut r, fk[1], Out::Next(fk[0] as u32)).unwrap();
    set_out(&mut t, &mut r, fk[2], Out::Merge(fk[1] as u32, 300)).unwrap();
    let protected: Vec<usize> = [&c[..], &m[..], &fk[..]].concat();
    // Eight feeders into the chains (`set_out` may refuse a fork onto a short line: compared).
    let chains: Vec<usize> = (0..60).collect();
    for k in 0..8 {
        let speed = [24i64, 72, 96][k % 3];
        let l = create(&mut t, &mut r, lens[2 + orng.below(3) as usize], speed);
        let a = chains[orng.below(60) as usize] as u32;
        let b = chains[orng.below(60) as usize] as u32;
        let len = r.line(a as usize).len as u32;
        let out = if k % 2 == 0 {
            Out::Merge(a, orng.below(len + 128))
        } else {
            Out::Fork(a, b)
        };
        let _ = set_out(&mut t, &mut r, l, out);
    }
    let mut out_changes = [0u32; 2]; // merges and forks set by the random `set_out`

    let live = |r: &Reference| -> Vec<usize> {
        (0..r.lines.len())
            .filter(|&l| r.lines[l].is_some())
            .collect()
    };
    for tick in 0..400 {
        // The cycles stay cycles (mutations pick other lines) and are kept fed but sparse (a
        // full loop jams), so items keep crossing their cuts.
        let alive: Vec<usize> = live(&r)
            .into_iter()
            .filter(|l| !protected.contains(l))
            .collect();
        let pick = |rng: &mut engine::rng::SimRng| alive[rng.below(alive.len() as u32) as usize];
        let in_cycle: usize = c.iter().map(|&l| r.line(l).items.len()).sum();
        for &l in c.iter().filter(|_| in_cycle < 8) {
            let item = 1 + rng.below(3) as u16;
            assert_eq!(
                t.insert_back(LineId(l as u32 + 1), Item(item)),
                r.insert_back(l, item),
                "tick {tick}: cycle feed {l}"
            );
        }
        for cycle in [&m, &fk] {
            let held: usize = cycle.iter().map(|&l| r.line(l).items.len()).sum();
            if held < 6 {
                let l = cycle[1];
                let item = 1 + orng.below(3) as u16;
                assert_eq!(
                    t.insert_back(LineId(l as u32 + 1), Item(item)),
                    r.insert_back(l, item),
                    "tick {tick}: M44 cycle feed {l}"
                );
            }
        }
        // M44: a random output to or from `Merge`/`Fork` (targets anywhere, the line itself
        // included: its refusal is compared).
        if orng.below(3) == 0 {
            let l = pick(&mut orng);
            let all = live(&r);
            let mut any = || all[orng.below(all.len() as u32) as usize] as u32;
            let (a, b) = (any(), any());
            let len = r.line(a as usize).len as u32;
            let out = match orng.below(6) {
                0 | 1 => Out::Merge(a, orng.below(len + 128)),
                2 | 3 => Out::Fork(a, b),
                4 => Out::Next(a),
                _ => [Out::DeadEnd, Out::Sink][orng.below(2) as usize],
            };
            if set_out(&mut t, &mut r, l, out).is_ok() {
                match out {
                    Out::Merge(..) => out_changes[0] += 1,
                    Out::Fork(..) => out_changes[1] += 1,
                    _ => {}
                }
            }
        }
        if rng.below(2) == 0 {
            let l = pick(&mut rng);
            match rng.below(5) {
                0 => {
                    let target = pick(&mut rng) as u32;
                    let outs = [Out::DeadEnd, Out::Sink, Out::Next(target)];
                    if set_out(&mut t, &mut r, l, outs[rng.below(3) as usize])
                        == Err(TransportError::BadSpeed)
                    {
                        bound_refusals += 1;
                    }
                }
                1 => {
                    let s = [8i64, 24, 72, 200][rng.below(4) as usize];
                    let want = r.set_speed(l, s);
                    assert_eq!(
                        t.set_speed(LineId(l as u32 + 1), s as u16),
                        want,
                        "set_speed"
                    );
                    if want == Err(TransportError::BadSpeed) {
                        bound_refusals += 1;
                    }
                }
                2 => {
                    let len = lens[rng.below(5) as usize];
                    let speed = speeds[rng.below(3) as usize];
                    let n = create(&mut t, &mut r, len, speed);
                    if set_out(&mut t, &mut r, n, Out::Next(l as u32))
                        == Err(TransportError::BadSpeed)
                    {
                        bound_refusals += 1;
                    }
                }
                _ if alive.len() > 40 => {
                    let mut got = Vec::new();
                    t.destroy(LineId(l as u32 + 1), &mut |i| got.push(i.0))
                        .unwrap();
                    assert_eq!(got, r.destroy(l), "tick {tick}: destroy {l}");
                }
                _ => {}
            }
        }
        // M43: surgery (before `advance`, as from `G::tick`), never on the cycle.
        let alive: Vec<usize> = live(&r)
            .into_iter()
            .filter(|l| !protected.contains(l))
            .collect();
        let pick = |rng: &mut engine::rng::SimRng| alive[rng.below(alive.len() as u32) as usize];
        if tick % 20 == 10 {
            if srng.below(2) == 0 {
                let l = pick(&mut srng);
                let at = srng.below(r.line(l).len as u32);
                let want = r.split(l, i64::from(at));
                let got = t.split(LineId(l as u32 + 1), at);
                assert_eq!(
                    got,
                    want.map(|n| LineId(n as u32 + 1)),
                    "tick {tick}: split {l}"
                );
                surgery[0] += u32::from(got.is_ok());
            } else {
                let backs: Vec<usize> = alive
                    .iter()
                    .copied()
                    .filter(
                        |&b| matches!(r.line(b).out, Out::Next(f) if !protected.contains(&(f as usize))),
                    )
                    .collect();
                if !backs.is_empty() {
                    let b = backs[srng.below(backs.len() as u32) as usize];
                    let Out::Next(f) = r.line(b).out else {
                        unreachable!()
                    };
                    let want = r.join(f as usize, b);
                    let got = t.join(LineId(f + 1), LineId(b as u32 + 1));
                    assert_eq!(got, want, "tick {tick}: join {f} {b}");
                    surgery[1] += u32::from(got.is_ok());
                }
            }
        }
        if tick % 30 == 15 {
            for _ in 0..3 {
                let l = pick(&mut srng);
                let id = LineId(l as u32 + 1);
                let by = srng.below(256);
                let at_front = srng.below(2) == 0;
                if srng.below(2) == 0 {
                    r.extend(l, i64::from(by), at_front);
                    let got = if at_front {
                        t.extend_front(id, by)
                    } else {
                        t.extend_back(id, by)
                    };
                    assert_eq!(got, Ok(()), "tick {tick}: extend {l}");
                    surgery[2] += 1;
                } else {
                    let want = r.shrink(l, i64::from(by), at_front);
                    let got = if at_front {
                        t.shrink_front(id, by)
                    } else {
                        t.shrink_back(id, by)
                    };
                    assert_eq!(got, want, "tick {tick}: shrink {l} by {by}");
                    surgery[3] += u32::from(got.is_ok());
                    surgery[4] += u32::from(got == Err(TransportError::NotEmpty));
                }
            }
        }
        if tick % 50 == 25 {
            for _ in 0..3 {
                let l = pick(&mut srng);
                let new_len = (r.line(l).len * i64::from(5 + srng.below(7)) / 8) as u32;
                let want = r.rescale(l, i64::from(new_len));
                let got = t.rescale(LineId(l as u32 + 1), new_len);
                assert_eq!(
                    got,
                    want.map(|_| ()),
                    "tick {tick}: rescale {l} to {new_len}"
                );
                surgery[5] += u32::from(want == Ok(true));
            }
        }
        let alive = live(&r);
        for _ in 0..40 {
            let l = alive[rng.below(alive.len() as u32) as usize];
            let item = 1 + rng.below(3) as u16; // few kinds: long same-kind runs
            let id = LineId(l as u32 + 1);
            let len = r.line(l).len as u32;
            match rng.below(4) {
                0 | 1 => assert_eq!(
                    t.insert_back(id, Item(item)),
                    r.insert_back(l, item),
                    "tick {tick}: insert_back line {l}"
                ),
                2 => {
                    let pos = rng.below(len);
                    assert_eq!(
                        t.insert_at(id, pos, Item(item)),
                        r.insert_at(l, i64::from(pos), item),
                        "tick {tick}: insert_at line {l} {pos}"
                    );
                }
                _ => {
                    let pos = rng.below(len);
                    assert_eq!(
                        t.remove_at(id, pos),
                        Ok(r.remove_at(l, i64::from(pos)).map(Item)),
                        "tick {tick}: remove_at line {l} {pos}"
                    );
                }
            }
        }
        t.advance();
        r.advance();
        for l in live(&r) {
            let want: Vec<(u16, u32)> = r
                .line(l)
                .items
                .iter()
                .map(|&(i, p)| (i, p as u32))
                .collect();
            assert_eq!(
                items(&t, LineId(l as u32 + 1)),
                want,
                "tick {tick}: line {l}"
            );
            assert_eq!(
                t.toggle(LineId(l as u32 + 1)),
                Ok(r.line(l).toggle),
                "tick {tick}: toggle {l}"
            );
            assert_eq!(
                t.out(LineId(l as u32 + 1)),
                Ok(to_output(r.line(l).out)),
                "tick {tick}: output {l}"
            );
        }
    }
    let sunk: u64 = live(&r)
        .iter()
        .map(|&l| t.sunk(LineId(l as u32 + 1)).unwrap())
        .sum();
    assert!(sunk > 100, "the world sank only {sunk} items");
    assert!(
        r.sunk >= sunk,
        "destroyed sinks took their counts with them"
    );
    assert!(
        r.cut_landings > 20,
        "only {} items crossed a cycle cut",
        r.cut_landings
    );
    assert!(bound_refusals >= 3, "only {bound_refusals} speed refusals");
    assert!(
        surgery.iter().all(|&n| n >= 4),
        "surgery too rare: {surgery:?} (split, join, extend, shrink, shrink refused, squashing rescale)"
    );
    // M44 non-vacuity: every merge and fork branch ran, across cuts too, with big steps.
    let mins = [
        (Stat::MergeLanded, 100),
        (Stat::MergeRefused, 20),
        (Stat::MergeCutMid, 5),
        (Stat::ForkPreferred, 50),
        (Stat::ForkDiverted, 10),
        (Stat::ForkWaited, 10),
        (Stat::BigStep, 10),
        (Stat::CutTransfer, 20),
    ];
    for (stat, min) in mins {
        assert!(
            r.stats[stat as usize] >= min,
            "{stat:?} ran {} times (< {min}): {:?}",
            r.stats[stat as usize],
            r.stats
        );
    }
    assert!(
        out_changes.iter().all(|&n| n >= 10),
        "random merges and forks set: {out_changes:?}"
    );
    round_trip(&t);
}

/// 0079 §5: the arena `Host::init`'s memory-split check counts, at literal sizes: a line costs
/// 88 B (record; M44 added the fork's second target slot, its toggle and the cut's mid-line
/// landing count) + 8 (index) + 4 (order) + 17 (Tarjan scratch) + 4 x 32 (segment pool, M43) +
/// 8 x 16 (tile index, M43) = 373 B, a run node 16 B plus one spare node (none at 0 items), and
/// the tile index's merge room, `MAX_LINE_TILES` x 16 = 65,536 B (none at 0 lines). At the
/// recommended caps: 32,768 x 373 + 262,145 x 16 + 65,536 = 16,482,320 B.
#[test]
fn transport_reserved_bytes_at_the_defaults() {
    assert_eq!(Transport::reserved_bytes(0, 0), 0);
    assert_eq!(Transport::reserved_bytes(1, 0), 373 + 65_536);
    assert_eq!(Transport::reserved_bytes(0, 1), 32);
    assert_eq!(
        Transport::reserved_bytes(
            engine::transport::DEFAULT_MAX_LINES,
            engine::transport::DEFAULT_MAX_ITEMS
        ),
        16_482_320
    );
}

/// 0079 (M42 review, finding 8; §11 as amended in M44): an item that crosses a cycle's cut lands on
/// a line that has not advanced yet this tick and moves no more than its tick's travel. Three lines of 512 in a loop at speed 24, four
/// items of distinct kinds spread around it: over 100 ticks every item moves exactly 24 per tick
/// along the loop (never 48 at the cut), and the items stay at least `SPACING` apart.
#[test]
fn transport_cycle_cut_moves_every_item_exactly_speed() {
    let mut t = Transport::new(8, 64);
    let ls: Vec<LineId> = (0..3).map(|_| t.create(512, 24).unwrap()).collect();
    for k in 0..3 {
        t.set_out(ls[k], Output::Next(ls[(k + 1) % 3])).unwrap();
    }
    // Loop coordinate: line k's position p sits at `p - 512 k (mod 1536)`; a crossing from line k
    // (p < 0) lands on line k + 1 at `512 + p`, the same loop coordinate.
    const LOOP: i64 = 1536;
    let coords = |t: &Transport| -> Vec<(u16, i64)> {
        let mut v = Vec::new();
        for (k, &l) in ls.iter().enumerate() {
            t.items_in(l, &mut |i, p| {
                v.push((i.0, (i64::from(p) - 512 * k as i64).rem_euclid(LOOP)))
            })
            .unwrap();
        }
        v.sort();
        v
    };
    for (k, pos) in [(0, 30), (0, 400), (1, 200), (2, 500)] {
        t.insert_at(ls[k], pos, Item(k as u16 * 10 + (pos / 100) as u16 + 1))
            .unwrap();
    }
    let mut before = coords(&t);
    assert_eq!(before.len(), 4);
    for tick in 0..100 {
        t.advance();
        let after = coords(&t);
        assert_eq!(after.len(), 4, "tick {tick}: an item was lost");
        for (&(item, g0), &(item1, g1)) in before.iter().zip(&after) {
            assert_eq!(item, item1);
            assert_eq!(
                (g0 - g1).rem_euclid(LOOP),
                24,
                "tick {tick}: item {item} moved {} along the loop",
                (g0 - g1).rem_euclid(LOOP)
            );
        }
        let mut gs: Vec<i64> = after.iter().map(|&(_, g)| g).collect();
        gs.sort();
        for w in 0..gs.len() {
            let gap = (gs[(w + 1) % gs.len()] - gs[w]).rem_euclid(LOOP);
            assert!(gap >= i64::from(SPACING), "tick {tick}: spacing {gap}");
        }
        before = after;
    }
}

/// M42 review (finding 1): a plain `Next` needs `target.len >= feeder.speed`, so a landing
/// `target.len + p` (`p >= -speed`) is never negative. The review's sequence is refused at
/// `set_out`; a target exactly `speed` long receives the item at 0; `set_speed` and decode hold the
/// same bound.
#[test]
fn transport_handoff_needs_target_len_at_least_speed() {
    let mut t = Transport::new(8, 64);
    let a = t.create(1000, 200).unwrap();
    let b = t.create(100, 50).unwrap();
    assert_eq!(t.set_out(a, Output::Next(b)), Err(TransportError::BadSpeed));

    let c = t.create(200, 50).unwrap();
    t.set_out(a, Output::Next(c)).unwrap();
    t.insert_at(a, 0, Item(1)).unwrap();
    t.advance(); // p = 0 - 200 = -200, landing at 200 - 200 = 0
    assert_eq!(items(&t, c), vec![(1, 0)]);
    assert_eq!(items(&t, a), vec![]);
    assert_eq!(
        t.set_speed(a, 201),
        Err(TransportError::BadSpeed),
        "c is 200 long"
    );
    assert_eq!(t.set_speed(a, 200), Ok(()));

    // Decode: a stored `Next` onto a target shorter than the feeder's speed is malformed.
    let mut s = Transport::new(4, 4);
    let a = s.create(1000, 200).unwrap();
    let b = s.create(200, 50).unwrap();
    s.set_out(a, Output::Next(b)).unwrap();
    let mut bytes = encode(&s);
    // line_count 4 | a: id 4, len 4, speed 2, out 1 + 4, sunk 8, jam 4, runs 4 | b: id 4, len 4.
    let b_len = 4 + 31 + 4;
    assert_eq!(
        u32::from_le_bytes(bytes[b_len..b_len + 4].try_into().unwrap()),
        200
    );
    bytes[b_len..b_len + 4].copy_from_slice(&199u32.to_le_bytes());
    assert_eq!(
        Transport::new(4, 4)
            .read_canonical(&mut ByteReader::new(&bytes))
            .err(),
        Some(engine::codec::CodecError::Malformed)
    );
}

/// M42 review (finding 5): decode checks the `jam` cursor's invariant (every run strictly between
/// the front run and the cursor has gap 0). A stopped line whose second run still has a gap,
/// stored with the cursor past it, is malformed; the honest encoding decodes.
#[test]
fn transport_codec_rejects_a_jam_cursor_past_a_gap() {
    let mut t = Transport::new(4, 16);
    let l = t.create(1024, 24).unwrap();
    t.insert_at(l, 0, Item(1)).unwrap();
    t.insert_at(l, 64, Item(2)).unwrap();
    t.insert_at(l, 600, Item(3)).unwrap();
    t.insert_at(l, 900, Item(1)).unwrap();
    t.advance(); // front held at 0: the cursor is set at the third run (the first with a gap)
    let good = encode(&t);
    // line_count 4 | id 4, len 4, speed 2, out 1, sunk 8 | jam 4
    let jam = 4 + 4 + 4 + 2 + 1 + 8;
    assert_eq!(
        u32::from_le_bytes(good[jam..jam + 4].try_into().unwrap()),
        2
    );
    let decode = |b: &[u8]| Transport::new(4, 16).read_canonical(&mut ByteReader::new(b));
    assert!(decode(&good).is_ok());
    // 3: a real run (the fourth), but the third, between it and the front, has a gap.
    // `u32::MAX`: "all packed". 4: past the runs.
    for bad in [3, u32::MAX, 4] {
        let mut b = good.clone();
        b[jam..jam + 4].copy_from_slice(&bad.to_le_bytes());
        assert_eq!(
            decode(&b).err(),
            Some(engine::codec::CodecError::Malformed),
            "cursor {bad} skips the gapped run"
        );
    }
}

fn runs(t: &Transport, l: LineId) -> Vec<(u16, u16, i32)> {
    let mut v = Vec::new();
    t.runs_in(l, &mut |i, c, g| v.push((i.0, c, g))).unwrap();
    v
}

/// A line packed with `n` items of kind 1 from position `from` (one run once merged).
fn packed(len: u32, n: u32, from: u32) -> (Transport, LineId) {
    let mut t = Transport::new(4, 65_536);
    let l = t.create(len, 24).unwrap();
    for k in 0..n {
        t.insert_at(l, from + k * SPACING, Item(1)).unwrap();
    }
    (t, l)
}

/// 0077 A6b (ii) (M42 review, finding 6a): every run merge guards `count` against `u16`
/// overflow. Each of the five merge sites is driven to the boundary: the count stays at
/// `u16::MAX` and a second run holds the rest, positions unchanged.
#[test]
fn transport_merges_stop_at_u16_max() {
    const MAX: u16 = u16::MAX;
    let full = u32::from(MAX); // 65,535 items
    let long = 4_300_000;

    // `insert_at` onto the back of a full run (merge_prev).
    let (mut t, l) = packed(long, full, 0);
    assert_eq!(runs(&t, l), vec![(1, MAX, 0)]);
    t.insert_at(l, full * SPACING, Item(1)).unwrap();
    assert_eq!(runs(&t, l), vec![(1, MAX, 0), (1, 1, 0)]);

    // `insert_at` in front of a full run (merge_succ).
    let (mut t, l) = packed(long, full, SPACING);
    t.insert_at(l, 0, Item(1)).unwrap();
    assert_eq!(runs(&t, l), vec![(1, 1, 0), (1, MAX, 0)]);

    // `insert_at` into a one-slot hole whose two sides would sum past the limit (merge_prev, then
    // the second merge refused).
    let (mut t, l) = packed(long, 100, 0);
    for k in 0..full - 100 {
        t.insert_at(l, (101 + k) * SPACING, Item(1)).unwrap();
    }
    assert_eq!(
        runs(&t, l),
        vec![(1, 100, 0), (1, MAX - 100, SPACING as i32)]
    );
    t.insert_at(l, 100 * SPACING, Item(1)).unwrap();
    assert_eq!(runs(&t, l), vec![(1, 101, 0), (1, MAX - 100, 0)]);

    // `insert_back` landing packed behind a full run (`land`).
    let (mut t, l) = packed(full * SPACING + 24, full, 0);
    t.insert_back(l, Item(1)).unwrap();
    assert_eq!(runs(&t, l), vec![(1, MAX, 0), (1, 1, 0)]);

    // `advance` closing a gap behind a full, stopped run (the walk's merge).
    let (mut t, l) = packed(long, full, 0);
    t.insert_at(l, full * SPACING + 100, Item(1)).unwrap();
    for _ in 0..5 {
        t.advance();
    }
    assert_eq!(
        runs(&t, l),
        vec![(1, MAX, 0), (1, 1, 0)],
        "closed, not merged"
    );
    assert_eq!(t.count(l), Ok(full + 1));
    round_trip(&t);
}

/// A `Next` loop of lines `lens[k]` long at `speeds[k]` (line k feeds k + 1), in the production
/// store and the reference, with items of distinct kinds at loop coordinates `coords` (a line's
/// position plus the lengths of the lines after it). Every tick both advance and must agree; at
/// the end of every tick every pair of consecutive items around the loop is at least `SPACING`
/// apart and no item moved more than the faster of the line it left and the line it is on.
/// Returns the moves of every tick.
fn loop_run(lens: &[i64], speeds: &[i64], coords: &[i64], ticks: u32) -> Vec<Vec<i64>> {
    let n = lens.len();
    let total: i64 = lens.iter().sum();
    let mut t = Transport::new(16, 256);
    let mut r = Reference::new();
    for k in 0..n {
        assert_eq!(t.create(lens[k] as u32, speeds[k] as u16), Ok(id(k as u32)));
        r.create(lens[k], speeds[k]);
    }
    for k in 0..n {
        let out = Out::Next(((k + 1) % n) as u32);
        assert_eq!(t.set_out(id(k as u32), to_output(out)), r.set_out(k, out));
    }
    let after = |k: usize| -> i64 { lens[k + 1..].iter().sum() };
    for (j, &c) in coords.iter().enumerate() {
        let k = (0..n).find(|&k| c >= after(k)).expect("on the loop");
        let p = c - after(k);
        assert_eq!(
            t.insert_at(id(k as u32), p as u32, Item(j as u16 + 1)),
            Ok(())
        );
        r.insert_at(k, p, j as u16 + 1).unwrap();
    }
    let place = |t: &Transport| -> Vec<(i64, usize)> {
        let mut v = vec![(0, 0); coords.len()];
        for k in 0..n {
            for (item, p) in items(t, id(k as u32)) {
                v[usize::from(item) - 1] = (i64::from(p) + after(k), k);
            }
        }
        v
    };
    let mut prev = place(&t);
    let mut moves = Vec::new();
    for tick in 0..ticks {
        t.advance();
        r.advance();
        for k in 0..n {
            let want: Vec<(u16, u32)> = r
                .line(k)
                .items
                .iter()
                .map(|&(i, p)| (i, p as u32))
                .collect();
            assert_eq!(items(&t, id(k as u32)), want, "tick {tick}: line {k}");
        }
        let now = place(&t);
        let mut tick_moves = Vec::new();
        for (j, (&(c0, k0), &(c1, k1))) in prev.iter().zip(&now).enumerate() {
            let d = (c0 - c1).rem_euclid(total);
            assert!(
                d <= speeds[k0].max(speeds[k1]),
                "tick {tick}: item {} moved {d}",
                j + 1
            );
            tick_moves.push(d);
        }
        let mut sorted: Vec<i64> = now.iter().map(|&(c, _)| c).collect();
        sorted.sort_unstable();
        let wrap = sorted[0] + total - sorted[sorted.len() - 1];
        for gap in sorted.windows(2).map(|w| w[1] - w[0]).chain([wrap]) {
            assert!(gap >= i64::from(SPACING), "tick {tick}: items {gap} apart");
        }
        moves.push(tick_moves);
        prev = now;
    }
    moves
}

/// M44 cut review (finding 6): `Next` loops with gaps at target speeds 72 and 96 (two items cross a
/// front per tick), packed pairs included, the cut's target among them. With every gap `>= 0` and
/// one speed a loop rotates rigidly: every item moves exactly `speed` every tick (and the
/// reference agrees).
#[test]
fn transport_cut_gapped_loops_rotate() {
    // Packed runs and gaps of 10-150 around a 3 x 1024 loop; item 1 sits at line 0's front, packed
    // behind line 1's rearmost item (the cut).
    let mut coords = Vec::new();
    let mut c = 2048i64;
    for k in 0..30i64 {
        coords.push(c % 3072);
        c += 64 + [0, 0, 10, 0, 150, 37, 0, 0, 88][(k % 9) as usize];
    }
    assert!(c - 2048 < 3072, "fits the loop");
    for speed in [72i64, 96] {
        let moves = loop_run(&[1024, 1024, 1024], &[speed; 3], &coords, 120);
        for (tick, m) in moves.iter().enumerate() {
            assert!(
                m.iter().all(|&d| d == speed),
                "speed {speed} tick {tick}: moves {m:?}"
            );
        }
    }
}

/// M44 cut review (finding 6): a 24 -> 72 -> 24 loop (the cut line at 24 feeds the fast line),
/// gapped and packed, against the reference, spacing held, nothing moving more than the faster of
/// its two lines; the fast line's items bunch up behind the slow one.
#[test]
fn transport_cut_mixed_speed_loop() {
    let coords: Vec<i64> = (0..22)
        .scan(1535i64, |c, k| {
            let at = *c;
            *c -= 64 + [0, 6][k % 2];
            Some(at)
        })
        .collect();
    let moves = loop_run(&[512, 512, 512], &[24, 72, 24], &coords, 200);
    let all: Vec<i64> = moves.iter().flatten().copied().collect();
    assert!(all.contains(&72), "the fast line ran at 72");
    assert!(all.contains(&24), "the slow lines ran at 24");
    assert!(
        all.iter().any(|&d| d != 24 && d != 72),
        "items bunched behind a slow line: {:?}",
        all.iter().collect::<std::collections::BTreeSet<_>>()
    );
}
