//! `RefWorldgen`/`RefParams` (docs/plan/20-reference-game-v0.md Scope, Order of work step 2):
//! five-octave height / three-octave moisture f64 simplex fBm gives five base terrains (deep
//! water, water, sand, grass, dirt); a `hash2` scatter puts iron, wood, stone or coal on land
//! tiles only, per Planning decisions ("Scatter is per-tile and independent ... Wood only on
//! grass, stone only on dirt and sand, iron and coal on any land").

use engine::world::{ChunkCoord, Tile};
use engine::worldgen::{Worldgen, hash2};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{content, noise};

/// Chunk edge this game always generates at (0007 §3's default, `Game::CHUNK_BITS`'s own default
/// of 5): fixed at compile time, like every other game's `CHUNK_BITS` (`fx-worldgen`'s own
/// precedent, docs/plan/08-worldgen-and-gen-worker.md Deviations) -- `Worldgen::generate`'s
/// signature carries no `ChunkDims` parameter, so this is the only way `out`'s length and this
/// file's own tiling math agree.
const EDGE: i32 = 32;

/// Seed-independent knobs (Scope: "octave counts, scales, sea level, per-resource density").
/// Densities are out of 65,536 (one `hash2` draw's low 16 bits), matching `fx-worldgen`'s own
/// scatter convention.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RefParams {
    pub height_octaves: u32,
    pub height_freq: f64,
    pub moisture_octaves: u32,
    pub moisture_freq: f64,
    /// Height threshold below which a tile is deep water.
    pub deep_water_level: f64,
    /// Height threshold below which a tile is (shallow) water.
    pub water_level: f64,
    /// Height threshold below which a land tile is sand rather than grass/dirt.
    pub sand_level: f64,
    /// Above `sand_level`, a tile is dirt when moisture is below this, else grass.
    pub dirt_moisture_max: f64,
    pub iron_density: u32,
    pub wood_density: u32,
    pub stone_density: u32,
    pub coal_density: u32,
}

impl Default for RefParams {
    fn default() -> Self {
        RefParams {
            height_octaves: 5,
            height_freq: 1.0 / 128.0,
            moisture_octaves: 3,
            moisture_freq: 1.0 / 128.0,
            deep_water_level: -0.25,
            water_level: -0.05,
            sand_level: 0.0,
            dirt_moisture_max: 0.0,
            iron_density: 1200,
            wood_density: 3500,
            stone_density: 1200,
            coal_density: 900,
        }
    }
}

pub struct RefWorldgen;

/// Height/moisture -> one of the five base terrain ids (`content::{DEEP_WATER, WATER, SAND,
/// GRASS, DIRT}`).
#[inline]
fn classify(h: f64, m: f64, p: &RefParams) -> u8 {
    if h < p.deep_water_level {
        content::DEEP_WATER
    } else if h < p.water_level {
        content::WATER
    } else if h < p.sand_level {
        content::SAND
    } else if m < p.dirt_moisture_max {
        content::DIRT
    } else {
        content::GRASS
    }
}

/// One `hash2` draw against a per-resource, per-terrain density (Planning decisions): land only,
/// each terrain offering a fixed, ordered subset so the same draw always resolves to the same
/// resource (or none) for that tile. Returns `0` ("no resource") on water or when the draw misses
/// every allowed resource's slice.
#[inline]
fn scatter_resource(seed: u64, wx: i32, wy: i32, terrain: u8, p: &RefParams) -> u8 {
    let allowed: [(u8, u32); 3] = match terrain {
        t if t == content::GRASS => [
            (content::IRON, p.iron_density),
            (content::WOOD, p.wood_density),
            (content::COAL, p.coal_density),
        ],
        t if t == content::DIRT || t == content::SAND => [
            (content::IRON, p.iron_density),
            (content::STONE, p.stone_density),
            (content::COAL, p.coal_density),
        ],
        // Requirements: "No resources on water."
        _ => return 0,
    };
    let r = (hash2(seed, wx, wy) & 0xffff) as u32;
    let mut acc = 0u32;
    for &(id, density) in &allowed {
        acc += density;
        if r < acc {
            return id;
        }
    }
    0
}

impl Worldgen for RefWorldgen {
    type Params = RefParams;
    const WORLDGEN_VERSION: u32 = 1;

    fn generate(seed: u64, params: &RefParams, chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        let seed32 = (seed as u32) ^ ((seed >> 32) as u32);
        let bx = chunk.x.wrapping_mul(EDGE);
        let by = chunk.y.wrapping_mul(EDGE);
        for ty in 0..EDGE {
            let wy = by.wrapping_add(ty);
            for tx in 0..EDGE {
                let wx = bx.wrapping_add(tx);
                let h = noise::height(
                    seed32,
                    wx as f64,
                    wy as f64,
                    params.height_freq,
                    params.height_octaves,
                );
                let m = noise::moisture(
                    seed32,
                    wx as f64,
                    wy as f64,
                    params.moisture_freq,
                    params.moisture_octaves,
                );
                let terrain = classify(h, m, params);
                let resource = scatter_resource(seed, wx, wy, terrain, params);
                let aux = if resource != 0 {
                    content::UNITS_PER_TILE
                } else {
                    0
                };
                let i = (ty * EDGE + tx) as usize;
                out[i] = Tile::new(terrain, resource, aux);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scatter_never_puts_a_resource_on_water() {
        assert_eq!(
            scatter_resource(1, 5, 5, content::DEEP_WATER, &RefParams::default()),
            0
        );
        assert_eq!(
            scatter_resource(1, 5, 5, content::WATER, &RefParams::default()),
            0
        );
    }

    #[test]
    fn scatter_only_offers_wood_on_grass() {
        let p = RefParams::default();
        for wx in 0..2000 {
            assert_ne!(scatter_resource(7, wx, 0, content::SAND, &p), content::WOOD);
            assert_ne!(scatter_resource(7, wx, 0, content::DIRT, &p), content::WOOD);
        }
    }

    #[test]
    fn scatter_never_offers_stone_on_grass() {
        let p = RefParams::default();
        for wx in 0..2000 {
            assert_ne!(
                scatter_resource(7, wx, 0, content::GRASS, &p),
                content::STONE
            );
        }
    }
}
