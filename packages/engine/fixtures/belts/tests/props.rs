//! Seeded property tests of `engine::transport` through `fx-belts`' request pattern on a native
//! `Sim` (M44b; helpers in `common/props.rs`, which M56 reuses). Each property asserts the world
//! did something (items sank, forked, lapped, edits landed), so none can pass on an idle world.

// Not in `common/mod.rs`: that tree is linked into the spike binaries, which define their own
// `#[global_allocator]` and so cannot link `fx_belts` (it exports one too).
#[path = "common/props.rs"]
mod props;

use std::collections::BTreeMap;

use engine::rng::SimRng;
use engine::transport::{LineId, Output, SPACING};
use fx_belts::Op;
use props::{World, between, chain, pick};

/// What a random edit did, summed over every seed.
#[derive(Default, Debug)]
struct Edits {
    cuts: u32,
    joins: u32,
    destroys: u32,
    inserts: u32,
    removes: u32,
}

/// `spawned + inserted == live + sunk + removed + taken + destroyed` after every tick of six
/// seeded 300-tick worlds under random edits (one tick in four): cuts, joins (a `Next` feeder into
/// its target), destroys, inserts, removes and take-fronts on any live line. The world: chain 0
/// (3 tiles) `Next` chain 1 (2 tiles, `Sink`); chain 2 side-loads onto chain 1 at a random entry;
/// chain 3 forks onto chain 4 (`Sink`) and chain 5 (`DeadEnd`); spawners on chains 0, 2, 3.
#[test]
fn prop_conservation() {
    let mut e = Edits::default();
    let mut sunk = 0;
    for seed in 0..6u64 {
        let mut rng = SimRng::new(0xC0_0000 + seed);
        let mut w = World::new(seed + 1, 64, 1024);
        let at = rng.below(512);
        let mut setup = vec![chain(3, 24, &[]), chain(2, 24, &[])];
        setup.extend((0..4).map(|_| chain(2, 24, &[])));
        setup.extend([
            Op::Link {
                from_line: 0,
                to_line: 1,
            },
            Op::Sink { line: 1 },
            Op::Merge {
                line: 2,
                into: 1,
                at,
            },
            Op::Fork {
                line: 3,
                a: 4,
                b: 5,
            },
            Op::Sink { line: 4 },
        ]);
        for (line, item) in [(0, 1), (2, 2), (3, 3)] {
            let period = between(&mut rng, 256, 1024);
            setup.push(Op::Spawner { line, item, period });
        }
        w.step(&setup);
        for t in 2..=300 {
            let mut ops = Vec::new();
            let mut joined = LineId::NONE;
            let chains = w.chains();
            let live = w.live_chains();
            if rng.below(4) == 0 && !live.is_empty() {
                let i = pick(&mut rng, &live);
                let l = w.line(i);
                let len = w.len(l);
                let line = i as u8;
                match rng.below(12) {
                    0..=2 => ops.push(Op::Cut {
                        line,
                        at: between(&mut rng, 1, len - 1),
                    }),
                    3..=4 => {
                        // A join needs `back` feeding `front` by `Next`.
                        let feeders: Vec<(u32, u32)> = live
                            .iter()
                            .filter_map(|&b| match w.out(w.line(b)) {
                                Output::Next(f) => w.index_of(f).map(|f| (f, b)),
                                _ => None,
                            })
                            .collect();
                        if !feeders.is_empty() {
                            let (front, back) = pick(&mut rng, &feeders);
                            joined = w.line(back);
                            ops.push(Op::Join {
                                front: front as u8,
                                back: back as u8,
                            });
                        }
                    }
                    5 if live.len() > 4 => ops.push(Op::Destroy { line }),
                    5..=7 => ops.push(Op::Insert {
                        line,
                        pos: rng.below(len),
                        item: 9,
                    }),
                    8..=10 => ops.push(Op::Remove {
                        line,
                        pos: rng.below(len),
                    }),
                    _ => ops.push(Op::TakeFront { line }),
                }
            }
            let before = w.ledger();
            w.step(&ops);
            let g = w.ledger();
            assert_eq!(
                g.made(),
                g.accounted(),
                "seed {seed} tick {t}: spawned + inserted == live + sunk + removed + taken + destroyed: {g:?}"
            );
            e.cuts += u32::from(w.chains() > chains);
            e.joins += u32::from(joined != LineId::NONE && !w.alive(joined));
            e.destroys += u32::from(g.destroyed > before.destroyed);
            e.inserts += u32::from(g.inserted > before.inserted);
            e.removes += u32::from(g.removed + g.taken > before.removed + before.taken);
            sunk = sunk.max(g.sunk);
        }
    }
    assert!(
        e.cuts > 5 && e.joins > 5 && e.destroys > 2 && e.inserts > 5 && e.removes > 5 && sunk > 50,
        "the edits landed and items sank: {e:?}, sunk {sunk}"
    );
}

/// Never under `SPACING` on a line or across a plain `Next` hand-off, checked after every tick of
/// eight seeded 400-tick worlds, except exactly two kinds of pair, each excused for itself only:
/// - *a rescale's window*: a pair on the rescaled line, or a hand-off pair with it at either end,
///   from the rescale until the line holds no short pair; the number of such pairs touching the
///   line may never grow (the window passes to a cut's back part and a join's front);
/// - *a merge landing* (0079 §15): a side-loaded item that landed within `SPACING` of its target's
///   front or back (`insert_at`'s room rule checks the target line only) excuses its own pair while
///   it is the target's front item (with the `Next` target's tail) or its tail item (with the front
///   of the line feeding the target by `Next`); it is followed by kind and position.
///
/// The counts of excused pairs are pinned. The world, at one random speed of 24, 48, 72, 96: chain
/// 0 (4 tiles) `Next` chain 1 (2 tiles, `Sink`); chain 2 side-loads onto chain 0 at an entry below
/// its speed (the clamp to 0), chain 3 at a random one; chain 4 forks onto chains 5 and 6
/// (`Sink`); saturating spawners on 2, 3, 4. One tick in six a random edit on a line without a
/// spawner: rescale (80-110 %), cut, join, insert or remove. Inserts stay `SPACING` from both ends
/// and no edit makes a line shorter than `SPACING + speed` (both are line-local rules of the engine
/// that would make further short hand-off pairs: M44b Deviations, Review fixes).
#[test]
fn prop_spacing_invariant() {
    let mut used = BTreeMap::<&str, u32>::new();
    let mut forked = 0;
    for seed in 0..8u64 {
        let mut rng = SimRng::new(0x5_9AC0 + seed);
        let speed = pick(&mut rng, &[24u16, 48, 72, 96]);
        let s = u32::from(speed);
        // No edit makes a line shorter than this (Deviations, Review fixes: a plain hand-off onto
        // a shorter empty line checks only that line's tail, not the tail of the line after it).
        let short = SPACING + s;
        let mut w = World::new(seed + 1, 64, 2048);
        let mut setup = vec![chain(4, speed, &[])];
        setup.extend((0..6).map(|_| chain(2, speed, &[])));
        setup.extend([
            Op::Link {
                from_line: 0,
                to_line: 1,
            },
            Op::Sink { line: 1 },
            Op::Merge {
                line: 2,
                into: 0,
                at: rng.below(s),
            },
            Op::Merge {
                line: 3,
                into: 0,
                at: between(&mut rng, 64, 1023),
            },
            Op::Fork {
                line: 4,
                a: 5,
                b: 6,
            },
            Op::Sink { line: 5 },
            Op::Sink { line: 6 },
        ]);
        for (line, item) in [(2, 2), (3, 3), (4, 4)] {
            setup.push(Op::Spawner {
                line,
                item,
                period: 256,
            });
        }
        w.step(&setup);
        let spawner_lines = [w.line(2), w.line(3), w.line(4)];
        // A rescale's window: line -> the most short pairs touching it it may still hold (never
        // more than the tick before; dropped at 0). A landing: merge target -> the landed items
        // (kind, position) still in a short pair at the target's front or back.
        let mut rescale = BTreeMap::<u32, usize>::new();
        let mut landing = BTreeMap::<u32, Vec<(u16, u32)>>::new();
        let mut prev_items = BTreeMap::<u32, Vec<(u16, u32)>>::new();
        for t in 2..=400 {
            let live: Vec<u32> = w
                .live_chains()
                .into_iter()
                .filter(|&i| !spawner_lines.contains(&w.line(i)))
                .collect();
            let mut ops = Vec::new();
            let (chains, mut rescaled, mut cut, mut joined) =
                (w.chains(), LineId::NONE, LineId::NONE, None);
            if rng.below(6) == 0 && !live.is_empty() {
                let i = pick(&mut rng, &live);
                let l = w.line(i);
                let len = w.len(l);
                let line = i as u8;
                match rng.below(5) {
                    0 => {
                        rescaled = l;
                        ops.push(Op::Rescale {
                            line,
                            new_len: (len * between(&mut rng, 80, 110) / 100).max(short),
                        });
                    }
                    1 if len >= 2 * short => {
                        cut = l;
                        ops.push(Op::Cut {
                            line,
                            at: between(&mut rng, short, len - short),
                        });
                    }
                    2 => {
                        let feeders: Vec<(u32, u32)> = live
                            .iter()
                            .filter_map(|&b| match w.out(w.line(b)) {
                                Output::Next(f) => w.index_of(f).map(|f| (f, b)),
                                _ => None,
                            })
                            .collect();
                        if !feeders.is_empty() {
                            let (front, back) = pick(&mut rng, &feeders);
                            joined = Some((w.line(front), w.line(back)));
                            ops.push(Op::Join {
                                front: front as u8,
                                back: back as u8,
                            });
                        }
                    }
                    3 if len > 2 * SPACING => ops.push(Op::Insert {
                        line,
                        pos: between(&mut rng, SPACING, len - SPACING),
                        item: 9,
                    }),
                    _ => ops.push(Op::Remove {
                        line,
                        pos: rng.below(len),
                    }),
                }
            }
            let len_before = (rescaled != LineId::NONE).then(|| w.len(rescaled));
            w.step(&ops);
            // The windows this tick's edits open or pass on.
            if let Some(len) = len_before
                && w.len(rescaled) != len
            {
                rescale.insert(rescaled.0, usize::MAX);
            }
            if cut != LineId::NONE
                && w.chains() > chains
                && let Some(&n) = rescale.get(&cut.0)
            {
                rescale.insert(w.line(chains).0, n);
            }
            if let Some((front, back)) = joined
                && !w.alive(back)
                && let Some(n) = rescale.remove(&back.0)
            {
                let e = rescale.entry(front.0).or_insert(0);
                *e = (*e).max(n);
            }
            // A landing near either end of the target: an item of a merge feeder that crossed this
            // tick (at `p < speed` at the end of the last tick, overshoot `o = speed - p`) lands at
            // `clamp(at - o, 0, len - 1)` and stays there this tick (0079 §15). `insert_at`'s room
            // rule checks the target line only, so within `SPACING` of the target's front it may sit
            // closer than `SPACING` to the `Next` target's tail, and within `SPACING` of its back to
            // the front of the line feeding it by `Next`.
            for i in w.live_chains() {
                let f = w.line(i);
                if let Output::Merge { line: m, at } = w.out(f)
                    && w.alive(m)
                    && let Some(before) = prev_items.get(&f.0)
                {
                    let (len, on_m) = (w.len(m), w.items(m));
                    for &(kind, p) in before.iter().filter(|&&(_, p)| p < s) {
                        let at_m = at.saturating_sub(s - p).min(len - 1);
                        if (at_m < SPACING || at_m + SPACING > len) && on_m.contains(&(kind, at_m))
                        {
                            landing.entry(m.0).or_default().push((kind, at_m));
                        }
                    }
                }
            }
            let gaps = w.short_gaps();
            // A landed item is followed by kind and by moving at most `speed` ahead per tick; it
            // excuses only a pair it is in: as the target's front (to its `Next` target's tail) or
            // as its tail (to the front of a line feeding it by `Next`).
            let excused_by_landing =
                |w: &World, g: &props::Gap, landed: &BTreeMap<u32, Vec<(u16, u32)>>| {
                    let Some(to) = g.target else { return false };
                    let front_pair = matches!(w.out(g.line), Output::Next(t) if t == to)
                        && landed.get(&g.line.0).is_some_and(|v| {
                            w.items(g.line).first().is_some_and(|it| v.contains(it))
                        });
                    let back_pair = landed
                        .get(&to.0)
                        .is_some_and(|v| w.items(to).last().is_some_and(|it| v.contains(it)));
                    front_pair || back_pair
                };
            for (&m, held) in landing.iter_mut() {
                let m = LineId(m);
                let on_m = if w.alive(m) { w.items(m) } else { Vec::new() };
                held.retain_mut(|(kind, pos)| {
                    let Some(&(_, now)) = on_m
                        .iter()
                        .find(|&&(k, p)| k == *kind && p <= *pos && p + s >= *pos)
                    else {
                        return false;
                    };
                    *pos = now;
                    true
                });
            }
            let mut in_pair = BTreeMap::<u32, Vec<(u16, u32)>>::new();
            for g in &gaps {
                if excused_by_landing(&w, g, &landing) {
                    let to = g.target.expect("a hand-off pair");
                    for l in [g.line, to] {
                        if let Some(v) = landing.get(&l.0) {
                            in_pair.entry(l.0).or_default().extend(v.iter().copied());
                        }
                    }
                }
            }
            for v in in_pair.values_mut() {
                v.sort_unstable();
                v.dedup();
            }
            landing = in_pair;
            let mut touching = BTreeMap::<u32, usize>::new();
            for g in &gaps {
                if excused_by_landing(&w, g, &landing) {
                    *used.entry("landing").or_default() += 1;
                    continue;
                }
                let ends = [Some(g.line), g.target];
                let hit: Vec<LineId> = ends
                    .into_iter()
                    .flatten()
                    .filter(|l| rescale.contains_key(&l.0))
                    .collect();
                if hit.is_empty() {
                    panic!("seed {seed} tick {t} (speed {s}): unexcused short pair {g:?}");
                }
                for l in hit {
                    *touching.entry(l.0).or_default() += 1;
                }
                *used.entry("rescale").or_default() += 1;
            }
            for (&l, n) in rescale.iter_mut() {
                let now = touching.get(&l).copied().unwrap_or(0);
                assert!(
                    now <= *n,
                    "seed {seed} tick {t} (speed {s}): line {l} holds {now} short pairs, {n} the tick before"
                );
                *n = now;
            }
            rescale.retain(|_, n| *n > 0);
            prev_items.clear();
            for i in w.live_chains() {
                let l = w.line(i);
                prev_items.insert(l.0, w.items(l));
            }
        }
        forked += w.sunk(w.line(5)).min(w.sunk(w.line(6)));
    }
    let got: Vec<(&str, u32)> = used.into_iter().collect();
    assert_eq!(
        got,
        [("landing", 86), ("rescale", 73)],
        "short pairs excused, per exception (deterministic: a change here is a changed engine)"
    );
    assert!(forked > 100, "both fork outputs sank items: {forked}");
}

/// A saturated lane delivers `20 x speed / SPACING` items per second within 1 %, measured at the
/// sink over 600 ticks after it fills: six seeds, each a random speed in 16-64 (one spawner tries
/// once per tick, so it saturates a lane only up to `SPACING` per tick) on a random two-line path
/// (`Next` then `Sink`, 1-6 tiles each).
#[test]
fn prop_throughput() {
    for seed in 0..6u64 {
        let mut rng = SimRng::new(0x7A_0000 + seed);
        let speed = between(&mut rng, 16, 64) as u16;
        let (ta, tb) = (
            between(&mut rng, 1, 6) as u16,
            between(&mut rng, 1, 6) as u16,
        );
        let mut w = World::new(seed + 1, 16, 1024);
        w.step(&[
            chain(ta, speed, &[]),
            chain(tb, speed, &[]),
            Op::Link {
                from_line: 0,
                to_line: 1,
            },
            Op::Sink { line: 1 },
            Op::Spawner {
                line: 0,
                item: 1,
                period: 256,
            },
        ]);
        let s = u32::from(speed);
        let fill = (u32::from(ta) + u32::from(tb)) * 256 / s + 4;
        for _ in 0..fill {
            w.step(&[]);
        }
        let sink = w.line(1);
        let start = w.sunk(sink);
        for _ in 0..600 {
            w.step(&[]);
        }
        let per_s = (w.sunk(sink) - start) as f64 / 30.0; // 600 ticks at 20 Hz
        let want = 20.0 * f64::from(s) / f64::from(SPACING);
        assert!(
            (per_s - want).abs() <= want / 100.0,
            "seed {seed}: speed {s}, {ta} + {tb} tiles: {per_s} items/s, want {want}"
        );
    }
}

/// A closed ring of four lines (1-4 tiles each, one random speed in 8-96) laps in
/// `total_len / speed` ticks within one tick: every item's ring coordinate drops by exactly `speed`
/// (mod the ring length) every tick, across each hand-off and the cycle's cut (0079 §11), and the
/// ticks between laps are `floor` or `ceil` of `total / speed`. Six seeds with one item, six with
/// a block of four items `SPACING + speed` apart on chain 0 (a packed block:
/// [`prop_ring_lap_time_packed_block`]); every run laps at least twice.
#[test]
fn prop_ring_lap_time() {
    for seed in 0..12u64 {
        let mut rng = SimRng::new(0x1A_9000 + seed);
        let speed = between(&mut rng, 8, 96) as u16;
        let rest: Vec<(u16, u32)> = if seed >= 6 {
            (0..4)
                .map(|k| (k as u16 + 1, k * (SPACING + u32::from(speed))))
                .collect()
        } else {
            vec![(1, rng.below(256))]
        };
        ring_laps(seed, &mut rng, speed, &rest);
    }
}

/// [`prop_ring_lap_time`] with a packed block of eight (`0, 64, ..., 448` on chain 0): the block
/// crosses the cycle's cut packed, every item moving `speed` every tick. Found red by M44b (the cut
/// line advanced first held a packed follower against its target's tail before that target moved,
/// so the block crossed spread to `SPACING + speed`); fixed by M44's cut-budget round (0079 §11).
#[test]
fn prop_ring_lap_time_packed_block() {
    for seed in 6..12u64 {
        let mut rng = SimRng::new(0x1A_9000 + seed);
        let speed = between(&mut rng, 8, 96) as u16;
        let rest: Vec<(u16, u32)> = (0..8).map(|k| (k as u16 + 1, k * SPACING)).collect();
        ring_laps(seed, &mut rng, speed, &rest);
    }
}

/// Builds the ring (chain 0 at least long enough for `rest`, chains 1-3 of 1-4 tiles), then
/// checks every item's per-tick move and the lap times of item 1 over three laps.
fn ring_laps(seed: u64, rng: &mut SimRng, speed: u16, rest: &[(u16, u32)]) {
    let s = u32::from(speed);
    let need = rest.iter().map(|&(_, p)| p).max().unwrap_or(0) / 256 + 1;
    let tiles: Vec<u16> = (0..4)
        .map(|k| between(rng, if k == 0 { need.max(1) } else { 1 }, 4.max(need)) as u16)
        .collect();
    let mut w = World::new(seed + 1, 16, 64);
    let mut setup = vec![chain(tiles[0], speed, rest)];
    setup.extend(tiles[1..].iter().map(|&n| chain(n, speed, &[])));
    for k in 0..4u8 {
        setup.push(Op::Link {
            from_line: k,
            to_line: (k + 1) % 4,
        });
    }
    w.step(&setup);
    // Ring coordinate: chain k's position plus the lengths of the chains ahead of it.
    let lens: Vec<u32> = (0..4).map(|k| w.len(w.line(k))).collect();
    let total: u32 = lens.iter().sum();
    let coords = |w: &World| -> BTreeMap<u16, u32> {
        let mut m = BTreeMap::new();
        for k in 0..4 {
            for (item, p) in w.items(w.line(k as u32)) {
                m.insert(item, p + lens[k + 1..].iter().sum::<u32>());
            }
        }
        m
    };
    let mut prev = coords(&w);
    assert_eq!(prev.len(), rest.len(), "seed {seed}: every item placed");
    let (lo, hi) = (total / s, total.div_ceil(s));
    let mut laps = Vec::new();
    for t in 0..3 * hi + 2 {
        w.step(&[]);
        let now = coords(&w);
        for (&item, &d) in &now {
            let want = (prev[&item] + total - s) % total;
            assert_eq!(
                d, want,
                "seed {seed} tick {t}: item {item} moved {s} (ring {total})"
            );
        }
        if now[&1] > prev[&1] {
            laps.push(t);
        }
        prev = now;
    }
    assert!(laps.len() >= 2, "seed {seed}: laps at {laps:?}");
    for p in laps.windows(2) {
        let lap = p[1] - p[0];
        assert!(
            lap == lo || lap == hi,
            "seed {seed}: a lap of {lap} ticks, ring {total} at speed {s}"
        );
    }
}
