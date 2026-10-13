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
//! divisor and the regime ([`marker`]).
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
//!
//! **The belt field** (M57, [`Regime::Belts`], `?bench=belts`): the marker's bits 13-14 name the
//! regime, so the same flat terrain carries either world. [`build_belts`] writes [`FIELD_RUNS`]
//! east-west runs of [`FIELD_W`] tiles, one every [`RUN_PITCH`] rows from the origin (the 256 x 144
//! view at the camera's maximum zoom-out): a spawner at the west end (both lanes at saturation,
//! `content::SPAWN_RATES[3]`, item [`FEED`] by run), belts, a despawner at the east end; every
//! [`SPECIAL_EVERY`]th run (from the first) carries a splitter pair at [`SPLITTER_X`] (two east
//! splitters side by side, their right halves in the row below: the first's right output feeds the
//! second's right half, whose own right output dead-ends; the first's right half has no input, so in
//! steady state that stub fills and both splitters' forks send everything left) and an
//! underground pair from [`UNDERGROUND_X`] with a gap of [`UNDERGROUND_GAP`] tiles. The entities
//! are spawned row-major (the layout's order, `tests/common/layout.rs` `bench_field`) and woken by
//! the spawn (genesis writes go through `Authority`'s own `WorldWrite`), so tick 1's
//! `topology::on_wake` maps every line and sets every spawner's schedule: no action, no timer.
//! Nothing reads the seed: the field depends on the marker alone.

use engine::game::{WorldRead, WorldWrite};
use engine::time::Tick;
use engine::world::{ChunkCoord, Tile, TilePos};

use crate::{Belt, BeltKind, Dir, Furnace, RefEntity, RefGame, SpawnCfg, TileXY, content};

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
/// The marker's regime field (M57): bits 13-14, beside the scale in bits 0-12.
const REGIME_SHIFT: u16 = 13;
const REGIME_MASK: u16 = 0x3;
const SCALE_MASK: u16 = 0x1fff;

/// What genesis builds on the bench terrain (M57): `RefParams::bench_regime` as a number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Regime {
    /// `0`: the standard large save (0020 §9), [`build`].
    LargeSave,
    /// `1`: the belt field (module doc), [`build_belts`].
    Belts,
}

impl Regime {
    /// `RefParams::bench_regime`'s value; an unknown number reads as the large save.
    pub const fn from_param(n: u32) -> Regime {
        match n {
            1 => Regime::Belts,
            _ => Regime::LargeSave,
        }
    }

    const fn bits(self) -> u16 {
        match self {
            Regime::LargeSave => 0,
            Regime::Belts => 1,
        }
    }
}

/// The belt field (module doc): runs, their length and pitch.
pub const FIELD_RUNS: u32 = 48;
pub const FIELD_W: i32 = 256;
pub const RUN_PITCH: i32 = 3;
/// Every this many runs (the first included) carries the splitter and underground pairs.
pub const SPECIAL_EVERY: u32 = 8;
/// The first splitter's tile on a special run (the second is one east).
pub const SPLITTER_X: i32 = 64;
/// The underground entrance's tile on a special run; the exit is `UNDERGROUND_GAP + 1` east.
pub const UNDERGROUND_X: i32 = 128;
pub const UNDERGROUND_GAP: i32 = 4;
/// Run `k`'s spawner makes `FEED[k % 4]` on both lanes (`content::ItemId` wire ids: iron, coal,
/// wood, stone, as M56's balancer).
pub const FEED: [u8; 4] = [
    content::ItemId::Iron as u8,
    content::ItemId::Coal as u8,
    content::ItemId::Wood as u8,
    content::ItemId::Stone as u8,
];
/// `content::SPAWN_RATES`' saturation index.
pub const SATURATE: u8 = 3;

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
/// block, and the marker tile (aux = `0x8000 | regime << 13 | scale`).
pub fn pristine_tile(chunk: ChunkCoord, tx: i32, ty: i32, scale: u32, regime: u32) -> Tile {
    if chunk.x == -1 && chunk.y == -1 && tx == 31 && ty == 31 {
        let regime = Regime::from_param(regime).bits() << REGIME_SHIFT;
        let scale = scale.min(u32::from(SCALE_MASK)) as u16;
        return Tile::new(content::GRASS, 0, MARKER_FLAG | regime | scale);
    }
    let in_block =
        (MOD_X0..MOD_X0 + MOD_BLOCK).contains(&chunk.x) && (0..MOD_BLOCK).contains(&chunk.y);
    if in_block {
        Tile::new(content::GRASS, content::IRON, content::UNITS_PER_TILE)
    } else {
        Tile::new(content::GRASS, 0, 0)
    }
}

/// `Some((scale, regime))` when this world's worldgen carried the bench marker. A read of one
/// terrain tile.
pub fn marker(w: &dyn WorldRead<RefGame>) -> Option<(u32, Regime)> {
    let t = w.tile(MARKER_TILE).ok()?;
    (t.aux() & MARKER_FLAG != 0 && t.base() == content::GRASS && t.resource() == 0).then(|| {
        let regime = Regime::from_param(u32::from((t.aux() >> REGIME_SHIFT) & REGIME_MASK));
        (u32::from(t.aux() & SCALE_MASK), regime)
    })
}

/// The belt field's placements in row-major order (`y`, then `x`): `(tile, facing, kind)`, the
/// anchors only (a splitter's second tile is the one south of it). `runs` east-west runs; see the
/// module doc.
pub fn belt_field(runs: u32) -> Vec<(TileXY, Dir, BeltKind)> {
    let mut v = Vec::new();
    for k in 0..runs {
        let y = k as i32 * RUN_PITCH;
        let special = k % SPECIAL_EVERY == 0;
        let exit_x = UNDERGROUND_X + UNDERGROUND_GAP + 1;
        for x in 0..FIELD_W {
            let kind = if x == 0 {
                BeltKind::Spawner
            } else if x == FIELD_W - 1 {
                BeltKind::Despawner
            } else if special && (x == SPLITTER_X || x == SPLITTER_X + 1) {
                BeltKind::Splitter
            } else if special && x == UNDERGROUND_X {
                BeltKind::UndergroundIn
            } else if special && x == exit_x {
                BeltKind::UndergroundOut
            } else if special && x > UNDERGROUND_X && x < exit_x {
                continue;
            } else {
                BeltKind::Belt
            };
            v.push((TileXY { x, y }, Dir::East, kind));
        }
    }
    v
}

/// Writes the belt field (module doc) of `FIELD_RUNS / scale` runs (at least one): one spawn per
/// placement, the spawners configured at saturation. Woken by the spawn; tick 1 maps them.
pub fn build_belts(w: &mut dyn WorldWrite<RefGame>, scale: u32) {
    let runs = (FIELD_RUNS / scale.max(1)).max(1);
    let mut spawner = 0usize;
    for (origin, dir, kind) in belt_field(runs) {
        let mut belt = Belt::new(origin, dir, kind);
        if kind == BeltKind::Spawner {
            let cfg = SpawnCfg {
                item: FEED[spawner % FEED.len()],
                rate: SATURATE,
            };
            belt.spawn = [Some(cfg); 2];
            spawner += 1;
        }
        w.spawn(RefEntity::Belt(belt));
    }
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
        let id = w.spawn(RefEntity::Furnace(Furnace {
            origin,
            iron_in: 999,
            coal: 50,
            wood: 0,
            burn_left: content::COAL_INGOTS,
            ingots_out: 0,
            smelt_done_at: Some(done),
        }));
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
