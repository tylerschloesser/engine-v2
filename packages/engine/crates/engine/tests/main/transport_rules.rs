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

#[derive(Clone, Copy)]
enum Out {
    DeadEnd,
    Next(u32),
    Sink,
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
        let out = match s.out {
            Out::DeadEnd => Output::DeadEnd,
            Out::Next(t) => Output::Next(id(t)),
            Out::Sink => Output::Sink,
        };
        t.set_out(id(i as u32), out).expect("set_out");
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

/// Every field round-trips; a later run's `dist` under `SPACING` (a spacing violation within a
/// line), a position past `len - 1`, an empty run and `Item(0)` are rejected.
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
        corrupt(run1 + 4, &(SPACING - 1).to_le_bytes()).err(),
        Some(engine::codec::CodecError::Malformed),
        "two items 63 apart on one line: a spacing violation"
    );
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
        "Fork is M44"
    );
    assert_eq!(
        u.insert_back(LineId(9), Item(1)),
        Err(TransportError::NoLine)
    );
}

/// A per-item reference of the same rule (M40's candidate A, written plainly): every line a `Vec`
/// of `(item, pos)` front to back, with its own update order (a reverse-topological walk, not
/// production's `order_into`) and its own reading of the cycle cut (0079: an item that crosses
/// the cut onto a line that has not advanced yet does not move again that tick).
struct Reference {
    lines: Vec<Option<RefLine>>, // by `LineId - 1`; `None` once destroyed
    sunk: u64,
    /// Items that crossed a cycle cut (non-vacuity of the cut rule).
    cut_landings: u64,
}

struct RefLine {
    len: i64,
    speed: i64,
    out: Out,
    items: Vec<(u16, i64)>,
    /// Items at the back that crossed the cut this tick (they do not move again).
    fresh: usize,
}

impl Reference {
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
            items: Vec::new(),
            fresh: 0,
        }));
    }

    /// Reverse topological, roots in ascending id: follow each root's links until a placed line
    /// (emit the path backwards) or a line already on the path (a cycle: its lowest id first, then
    /// backwards against the links; then the path before it, backwards).
    fn order(&self) -> Vec<usize> {
        let n = self.lines.len();
        let mut placed = vec![false; n];
        let mut order = Vec::new();
        for r in 0..n {
            if self.lines[r].is_none() || placed[r] {
                continue;
            }
            let mut path: Vec<usize> = Vec::new();
            let mut x = r;
            let cut = loop {
                if placed[x] {
                    break None;
                }
                if let Some(k) = path.iter().position(|&p| p == x) {
                    break Some(k);
                }
                path.push(x);
                match self.line(x).out {
                    Out::Next(t) => x = t as usize,
                    _ => break None,
                }
            };
            let prefix = match cut {
                Some(k) => {
                    let cycle = &path[k..];
                    let lowest = *cycle.iter().min().unwrap();
                    let at = cycle.iter().position(|&c| c == lowest).unwrap();
                    order.push(lowest);
                    for d in 1..cycle.len() {
                        order.push(cycle[(at + cycle.len() - d) % cycle.len()]);
                    }
                    k
                }
                None => path.len(),
            };
            order.extend(path[..prefix].iter().rev());
            for &p in &path {
                placed[p] = true;
            }
        }
        order
    }

    fn advance(&mut self) {
        const SP: i64 = SPACING as i64;
        let mut advanced = vec![false; self.lines.len()];
        for l in self.order() {
            let (speed, out) = (self.line(l).speed, self.line(l).out);
            let mut leader = match out {
                Out::DeadEnd => -SP,
                Out::Sink => i64::MIN / 4,
                Out::Next(t) => {
                    let t = self.line(t as usize);
                    t.items.last().map_or(i64::MIN / 4, |&(_, p)| p - t.len)
                }
            };
            let fresh = std::mem::take(&mut self.line_mut(l).fresh);
            let mut k = 0;
            while k + fresh < self.line(l).items.len() {
                let (item, pos) = self.line(l).items[k];
                let bound = leader + SP;
                let p = if pos < bound {
                    pos
                } else {
                    (pos - speed).max(bound)
                };
                leader = p;
                if p >= 0 {
                    self.line_mut(l).items[k].1 = p;
                    k += 1;
                    continue;
                }
                self.line_mut(l).items.remove(k);
                match out {
                    Out::Sink => self.sunk += 1,
                    Out::Next(t) => {
                        let t = t as usize;
                        let tlen = self.line(t).len;
                        self.line_mut(t).items.push((item, tlen + p));
                        if !advanced[t] {
                            self.line_mut(t).fresh += 1;
                            self.cut_landings += 1;
                        }
                    }
                    Out::DeadEnd => unreachable!("a dead end bounds p at 0"),
                }
            }
            advanced[l] = true;
        }
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

    /// `set_out`'s refusals, written from the rule: not into itself, a target at least `speed`
    /// long (the hand-off bound).
    fn set_out(&mut self, l: usize, out: Out) -> Result<(), TransportError> {
        if let Out::Next(t) = out {
            if t as usize == l {
                return Err(TransportError::Unsupported);
            }
            if self.line(t as usize).len < self.line(l).speed {
                return Err(TransportError::BadSpeed);
            }
        }
        self.line_mut(l).out = out;
        Ok(())
    }

    fn set_speed(&mut self, l: usize, speed: i64) -> Result<(), TransportError> {
        let line = self.line(l);
        let short_target = matches!(line.out, Out::Next(t) if self.line(t as usize).len < speed);
        if speed >= line.len || short_target {
            return Err(TransportError::BadSpeed);
        }
        self.line_mut(l).speed = speed;
        Ok(())
    }

    fn destroy(&mut self, l: usize) -> Vec<u16> {
        let gone = self.lines[l].take().expect("a live line");
        for line in self.lines.iter_mut().flatten() {
            if matches!(line.out, Out::Next(t) if t as usize == l) {
                line.out = Out::DeadEnd;
            }
        }
        gone.items.into_iter().map(|(i, _)| i).collect()
    }
}

fn to_output(out: Out) -> Output {
    match out {
        Out::DeadEnd => Output::DeadEnd,
        Out::Sink => Output::Sink,
        Out::Next(a) => Output::Next(LineId(a + 1)),
    }
}

/// The production store against the per-item reference, which owns its own update order: seeded
/// random chains with mixed speeds (8, 24 and 72 in one path) and lengths down to half a tile,
/// sinks, dead ends, a three-line cycle; 40 random `insert_back`/`insert_at`/`remove_at` every tick
/// and, on random ticks, `set_out`, `set_speed`, `create` and `destroy` (each refusal compared
/// too); every live line compared every tick for 400 ticks, and the codec round trip at the end.
#[test]
fn transport_matches_per_item_reference() {
    let mut rng = engine::rng::SimRng::new(11);
    let mut t = Transport::new(512, 1 << 16);
    let mut r = Reference {
        lines: Vec::new(),
        sunk: 0,
        cut_landings: 0,
    };
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

    let live = |r: &Reference| -> Vec<usize> {
        (0..r.lines.len())
            .filter(|&l| r.lines[l].is_some())
            .collect()
    };
    for tick in 0..400 {
        // The cycle stays a cycle (mutations pick other lines) and is kept fed but sparse (a full
        // loop jams), so items keep crossing its cut.
        let alive: Vec<usize> = live(&r).into_iter().filter(|l| !c.contains(l)).collect();
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
    round_trip(&t);
}

/// 0079 §5: the arena `Host::init`'s memory-split check counts, at literal sizes: a line costs
/// 72 B (record) + 8 (index) + 4 (order) + 17 (Tarjan scratch) = 101 B, a run node 16 B, plus
/// one spare node (none at 0 items). At the defaults: 32,768 x 101 + 262,145 x 16 = 7,503,888 B.
#[test]
fn transport_reserved_bytes_at_the_defaults() {
    assert_eq!(Transport::reserved_bytes(0, 0), 0);
    assert_eq!(Transport::reserved_bytes(1, 0), 101);
    assert_eq!(Transport::reserved_bytes(0, 1), 32);
    assert_eq!(
        Transport::reserved_bytes(
            engine::transport::DEFAULT_MAX_LINES,
            engine::transport::DEFAULT_MAX_ITEMS
        ),
        7_503_888
    );
}

/// 0079 (M42 review, finding 8): an item that crosses a cycle's cut lands on a line that has not
/// advanced yet this tick and does not move again. Three lines of 512 in a loop at speed 24, four
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

fn runs(t: &Transport, l: LineId) -> Vec<(u16, u16, u32)> {
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
    assert_eq!(runs(&t, l), vec![(1, 100, 0), (1, MAX - 100, SPACING)]);
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
