//! Black-box `TerrainStore` tests: only the public API of `engine::world`. Needs feature `testing`
//! for `golden_terrain_canonical`'s `assert_golden_bytes!`.

use engine::bytes::{ByteReader, ByteSink};
use engine::hash::{Fnv64, StateHash};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TileChange, TilePos,
};

/// A small deterministic `PristineSource`: `Tile::new(chunk.x wrapping + local index, 0, 0)`, easy
/// to predict by hand in assertions.
struct Linear;
impl PristineSource for Linear {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        for (i, t) in out.iter_mut().enumerate() {
            *t = Tile::new((chunk.x as i64 + i as i64).rem_euclid(251) as u8, 0, 0);
        }
    }
}

fn store(capacity: CacheCapacity) -> engine::world::TerrainStore {
    engine::world::TerrainStore::new(ChunkDims::new(5), Box::new(Linear), capacity)
}

struct VecSink<'a>(&'a mut Vec<u8>);
impl ByteSink for VecSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

#[test]
fn out_of_range_reads_void_writes_rejected() {
    let dims = ChunkDims::new(5);
    let mut s = store(CacheCapacity::Chunks(4));
    let far = TilePos::new(engine::world::TILE_MAX + 1, 0);
    assert!(!dims.in_range(far));
    assert_eq!(s.tile(far), Tile::VOID);
    assert_eq!(
        s.set_tile(far, Tile::new(1, 0, 0)),
        Err(engine::world::OutOfRange)
    );

    // In-range edges must not be rejected.
    let edge = TilePos::new(engine::world::TILE_MIN, engine::world::TILE_MAX);
    let _ = s.tile(edge);
    assert!(s.set_tile(edge, Tile::new(3, 0, 0)).is_ok());
}

#[test]
fn clear_overlay_restores_slab() {
    let dims = ChunkDims::new(5);
    let mut s = store(CacheCapacity::Chunks(4));
    let pos = TilePos::new(1, 1);
    let chunk = dims.chunk_of(pos);
    let before = s.tile(pos);
    s.set_tile(pos, Tile::new(200, 1, 1)).unwrap();
    assert_eq!(s.tile(pos), Tile::new(200, 1, 1));
    assert_eq!(s.modified_tiles(), 1);

    s.clear_overlay(chunk);
    assert_eq!(s.tile(pos), before);
    assert_eq!(s.modified_tiles(), 0);
    assert!(s.overlay(chunk).is_none_or(|o| o.is_empty()));
}

#[test]
fn canonical_roundtrip() {
    let mut s = store(CacheCapacity::Chunks(16));
    let positions: Vec<TilePos> = (0..40i32).map(|i| TilePos::new(i * 3, -i * 5)).collect();
    for (i, &pos) in positions.iter().enumerate() {
        s.set_tile(pos, Tile::new(i as u8, 1, i as u16)).unwrap();
    }

    let mut buf = Vec::new();
    s.write_canonical(&mut VecSink(&mut buf));

    let mut s2 = store(CacheCapacity::Chunks(16));
    let mut reader = ByteReader::new(&buf);
    s2.read_canonical(&mut reader).unwrap();

    for &pos in &positions {
        assert_eq!(s.tile(pos), s2.tile(pos));
    }
    assert_eq!(s.modified_tiles(), s2.modified_tiles());
    let mut h1 = Fnv64::new();
    s.hash_state(&mut h1);
    let mut h2 = Fnv64::new();
    s2.hash_state(&mut h2);
    assert_eq!(h1.finish(), h2.finish());
}

#[test]
fn canonical_bytes_independent_of_write_history() {
    let pos = TilePos::new(11, -3);

    let mut a = store(CacheCapacity::Chunks(4));
    a.set_tile(pos, Tile::new(1, 0, 0)).unwrap();
    a.set_tile(pos, Tile::new(5, 0, 0)).unwrap();
    a.set_tile(pos, Tile::new(9, 0, 0)).unwrap();

    let mut b = store(CacheCapacity::Chunks(4));
    b.set_tile(pos, Tile::new(9, 0, 0)).unwrap();

    let mut buf_a = Vec::new();
    let mut buf_b = Vec::new();
    a.write_canonical(&mut VecSink(&mut buf_a));
    b.write_canonical(&mut VecSink(&mut buf_b));
    assert_eq!(
        buf_a, buf_b,
        "same effective state must serialize identically regardless of history"
    );
}

#[test]
fn loaded_entries_learn_pristine_on_materialize() {
    let dims = ChunkDims::new(5);
    let pos = TilePos::new(4, 4);
    let chunk = dims.chunk_of(pos);
    let index = dims.local_index(pos);

    let mut buf = Vec::new();
    {
        let mut sink = VecSink(&mut buf);
        sink.put_u32(1);
        sink.put_u64(chunk.key());
        sink.put_u32(1);
        sink.put_u16(index);
        sink.put_u32(Tile::new(77, 0, 0).0);
    }

    let mut s = store(CacheCapacity::Chunks(4));
    let mut reader = ByteReader::new(&buf);
    s.read_canonical(&mut reader).unwrap();
    assert!(s.overlay(chunk).unwrap().cached_pristine(index).is_none());

    assert_eq!(s.tile(pos), Tile::new(77, 0, 0));
    assert!(s.overlay(chunk).unwrap().cached_pristine(index).is_some());
}

#[test]
fn cache_events_report_slots() {
    let s = store(CacheCapacity::Chunks(2));
    s.enable_cache_events();
    let c0 = ChunkCoord::new(0, 0);
    let c1 = ChunkCoord::new(1, 0);
    let c2 = ChunkCoord::new(2, 0);
    s.materialize(c0);
    s.materialize(c1);
    s.materialize(c2); // evicts c0 (LRU)

    let mut events = Vec::new();
    s.drain_cache_events(|e| events.push(e));
    assert_eq!(events.len(), 4); // Loaded c0, Loaded c1, Loaded c2, Evicted c0
    assert!(matches!(
        events[0],
        engine::world::CacheEvent::Loaded { chunk, .. } if chunk == c0
    ));
    assert!(matches!(
        events[3],
        engine::world::CacheEvent::Evicted { chunk, .. } if chunk == c0
    ));

    let mut more = Vec::new();
    s.drain_cache_events(|e| more.push(e));
    assert!(more.is_empty(), "draining twice must not repeat events");
}

#[test]
fn lru_evicts_least_recent() {
    let s = store(CacheCapacity::Chunks(2));
    let c0 = ChunkCoord::new(0, 0);
    let c1 = ChunkCoord::new(1, 0);
    let c2 = ChunkCoord::new(2, 0);
    s.materialize(c0);
    s.materialize(c1);
    s.materialize(c2);
    assert!(!s.is_cached(c0));
    assert!(s.is_cached(c1));
    assert!(s.is_cached(c2));
}

#[test]
fn touch_protects() {
    let s = store(CacheCapacity::Chunks(2));
    let c0 = ChunkCoord::new(0, 0);
    let c1 = ChunkCoord::new(1, 0);
    let c2 = ChunkCoord::new(2, 0);
    s.materialize(c0);
    s.materialize(c1);
    s.touch(c0);
    s.materialize(c2); // evicts c1, since c0 was touched more recently
    assert!(s.is_cached(c0));
    assert!(!s.is_cached(c1));
}

#[test]
fn set_tile_reports_change_and_count() {
    let mut s = store(CacheCapacity::Chunks(4));
    let pos = TilePos::new(0, 0);
    let before = s.tile(pos);
    assert_eq!(s.set_tile(pos, before).unwrap(), TileChange::Unchanged);
    assert_eq!(s.modified_tiles(), 0);

    let new = Tile::new(before.base().wrapping_add(1), 0, 0);
    assert_eq!(
        s.set_tile(pos, new).unwrap(),
        TileChange::Changed { old: before }
    );
    assert_eq!(s.modified_tiles(), 1);

    assert_eq!(
        s.set_tile(pos, before).unwrap(),
        TileChange::Changed { old: new }
    );
    assert_eq!(s.modified_tiles(), 0);
}

#[test]
fn copy_chunk_matches_individual_reads() {
    let dims = ChunkDims::new(5);
    let mut s = store(CacheCapacity::Chunks(4));
    let chunk = ChunkCoord::new(2, -1);
    s.set_tile(dims.tile_at(chunk, 5), Tile::new(200, 0, 0))
        .unwrap();

    let mut out = vec![Tile(0); dims.area() as usize];
    s.copy_chunk(chunk, &mut out);
    for i in 0..dims.area() as u16 {
        assert_eq!(out[i as usize], s.tile(dims.tile_at(chunk, i)));
    }
}

#[test]
fn memory_bytes_is_pool_plus_overlay() {
    let dims = ChunkDims::new(5);
    let mut s =
        engine::world::TerrainStore::new(dims, Box::new(Linear), CacheCapacity::Chunks(1024));
    assert_eq!(s.memory_bytes(), 1024 * dims.slab_bytes());
    s.set_tile(TilePos::new(0, 0), Tile::new(1, 0, 0)).unwrap();
    assert!(s.memory_bytes() > 1024 * dims.slab_bytes());
}

#[test]
fn golden_terrain_canonical() {
    let mut s = store(CacheCapacity::Chunks(32));
    // A fixed, hand-picked script: order matters for readability, not for the golden (canonical
    // bytes are independent of write history, proven above).
    let script: &[(i32, i32, u8, u8, u16)] = &[
        (0, 0, 1, 0, 0),
        (5, 5, 2, 1, 7),
        (-5, -5, 3, 0, 0),
        (100, -100, 4, 2, 300),
        (31, 31, 5, 0, 0),
        (32, 32, 6, 0, 0),
        (-1, -1, 7, 0, 0),
        (0, 0, 9, 0, 0), // overwrite the first write
    ];
    for &(x, y, base, resource, aux) in script {
        s.set_tile(TilePos::new(x, y), Tile::new(base, resource, aux))
            .unwrap();
    }
    let mut buf = Vec::new();
    s.write_canonical(&mut VecSink(&mut buf));
    engine::assert_golden_bytes!("terrain_canonical", &buf);
    let mut h = Fnv64::new();
    s.hash_state(&mut h);
    engine::assert_golden_hash!("terrain_canonical_hash", h.finish());
}
