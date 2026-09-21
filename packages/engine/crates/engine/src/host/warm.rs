//! The between-tick warmer (docs/decisions/0008-chunk-generation.md §2 "Sim host warmer";
//! docs/plan/13-sim-host-tick-loop.md Scope): a fixed-capacity list of view rectangles, one per
//! connection slot, fed by [`Warm::set_view`] (M15's connections call it; this milestone's own
//! native tests call it directly, since no connection exists yet -- Non-scope). [`Warm::warm_one`]
//! generates at most one uncached chunk across every set view, nearest-to-that-view's-centre-first
//! (`view::nearest_first`, "offered to M13's `host::warm`" by its own doc comment), and is
//! invisible to any state hash: it only ever calls `TerrainStore::materialize`, the same cache-only
//! path every read already takes (0007 Consequences).

use crate::view::nearest_first;
use crate::world::{ChunkCoord, ChunkRect, TerrainStore, TilePos};

/// Connections a warm list tracks (0009 `WorldConfig.maxPlayers` default 8): generous headroom
/// above that default without depending on M15's actual connection type.
pub const MAX_VIEWS: usize = 8;

/// Chunks one view's rect can hold and still get a fully correct nearest-first order (0008 §5's
/// worst case at the view bound is 13x13 = 169); the scratch buffer `warm_one` sorts into,
/// allocation-free, reserved once at construction.
const SCRATCH_CHUNKS: usize = 512;

/// A fixed-capacity list of per-connection view rectangles plus the scratch buffer `warm_one`
/// sorts into -- no heap allocation after construction (`.claude/rules/hot-paths.md`'s
/// no-allocation-per-tick principle: this runs once between every tick).
pub struct Warm {
    views: [Option<ChunkRect>; MAX_VIEWS],
    scratch: [ChunkCoord; SCRATCH_CHUNKS],
}

impl Warm {
    pub fn new() -> Self {
        Warm {
            views: [None; MAX_VIEWS],
            scratch: [ChunkCoord::default(); SCRATCH_CHUNKS],
        }
    }

    /// Sets connection `conn`'s visible rectangle (fed by M15's subscription machinery; Non-scope
    /// here). Out of `[0, MAX_VIEWS)` is a bug in the caller: debug-asserted and ignored, the same
    /// convention `WorldWrite::set_tile` uses for an out-of-range write (0007 §2).
    pub fn set_view(&mut self, conn: u32, rect: ChunkRect) {
        match self.views.get_mut(conn as usize) {
            Some(slot) => *slot = Some(rect),
            None => debug_assert!(
                false,
                "set_view: conn {conn} out of range (max {MAX_VIEWS})"
            ),
        }
    }

    /// Clears connection `conn`'s view (M15: a client leaves or disconnects). Out of range is the
    /// same no-op-in-release convention as [`Warm::set_view`].
    pub fn clear_view(&mut self, conn: u32) {
        match self.views.get_mut(conn as usize) {
            Some(slot) => *slot = None,
            None => debug_assert!(
                false,
                "clear_view: conn {conn} out of range (max {MAX_VIEWS})"
            ),
        }
    }

    /// Generates at most one chunk across every set view, in connection-slot order, nearest to
    /// that view's own centre first. Returns the chunk it generated, or `None` when every set
    /// view's chunks (within the scratch buffer's capacity) are already cached. Takes no
    /// `ChunkDims`: `nearest_first` and `TerrainStore::is_cached`/`materialize` already close over
    /// whatever chunk size the store itself was built with.
    pub fn warm_one(&mut self, terrain: &TerrainStore) -> Option<ChunkCoord> {
        for view in self.views.into_iter().flatten() {
            // `nearest_first`'s own doc comment: `center` is chunk-coordinate space, reinterpreted
            // as a `TilePos` (both are plain `i32` pairs with no inherent scale).
            let center = TilePos::new((view.min.x + view.max.x) / 2, (view.min.y + view.max.y) / 2);
            let n = nearest_first(view, center, &mut self.scratch);
            for &chunk in &self.scratch[..n] {
                if !terrain.is_cached(chunk) {
                    terrain.materialize(chunk);
                    return Some(chunk);
                }
            }
        }
        None
    }
}

impl Default for Warm {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::Fnv64;
    use crate::world::{CacheCapacity, ChunkDims, PristineSource, Tile};

    /// Deterministic, distinguishable-per-chunk tiles (no game/worldgen needed: `Warm` only ever
    /// touches `TerrainStore`).
    struct CountingSource;
    impl PristineSource for CountingSource {
        fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
            let v = (chunk.x.wrapping_mul(31) ^ chunk.y) as u8;
            out.fill(Tile::new(v, 0, 0));
        }
    }

    fn terrain() -> TerrainStore {
        TerrainStore::new(
            ChunkDims::new(4),
            Box::new(CountingSource),
            CacheCapacity::Unlimited,
        )
    }

    #[test]
    fn warm_nearest_first() {
        let t = terrain();
        let mut warm = Warm::new();
        let rect = ChunkRect::new(ChunkCoord::new(-2, -2), ChunkCoord::new(2, 2));
        warm.set_view(0, rect);

        let mut order = Vec::new();
        while let Some(c) = warm.warm_one(&t) {
            order.push(c);
        }
        assert_eq!(
            order.len(),
            25,
            "every chunk in the 5x5 rect got warmed exactly once"
        );
        assert_eq!(
            order[0],
            ChunkCoord::new(0, 0),
            "nearest to the view's centre first"
        );

        let dist = |c: ChunkCoord| (c.x as i64).pow(2) + (c.y as i64).pow(2);
        let mut last = 0i64;
        for &c in &order {
            let d = dist(c);
            assert!(d >= last, "not nearest-first: {order:?}");
            last = d;
        }

        // Every chunk in the rect is now cached: nothing left to warm.
        assert_eq!(warm.warm_one(&t), None);
        for c in rect.iter() {
            assert!(t.is_cached(c));
        }
    }

    #[test]
    fn warm_is_invisible_to_hash() {
        let t = terrain();
        let hash_of = |t: &TerrainStore| {
            let mut h = Fnv64::new();
            t.write_canonical(&mut h);
            h.finish()
        };

        let before = hash_of(&t);

        let mut warm = Warm::new();
        warm.set_view(
            0,
            ChunkRect::new(ChunkCoord::new(-1, -1), ChunkCoord::new(1, 1)),
        );
        let mut warmed = 0;
        while warm.warm_one(&t).is_some() {
            warmed += 1;
        }
        assert_eq!(warmed, 9, "warmed the whole 3x3 rect");

        assert_eq!(
            before,
            hash_of(&t),
            "warming is invisible to the canonical hash"
        );
    }

    #[test]
    fn warm_one_with_no_view_is_a_noop() {
        let t = terrain();
        let mut warm = Warm::new();
        assert!(warm.warm_one(&t).is_none());
    }
}
