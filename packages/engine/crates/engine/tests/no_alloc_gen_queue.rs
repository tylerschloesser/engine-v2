//! Own test binary (mirrors `no_alloc_terrain.rs`, for the same reason: a `#[global_allocator]`
//! only counts allocations made inside the binary that installs it, and inline unit tests share the
//! crate's own lib test binary, which installs none). `GenQueue`'s own storage never grows past its
//! preallocated capacity (docs/decisions/0008-chunk-generation.md §4 "a preallocated array of a few
//! hundred entries"): a realistic pan sequence (repeated `set_view`/`take`/`complete`) allocates
//! zero bytes beyond warm-up (`docs/plan/08b-gen-workers-and-queue.md` Deviations: this test lives
//! here, not inline in `gen_queue.rs`, because only a dedicated binary's global allocator is
//! actually counted).

use engine::abi::Arena;
use engine::gen_queue::{GenQueue, GenView};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, ChunkRect, PristineSource, TerrainStore, Tile, TilePos,
    WorldPos,
};

#[global_allocator]
static ALLOCATOR: Arena = Arena;

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

fn view_at(visible: ChunkRect) -> GenView {
    GenView {
        visible,
        center: WorldPos::from_tile(TilePos::new(0, 0)),
        velocity: (0, 0),
    }
}

#[test]
fn no_alloc_gen_queue() {
    let s = TerrainStore::new(
        ChunkDims::new(5),
        Box::new(ZeroSource),
        CacheCapacity::Unlimited,
    );
    let mut q = GenQueue::new(ChunkDims::new(5), 2);
    // Warm up: first pass through a view establishes every Vec's steady-state length.
    q.set_view(
        &view_at(ChunkRect::new(ChunkCoord::new(0, 0), ChunkCoord::new(0, 0))),
        &s,
    );
    for _ in 0..4 {
        q.take(0);
        q.take(1);
    }

    let before = live();
    for step in 0..20i32 {
        let c = ChunkCoord::new(step, step);
        q.set_view(&view_at(ChunkRect::new(c, c)), &s);
        if let Some(chunk) = q.take(0) {
            q.complete(0, chunk);
        }
        if let Some(chunk) = q.take(1) {
            q.complete(1, chunk);
        }
    }
    assert_eq!(live(), before, "GenQueue churn allocated");
}
