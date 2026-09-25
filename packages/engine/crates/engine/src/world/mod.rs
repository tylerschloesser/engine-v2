//! The world model (docs/decisions/0007-world-model.md): tiles, coordinates, trait tables, and
//! `TerrainStore` -- sparse canonical overlays over a pure pristine function, cached through an
//! LRU dense slab pool that nothing outside this module can observe (0007 Consequences).
//! `engine::testing::cache_matrix` (feature `testing`) mechanically proves the cache is invisible:
//! `assert_cache_invisible` replays the same script at capacity 1, default and unlimited, with
//! generation pre-warmed in shuffled orders, and requires identical state hashes and reads.

mod cache;
mod coords;
mod overlay;
mod terrain;
mod tile;
mod traits;

pub use cache::{CacheCapacity, CacheEvent};
pub use coords::{
    ChunkCoord, ChunkDims, ChunkRect, ChunkRectIter, TILE_MAX, TILE_MIN, TilePos, TileRect,
    WorldPos,
};
pub use overlay::{ChunkOverlay, Overlays};
pub use terrain::{OutOfRange, PristineSource, TerrainStore, TileChange};
pub use tile::Tile;
pub use traits::{Footprint, PrototypeId, Registry, SystemId, TraitSet};
