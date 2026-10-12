//! The standard belt world (M40 Scope, docs/decisions/0077 §2): 50,000 belt tiles (two lanes each,
//! so 100,000 lane-tiles of 256 positions) and about 250,000 items at `speed = 24`, as plain data.
//! M40's spike built its candidate representations from the [`LineSpec`]s; since M45 this module
//! is in the library (it was `tests/common/world.rs`) and `Belts::genesis` builds the `Mixed`
//! world in the production `engine::transport` (`super::build`), natively and in the `.wasm`.
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
//! - `SaturatedView` (M41, its own world: [`saturated_view_world`]): a 256 x 144 viewport of belts,
//!   every lane packed and fed to saturation, a share of the sinks closing and reopening.
//!
//! Tile coordinates (M41, plain data nothing in M40 reads): every line has a [`Span`] of tiles on
//! one row. In the standard world belt chain `b` is row `b`, its front line at `x = 0` and each
//! line behind it to the right (items move toward `-x`); both lanes share the span.
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
    /// M41: [`saturated_view_world`]. `jam_pct` of the sinks close and reopen with `period` ticks
    /// (0: never toggles).
    SaturatedView {
        jam_pct: u8,
        period: u16,
    },
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
            Regime::SaturatedView { .. } => "saturated-view",
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

/// A line's tiles: `w` tiles on row `y` from `x0` (front) to `x0 + w - 1` (back).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub x0: u32,
    pub y: u32,
    pub w: u32,
}

impl Span {
    /// Whether the span meets the tile rect `[x0, x1) x [y0, y1)`.
    pub fn meets(&self, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
        self.y >= y0 && self.y < y1 && self.x0 < x1 && self.x0 + self.w > x0
    }
}

/// A sink that closes (`Out::Sink` -> `Out::DeadEnd`) and reopens: closed at tick `t` when
/// `(t + phase) % period < period / 2` (see [`Toggle::closed`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Toggle {
    pub line: LineIdx,
    pub phase: u16,
}

impl Toggle {
    pub fn closed(&self, tick: u32, period: u16) -> bool {
        period > 0 && (tick + u32::from(self.phase)) % u32::from(period) < u32::from(period / 2)
    }
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
    /// Per line, its tiles (M41).
    pub spans: Vec<Span>,
    /// The world's tile extent: every span lies in `[0, width) x [0, height)`.
    pub width: u32,
    pub height: u32,
    /// `SaturatedView` only: the sinks that close and reopen, with [`Regime::SaturatedView`]'s
    /// `period`.
    pub toggles: Vec<Toggle>,
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
    if let Regime::SaturatedView { jam_pct, period } = regime {
        return saturated_view_world(seed, jam_pct, period, (VIEW_H / scale).max(1));
    }
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
            Regime::SaturatedView { .. } => unreachable!("built by saturated_view_world"),
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
    let mut spans = Vec::new();
    let mut spawners = Vec::new();
    for (k, ((&(segs, _, b), plan), &n)) in chains.iter().zip(&plans).zip(&counts).enumerate() {
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
        let mut x = 0u32;
        for (s, &t) in segs.iter().enumerate() {
            let len = t * TILE;
            spans.push(Span {
                x0: x,
                y: b as u32,
                w: t,
            });
            x += t;
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
    let width = spans.iter().map(|s| s.x0 + s.w).max().unwrap_or(0);
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
        spans,
        width,
        height: belts.len() as u32,
        toggles: Vec::new(),
    }
}

/// The viewport M41 stands in for (`docs/architecture/sync-and-netcode.md`: views clamp to 256
/// tiles per axis; 256 x 144 is a 16:9 view at that width).
pub const VIEW_W: u32 = 256;
pub const VIEW_H: u32 = 144;

/// Lines whose span meets a `VIEW_W x VIEW_H` rect at the world's centre (M41's visible set).
pub fn visible_at_centre(w: &BenchWorld) -> Vec<bool> {
    visible_in(w, VIEW_W, VIEW_H)
}

/// Lines whose span meets a `width x height` rect at the world's centre.
pub fn visible_in(w: &BenchWorld, width: u32, height: u32) -> Vec<bool> {
    let x0 = (w.width / 2).saturating_sub(width / 2);
    let y0 = (w.height / 2).saturating_sub(height / 2);
    w.spans
        .iter()
        .map(|s| s.meets(x0, y0, x0 + width, y0 + height))
        .collect()
}

/// `Regime::SaturatedView` (M41): `rows` rows of [`VIEW_W`] belt tiles (144 at full scale: 36,864
/// tiles, all of them in one viewport). Each row is filled from `x = 0` with belt chains of 1-6
/// lines of 4-48 tiles (the standard world's distribution; the chain that reaches the row's end is
/// cut there). Every belt chain gives two lane chains, packed full from the front (gap 0, so the
/// stream is saturated from tick 0), its front line into a `Sink`, a spawner at `rate256 = 256` on
/// its rear line; alternate belt chains carry one item kind or cycle `1..=KINDS`, as in `Mixed`.
///
/// Jams: `jam_pct` % of the lane-chain sinks (rounded down; chosen by a seeded shuffle) are
/// [`Toggle`]s, each with a seeded phase in `0..period`: closed for half the period, open for the
/// other half, staggered so the toggles spread evenly over time. `period = 0`: none toggles.
pub fn saturated_view_world(seed: u64, jam_pct: u8, period: u16, rows: u32) -> BenchWorld {
    let mut rng = SimRng::new(seed);
    let mut belts: Vec<(u32, Vec<u32>)> = Vec::new(); // (row, segment tiles front first)
    for y in 0..rows {
        let mut x = 0;
        while x < VIEW_W {
            let n = 1 + rng.below(6);
            let mut segs = Vec::new();
            for _ in 0..n {
                if x == VIEW_W {
                    break;
                }
                let t = (4 + rng.below(45)).min(VIEW_W - x);
                segs.push(t);
                x += t;
            }
            belts.push((y, segs));
        }
    }
    let mut lines = Vec::new();
    let mut spans = Vec::new();
    let mut spawners = Vec::new();
    let mut sinks = Vec::new();
    let mut row_x = vec![0u32; rows as usize];
    for (b, (y, segs)) in belts.iter().enumerate() {
        let x_start = row_x[*y as usize];
        row_x[*y as usize] += segs.iter().sum::<u32>();
        let same_kind = b % 2 == 0;
        for lane in 0..2u32 {
            let kind0 = ((2 * b as u32 + lane) % u32::from(KINDS)) as Item;
            let kind = |j: u32| -> Item {
                if same_kind {
                    kind0 + 1
                } else {
                    ((u32::from(kind0) + j) % u32::from(KINDS)) as Item + 1
                }
            };
            let first_line = lines.len() as u32;
            let mut j = 0u32;
            let mut x = x_start;
            for (s, &t) in segs.iter().enumerate() {
                let len = t * TILE;
                let items = (0..len / SPACING)
                    .map(|i| {
                        let item = kind(j);
                        j += 1;
                        (item, i * SPACING)
                    })
                    .collect();
                lines.push(LineSpec {
                    len,
                    speed: SPEED,
                    out: if s == 0 {
                        Out::Sink
                    } else {
                        Out::Next(first_line + s as u32 - 1)
                    },
                    items_at_rest: items,
                });
                spans.push(Span { x0: x, y: *y, w: t });
                x += t;
            }
            sinks.push(first_line);
            spawners.push(Spawner {
                line: first_line + segs.len() as u32 - 1,
                rate256: 256,
                first: kind(j),
                cycle: !same_kind,
            });
        }
    }
    // A seeded shuffle of the sinks; the first `jam_pct` % toggle.
    for i in (1..sinks.len()).rev() {
        let k = rng.below(i as u32 + 1) as usize;
        sinks.swap(i, k);
    }
    let n_jam = if period == 0 {
        0
    } else {
        sinks.len() * usize::from(jam_pct) / 100
    };
    let mut toggles: Vec<Toggle> = sinks[..n_jam]
        .iter()
        .map(|&line| Toggle {
            line,
            phase: rng.below(u32::from(period)) as u16,
        })
        .collect();
    toggles.sort_unstable_by_key(|t| t.line);
    let order = update_order(&lines);
    BenchWorld {
        seed,
        regime: Regime::SaturatedView { jam_pct, period },
        lines,
        order,
        spawners,
        inserter_calls: 0,
        spans,
        width: VIEW_W,
        height: rows,
        toggles,
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
