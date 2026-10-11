//! The standard belt world (M40 Scope, docs/decisions/0077 §2): 50,000 belt tiles (two lanes each,
//! so 100,000 lane-tiles of 256 positions) and about 250,000 items at `speed = 24`, as plain data.
//! A candidate representation (or M45's production `engine::transport`) is built from the
//! [`LineSpec`]s and driven by [`Spawner`]s and the inserter-like call count; nothing here calls a
//! candidate.
//!
//! Layout: "belt chains" of 1-6 straight lines of 4-48 tiles each (merged lines, `len` a multiple of
//! 256), each line `Next` into the one ahead of it; every belt chain gives two lane chains with the
//! same lengths. Per regime, a lane chain's front line ends in a `Sink` or a `DeadEnd`, its items
//! start spread or packed from the front, and a spawner may feed its rear line.
//!
//! - `Flowing`: every chain sinks, items spread evenly, a spawner at the same mean rate.
//! - `Jammed`: every chain dead-ends, items packed from the front, no spawner: nothing moves.
//! - `Mixed`: lane 0 of each belt chain sinks a packed moving stream (spawner at full rate); lane 1
//!   dead-ends with sparse items and a slow spawner, so a compression front moves back through it.
//!   Alternate belt chains carry one item kind (packed same-kind runs) or cycle `1..=6` (runs that
//!   never merge).
//! - `InserterLike`: `Mixed` plus [`INSERTER_CALLS`] `insert_at`/`remove_at` calls per tick.
#![allow(dead_code)]

use engine::rng::SimRng;

/// 0076 §1: the minimum distance between two items on a line and across a plain hand-off.
pub const SPACING: u32 = 64;
pub const TILE: u32 = 256;
pub const TILES: u32 = 50_000;
pub const ITEMS: u32 = 250_000;
pub const SPEED: u16 = 24;
/// 0077 §2: per tick, in the inserter-like regime (at full scale).
pub const INSERTER_CALLS: u32 = 2_000;
/// Item ids cycle through `1..=KINDS` (0 is "none", 0076 §1).
pub const KINDS: u16 = 6;

pub type LineIdx = u32;
pub type Item = u16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Out {
    DeadEnd,
    Next(LineIdx),
    Sink,
}

/// One line (one lane): `items_at_rest` are its items at build, front to back, `(item, pos)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineSpec {
    pub len: u32,
    pub speed: u16,
    pub out: Out,
    pub items_at_rest: Vec<(Item, u32)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Regime {
    Flowing,
    Jammed,
    Mixed,
    InserterLike,
}

impl Regime {
    pub const ALL: [Regime; 4] = [
        Regime::Flowing,
        Regime::Jammed,
        Regime::Mixed,
        Regime::InserterLike,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Regime::Flowing => "flowing",
            Regime::Jammed => "jammed",
            Regime::Mixed => "mixed",
            Regime::InserterLike => "inserter-like",
        }
    }
}

/// One `insert_back(line, item)` per `256 / rate256` ticks: `acc += rate256` each tick; at 256 or
/// more an insert is attempted, a success takes 256 off, a refusal holds `acc` at 256 (no backlog;
/// `rate256 = 256` tries every tick, a saturated input). `cycle`: the item id steps through
/// `1..=KINDS` from `first`; else always `first`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spawner {
    pub line: LineIdx,
    pub rate256: u16,
    pub first: Item,
    pub cycle: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BenchWorld {
    pub seed: u64,
    pub regime: Regime,
    pub lines: Vec<LineSpec>,
    /// Reverse topological over `Next` ([`update_order`]): every candidate advances in this order.
    pub order: Vec<LineIdx>,
    pub spawners: Vec<Spawner>,
    /// `insert_at`/`remove_at` calls per tick (0 except `InserterLike`).
    pub inserter_calls: u32,
}

impl BenchWorld {
    /// Belt tiles: lane-tiles / 2.
    pub fn tiles(&self) -> u64 {
        self.lines.iter().map(|l| u64::from(l.len)).sum::<u64>() / u64::from(TILE) / 2
    }

    pub fn items(&self) -> u64 {
        self.lines
            .iter()
            .map(|l| l.items_at_rest.len() as u64)
            .sum()
    }
}

/// The standard world of 0077 §2 at full scale.
pub fn bench_world(seed: u64, regime: Regime) -> BenchWorld {
    bench_world_scaled(seed, regime, 1)
}

/// [`bench_world`] with tiles, items and inserter calls divided by `scale` (the fast tests use 64).
pub fn bench_world_scaled(seed: u64, regime: Regime, scale: u32) -> BenchWorld {
    let mut rng = SimRng::new(seed);
    let belt_tiles = TILES / scale;
    let item_target = u64::from(ITEMS / scale);

    // Belt chains: segment lengths in tiles, front first.
    let mut belts: Vec<Vec<u32>> = Vec::new();
    let mut placed = 0;
    while placed < belt_tiles {
        let n = 1 + rng.below(6);
        let mut segs = Vec::new();
        for _ in 0..n {
            if placed == belt_tiles {
                break;
            }
            let t = (4 + rng.below(45)).min(belt_tiles - placed);
            segs.push(t);
            placed += t;
        }
        belts.push(segs);
    }

    // Lane chains: (segments, lane).
    let chains: Vec<(&Vec<u32>, u32, usize)> = belts
        .iter()
        .enumerate()
        .flat_map(|(b, segs)| [(segs, 0, b), (segs, 1, b)])
        .collect();
    let cap =
        |segs: &Vec<u32>| -> u64 { segs.iter().map(|&t| u64::from(t * TILE / SPACING)).sum() };

    #[derive(Clone, Copy)]
    enum Fill {
        Spread,
        Packed,
    }
    struct Plan {
        out: Out,
        fill: Fill,
        rate: u16,
        same_kind: bool,
        /// Takes a share of the item target in proportion to capacity (else: packed full).
        shared: bool,
    }
    let plans: Vec<Plan> = chains
        .iter()
        .map(|&(_, lane, b)| match regime {
            Regime::Flowing => Plan {
                out: Out::Sink,
                fill: Fill::Spread,
                rate: 60,
                same_kind: false,
                shared: true,
            },
            Regime::Jammed => Plan {
                out: Out::DeadEnd,
                fill: Fill::Packed,
                rate: 0,
                same_kind: false,
                shared: true,
            },
            Regime::Mixed | Regime::InserterLike => {
                let same_kind = b % 2 == 0;
                if lane == 0 {
                    Plan {
                        out: Out::Sink,
                        fill: Fill::Packed,
                        rate: 256,
                        same_kind,
                        shared: false,
                    }
                } else {
                    Plan {
                        out: Out::DeadEnd,
                        fill: Fill::Spread,
                        rate: 24,
                        same_kind,
                        shared: true,
                    }
                }
            }
        })
        .collect();

    // Items per chain: a packed-full chain holds its capacity; the rest of the target is shared by
    // the other chains in proportion to capacity (cumulative rounding, so the sum is exact).
    let full: u64 = chains
        .iter()
        .zip(&plans)
        .filter(|(_, p)| !p.shared)
        .map(|(c, _)| cap(c.0))
        .sum();
    assert!(
        full <= item_target,
        "packed chains alone exceed the item target"
    );
    let shared = item_target - full;
    let shared_cap: u64 = chains
        .iter()
        .zip(&plans)
        .filter(|(_, p)| p.shared)
        .map(|(c, _)| cap(c.0))
        .sum();
    let mut cum = 0u64;
    let counts: Vec<u64> = chains
        .iter()
        .zip(&plans)
        .map(|(c, p)| {
            if !p.shared {
                return cap(c.0);
            }
            let before = cum * shared / shared_cap;
            cum += cap(c.0);
            cum * shared / shared_cap - before
        })
        .collect();

    let mut lines: Vec<LineSpec> = Vec::new();
    let mut spawners = Vec::new();
    for (k, ((&(segs, _, _), plan), &n)) in chains.iter().zip(&plans).zip(&counts).enumerate() {
        let kind0 = (k % KINDS as usize) as u16;
        let kind = |j: u64| -> Item {
            if plan.same_kind {
                kind0 + 1
            } else {
                ((u64::from(kind0) + j) % u64::from(KINDS)) as u16 + 1
            }
        };
        let first_line = lines.len() as u32;
        let total: u64 = segs.iter().map(|&t| u64::from(t * TILE)).sum();
        // Chain positions (front = 0), then cut into the segments.
        let positions: Vec<u64> = (0..n)
            .map(|j| match plan.fill {
                Fill::Packed => j * u64::from(SPACING),
                Fill::Spread => (2 * j + 1) * total / (2 * n),
            })
            .collect();
        for w in positions.windows(2) {
            assert!(w[1] - w[0] >= u64::from(SPACING), "spacing below 64");
        }
        let mut offset = 0u64;
        let mut j = 0usize;
        for (s, &t) in segs.iter().enumerate() {
            let len = t * TILE;
            let mut items = Vec::new();
            while j < positions.len() && positions[j] < offset + u64::from(len) {
                items.push((kind(j as u64), (positions[j] - offset) as u32));
                j += 1;
            }
            lines.push(LineSpec {
                len,
                speed: SPEED,
                out: if s == 0 {
                    plan.out
                } else {
                    Out::Next(first_line + s as u32 - 1)
                },
                items_at_rest: items,
            });
            offset += u64::from(len);
        }
        if plan.rate > 0 {
            spawners.push(Spawner {
                line: first_line + segs.len() as u32 - 1,
                rate256: plan.rate,
                first: kind(n),
                cycle: !plan.same_kind,
            });
        }
    }

    let order = update_order(&lines);
    BenchWorld {
        seed,
        regime,
        lines,
        order,
        spawners,
        inserter_calls: if regime == Regime::InserterLike {
            INSERTER_CALLS / scale
        } else {
            0
        },
    }
}

/// Reverse topological over `Next` (0076 §2: a line after the lines it feeds): each line that
/// feeds no line, then depth-first through its feeders, in index order. Panics on a cycle (the
/// bench world has none; production cuts a cycle at its lowest id).
pub fn update_order(lines: &[LineSpec]) -> Vec<LineIdx> {
    let mut feeders: Vec<(LineIdx, LineIdx)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| match l.out {
            Out::Next(t) => Some((t, i as LineIdx)),
            _ => None,
        })
        .collect();
    feeders.sort_unstable();
    let mut order = Vec::with_capacity(lines.len());
    let mut stack = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if matches!(l.out, Out::Next(_)) {
            continue;
        }
        stack.push(i as LineIdx);
        while let Some(x) = stack.pop() {
            order.push(x);
            let from = feeders.partition_point(|&(t, _)| t < x);
            let to = feeders.partition_point(|&(t, _)| t <= x);
            for &(_, f) in feeders[from..to].iter().rev() {
                stack.push(f);
            }
        }
    }
    assert_eq!(order.len(), lines.len(), "the Next graph has a cycle");
    order
}
