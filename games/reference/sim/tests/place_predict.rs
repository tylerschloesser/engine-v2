//! Predicted furnace placement through the real host <-> client round trip (`Loopback`, M25's
//! testkit), docs/plan/33-reference-furnace.md Tests added. The player earns the furnace the honest
//! way (five stone, one craft) because the loopback host offers no direct write.

use engine::client::drawlist::{HEADER_BYTES, KIND_SPRITE, REGION_BYTES};
use engine::client::{ClientSide, DrawList, PREDICTED};
use engine::game::Game as _;
use engine::game::{EntityId, PlayerId, WorldRead};
use engine::predict::Prediction;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos, TileRect,
};
use engine::worldgen::Worldgen;
use reference_sim::client::PlayerPresence;
use reference_sim::content::{self, ItemId, RECIPE_FURNACE};
use reference_sim::{RefAction, RefClient, RefGame, RefParams, RefWorldgen, TileXY, WorldXY};

const SEED: u64 = content::SEED;

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        RefWorldgen::generate(SEED, &RefParams::default(), chunk, out);
    }
}

fn camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 1,
        half_h: 1,
        vel_x: 0,
        vel_y: 0,
    }
}

/// The pristine tile at `(x, y)` (chunk edge 32).
fn pristine(x: i32, y: i32) -> Tile {
    let dims = ChunkDims::new(RefGame::CHUNK_BITS);
    let chunk = dims.chunk_of(TilePos::new(x, y));
    let mut out = vec![Tile::new(0, 0, 0); 32 * 32];
    RefWorldgen::generate(SEED, &RefParams::default(), chunk, &mut out);
    out[((y & 31) * 32 + (x & 31)) as usize]
}

fn buildable(x: i32, y: i32) -> bool {
    let t = pristine(x, y);
    t.resource() == 0 && t.base() >= content::SAND
}

/// Top-left of the first fully buildable, resource-free 2x2 in `[lo, hi)` both axes.
fn free_spot(lo: i32, hi: i32) -> TilePos {
    for y in lo..hi {
        for x in lo..hi {
            if [(0, 0), (1, 0), (0, 1), (1, 1)]
                .iter()
                .all(|&(dx, dy)| buildable(x + dx, y + dy))
            {
                return TilePos::new(x, y);
            }
        }
    }
    panic!("no free 2x2 in range at TEST_SEED");
}

/// A loopback with one client (`delay` ticks of downlink latency) holding `items` crafted furnace
/// items (five stone each; the stone landmark holds exactly ten units).
fn world_with_furnaces(delay: u32, items: u32) -> (Loopback<RefGame>, usize, PlayerId) {
    let mut lb = Loopback::new(WorldParams::<RefGame> {
        seed: SEED,
        worldgen: RefParams::default(),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    });
    let (idx, who) = lb.add_client(
        delay,
        ChunkDims::new(RefGame::CHUNK_BITS),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    );
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    // The stone landmark (`tests/fixtures/landmarks.json`): stand on it and collect five times.
    let stone = TilePos::new(-1, 2);
    let from = WorldXY {
        x: stone.x * 256 + 128,
        y: stone.y * 256 + 128,
    };
    for _ in 0..5 * items {
        lb.set_presence(
            idx,
            PlayerPresence {
                pos: [from.x, from.y],
                vel: [0, 0],
            },
        );
        lb.action(
            who,
            RefAction::StartCollect {
                tile: TileXY::from_tile(stone),
                from,
            },
        );
        lb.run(content::COLLECT.0 + 2);
    }
    for n in 1..=items {
        lb.action(
            who,
            RefAction::StartCraft {
                recipe: RECIPE_FURNACE,
            },
        );
        // Bounded wait for the craft to land in the client's replica (recipe time plus latency).
        for _ in 0..RECIPE_SECS_TICKS + 30 {
            lb.step();
            if my_furnace_items(&lb, idx) == n {
                break;
            }
        }
        assert_eq!(my_furnace_items(&lb, idx), n, "craft {n} landed");
    }
    (lb, idx, who)
}

const RECIPE_SECS_TICKS: u32 = content::RECIPES[0].secs * 20;

/// Inside the subscribed chunks (-1..=1 on both axes): a replica answers `Unknown` for a wider rect.
const WIDE: TileRect = TileRect::new(TilePos::new(-8, -8), TilePos::new(60, 40));

fn host_furnaces(lb: &Loopback<RefGame>) -> usize {
    let mut n = 0;
    lb.host
        .sim()
        .expect("genesis ran")
        .authority()
        .entities_in(
            TileRect::new(TilePos::new(-64, -64), TilePos::new(127, 127)),
            &mut |_, _| n += 1,
        )
        .expect("host reads are total");
    n
}

fn my_furnace_items(lb: &Loopback<RefGame>, idx: usize) -> u32 {
    lb.visible(idx, TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)))
        .me
        .expect("own player")
        .inventory
        .get(ItemId::Furnace)
}

/// The ghost-to-real swap: the furnace is there at once under a provisional id, the host acks, and
/// at every step in between the client sees exactly one furnace at that tile (never zero, never two).
/// Fails if `PlaceFurnace` is opted out of prediction (`Game::predict` false) or the spawn does not
/// go through the overlay's provisional id.
#[test]
fn predicted_place_then_ack_keeps_one_furnace() {
    let (mut lb, idx, _who) = world_with_furnaces(3, 1);
    let origin = free_spot(-8, 30);
    assert_eq!(lb.entities_in(idx, WIDE).len(), 0);

    let (seq, st) = lb.dispatch(
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    );
    assert_eq!(st, Prediction::Applied);
    let ghost = lb.entity_at(idx, origin).expect("predicted occupant");
    assert!(ghost.is_provisional());
    assert_eq!(my_furnace_items(&lb, idx), 0, "item spent locally at once");
    assert_eq!(host_furnaces(&lb), 0, "the host has not heard yet");

    let mut confirmed = false;
    let mut ids: Vec<EntityId> = vec![ghost];
    for step in 0..14 {
        lb.step();
        let here = lb.entities_in(idx, WIDE);
        assert_eq!(here.len(), 1, "step {step}: exactly one furnace visible");
        let id = lb.entity_at(idx, origin).expect("occupied every step");
        if ids.last() != Some(&id) {
            ids.push(id);
        }
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq && r.is_ok() {
                confirmed = true;
            }
        });
        if confirmed && lb.pending(idx).count() == 0 {
            break;
        }
    }
    assert!(confirmed, "the host accepted");
    assert_eq!(lb.overlay_len(idx), 0, "the view is authoritative again");
    assert_eq!(host_furnaces(&lb), 1);
    let real = lb.entity_at(idx, origin).expect("real occupant");
    assert!(!real.is_provisional());
    assert_eq!(ids, vec![ghost, real], "one id swap, provisional to real");
    assert_eq!(my_furnace_items(&lb, idx), 0);
}

/// A footprint that reaches an unsubscribed chunk is not predicted (`NotPredictable`: no ghost, no
/// local spend) but is still sent, and the host, which has the whole world, places it.
#[test]
fn predicted_place_at_subscription_edge_is_not_predictable() {
    let (mut lb, idx, _who) = world_with_furnaces(2, 2);
    // Camera chunk (0,0) subscribes chunks -1..=1 (tiles up to x = 63): column 63 is held, 64 is not.
    let y = (-30..60)
        .find(|&y| {
            buildable(63, y) && buildable(64, y) && buildable(63, y + 1) && buildable(64, y + 1)
        })
        .expect("a free 2x2 across the x = 63/64 chunk border");
    let origin = TilePos::new(63, y);

    // Control: a footprint wholly inside the subscription *is* predicted, so the `NotPredictable`
    // below is the edge and not a game that never predicts placement.
    let inside = free_spot(-8, 30);
    assert_eq!(
        lb.dispatch(
            idx,
            RefAction::PlaceFurnace {
                origin: TileXY::from_tile(inside),
            },
        )
        .1,
        Prediction::Applied
    );
    assert_eq!(my_furnace_items(&lb, idx), 1, "one item spent locally");

    let (seq, st) = lb.dispatch(
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    );
    assert_eq!(st, Prediction::NotPredictable);
    assert_eq!(lb.entity_at(idx, origin), None, "no ghost");
    assert_eq!(my_furnace_items(&lb, idx), 1, "no partial local spend");
    assert_eq!(lb.pending(idx).count(), 2, "both still sent and tracked");

    let mut confirmed = false;
    for _ in 0..10 {
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq && r.is_ok() {
                confirmed = true;
            }
        });
    }
    assert!(confirmed, "the host places it");
    assert_eq!(host_furnaces(&lb), 2);
}

/// One decoded sprite record of the furnace kind: `(pos, flags, color, param, pick_id)`.
type SpriteRec = ([f32; 2], u8, u32, f32, u32);

/// Runs `RefClient::extract` over client `idx`'s prediction-merged `FrameView` and returns every
/// sprite record (the 32-byte layout of 0018 section 2, decoded by hand: the engine's reader is test-private).
fn sprites(lb: &Loopback<RefGame>, idx: usize) -> Vec<SpriteRec> {
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let view = lb.frame_view(idx, WIDE, TilePos::new(0, 0));
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None);
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let u32_at = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut found = Vec::new();
    for i in 0..n as usize {
        let r = &region[HEADER_BYTES + i * 32..HEADER_BYTES + (i + 1) * 32];
        let kind = u16::from_le_bytes([r[16], r[17]]) >> 12;
        if kind == KIND_SPRITE {
            found.push((
                [f32_at(r, 0), f32_at(r, 4)],
                r[19],
                u32_at(r, 20),
                f32_at(r, 24),
                u32_at(r, 28),
            ));
        }
    }
    found
}

/// `extract` draws the furnace as one sprite at its min-corner tile, `PREDICTED` and dimmed while it
/// is only a prediction (provisional `pick_id`), then plain with the real id once acked -- and there
/// is exactly one sprite record at every step in between. Fails if `extract` drops the flag or the
/// dimming, skips overlay entities, or draws the furnace twice across the swap.
#[test]
fn extract_draws_predicted_then_real_furnace_sprite() {
    let (mut lb, idx, _who) = world_with_furnaces(3, 1);
    let origin = free_spot(-8, 30);
    assert!(sprites(&lb, idx).is_empty(), "no furnace, no sprite");

    let (seq, _) = lb.dispatch(
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    );
    let mut acked = false;
    let mut saw_predicted = false;
    for _ in 0..14 {
        let recs = sprites(&lb, idx);
        assert_eq!(recs.len(), 1, "exactly one furnace sprite");
        let (pos, flags, color, param, pick) = recs[0];
        assert_eq!(pos, [origin.x as f32, origin.y as f32]);
        assert_eq!(param, 0.0, "idle frame");
        if EntityId(pick).is_provisional() {
            saw_predicted = true;
            assert_eq!(flags & PREDICTED, PREDICTED);
            assert_eq!(color, 0x99ff_ffff);
        } else {
            assert_eq!(flags & PREDICTED, 0, "real furnace is not flagged");
            assert_eq!(color, 0xffff_ffff);
            break;
        }
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq && r.is_ok() {
                acked = true;
            }
        });
    }
    assert!(saw_predicted, "the provisional phase was observed");
    let recs = sprites(&lb, idx);
    assert_eq!(recs.len(), 1);
    assert!(
        !EntityId(recs[0].4).is_provisional(),
        "swapped to the real id"
    );
}

/// `.claude/rules/hot-paths.md`: `extract` with a furnace in view (predicted, then real) retains no
/// allocation once warm. `engine::abi::arena` (installed by `export_game!`) counts bytes allocated
/// minus freed on this thread. Limits: a transient allocation freed inside the same window moves
/// only the high-water mark, which the test's own multi-MiB setup has already raised far past any
/// such allocation, so this catches a leaking or retained per-call allocation (a growing scratch,
/// a `Box::leak`), not an alloc-then-free; the page-level check for that is the zero-GC browser
/// page (`gc.pages.reference`, re-run with construction mode on). Fails if the furnace loop in
/// `RefClient::extract` leaks per call.
#[test]
fn extract_with_furnace_allocates_nothing() {
    let (mut lb, idx, _who) = world_with_furnaces(3, 1);
    let origin = free_spot(-8, 30);
    lb.dispatch(
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    );
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let mut out = DrawList::new();
    let mut region = vec![0u8; REGION_BYTES];
    for phase in ["predicted", "real"] {
        if phase == "real" {
            for _ in 0..14 {
                lb.step();
            }
            assert_eq!(lb.overlay_len(idx), 0, "acked");
        }
        let view = lb.frame_view(idx, WIDE, TilePos::new(0, 0));
        // Warm-up: the first extract may size the overlay merge scratch once.
        out.begin_frame(TilePos::new(0, 0));
        client.extract(&view, &mut out);
        out.sort_into(&mut region, 0.0, None);

        let live_before = engine::abi::arena::thread_live_bytes();
        let hw_before = engine::abi::arena::thread_high_water_bytes();
        for _ in 0..50 {
            out.begin_frame(TilePos::new(0, 0));
            client.extract(&view, &mut out);
            assert!(
                out.sort_into(&mut region, 0.0, None) >= 3,
                "furnace + circle + ring"
            );
        }
        assert_eq!(
            engine::abi::arena::thread_live_bytes(),
            live_before,
            "{phase}: live bytes moved"
        );
        assert_eq!(
            engine::abi::arena::thread_high_water_bytes(),
            hw_before,
            "{phase}: a transient allocation was freed inside the window"
        );
    }
}
