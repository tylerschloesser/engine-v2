//! The standard large save (docs/decisions/0020 §9; M36,
//! behind cargo feature `bench`. **Never ships**: `vite build` and the fast tier's `.wasm` never
//! enable the feature; `buildGame({ features: ['bench'] })` is the only way in (build dir
//! `target/engine/<profile>+bench`, a different build hash, so a bench client cannot join a normal
//! server). Same shape as `test-hooks` (`games/reference/CLAUDE.md`).
//!
//! The save is not a stored file: [`standard_large_save`] fills a fresh world through the ordinary
//! write path, reached from `RefGame::genesis` when the worldgen params carry the bench marker
//! (`RefParams::bench`, a scale divisor: `1` is the full save, `64` a 1/64-scale one for the fast
//! test). `Game::genesis` sees no params, so the marker is a tile: with `bench` set `RefWorldgen`
//! generates a flat bench terrain and a marker tile at [`MARKER_TILE`] whose `aux` carries the
//! divisor ([`marker_scale`]).
//!
//! Layout (chunks are 32x32 tiles, furnaces 2x2):
//! - **Furnaces:** [`ENTITIES_PER_CHUNK`] (200, 800 of 1,024 tiles) per chunk, in a block of chunks
//!   from the origin, `entity_cols` wide (37 x 36 for 1,311 chunks), row-major.
//! - **Depleted tiles:** [`MODIFIED_PER_CHUNK`] (256: the first 8 rows) per chunk in a block of
//!   chunks starting at chunk x = [`MOD_X0`], whose pristine tiles all hold iron, so each write
//!   really changes a tile. Disjoint from the furnace block.
//! - **Timers:** every furnace is lit (`burn_left`), stocked and carries a `smelt_done_at` deadline,
//!   `2 + (index + seed) mod SMELT`, uniformly staggered: 262,144 / 100 = 2,621.4 completions per
//!   tick. The builder arms each timer itself with `WorldWrite::wake_at` (ADR 0046).

use engine::game::{WorldRead, WorldWrite};
use engine::time::Tick;
use engine::world::{ChunkCoord, Tile, TilePos};

use crate::{Furnace, RefGame, TileXY, content};

/// Furnaces per dense chunk (0010 "dense chunk": 800 of 1,024 tiles under 2x2 footprints).
pub const ENTITIES_PER_CHUNK: u32 = 200;
/// Depleted resource tiles per modified chunk (0020 §9: 256).
pub const MODIFIED_PER_CHUNK: u32 = 256;
/// 0007 §8's shares at `WorldConfig` defaults: 32 MiB of entities at a nominal 128 B, and 12 MiB of
/// overlay at 12 B per modified tile.
pub const ENTITY_SHARE_BYTES: u64 = 32 << 20;
pub const NOMINAL_ENTITY_BYTES: u64 = 128;
pub const OVERLAY_SHARE_BYTES: u64 = 12 << 20;
pub const OVERLAY_ENTRY_BYTES: u64 = 12;
/// The first chunk column of the depleted-tile block.
pub const MOD_X0: i32 = 64;
/// The side of the depleted-tile block the bench worldgen fills with iron, in chunks.
pub const MOD_BLOCK: i32 = 64;
/// The tile whose `aux` carries the marker (the last tile of chunk (-1, -1)).
pub const MARKER_TILE: TilePos = TilePos::new(-1, -1);
const MARKER_FLAG: u16 = 0x8000;

/// How big a save is: the two state-budget figures (entity count, modified-tile count).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shape {
    pub entities: u32,
    pub modified_tiles: u32,
}

impl Shape {
    /// 0020 §9, computed from the 0007 §8 shares: 262,144 furnaces, 1,048,576 modified tiles.
    pub const FULL: Shape = Shape {
        entities: (ENTITY_SHARE_BYTES / NOMINAL_ENTITY_BYTES) as u32,
        modified_tiles: (OVERLAY_SHARE_BYTES / OVERLAY_ENTRY_BYTES) as u32,
    };

    /// `FULL` divided by `div` (the fast test's 1/64; `div` 0 is read as 1).
    pub const fn scaled(div: u32) -> Shape {
        let d = if div == 0 { 1 } else { div };
        Shape {
            entities: Self::FULL.entities / d,
            modified_tiles: Self::FULL.modified_tiles / d,
        }
    }

    pub const fn entity_chunks(self) -> u32 {
        self.entities.div_ceil(ENTITIES_PER_CHUNK)
    }

    pub const fn modified_chunks(self) -> u32 {
        self.modified_tiles.div_ceil(MODIFIED_PER_CHUNK)
    }
}

/// Smallest `c` with `c * c >= n`: the width of the square-ish block `n` chunks fill.
const fn cols(n: u32) -> u32 {
    let mut c = 1;
    while c * c < n {
        c += 1;
    }
    c
}

/// The bench worldgen's tile at `chunk` + local `(tx, ty)`: flat grass, iron over the depleted-tile
/// block, and the marker tile (aux = `0x8000 | scale`).
pub fn pristine_tile(chunk: ChunkCoord, tx: i32, ty: i32, scale: u32) -> Tile {
    if chunk.x == -1 && chunk.y == -1 && tx == 31 && ty == 31 {
        return Tile::new(content::GRASS, 0, MARKER_FLAG | (scale.min(0x7fff) as u16));
    }
    let in_block =
        (MOD_X0..MOD_X0 + MOD_BLOCK).contains(&chunk.x) && (0..MOD_BLOCK).contains(&chunk.y);
    if in_block {
        Tile::new(content::GRASS, content::IRON, content::UNITS_PER_TILE)
    } else {
        Tile::new(content::GRASS, 0, 0)
    }
}

/// `Some(scale)` when this world's worldgen carried the bench marker. A read of one terrain tile.
pub fn marker_scale(w: &dyn WorldRead<RefGame>) -> Option<u32> {
    let t = w.tile(MARKER_TILE).ok()?;
    (t.aux() & MARKER_FLAG != 0 && t.base() == content::GRASS && t.resource() == 0)
        .then(|| u32::from(t.aux() & !MARKER_FLAG))
}

/// The standard large save (0020 §9) at full scale: see the module doc.
pub fn standard_large_save(w: &mut dyn WorldWrite<RefGame>, seed: u64) {
    build(w, seed, Shape::FULL);
}

/// [`standard_large_save`] at any [`Shape`] (`Shape::scaled(64)` for the fast test).
pub fn build(w: &mut dyn WorldWrite<RefGame>, seed: u64, shape: Shape) {
    let ec = cols(shape.entity_chunks()) as i32;
    let offset = (seed % u64::from(content::SMELT.0)) as u32;
    for i in 0..shape.entities {
        let chunk = i / ENTITIES_PER_CHUNK;
        let slot = (i % ENTITIES_PER_CHUNK) as i32;
        let (cx, cy) = (chunk as i32 % ec, chunk as i32 / ec);
        let origin = TileXY {
            x: cx * 32 + (slot % 16) * 2,
            y: cy * 32 + (slot / 16) * 2,
        };
        let phase = (i + offset) % content::SMELT.0;
        let done = Tick(2 + phase);
        let id = w.spawn(Furnace {
            origin,
            iron_in: 999,
            coal: 50,
            wood: 0,
            burn_left: content::COAL_INGOTS,
            ingots_out: 0,
            smelt_done_at: Some(done),
        });
        // Armed here (ADR 0046): the first wake finds `done` still ahead and leaves the timer.
        w.wake_at(id, done);
    }
    let mc = cols(shape.modified_chunks()) as i32;
    for i in 0..shape.modified_tiles {
        let chunk = (i / MODIFIED_PER_CHUNK) as i32;
        let local = (i % MODIFIED_PER_CHUNK) as i32;
        let p = TilePos::new(
            (MOD_X0 + chunk % mc) * 32 + local % 32,
            (chunk / mc) * 32 + local / 32,
        );
        // Depleted: the resource gone, no units left (`rules::collect::tick`'s final write).
        w.set_tile(p, Tile::new(content::GRASS, 0, 0));
    }
}
