//! `Uploader`: the client-role object that turns resident chunks, tile patches and residency
//! changes into upload-ring records for `worker/client.ts`'s `upload_stage(free)` pump to copy into
//! the SAB `uploadRing` (docs/decisions/0018-renderer.md §3; docs/plan/09-renderer-terrain.md
//! Planning decisions "Upload-ring record layout", "Which chunks upload"). `TerrainStore` is never
//! owned here -- every method that needs one takes `&TerrainStore` (mirrors `TerrainFeed::on_frame`
//! taking `&TerrainStore`, `client/terrain_feed.rs`), so a fixture's `upload_stage` ABI impl passes
//! its own store to [`Uploader::stage`].
//!
//! Record layout is fixed, one record = [`RECORD_BYTES`] (4,112 = a 16-byte header + a 4,096-byte
//! payload): `1 CHUNK` (1,024 `rg16uint` texels, row-major, for one page slot), `2 PATCH` (up to
//! 512 `{slot, index, texel}` entries), `3 INDIR` (up to 1,024 `{x, y, value}` toroidal
//! indirection entries, `0xFFFF` = none). A `CHUNK`'s `INDIR` (its slot going live) is always
//! staged in a later record, never the same or an earlier one, so a slot is never addressed before
//! its texels exist.

use std::collections::VecDeque;

use super::CameraBlock;
use super::texel::{ClientSide, TileTexel};
use crate::view;
use crate::world::CacheEvent;
use crate::world::{ChunkCoord, ChunkDims, ChunkRect, TerrainStore, Tile, TilePos};

/// One upload-ring record (Planning decisions "Upload-ring record layout").
pub const RECORD_BYTES: usize = 4_112;
const HEADER_BYTES: usize = 16;

const KIND_CHUNK: u16 = 1;
const KIND_PATCH: u16 = 2;
const KIND_INDIR: u16 = 3;

/// Planning decisions "`CHUNK_BITS` is 5 here": every size in this module is derived from this one
/// constant, and [`Uploader::new`] fails fast on any other value.
const CHUNK_EDGE: u32 = 32;
const CHUNK_TEXELS: usize = (CHUNK_EDGE * CHUNK_EDGE) as usize; // 1,024, matches the 4,096-byte payload / 4
/// 1,024 slots of 32x32 in the 1024x1024 page texture (0018 §3): the cache slot *is* the page slot.
pub const PAGE_SLOTS: u32 = 1_024;
/// The indirection texture is toroidal 64x64 regardless of chunk size (0018 §3).
const INDIR_EDGE: i32 = 64;

const PATCH_MAX_ENTRIES: usize = 512;
const INDIR_MAX_ENTRIES: usize = 1_024;
/// Sentinel `value` in an `INDIR` entry: no chunk resident at that toroidal cell.
pub const INDIR_NONE: u16 = 0xFFFF;

#[derive(Clone, Copy, Debug)]
struct IndirEntry {
    x: u8,
    y: u8,
    value: u16,
}

#[derive(Clone, Copy, Debug)]
struct PatchEntry {
    chunk: ChunkCoord,
    index: u16,
    texel: TileTexel,
}

/// Toroidal indirection coordinates for `chunk` (`chunk & 63` per axis, 0018 §3).
#[inline]
fn indir_coords(chunk: ChunkCoord) -> (u8, u8) {
    (
        chunk.x.rem_euclid(INDIR_EDGE) as u8,
        chunk.y.rem_euclid(INDIR_EDGE) as u8,
    )
}

/// Pushes only while under capacity (never grows past what [`Uploader::new`] reserved --
/// `.claude/rules/hot-paths.md`'s no-allocation-per-frame rule; a full queue drops the newest
/// entry rather than reallocate, the same shape `DrawList` uses for a full list, 0018 §2).
fn push_bounded<T>(q: &mut VecDeque<T>, item: T) {
    if q.len() < q.capacity() {
        q.push_back(item);
    }
}

/// Squared distance in chunk space, for nearest-first ordering (mirrors `view::nearest_first`'s
/// private helper; duplicated here because that one is not `pub` -- docs/plan/
/// 09-renderer-terrain.md Deviations).
#[inline]
fn chunk_dist_sq(a: ChunkCoord, b: ChunkCoord) -> i64 {
    let dx = a.x as i64 - b.x as i64;
    let dy = a.y as i64 - b.y as i64;
    dx * dx + dy * dy
}

/// The client-role uploader (Provides of docs/plan/09-renderer-terrain.md). `C: ClientSide<G>` is
/// called generically (`C::tile_visual`, static, no instance): `G` defaults to `()` so a fixture
/// with no `Game` yet (M09 runs before M12) can write `impl ClientSide for Fixture {}` and use
/// `Uploader<Fixture>` directly.
pub struct Uploader<C: ClientSide<G>, G = ()> {
    dims: ChunkDims,
    /// One bit per cache slot: "texels currently on the GPU" (Planning decisions "Which chunks
    /// upload").
    uploaded: [bool; PAGE_SLOTS as usize],
    /// Chunks queued for a fresh `CHUNK` record, already sorted nearest-first when pushed by
    /// `on_frame` (`enqueue_chunk` appends at the back instead: a dirty-chunk push, not a residency
    /// scan, docs/plan/09-renderer-terrain.md Deviations).
    pending_chunks: VecDeque<ChunkCoord>,
    pending_indir: VecDeque<IndirEntry>,
    pending_patches: VecDeque<PatchEntry>,
    /// The last visible rect `on_frame` scanned against; re-scans only on a change (Planning
    /// decisions "Which chunks upload": "cache events arrived or the camera's chunk rectangle
    /// changed").
    last_visible: Option<ChunkRect>,
    /// Scratch for `copy_chunk`, reserved once (`.claude/rules/hot-paths.md`).
    scratch_tiles: Vec<Tile>,
    /// Scratch for `on_frame`'s ring-1 + look-ahead scan, reserved once.
    scratch_candidates: Vec<ChunkCoord>,
    seq: u32,
    _client: core::marker::PhantomData<fn() -> (C, G)>,
}

/// Generous bound on ring-1 + look-ahead chunks scanned per `on_frame` (0018 §6's worst case is
/// 121 subscribed chunks at the view bound).
const MAX_CANDIDATES: usize = 256;

impl<C: ClientSide<G>, G> Uploader<C, G> {
    /// Fails fast (Planning decisions "`CHUNK_BITS` is 5 here") rather than producing
    /// wrongly-shaped `CHUNK` records at some other edge.
    pub fn new(dims: ChunkDims) -> Self {
        assert_eq!(
            dims.edge(),
            CHUNK_EDGE,
            "Uploader requires CHUNK_BITS=5 (edge {CHUNK_EDGE}); 0024 §9 tracks generalising this"
        );
        Uploader {
            dims,
            uploaded: [false; PAGE_SLOTS as usize],
            pending_chunks: VecDeque::with_capacity(PAGE_SLOTS as usize),
            pending_indir: VecDeque::with_capacity(PAGE_SLOTS as usize * 2),
            pending_patches: VecDeque::with_capacity(PATCH_MAX_ENTRIES * 4),
            last_visible: None,
            scratch_tiles: vec![Tile::VOID; CHUNK_TEXELS],
            scratch_candidates: Vec::with_capacity(MAX_CANDIDATES),
            seq: 0,
            _client: core::marker::PhantomData,
        }
    }

    #[inline]
    fn next_seq(&mut self) -> u32 {
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    /// The queue step (Planning decisions "Which chunks upload"), run every client frame: drains
    /// `store`'s cache events (an `Evicted` clears the slot's bit and queues its indirection
    /// removal), then -- only when something changed -- rescans ring 1 + look-ahead for cached,
    /// not-yet-uploaded chunks, nearest first.
    pub fn on_frame(&mut self, camera: &CameraBlock, store: &TerrainStore) {
        let mut changed = false;
        store.drain_cache_events(|event| {
            changed = true;
            if let CacheEvent::Evicted { chunk, slot } = event {
                self.uploaded[slot as usize] = false;
                let (x, y) = indir_coords(chunk);
                push_bounded(
                    &mut self.pending_indir,
                    IndirEntry {
                        x,
                        y,
                        value: INDIR_NONE,
                    },
                );
            }
        });

        let centre = (camera.centre[0], camera.centre[1]);
        let half_extent = (camera.half_extent_tiles[0], camera.half_extent_tiles[1]);
        let visible = view::visible_rect(centre, half_extent, self.dims);
        if !changed && self.last_visible == Some(visible) {
            return;
        }
        self.last_visible = Some(visible);

        // `lookahead_chunks` only reads velocity's sign (`view.rs` doc comment); a plain sign
        // extraction avoids duplicating `TerrainFeed`'s private Q24.8 conversion for no benefit
        // here (docs/plan/09-renderer-terrain.md Deviations).
        let velocity = (sign_i32(camera.velocity[0]), sign_i32(camera.velocity[1]));
        let ring1 = visible.expanded(1);

        self.scratch_candidates.clear();
        for chunk in ring1.iter() {
            if self.scratch_candidates.len() == self.scratch_candidates.capacity() {
                break;
            }
            self.scratch_candidates.push(chunk);
        }
        let mut lookahead = [ChunkCoord::default(); 2];
        let n = view::lookahead_chunks(visible, velocity, self.dims, &mut lookahead);
        for &chunk in &lookahead[..n] {
            if self.scratch_candidates.len() < self.scratch_candidates.capacity() {
                self.scratch_candidates.push(chunk);
            }
        }

        let centre_tile = TilePos::new(clamp_tile(camera.centre[0]), clamp_tile(camera.centre[1]));
        let centre_chunk = self.dims.chunk_of(centre_tile);
        self.scratch_candidates
            .sort_unstable_by_key(|c| chunk_dist_sq(*c, centre_chunk));

        for i in 0..self.scratch_candidates.len() {
            let chunk = self.scratch_candidates[i];
            let Some(slot) = store.slot_of(chunk) else {
                continue; // not resident yet: the gen queue is still working on it
            };
            if !self.uploaded[slot as usize] {
                // Marked immediately so a second `on_frame` before this stages doesn't re-queue it
                // (Planning decisions "Which chunks upload": one bit per slot).
                self.uploaded[slot as usize] = true;
                push_bounded(&mut self.pending_chunks, chunk);
            }
        }
    }

    /// A whole resident chunk needs a fresh `CHUNK` record (a dirty-chunk push from M15b, or
    /// M37b's `requeue_all` below) -- re-converted from `TerrainStore::copy_chunk` at stage time.
    pub fn enqueue_chunk(&mut self, chunk: ChunkCoord) {
        push_bounded(&mut self.pending_chunks, chunk);
    }

    /// A single tile changed on an already-resident chunk: queues one `PATCH` entry, converted
    /// through `C::tile_visual` now (cheap, one tile) so `stage` only needs `store.slot_of` at
    /// record time.
    pub fn patch_tile(&mut self, pos: TilePos, tile: Tile) {
        let chunk = self.dims.chunk_of(pos);
        let index = self.dims.local_index(pos);
        let texel = C::tile_visual(tile);
        push_bounded(
            &mut self.pending_patches,
            PatchEntry {
                chunk,
                index,
                texel,
            },
        );
    }

    /// M37b (device loss): forget every slot's "on GPU" bit and force the next `on_frame` to
    /// re-scan from scratch, so every still-resident chunk in view is re-queued. Full replay of
    /// every resident chunk regardless of view (not just ring 1 + look-ahead) is M37b's own
    /// extension (docs/plan/09-renderer-terrain.md Deviations: out of this milestone's scope).
    pub fn requeue_all(&mut self) {
        self.uploaded = [false; PAGE_SLOTS as usize];
        self.last_visible = None;
        self.pending_indir.clear();
        self.pending_patches.clear();
        self.pending_chunks.clear();
    }

    /// Stages up to `max_records` records into `region` (`RegionId::ChunkTexels`, sized for at
    /// least `max_records * RECORD_BYTES`), CHUNK work first, then INDIR, then PATCH -- the
    /// `upload_stage` ABI export's implementation forwards here with the fixture's own store.
    /// Returns the number of records actually written.
    pub fn stage(&mut self, max_records: u32, store: &TerrainStore, region: &mut [u8]) -> u32 {
        let mut written = 0u32;
        while written < max_records {
            let start = written as usize * RECORD_BYTES;
            let Some(out) = region.get_mut(start..start + RECORD_BYTES) else {
                break;
            };
            if !self.stage_one(store, out) {
                break;
            }
            written += 1;
        }
        written
    }

    fn stage_one(&mut self, store: &TerrainStore, out: &mut [u8]) -> bool {
        while let Some(chunk) = self.pending_chunks.pop_front() {
            if self.stage_chunk(chunk, store, out) {
                return true;
            }
            // Evicted since it was queued: drop it and try the next one.
        }
        if self.stage_indir(out) {
            return true;
        }
        self.stage_patch(store, out)
    }

    fn stage_chunk(&mut self, chunk: ChunkCoord, store: &TerrainStore, out: &mut [u8]) -> bool {
        let Some(slot) = store.slot_of(chunk) else {
            return false;
        };
        store.copy_chunk(chunk, &mut self.scratch_tiles);
        for (i, &tile) in self.scratch_tiles.iter().enumerate() {
            let texel = C::tile_visual(tile);
            let base = HEADER_BYTES + i * 4;
            out[base..base + 2].copy_from_slice(&texel.base.to_le_bytes());
            out[base + 2..base + 4].copy_from_slice(&texel.resource.to_le_bytes());
        }
        let seq = self.next_seq();
        write_header(out, KIND_CHUNK, slot as u16, 0, seq);
        self.uploaded[slot as usize] = true;
        let (x, y) = indir_coords(chunk);
        push_bounded(
            &mut self.pending_indir,
            IndirEntry {
                x,
                y,
                value: slot as u16,
            },
        );
        true
    }

    fn stage_indir(&mut self, out: &mut [u8]) -> bool {
        if self.pending_indir.is_empty() {
            return false;
        }
        let n = self.pending_indir.len().min(INDIR_MAX_ENTRIES);
        for i in 0..n {
            let e = self.pending_indir.pop_front().expect("checked non-empty");
            let base = HEADER_BYTES + i * 4;
            out[base] = e.x;
            out[base + 1] = e.y;
            out[base + 2..base + 4].copy_from_slice(&e.value.to_le_bytes());
        }
        for b in &mut out[HEADER_BYTES + n * 4..RECORD_BYTES] {
            *b = 0;
        }
        let seq = self.next_seq();
        write_header(out, KIND_INDIR, 0, n as u16, seq);
        true
    }

    fn stage_patch(&mut self, store: &TerrainStore, out: &mut [u8]) -> bool {
        let mut count = 0usize;
        while count < PATCH_MAX_ENTRIES {
            let Some(p) = self.pending_patches.pop_front() else {
                break;
            };
            let Some(slot) = store.slot_of(p.chunk) else {
                continue; // evicted since queued: drop, doesn't cost a record slot
            };
            let base = HEADER_BYTES + count * 8;
            out[base..base + 2].copy_from_slice(&(slot as u16).to_le_bytes());
            out[base + 2..base + 4].copy_from_slice(&p.index.to_le_bytes());
            out[base + 4..base + 6].copy_from_slice(&p.texel.base.to_le_bytes());
            out[base + 6..base + 8].copy_from_slice(&p.texel.resource.to_le_bytes());
            count += 1;
        }
        if count == 0 {
            return false;
        }
        for b in &mut out[HEADER_BYTES + count * 8..RECORD_BYTES] {
            *b = 0;
        }
        let seq = self.next_seq();
        write_header(out, KIND_PATCH, 0, count as u16, seq);
        true
    }
}

#[inline]
fn sign_i32(v: f32) -> i32 {
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

#[inline]
fn clamp_tile(v: f64) -> i32 {
    v.clamp(crate::world::TILE_MIN as f64, crate::world::TILE_MAX as f64) as i32
}

fn write_header(out: &mut [u8], kind: u16, slot: u16, count: u16, seq: u32) {
    out[0..2].copy_from_slice(&kind.to_le_bytes());
    out[2..4].copy_from_slice(&slot.to_le_bytes());
    out[4..6].copy_from_slice(&count.to_le_bytes());
    out[6..8].copy_from_slice(&0u16.to_le_bytes());
    out[8..12].copy_from_slice(&seq.to_le_bytes());
    out[12..16].copy_from_slice(&0u32.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{CacheCapacity, PristineSource};

    struct FixedSource;
    impl PristineSource for FixedSource {
        fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::new((chunk.x & 0xff) as u8, (chunk.y & 0xff) as u8, 0));
        }
    }

    struct Fixture;
    impl ClientSide for Fixture {}

    fn store(capacity: u32) -> TerrainStore {
        TerrainStore::new(
            ChunkDims::new(5),
            Box::new(FixedSource),
            CacheCapacity::Chunks(capacity),
        )
    }

    fn camera_at(x: f64, y: f64) -> CameraBlock {
        CameraBlock::for_test([x, y], [0.0, 0.0], [16.0, 16.0])
    }

    /// A wide-enough half extent that a 5x5 chunk grid around the origin (`materialize_grid`)
    /// falls inside ring 1.
    fn camera_wide(x: f64, y: f64) -> CameraBlock {
        CameraBlock::for_test([x, y], [0.0, 0.0], [128.0, 128.0])
    }

    fn materialize_grid(s: &TerrainStore) {
        for x in -2..=2 {
            for y in -2..=2 {
                s.materialize(ChunkCoord::new(x, y));
            }
        }
    }

    // Needs the `testing` feature for `assert_golden_bytes!` (always on for `pnpm test rust`'s
    // `--workspace` build, per `Cargo.toml`'s comment on the `codec`/`world_terrain` test targets);
    // an isolated `cargo test -p engine` without `--features testing` skips it instead of failing
    // to compile.
    #[cfg(feature = "testing")]
    #[test]
    fn record_layout_golden() {
        let mut up = Uploader::<Fixture>::new(ChunkDims::new(5));
        let s = store(16);
        s.materialize(ChunkCoord::new(0, 0));
        let cam = camera_at(0.0, 0.0);
        up.on_frame(&cam, &s);
        let mut region = vec![0u8; RECORD_BYTES * 4];
        let n = up.stage(4, &s, &mut region);
        assert!(n >= 1);
        crate::assert_golden_bytes!("upload_record_layout", &region[..RECORD_BYTES * n as usize]);
    }

    #[test]
    fn stage_respects_max() {
        let mut up = Uploader::<Fixture>::new(ChunkDims::new(5));
        let s = store(64);
        materialize_grid(&s);
        up.on_frame(&camera_wide(0.0, 0.0), &s);
        let mut region = vec![0u8; RECORD_BYTES * 100];
        let n = up.stage(2, &s, &mut region);
        assert_eq!(n, 2);
    }

    #[test]
    fn indir_after_chunk() {
        let mut up = Uploader::<Fixture>::new(ChunkDims::new(5));
        let s = store(64);
        materialize_grid(&s);
        up.on_frame(&camera_wide(0.0, 0.0), &s);
        let mut region = vec![0u8; RECORD_BYTES * 200];
        let n = up.stage(200, &s, &mut region) as usize;
        let mut saw_chunk_slots: Vec<u16> = Vec::new();
        let mut saw_indir = false;
        for i in 0..n {
            let rec = &region[i * RECORD_BYTES..(i + 1) * RECORD_BYTES];
            let kind = u16::from_le_bytes([rec[0], rec[1]]);
            let slot = u16::from_le_bytes([rec[2], rec[3]]);
            if kind == KIND_CHUNK {
                saw_chunk_slots.push(slot);
            } else if kind == KIND_INDIR {
                saw_indir = true;
                // Every INDIR entry whose value != NONE must reference a slot already staged as a
                // CHUNK in an earlier record.
                let count = u16::from_le_bytes([rec[4], rec[5]]) as usize;
                for e in 0..count {
                    let base = HEADER_BYTES + e * 4;
                    let value = u16::from_le_bytes([rec[base + 2], rec[base + 3]]);
                    if value != INDIR_NONE {
                        assert!(
                            saw_chunk_slots.contains(&value),
                            "INDIR referenced slot {value} before its CHUNK"
                        );
                    }
                }
            }
        }
        assert!(saw_indir, "expected at least one INDIR record");
        assert!(!saw_chunk_slots.is_empty());
    }

    #[test]
    fn toroidal_window_pm31() {
        // A chunk far from the origin still maps into the 64x64 toroidal window.
        let far = ChunkCoord::new(1_000_003, -1_000_003);
        let (x, y) = indir_coords(far);
        assert!((x as i32) < INDIR_EDGE);
        assert!((y as i32) < INDIR_EDGE);
        assert_eq!(
            indir_coords(ChunkCoord::new(64, 64)),
            indir_coords(ChunkCoord::new(0, 0))
        );
        assert_eq!(indir_coords(ChunkCoord::new(-1, -1)), (63, 63));
    }

    #[test]
    fn eviction_clears_bit_and_queues_indir_none() {
        let mut up = Uploader::<Fixture>::new(ChunkDims::new(5));
        let s = store(1); // capacity 1: the second chunk read evicts the first
        s.materialize(ChunkCoord::new(0, 0));
        s.materialize(ChunkCoord::new(5, 5)); // evicts (0,0)
        up.on_frame(&camera_at(0.0, 0.0), &s);
        let mut found_none = false;
        for e in &up.pending_indir {
            if e.value == INDIR_NONE {
                found_none = true;
            }
        }
        assert!(found_none, "expected an INDIR-none for the evicted chunk");
    }

    #[test]
    fn patch_dropped_when_chunk_no_longer_resident() {
        let mut up = Uploader::<Fixture>::new(ChunkDims::new(5));
        let s = store(16);
        s.materialize(ChunkCoord::new(0, 0));
        up.patch_tile(TilePos::new(1, 1), Tile::new(9, 9, 9));
        // Evict it before staging.
        for i in 1..20 {
            s.materialize(ChunkCoord::new(i, 0));
        }
        let mut region = vec![0u8; RECORD_BYTES * 4];
        // Drain whatever `on_frame` would have queued first, then try to stage the stale patch.
        up.pending_chunks.clear();
        let n = up.stage(4, &s, &mut region);
        assert_eq!(
            n, 0,
            "a patch on an evicted chunk must not produce a record"
        );
    }
}
