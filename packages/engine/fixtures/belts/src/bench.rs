//! The standard belt world at genesis (M45): `BeltsParams.bench = Some(spec)` makes
//! [`crate::Belts::genesis`] build M40's `Mixed` world ([`world::bench_world_scaled`]: 3,810
//! lines, 50,000 belt tiles and 250,000 items at seed 7, scale 1) directly through
//! `transport_mut()`, which is `Ok` in genesis (docs/decisions/0079 §4); 3,810 lines would not fit
//! the request pattern's 32-slot chain table. `None` (JSON `null`, every scenario file) is the
//! empty world every golden starts from.
//!
//! **How genesis sees the spec.** `Game::genesis` gets no params, so the worldgen carries them (the
//! reference game's bench marker, `games/reference/sim/src/bench.rs`): with a spec,
//! [`crate::FlatWorldgen`] writes four tiles at `y = -1`, `x = -1 ..= -4` (chunk `(-1, -1)`, far
//! from every bench line), each the world's plain tile kind with the data in its 16-bit `aux`
//! field, which nothing draws: [`MARKER`], the seed's low and high halves, the scale; and (M47b)
//! the regime in three more at `x = -5 ..= -7` ([`BenchRegime`]: its tag and `jam_pct`, `period`,
//! `speed`), all 0 for `Mixed`, which is the plain tile, so a `Mixed` spec's world is the one it was
//! (`golden-bench-64.json` holds). Genesis reads them.
//!
//! **Regimes (M47b).** [`BenchRegime::Mixed`] is M40's world; `InserterLike` adds one
//! [`crate::Thing::Inserter`] making M40's `2,000 / scale` edits a tick; `MixedEmpty` is `Mixed`
//! with no item at rest (M41's "empty at the start"); `SaturatedView { jam_pct, period, speed }` is
//! M44b's [`world::saturated_view_world`] (`144 / scale` rows of 256 tiles), every line at `speed`
//! (0: 24), with one [`crate::Thing::Jam`] per toggled sink (M41's jam schedule). `MixedFeeders`
//! (M48c) is `Mixed` with a stateless [`crate::Thing::Feeder`] in place of every spawner (same
//! lines, same items at rest; the item the world gives the chain, a cycling chain's first kind):
//! one `insert_back` attempt a tick, never written, the shape the reference game's spawners must
//! take (0079 §19 (e)).
//!
//! **What is built.** Per line, in the world's order: `create(len, 24)`; then every `set_out`
//! (`Next`, `Sink`, `DeadEnd`); every item at rest by `insert_at`, front to back; one straight
//! segment per line from its tile [`world::Span`] (front at `x0`, items moving toward `-x`; lane 0
//! a quarter tile into the row, lane 1 three quarters), so chunk sets and the tile index are real.
//! Then one [`crate::Thing::Spawner`] (or [`crate::Thing::Cycling`] where M40's spawner cycles its
//! item) per world spawner at its line's back tile, on the
//! `"spawner"` list from tick 1 (a genesis spawn is woken; `Belts::tick` activates a woken
//! spawner). Rates: `period = round(65,536 / rate256)` (M40's `rate256` per 256 ticks; 24 becomes
//! 2,731, 0.01 % slower than the spike's).
//! A refused write panics, naming the step and the line (M47b: a fixture-only genesis, and a world
//! cut short by small caps once passed silently; `bench_world_at_genesis_is_deterministic` asserts
//! the counts). Geometry upkeep at genesis is
//! O(index) per line (0079 §14): about a second natively in release at full scale.

pub mod world;

use engine::game::WorldWrite;
use engine::transport::{Geometry, Item, LineId, Output, Segment};
use engine::world::{Tile, TilePos, WorldPos};

use crate::{Belts, Feeder, Inserter, Jam, Pos, Spawner, Thing};
use world::{Out, Regime, TILE};

/// The bench world to build: `bench_world_scaled(seed, regime, scale)` (M40's `Mixed` by default).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct BenchSpec {
    /// `bench_world`'s seed (M40 and the gated benchmark: 7).
    pub seed: u32,
    /// 1 = full scale; `n` divides tiles and items by `n` (the fast test and the golden use 64).
    /// At most `u16::MAX` (it rides in one tile's `aux`).
    pub scale: u16,
    /// M47b: which world (module doc). Absent in JSON is `Mixed`, and `Mixed` is never written, so
    /// every earlier spec reads and writes as it did.
    #[serde(default)]
    pub regime: BenchRegime,
}

/// The bench world's regime (M47b, module doc). JSON: `"Mixed"`, `"InserterLike"`,
/// `"MixedEmpty"`, `"MixedFeeders"` (M48c) or `{"SaturatedView": {"jam_pct": 20, "period": 100, "speed": 0}}` (`speed`
/// optional, 0 = 24).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum BenchRegime {
    #[default]
    Mixed,
    InserterLike,
    MixedEmpty,
    SaturatedView {
        jam_pct: u8,
        period: u16,
        #[serde(default)]
        speed: u16,
    },
    MixedFeeders,
}

impl BenchRegime {
    pub fn is_mixed(&self) -> bool {
        *self == BenchRegime::Mixed
    }

    /// The plain-data world's regime.
    pub fn world(self) -> Regime {
        match self {
            BenchRegime::Mixed | BenchRegime::MixedEmpty | BenchRegime::MixedFeeders => {
                Regime::Mixed
            }
            BenchRegime::InserterLike => Regime::InserterLike,
            BenchRegime::SaturatedView {
                jam_pct, period, ..
            } => Regime::SaturatedView { jam_pct, period },
        }
    }

    /// The three marker `aux` values (`x = -5, -6, -7`): all 0 for `Mixed`.
    fn encode(self) -> [u16; 3] {
        match self {
            BenchRegime::Mixed => [0, 0, 0],
            BenchRegime::InserterLike => [1, 0, 0],
            BenchRegime::MixedEmpty => [2, 0, 0],
            BenchRegime::SaturatedView {
                jam_pct,
                period,
                speed,
            } => [3 | (u16::from(jam_pct) << 8), period, speed],
            BenchRegime::MixedFeeders => [4, 0, 0],
        }
    }

    /// The inverse of [`BenchRegime::encode`]; an unknown tag reads as `Mixed`.
    fn decode(aux: [u16; 3]) -> Self {
        match aux[0] & 0xff {
            1 => BenchRegime::InserterLike,
            2 => BenchRegime::MixedEmpty,
            3 => BenchRegime::SaturatedView {
                jam_pct: (aux[0] >> 8) as u8,
                period: aux[1],
                speed: aux[2],
            },
            4 => BenchRegime::MixedFeeders,
            _ => BenchRegime::Mixed,
        }
    }
}

/// `Worldgen::Params` of `fx-belts` (JSON `null` or `{"bench": {"seed": 7, "scale": 1}}`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(from = "Option<RawParams>", into = "Option<RawParams>")]
pub struct BeltsParams {
    pub bench: Option<BenchSpec>,
}

/// The wire shape of [`BeltsParams`]: `null` stays `null` (every scenario's `"params": null`).
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct RawParams {
    #[serde(default)]
    bench: Option<BenchSpec>,
}

impl From<Option<RawParams>> for BeltsParams {
    fn from(r: Option<RawParams>) -> Self {
        BeltsParams {
            bench: r.and_then(|r| r.bench),
        }
    }
}

impl From<BeltsParams> for Option<RawParams> {
    fn from(p: BeltsParams) -> Self {
        p.bench.map(|b| RawParams { bench: Some(b) })
    }
}

/// The first marker tile's `aux` (module doc).
pub const MARKER: u16 = 0xBE17;
const MARKER_ROW: i32 = -1;

/// The tile `FlatWorldgen` writes everywhere; the marker tiles differ only in `aux`.
fn plain(aux: u16) -> Tile {
    Tile::new(0, 0, aux)
}

/// The tiles the worldgen writes into chunk `(-1, -1)` for `spec` (`(index in the 32 x 32 chunk,
/// tile)`): `x = -1 ..= -7` on its last row (the last three plain for `Mixed`).
pub fn marker_tiles(spec: BenchSpec) -> [(usize, Tile); 7] {
    let r = spec.regime.encode();
    [
        (31 * 32 + 31, plain(MARKER)),
        (31 * 32 + 30, plain(spec.seed as u16)),
        (31 * 32 + 29, plain((spec.seed >> 16) as u16)),
        (31 * 32 + 28, plain(spec.scale)),
        (31 * 32 + 27, plain(r[0])),
        (31 * 32 + 26, plain(r[1])),
        (31 * 32 + 25, plain(r[2])),
    ]
}

/// The spec the worldgen carried, if any: four reads of terrain tiles.
pub fn marker(w: &dyn engine::game::WorldRead<Belts>) -> Option<BenchSpec> {
    let at = |x| {
        w.tile(TilePos::new(x, MARKER_ROW))
            .ok()
            .filter(|t| t.base() == 0 && t.resource() == 0)
            .map(|t| t.aux())
    };
    if at(-1)? != MARKER {
        return None;
    }
    Some(BenchSpec {
        seed: u32::from(at(-2)?) | (u32::from(at(-3)?) << 16),
        scale: at(-4)?.max(1),
        regime: BenchRegime::decode([
            at(-5).unwrap_or(0),
            at(-6).unwrap_or(0),
            at(-7).unwrap_or(0),
        ]),
    })
}

/// The plain-data world `spec` builds: `bench_world_scaled` with the regime's own edits
/// (`MixedEmpty` clears every line's items, `SaturatedView.speed` sets every line's speed). Genesis
/// and the tests' count checks share it.
pub fn world_of(spec: BenchSpec) -> world::BenchWorld {
    let mut bw = world::bench_world_scaled(
        u64::from(spec.seed),
        spec.regime.world(),
        u32::from(spec.scale),
    );
    match spec.regime {
        BenchRegime::MixedEmpty => bw.lines.iter_mut().for_each(|l| l.items_at_rest.clear()),
        BenchRegime::SaturatedView { speed, .. } if speed > 0 => {
            bw.lines.iter_mut().for_each(|l| l.speed = speed)
        }
        _ => {}
    }
    bw
}

/// Builds `spec`'s world (module doc).
pub fn build(w: &mut dyn WorldWrite<Belts>, spec: BenchSpec) {
    let bw = world_of(spec);
    let mut ids: Vec<LineId> = Vec::with_capacity(bw.lines.len());
    {
        let Ok(t) = w.transport_mut() else {
            return; // unreachable: genesis answers `Ok` (0079 §4).
        };
        for l in &bw.lines {
            match t.create(l.len, l.speed) {
                Ok(id) => ids.push(id),
                Err(e) => panic!("bench genesis: create line {}: {e:?}", ids.len()),
            }
        }
        for (i, l) in bw.lines.iter().enumerate() {
            let out = match l.out {
                Out::DeadEnd => Output::DeadEnd,
                Out::Sink => Output::Sink,
                Out::Next(j) => Output::Next(ids[j as usize]),
            };
            if let Err(e) = t.set_out(ids[i], out) {
                panic!("bench genesis: set_out line {i}: {e:?}");
            }
        }
        for (i, l) in bw.lines.iter().enumerate() {
            for &(item, pos) in &l.items_at_rest {
                if let Err(e) = t.insert_at(ids[i], pos, Item(item)) {
                    panic!("bench genesis: insert_at line {i} pos {pos}: {e:?}");
                }
            }
        }
        // Lanes: lane chains alternate 0, 1 per belt chain, each starting at a line that does not
        // feed another (its front).
        let mut chain = 0u32;
        for (i, (l, s)) in bw.lines.iter().zip(&bw.spans).enumerate() {
            if i > 0 && !matches!(l.out, Out::Next(_)) {
                chain += 1;
            }
            let y = (s.y * TILE
                + if chain.is_multiple_of(2) {
                    TILE / 4
                } else {
                    3 * TILE / 4
                }) as i32;
            let seg = Segment {
                len: l.len,
                geometry: Geometry::Straight {
                    from: WorldPos {
                        x: (s.x0 * TILE) as i32,
                        y,
                    },
                    to: WorldPos {
                        x: ((s.x0 + s.w) * TILE) as i32,
                        y,
                    },
                },
            };
            if let Err(e) = t.set_segments(ids[i], &[seg]) {
                panic!("bench genesis: set_segments line {i}: {e:?}");
            }
        }
    }
    for sp in &bw.spawners {
        let s = bw.spans[sp.line as usize];
        let at = Pos {
            x: (s.x0 + s.w - 1) as i32,
            y: s.y as i32,
        };
        if spec.regime == BenchRegime::MixedFeeders {
            w.spawn(Thing::Feeder(Feeder {
                at,
                line: ids[sp.line as usize].0,
                item: sp.first,
            }));
            continue;
        }
        let period = (65_536 + u32::from(sp.rate256) / 2) / u32::from(sp.rate256);
        let spawner = Spawner {
            at,
            line: ids[sp.line as usize].0,
            item: sp.first,
            period: period.max(256),
            acc: 0,
            spawned: 0,
        };
        w.spawn(if sp.cycle {
            Thing::Cycling(spawner)
        } else {
            Thing::Spawner(spawner)
        });
    }
    if let Regime::SaturatedView { period, .. } = bw.regime {
        for tg in &bw.toggles {
            let s = bw.spans[tg.line as usize];
            w.spawn(Thing::Jam(Jam {
                at: Pos {
                    x: s.x0 as i32,
                    y: s.y as i32,
                },
                line: ids[tg.line as usize].0,
                phase: tg.phase,
                period,
            }));
        }
    }
    // The edits name lines by id, so they need the ids `create` handed out in order (a fresh
    // store's are 1, 2, ...): anything else would silently make `InserterLike` a `Mixed` world.
    if bw.inserter_calls > 0 && !ids.is_empty() {
        assert!(
            ids.windows(2).all(|p| p[1].0 == p[0].0 + 1),
            "InserterLike needs contiguous line ids at genesis"
        );
        w.spawn(Thing::Inserter(Inserter {
            at: Pos { x: 0, y: 0 },
            first: ids[0].0,
            lines: ids.len() as u32,
            calls: bw.inserter_calls,
            seed: spec.seed,
        }));
    }
}
