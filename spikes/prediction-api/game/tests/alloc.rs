//! Own test binary (one test, one thread) so the counting allocator sees only this work.

use spike_engine::harness::Sim;
use spike_engine::*;
use spike_game::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! { static ALLOCS: Cell<u64> = const { Cell::new(0) }; }

struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static A: Counting = Counting;

fn allocs() -> u64 {
    ALLOCS.with(|c| c.get())
}

#[test]
fn reset_and_replay_does_not_allocate_in_steady_state() {
    const P1: PlayerId = PlayerId(1);
    let probe = allocs();
    drop(std::hint::black_box(Box::new(1u64)));
    assert_eq!(allocs() - probe, 1, "the counter works");
    let cfg = Config { seed: 7 };
    let mut s = Sim::<RefGame>::new(cfg.clone());
    s.add_client(cfg, P1, 0, &[ChunkCoord { x: 0, y: 0 }, ChunkCoord { x: 1, y: 0 }]);
    s.run(3);
    // An authoritative furnace, so that frames can carry a put for an existing entity.
    s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(20, 20) });
    s.run(3);
    let (real_id, real) = {
        let v = s.client(0).view();
        let id = v.entity_at(TilePos::new(20, 20)).unwrap().unwrap();
        (id, *v.entity(id).unwrap().unwrap())
    };
    let me = *s.client(0).view().player(P1).unwrap();
    let tick0 = s.client(0).view().tick();

    // Four pending actions that never get acked: a border-spanning placement, two dependent
    // deposits, and a timed collect. From here on we drive the client by hand.
    let c = s.client(0);
    let a0 = allocs();
    for a in [
        Action::PlaceFurnace { origin: TilePos::new(31, 5) },
        Action::Deposit { at: TilePos::new(32, 6), item: Item::Coal, count: 1 },
        Action::Deposit { at: TilePos::new(31, 5), item: Item::Coal, count: 2 },
        Action::StartCollect { tile: TilePos::new(9, 9), claimed_pos: TilePos::new(9, 9) },
    ] {
        assert_eq!(c.submit(a).1, Prediction::Applied);
    }
    let submit_allocs = allocs() - a0;

    // Frames built up front: empty ones, and ones that re-put existing authoritative values.
    let frames: Vec<Frame<RefGame>> = (1..=200u32)
        .map(|i| Frame {
            tick: tick0 + i,
            enter: Vec::new(),
            deltas: if i % 2 == 0 {
                vec![
                    Delta::Player { who: P1, state: me },
                    Delta::EntityPut { id: real_id, entity: Furnace { coal: (i % 7) as u16, ..real } },
                    Delta::Tile { pos: TilePos::new(9, 10), tile: pack(BASE_GRASS, RES_IRON, 1 + (i % 2)) },
                ]
            } else {
                Vec::new()
            },
            acks: Vec::new(),
        })
        .collect();
    for f in &frames[..10] {
        c.on_frame(f); // warm up (first tile put inserts a map node)
    }

    let before = allocs();
    for f in &frames[10..] {
        c.on_frame(f);
    }
    let during = allocs() - before;

    assert_eq!(c.pending().count(), 4);
    assert!(c.pending().all(|p| p.status == Prediction::Applied));
    assert_eq!(c.overlay_len(), 7, "place 2 + deposit 2 + deposit 2 + collect 1 entries, rebuilt every frame");
    println!("allocations: {submit_allocs} for 4 submits (human rate), {during} for 190 reset-and-replay frames x 4 pending actions");
    assert_eq!(during, 0);
}
