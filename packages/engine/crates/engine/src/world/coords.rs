//! Coordinates (docs/decisions/0007-world-model.md §2-3): tile/chunk/world positions, chunk
//! dimensions, and the tile/chunk rectangles the client's `visible()` and the world's `entities_in`
//! iterate.

/// A tile coordinate. Valid range is `[-2^23, 2^23)` per axis (0007 §2): `WorldPos`'s Q24.8 raw
/// `i32` covers exactly this range, one tile step per 256 raw units.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

/// Lower bound of a valid tile coordinate on either axis (inclusive).
pub const TILE_MIN: i32 = -(1 << 23);
/// Upper bound of a valid tile coordinate on either axis (inclusive).
pub const TILE_MAX: i32 = (1 << 23) - 1;

impl TilePos {
    #[inline]
    pub const fn new(x: i32, y: i32) -> Self {
        TilePos { x, y }
    }

    /// Whether both axes fall in `[TILE_MIN, TILE_MAX]` (0007 §2).
    #[inline]
    pub const fn in_range(self) -> bool {
        self.x >= TILE_MIN && self.x <= TILE_MAX && self.y >= TILE_MIN && self.y <= TILE_MAX
    }
}

/// A chunk coordinate: `tile >> CHUNK_BITS`, floor division (arithmetic shift, correct for
/// negatives).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Hash)]
pub struct ChunkCoord {
    pub x: i32,
    pub y: i32,
}

impl ChunkCoord {
    #[inline]
    pub const fn new(x: i32, y: i32) -> Self {
        ChunkCoord { x, y }
    }

    /// The chunk map key (0007 §2): `(cx as u32 as u64) << 32 | (cy as u32)`.
    #[inline]
    pub const fn key(self) -> u64 {
        ((self.x as u32 as u64) << 32) | (self.y as u32 as u64)
    }

    #[inline]
    pub const fn from_key(key: u64) -> Self {
        ChunkCoord {
            x: (key >> 32) as u32 as i32,
            y: key as u32 as i32,
        }
    }
}

/// The fractional bits of `WorldPos`'s Q24.8 fixed point (1/256 tile).
const FRAC_BITS: u32 = 8;
const SUBTILE: i32 = 1 << FRAC_BITS;

/// A fixed-point world position: Q24.8 in an `i32` per axis, one representation for sim, wire and
/// hash (0007 §2). The raw `i32` range maps exactly onto `[TILE_MIN, TILE_MAX]` (`i32::MIN` is
/// `TILE_MIN` tiles exactly, `i32::MAX` is one 1/256 short of `TILE_MAX + 1`), so every `i32` bit
/// pattern is a valid `WorldPos`; only wider intermediates (movement math) can go out of range,
/// which is what [`WorldPos::clamped`] saturates.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct WorldPos {
    pub x: i32,
    pub y: i32,
}

impl WorldPos {
    #[inline]
    pub const fn from_tile(t: TilePos) -> Self {
        WorldPos {
            x: t.x.wrapping_mul(SUBTILE),
            y: t.y.wrapping_mul(SUBTILE),
        }
    }

    /// Floors to the containing tile (arithmetic shift: correct for negatives, 0007 §2).
    #[inline]
    pub const fn tile(self) -> TilePos {
        TilePos {
            x: self.x >> FRAC_BITS,
            y: self.y >> FRAC_BITS,
        }
    }

    /// Builds a `WorldPos` from a wider intermediate (movement math can overflow `i32` before it is
    /// clamped), saturating each axis to `[i32::MIN, i32::MAX]` instead of wrapping -- "movement
    /// clamps at the edge" (0007 §2).
    #[inline]
    pub fn clamped(x: i64, y: i64) -> Self {
        WorldPos {
            x: x.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            y: y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        }
    }
}

/// A game's chunk size (0007 §3): a power of two, 16/32/64 tiles (`CHUNK_BITS` 4/5/6). Runtime
/// value, not a const generic (Planning decisions 1 of docs/plan/07-world-model-core.md): stable
/// Rust cannot spell `[Tile; N*N]` generic over `G::CHUNK_BITS`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ChunkDims {
    bits: u32,
}

impl ChunkDims {
    /// Panics unless `bits` is 4, 5 or 6 (0007 §3: chunk edge 16, 32 or 64).
    pub fn new(bits: u32) -> Self {
        assert!(
            matches!(bits, 4..=6),
            "unsupported chunk bits {bits}: 0007 §3 allows 4, 5 or 6 (edge 16, 32, 64)"
        );
        ChunkDims { bits }
    }

    #[inline]
    pub const fn bits(&self) -> u32 {
        self.bits
    }

    #[inline]
    pub const fn edge(&self) -> u32 {
        1 << self.bits
    }

    #[inline]
    pub const fn area(&self) -> u32 {
        self.edge() * self.edge()
    }

    #[inline]
    pub const fn slab_bytes(&self) -> usize {
        self.area() as usize * 4
    }

    /// `tile >> CHUNK_BITS`, floor division (arithmetic shift, correct for negatives, 0007 §2).
    #[inline]
    pub const fn chunk_of(&self, pos: TilePos) -> ChunkCoord {
        ChunkCoord {
            x: pos.x >> self.bits,
            y: pos.y >> self.bits,
        }
    }

    /// `(y & MASK) << CHUNK_BITS | (x & MASK)`, row-major (0007 §2).
    #[inline]
    pub const fn local_index(&self, pos: TilePos) -> u16 {
        let mask = (self.edge() - 1) as i32;
        let lx = (pos.x & mask) as u32;
        let ly = (pos.y & mask) as u32;
        ((ly << self.bits) | lx) as u16
    }

    /// The tile at `index` within `chunk` (inverse of [`ChunkDims::local_index`] plus
    /// [`ChunkDims::chunk_of`]).
    #[inline]
    pub const fn tile_at(&self, chunk: ChunkCoord, index: u16) -> TilePos {
        let mask = self.edge() - 1;
        let lx = (index as u32) & mask;
        let ly = (index as u32) >> self.bits;
        TilePos {
            x: chunk.x * self.edge() as i32 + lx as i32,
            y: chunk.y * self.edge() as i32 + ly as i32,
        }
    }

    /// Whether `pos` is inside the world's valid coordinate range (0007 §2). Independent of chunk
    /// size; a method here because every caller already holds a `ChunkDims`.
    #[inline]
    pub const fn in_range(&self, pos: TilePos) -> bool {
        pos.in_range()
    }
}

/// An inclusive rectangle of chunk coordinates.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ChunkRect {
    pub min: ChunkCoord,
    pub max: ChunkCoord,
}

impl ChunkRect {
    #[inline]
    pub const fn new(min: ChunkCoord, max: ChunkCoord) -> Self {
        ChunkRect { min, max }
    }

    /// Grows the rectangle by `rings` chunks on every side.
    #[inline]
    pub const fn expanded(&self, rings: i32) -> Self {
        ChunkRect {
            min: ChunkCoord {
                x: self.min.x - rings,
                y: self.min.y - rings,
            },
            max: ChunkCoord {
                x: self.max.x + rings,
                y: self.max.y + rings,
            },
        }
    }

    #[inline]
    pub const fn contains(&self, c: ChunkCoord) -> bool {
        c.x >= self.min.x && c.x <= self.max.x && c.y >= self.min.y && c.y <= self.max.y
    }

    /// Row-major iteration (y outer, x inner), allocation-free.
    pub fn iter(&self) -> ChunkRectIter {
        ChunkRectIter {
            rect: *self,
            next: if self.min.x > self.max.x || self.min.y > self.max.y {
                None
            } else {
                Some(self.min)
            },
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ChunkRectIter {
    rect: ChunkRect,
    next: Option<ChunkCoord>,
}

impl Iterator for ChunkRectIter {
    type Item = ChunkCoord;

    fn next(&mut self) -> Option<ChunkCoord> {
        let cur = self.next?;
        self.next = if cur.x < self.rect.max.x {
            Some(ChunkCoord {
                x: cur.x + 1,
                y: cur.y,
            })
        } else if cur.y < self.rect.max.y {
            Some(ChunkCoord {
                x: self.rect.min.x,
                y: cur.y + 1,
            })
        } else {
            None
        };
        Some(cur)
    }
}

/// An inclusive rectangle of tile coordinates.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TileRect {
    pub min: TilePos,
    pub max: TilePos,
}

impl TileRect {
    #[inline]
    pub const fn new(min: TilePos, max: TilePos) -> Self {
        TileRect { min, max }
    }

    #[inline]
    pub const fn contains(&self, p: TilePos) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }

    #[inline]
    pub const fn intersects(&self, other: &TileRect) -> bool {
        !(self.max.x < other.min.x
            || other.max.x < self.min.x
            || self.max.y < other.min.y
            || other.max.y < self.min.y)
    }

    /// The chunk rectangle covering every chunk this tile rectangle touches.
    #[inline]
    pub const fn chunks(&self, dims: &ChunkDims) -> ChunkRect {
        ChunkRect {
            min: dims.chunk_of(self.min),
            max: dims.chunk_of(self.max),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_of_negative_tiles_floors() {
        for bits in [4u32, 5, 6] {
            let dims = ChunkDims::new(bits);
            let edge = dims.edge() as i32;
            // The tile just below 0 belongs to chunk -1, not chunk 0 (floor, not truncate).
            assert_eq!(dims.chunk_of(TilePos::new(-1, -1)), ChunkCoord::new(-1, -1));
            assert_eq!(
                dims.chunk_of(TilePos::new(-edge, -edge)),
                ChunkCoord::new(-1, -1)
            );
            assert_eq!(
                dims.chunk_of(TilePos::new(-edge - 1, 0)),
                ChunkCoord::new(-2, 0)
            );
            assert_eq!(dims.chunk_of(TilePos::new(0, 0)), ChunkCoord::new(0, 0));
            assert_eq!(
                dims.chunk_of(TilePos::new(edge - 1, edge - 1)),
                ChunkCoord::new(0, 0)
            );
            assert_eq!(
                dims.chunk_of(TilePos::new(edge, edge)),
                ChunkCoord::new(1, 1)
            );
        }
    }

    #[test]
    fn local_index_row_major() {
        for bits in [4u32, 5, 6] {
            let dims = ChunkDims::new(bits);
            let edge = dims.edge() as i32;
            // (y & MASK) << CHUNK_BITS | (x & MASK): row-major, x fastest.
            assert_eq!(dims.local_index(TilePos::new(0, 0)), 0);
            assert_eq!(dims.local_index(TilePos::new(1, 0)), 1);
            assert_eq!(dims.local_index(TilePos::new(0, 1)), edge as u16);
            assert_eq!(
                dims.local_index(TilePos::new(edge - 1, edge - 1)),
                (dims.area() - 1) as u16
            );
            // Negative tiles wrap into the same local index as the equivalent positive tile in the
            // same chunk (mask picks out the low bits regardless of sign).
            let chunk = dims.chunk_of(TilePos::new(-1, -1));
            let pos = TilePos::new(-1, -1);
            let expected = dims.tile_at(chunk, dims.local_index(pos));
            assert_eq!(expected, pos);
        }
    }

    #[test]
    fn chunk_key_roundtrip() {
        for (x, y) in [(0, 0), (-1, -1), (i32::MIN, i32::MAX), (250_000, -250_000)] {
            let c = ChunkCoord::new(x, y);
            assert_eq!(ChunkCoord::from_key(c.key()), c);
        }
    }

    #[test]
    fn worldpos_range_and_clamp() {
        // The raw i32 range covers exactly [TILE_MIN, TILE_MAX] in tile units.
        assert_eq!(
            WorldPos::from_tile(TilePos::new(TILE_MIN, TILE_MIN)).x,
            i32::MIN
        );
        assert_eq!(
            WorldPos::from_tile(TilePos::new(TILE_MAX, TILE_MAX)).tile(),
            TilePos::new(TILE_MAX, TILE_MAX)
        );
        assert_eq!(WorldPos { x: i32::MAX, y: 0 }.tile().x, TILE_MAX);
        assert_eq!(WorldPos { x: i32::MIN, y: 0 }.tile().x, TILE_MIN);

        // A wider intermediate beyond i32 range saturates rather than wrapping.
        let over = WorldPos::clamped(i32::MAX as i64 + 1_000_000, i32::MIN as i64 - 1_000_000);
        assert_eq!(over.x, i32::MAX);
        assert_eq!(over.y, i32::MIN);
        let inside = WorldPos::clamped(42, -42);
        assert_eq!(inside, WorldPos { x: 42, y: -42 });
    }

    #[test]
    fn dims_reject_unsupported_bits() {
        for bits in [0u32, 1, 2, 3, 7, 8, 32] {
            let ok = std::panic::catch_unwind(|| ChunkDims::new(bits)).is_ok();
            assert!(!ok, "ChunkDims::new({bits}) should panic (0007 §3)");
        }
        for bits in [4u32, 5, 6] {
            let _ = ChunkDims::new(bits); // must not panic
        }
    }

    #[test]
    fn tile_range_edges() {
        assert!(TilePos::new(TILE_MIN, TILE_MAX).in_range());
        assert!(!TilePos::new(TILE_MIN - 1, 0).in_range());
        assert!(!TilePos::new(0, TILE_MAX + 1).in_range());
    }

    #[test]
    fn chunk_rect_iter_is_row_major_and_inclusive() {
        let rect = ChunkRect::new(ChunkCoord::new(-1, 0), ChunkCoord::new(1, 1));
        let got: Vec<ChunkCoord> = rect.iter().collect();
        assert_eq!(
            got,
            vec![
                ChunkCoord::new(-1, 0),
                ChunkCoord::new(0, 0),
                ChunkCoord::new(1, 0),
                ChunkCoord::new(-1, 1),
                ChunkCoord::new(0, 1),
                ChunkCoord::new(1, 1),
            ]
        );
        assert!(rect.contains(ChunkCoord::new(0, 1)));
        assert!(!rect.contains(ChunkCoord::new(2, 0)));
    }

    #[test]
    fn tile_rect_intersects_and_chunks() {
        let dims = ChunkDims::new(5);
        let a = TileRect::new(TilePos::new(0, 0), TilePos::new(10, 10));
        let b = TileRect::new(TilePos::new(10, 10), TilePos::new(20, 20));
        let c = TileRect::new(TilePos::new(11, 11), TilePos::new(20, 20));
        assert!(a.intersects(&b));
        assert!(!a.intersects(&c));
        assert!(a.contains(TilePos::new(5, 5)));
        let rect = a.chunks(&dims);
        assert_eq!(rect.min, dims.chunk_of(a.min));
        assert_eq!(rect.max, dims.chunk_of(a.max));
    }
}
