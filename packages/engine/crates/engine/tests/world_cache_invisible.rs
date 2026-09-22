//! Cache invisibility (0007 Consequences, 0020 §3 Rust native row): the dense LRU cache must never
//! be observable from reads or state hashes, whatever its capacity or generation order. Needs
//! feature `testing` for `engine::testing::{assert_cache_invisible, ...}`.

use engine::hash::{Fnv64, StateHash};
use engine::testing::{
    CacheConfig, CountingSource, Prewarm, TestTerrain, assert_cache_invisible, prewarm_chunks,
};
use engine::world::{ChunkCoord, ChunkDims, PristineSource, TerrainStore, Tile};

const CHUNK_COUNT: i32 = 300;
const OP_COUNT: u32 = 5_000;
const CHECKPOINT_EVERY: u32 = 500;

fn chunk_list() -> Vec<ChunkCoord> {
    (0..CHUNK_COUNT)
        .map(|i| ChunkCoord::new(i % 20 - 10, i / 20 - 8))
        .collect()
}

/// A tiny `mix64`-chained counter: integer-only, deterministic (0002 §2), no ambient randomness.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        engine::hash::mix64(self.0)
    }
}

fn run_script(cfg: &CacheConfig) -> Vec<u64> {
    let dims = ChunkDims::new(5);
    let chunks = chunk_list();
    let mut store = TerrainStore::new(
        dims,
        Box::new(TestTerrain::new(0xABCD_1234_0000_0001)),
        cfg.capacity,
    );
    prewarm_chunks(&store, &chunks, cfg.prewarm);

    let mut rng = Rng(0x5EED_5EED_5EED_5EED);
    let mut checkpoints = Vec::new();
    let mut reads = Fnv64::new();
    for i in 0..OP_COUNT {
        let r = rng.next();
        let chunk = chunks[(r as usize) % chunks.len()];
        let local = ((r >> 20) as u32 % dims.area()) as u16;
        let pos = dims.tile_at(chunk, local);
        if r & 1 == 0 {
            let t = store.tile(pos);
            reads.write_u32(t.0);
        } else {
            let new = Tile::new(
                ((r >> 8) & 0xff) as u8,
                ((r >> 16) & 0xff) as u8,
                ((r >> 24) & 0xffff) as u16,
            );
            let _ = store.set_tile(pos, new);
        }
        if (i + 1) % CHECKPOINT_EVERY == 0 {
            let mut h = Fnv64::new();
            store.hash_state(&mut h);
            checkpoints.push(h.finish());
        }
    }
    checkpoints.push(reads.finish());
    checkpoints
}

#[test]
fn cache_invisible_matrix() {
    assert_cache_invisible(run_script);
}

/// M15c step 2's own guard rail (Planning decisions: "a cache event that reaches any hash means the
/// fix is wrong"). Interleaves `set_tile`, `replace_overlay` and `clear_overlay` -- so
/// `evict_if_present`'s new `push_event` call and the always-on `invalidation_seq` counter both fire --
/// across two otherwise-identical stores, one with cache-event recording enabled and drained mid-run
/// and one that never enables it. Final state hash and every tile read must agree regardless.
#[test]
fn cache_events_do_not_affect_any_hash() {
    let dims = ChunkDims::new(5);
    let seed = 0xCAFE_D00D_0000_0001u64;
    let chunks: Vec<ChunkCoord> = (0..12).map(|i| ChunkCoord::new(i, -i)).collect();

    let mut baseline = TerrainStore::new(
        dims,
        Box::new(engine::testing::TestTerrain::new(seed)),
        engine::world::CacheCapacity::Chunks(4),
    );
    let mut with_events = TerrainStore::new(
        dims,
        Box::new(engine::testing::TestTerrain::new(seed)),
        engine::world::CacheCapacity::Chunks(4),
    );
    with_events.enable_cache_events();

    for (i, &chunk) in chunks.iter().enumerate() {
        let local = (i as u32 % dims.area()) as u16;
        let pos = dims.tile_at(chunk, local);
        let tile = Tile::new((i as u8).wrapping_mul(7).wrapping_add(1), 1, i as u16);
        let _ = baseline.set_tile(pos, tile);
        let _ = with_events.set_tile(pos, tile);

        if i % 3 == 0 {
            let entries = [(local, tile)];
            baseline.replace_overlay(chunk, &entries);
            with_events.replace_overlay(chunk, &entries);
        }
        if i % 4 == 0 {
            baseline.clear_overlay(chunk);
            with_events.clear_overlay(chunk);
        }
        // Draining (or not draining) the event queue must never perturb state: only `with_events`
        // has anything queued (opt-in), and this drains it every other step so both a drained and
        // an undrained queue are exercised across the run.
        if i % 2 == 0 {
            with_events.drain_cache_events(|_| {});
        }
    }

    let mut h1 = Fnv64::new();
    baseline.hash_state(&mut h1);
    let mut h2 = Fnv64::new();
    with_events.hash_state(&mut h2);
    assert_eq!(
        h1.finish(),
        h2.finish(),
        "cache-event recording must not affect the state hash"
    );

    for &chunk in &chunks {
        for local in 0..dims.area() as u16 {
            let pos = dims.tile_at(chunk, local);
            assert_eq!(
                baseline.tile(pos),
                with_events.tile(pos),
                "cache-event recording must not affect reads, chunk {chunk:?} index {local}"
            );
        }
    }
}

#[test]
fn cache_invisible_insert_pristine_any_order() {
    let seed = 0x1234_5678_9abc_def0u64;
    let dims = ChunkDims::new(5);
    let chunk = ChunkCoord::new(3, -2);
    let pos = dims.tile_at(chunk, 5);
    let mut pristine = vec![Tile(0); dims.area() as usize];
    TestTerrain::new(seed).generate(chunk, &mut pristine);

    // Early: insert_pristine before any read.
    let early = TerrainStore::new(
        dims,
        Box::new(TestTerrain::new(seed)),
        engine::world::CacheCapacity::Chunks(4),
    );
    early.insert_pristine(chunk, &pristine);
    let t_early = early.tile(pos);

    // Late: read first (materializes via the synchronous source), then insert_pristine (idempotent
    // no-op past the debug-build equality check).
    let late = TerrainStore::new(
        dims,
        Box::new(TestTerrain::new(seed)),
        engine::world::CacheCapacity::Chunks(4),
    );
    let t_late = late.tile(pos);
    late.insert_pristine(chunk, &pristine);

    // Duplicated: insert_pristine called twice.
    let dup = TerrainStore::new(
        dims,
        Box::new(TestTerrain::new(seed)),
        engine::world::CacheCapacity::Chunks(4),
    );
    dup.insert_pristine(chunk, &pristine);
    dup.insert_pristine(chunk, &pristine);
    let t_dup = dup.tile(pos);

    assert_eq!(t_early, t_late);
    assert_eq!(t_late, t_dup);

    let mut h1 = Fnv64::new();
    early.hash_state(&mut h1);
    let mut h2 = Fnv64::new();
    late.hash_state(&mut h2);
    let mut h3 = Fnv64::new();
    dup.hash_state(&mut h3);
    assert_eq!(h1.finish(), h2.finish());
    assert_eq!(h2.finish(), h3.finish());
}

#[test]
fn source_called_once_per_chunk_when_unlimited() {
    let dims = ChunkDims::new(5);
    let (source, handle) = CountingSource::new(TestTerrain::new(7));
    let store = TerrainStore::new(
        dims,
        Box::new(source),
        engine::world::CacheCapacity::Unlimited,
    );
    let chunks: Vec<ChunkCoord> = (0..20).map(|i| ChunkCoord::new(i, 0)).collect();

    for _ in 0..5 {
        for &c in &chunks {
            for local in [0u16, 7, 42] {
                let _ = store.tile(dims.tile_at(c, local));
            }
        }
    }

    assert_eq!(handle.call_count(), chunks.len());
    assert_eq!(
        handle.calls(),
        chunks,
        "generated in first-touch order, once each"
    );
}

// Sanity: the prewarm helper actually shuffles for `Shuffled`, so `assert_cache_invisible`'s
// "generation pre-warmed in shuffled orders" leg is exercising a genuinely different order, not a
// no-op.
#[test]
fn prewarm_shuffled_visits_every_chunk_in_a_different_order() {
    let dims = ChunkDims::new(5);
    let (source, handle) = CountingSource::new(TestTerrain::new(1));
    let store = TerrainStore::new(
        dims,
        Box::new(source),
        engine::world::CacheCapacity::Unlimited,
    );
    let chunks = chunk_list();
    prewarm_chunks(&store, &chunks, Prewarm::Shuffled(9));
    assert_eq!(handle.call_count(), chunks.len());
    assert_ne!(
        handle.calls(),
        chunks,
        "shuffled prewarm should not match insertion order"
    );
}
