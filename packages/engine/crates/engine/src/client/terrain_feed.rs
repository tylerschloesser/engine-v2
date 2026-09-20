//! `TerrainFeed`: the ABI-facing wrapper around `GenQueue` a client instance embeds beside its own
//! `TerrainStore` (`docs/plan/08b-gen-workers-and-queue.md` Seams; M15's client core does the same
//! beside the replica's store). `on_frame` runs the queue step every `frame` call (Planning
//! decisions 3); `take`/`deliver` encode and decode the `genRequest`/`genResult` records (Planning
//! decisions 1) that the `gen_take`/`gen_deliver` ABI exports (`abi/mod.rs`) copy to and from the
//! `Result` and `GenIn` regions.

use core::cell::RefCell;

use super::camera::CameraBlock;
use crate::abi::Status;
use crate::gen_queue::{GenQueue, GenStats, GenView};
use crate::hash::Fnv64;
use crate::view;
use crate::world::{ChunkCoord, ChunkDims, TerrainStore, Tile, WorldPos};

/// Request record: `[cx i32][cy i32][0 u32][0 u32]`, little-endian (Planning decisions 1).
const REQUEST_BYTES: usize = 16;

/// `center + velocity * 0.5s` is computed in Q24.8 by `GenQueue` itself; this is only the one-time
/// conversion from the camera block's `f64`/`f32` units into that fixed point (Planning decisions
/// 3: "velocity converted once to Q24.8", `.as` casts and `round` are the allowed float ops here).
fn q24_8_centre(centre: [f64; 2]) -> WorldPos {
    let x = (centre[0] * 256.0).round();
    let y = (centre[1] * 256.0).round();
    WorldPos::clamped(x as i64, y as i64)
}

fn clamp_i32(v: f64) -> i32 {
    v.clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

fn q24_8_velocity(velocity: [f32; 2]) -> (i32, i32) {
    let x = (velocity[0] as f64 * 256.0).round();
    let y = (velocity[1] as f64 * 256.0).round();
    (clamp_i32(x), clamp_i32(y))
}

pub struct TerrainFeed {
    dims: ChunkDims,
    queue: GenQueue,
    /// Reserved once (Planning decisions, `.claude/rules/hot-paths.md`'s glob now covers
    /// `src/client/**`): `deliver` and `chunk_hash` decode/read a whole slab through this instead
    /// of a fresh `Vec` per call.
    scratch: RefCell<Vec<Tile>>,
}

impl TerrainFeed {
    /// Size of the `GenIn` region a client-role `init` must declare (Planning decisions 1): the
    /// request header (16 bytes) plus one slab.
    pub const fn gen_in_bytes(dims: ChunkDims) -> usize {
        REQUEST_BYTES + dims.slab_bytes()
    }

    pub fn new(dims: ChunkDims, workers: u32) -> Self {
        TerrainFeed {
            queue: GenQueue::new(dims, workers),
            scratch: RefCell::new(vec![Tile::VOID; dims.area() as usize]),
            dims,
        }
    }

    /// The queue step (Planning decisions 2, 3): builds this pass's `GenView` from the camera
    /// block and `store`'s cache state, and re-sorts if the visible chunk set changed.
    pub fn on_frame(&mut self, camera: &CameraBlock, store: &TerrainStore) {
        let centre = (camera.centre[0], camera.centre[1]);
        let half_extent = (camera.half_extent_tiles[0], camera.half_extent_tiles[1]);
        let visible = view::visible_rect(centre, half_extent, self.dims);
        let view = GenView {
            visible,
            center: q24_8_centre(camera.centre),
            velocity: q24_8_velocity(camera.velocity),
        };
        self.queue.set_view(&view, store);
    }

    /// Writes a `genRequest` record for `worker` into `out` if the queue has a job to dispatch;
    /// `false` when it doesn't (nothing to copy, the pump moves on -- Planning decisions 5).
    pub fn take(&mut self, worker: u32, out: &mut [u8; REQUEST_BYTES]) -> bool {
        let Some(chunk) = self.queue.take(worker) else {
            return false;
        };
        out[0..4].copy_from_slice(&chunk.x.to_le_bytes());
        out[4..8].copy_from_slice(&chunk.y.to_le_bytes());
        out[8..12].copy_from_slice(&0u32.to_le_bytes());
        out[12..16].copy_from_slice(&0u32.to_le_bytes());
        true
    }

    /// Decodes a `genResult` record (`16 + dims.slab_bytes()`: the request header followed by
    /// `GenOut`'s little-endian tile bytes) and inserts its tiles into `store`. `Status::BadLength`
    /// for any other length, `Status::Ok` otherwise -- always accepted, even if the view has since
    /// moved on (0008 §4, "a late result is cached anyway").
    pub fn deliver(&mut self, worker: u32, record: &[u8], store: &mut TerrainStore) -> Status {
        let want = REQUEST_BYTES + self.dims.slab_bytes();
        if record.len() != want {
            return Status::BadLength;
        }
        let cx = i32::from_le_bytes([record[0], record[1], record[2], record[3]]);
        let cy = i32::from_le_bytes([record[4], record[5], record[6], record[7]]);
        let chunk = ChunkCoord::new(cx, cy);
        {
            let mut scratch = self.scratch.borrow_mut();
            for (tile, bytes) in scratch
                .iter_mut()
                .zip(record[REQUEST_BYTES..].chunks_exact(4))
            {
                *tile = Tile(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
            }
            store.insert_pristine(chunk, &scratch);
        }
        self.queue.complete(worker, chunk);
        Status::Ok
    }

    pub fn stats(&self) -> GenStats {
        self.queue.stats()
    }

    /// FNV-1a of the *effective* (pristine + overlay) slab of `chunk`, as it is right now in
    /// `store`'s cache -- `None` when `chunk` is not resident (never materializes it: this reads
    /// the cache, it does not drive it). `Status::NotCached` is the ABI's own spelling of `None`
    /// (`abi::client_chunk_hash`).
    pub fn chunk_hash(&self, store: &TerrainStore, chunk: ChunkCoord) -> Option<u64> {
        if !store.is_cached(chunk) {
            return None;
        }
        let mut scratch = self.scratch.borrow_mut();
        store.copy_chunk(chunk, &mut scratch);
        let mut h = Fnv64::new();
        for tile in scratch.iter() {
            h.write_u32(tile.0);
        }
        Some(h.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{CacheCapacity, PristineSource};

    struct FixedSource;
    impl PristineSource for FixedSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::new(1, 0, 0));
        }
    }

    fn store() -> TerrainStore {
        TerrainStore::new(
            ChunkDims::new(4),
            Box::new(FixedSource),
            CacheCapacity::Unlimited,
        )
    }

    #[test]
    fn feed_record_roundtrip() {
        let dims = ChunkDims::new(4);
        let mut feed = TerrainFeed::new(dims, 1);
        let mut s = store();
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);
        feed.on_frame(&camera, &s);

        let mut req = [0u8; REQUEST_BYTES];
        assert!(feed.take(0, &mut req));
        let cx = i32::from_le_bytes([req[0], req[1], req[2], req[3]]);
        let cy = i32::from_le_bytes([req[4], req[5], req[6], req[7]]);
        assert_eq!(&req[8..16], &[0u8; 8]);
        let chunk = ChunkCoord::new(cx, cy);
        assert!(!s.is_cached(chunk));

        // Build a matching result record with recognisable tile bytes and deliver it.
        let mut result = vec![0u8; REQUEST_BYTES + dims.slab_bytes()];
        result[0..4].copy_from_slice(&cx.to_le_bytes());
        result[4..8].copy_from_slice(&cy.to_le_bytes());
        let tile = Tile::new(9, 9, 9);
        for chunk_bytes in result[REQUEST_BYTES..].chunks_exact_mut(4) {
            chunk_bytes.copy_from_slice(&tile.to_le_bytes());
        }
        let before_delivered = feed.stats().delivered;
        assert_eq!(feed.deliver(0, &result, &mut s), Status::Ok);
        assert_eq!(feed.stats().delivered, before_delivered + 1);
        assert!(s.is_cached(chunk));
        assert_eq!(feed.chunk_hash(&s, chunk), feed.chunk_hash(&s, chunk));

        let mut scratch = vec![Tile::VOID; dims.area() as usize];
        s.copy_chunk(chunk, &mut scratch);
        assert!(scratch.iter().all(|&t| t == tile));
    }

    #[test]
    fn feed_rejects_bad_len() {
        let dims = ChunkDims::new(4);
        let mut feed = TerrainFeed::new(dims, 1);
        let mut s = store();
        let short = vec![0u8; REQUEST_BYTES + dims.slab_bytes() - 1];
        assert_eq!(feed.deliver(0, &short, &mut s), Status::BadLength);
        let long = vec![0u8; REQUEST_BYTES + dims.slab_bytes() + 1];
        assert_eq!(feed.deliver(0, &long, &mut s), Status::BadLength);
    }

    #[test]
    fn feed_chunk_hash_none_until_cached() {
        let dims = ChunkDims::new(4);
        let feed = TerrainFeed::new(dims, 1);
        let s = store();
        assert_eq!(feed.chunk_hash(&s, ChunkCoord::new(0, 0)), None);
        s.materialize(ChunkCoord::new(0, 0));
        assert!(feed.chunk_hash(&s, ChunkCoord::new(0, 0)).is_some());
    }
}
