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
//! field, which nothing draws: [`MARKER`], the seed's low and high halves, the scale. Genesis
//! reads them.
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
//! Every write stops at the first refusal, so a world whose caps are too small is visibly short
//! (`bench_world_at_genesis_is_deterministic` asserts the counts). Geometry upkeep at genesis is
//! O(index) per line (0079 §14): about a second natively in release at full scale.

pub mod world;

use engine::game::WorldWrite;
use engine::transport::{Geometry, Item, LineId, Output, Segment};
use engine::world::{Tile, TilePos, WorldPos};

use crate::{Belts, Pos, Spawner, Thing};
use world::{Out, Regime, TILE};

/// The bench world to build: M40's `bench_world_scaled(seed, Regime::Mixed, scale)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct BenchSpec {
    /// `bench_world`'s seed (M40 and the gated benchmark: 7).
    pub seed: u32,
    /// 1 = full scale; `n` divides tiles and items by `n` (the fast test and the golden use 64).
    /// At most `u16::MAX` (it rides in one tile's `aux`).
    pub scale: u16,
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
/// tile)`): `x = -1, -2, -3, -4` on its last row.
pub fn marker_tiles(spec: BenchSpec) -> [(usize, Tile); 4] {
    [
        (31 * 32 + 31, plain(MARKER)),
        (31 * 32 + 30, plain(spec.seed as u16)),
        (31 * 32 + 29, plain((spec.seed >> 16) as u16)),
        (31 * 32 + 28, plain(spec.scale)),
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
    })
}

/// Builds `spec`'s world (module doc).
pub fn build(w: &mut dyn WorldWrite<Belts>, spec: BenchSpec) {
    let bw = world::bench_world_scaled(u64::from(spec.seed), Regime::Mixed, u32::from(spec.scale));
    let mut ids: Vec<LineId> = Vec::with_capacity(bw.lines.len());
    {
        let Ok(t) = w.transport_mut() else {
            return; // unreachable: genesis answers `Ok` (0079 §4).
        };
        for l in &bw.lines {
            match t.create(l.len, l.speed) {
                Ok(id) => ids.push(id),
                Err(_) => return,
            }
        }
        for (i, l) in bw.lines.iter().enumerate() {
            let out = match l.out {
                Out::DeadEnd => Output::DeadEnd,
                Out::Sink => Output::Sink,
                Out::Next(j) => Output::Next(ids[j as usize]),
            };
            if t.set_out(ids[i], out).is_err() {
                return;
            }
        }
        for (i, l) in bw.lines.iter().enumerate() {
            for &(item, pos) in &l.items_at_rest {
                if t.insert_at(ids[i], pos, Item(item)).is_err() {
                    return;
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
            if t.set_segments(ids[i], &[seg]).is_err() {
                return;
            }
        }
    }
    for sp in &bw.spawners {
        let s = bw.spans[sp.line as usize];
        let period = (65_536 + u32::from(sp.rate256) / 2) / u32::from(sp.rate256);
        let spawner = Spawner {
            at: Pos {
                x: (s.x0 + s.w - 1) as i32,
                y: s.y as i32,
            },
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
}
