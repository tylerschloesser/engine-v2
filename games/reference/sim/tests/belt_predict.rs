//! Belt actions through the real host <-> client round trip (`Loopback`, M25's testkit) and the
//! belt half of `RefClient::extract` (M51 Tests added): `PlaceBelt`, `RotateBelt` and `PickUpBelt`
//! predicted then acked (M60: an underground pair's rotation, both ends, or `NotPredictable` when
//! its pairing scan reaches an unheld tile), a rejected predicted placement replaced by the host's
//! belt, the DrawList golden of every kind and direction plus a predicted belt and the belt ghost,
//! and no retained allocation in `extract` with belts in view.

use std::collections::BTreeMap;

use engine::client::drawlist::{HEADER_BYTES, KIND_SPRITE, REGION_BYTES, hash_region};
use engine::client::input::kind;
use engine::client::{
    ANCHOR_CURSOR_TILE, ClientSide, Clocks, DrawList, FLIP_X, FrameView, InputEvent, PREDICTED,
    RemotePresences,
};
use engine::game::Game as _;
use engine::game::{EntityId, PlayerId, Unknown, WorldRead};
use engine::predict::Prediction;
use engine::sim::{Rejected, WorldParams};
use engine::testing::assert_golden_hash;
use engine::testing::testkit::Loopback;
use engine::time::{Tick, Ticks};
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Registry, Tile, TilePos, TileRect,
    TraitSet,
};
use engine::worldgen::Worldgen;
use reference_sim::content;
use reference_sim::{
    Belt, BeltKind, BeltShape, Dir, RefAction, RefClient, RefEntity, RefGame, RefParams, RefPlayer,
    RefReject, RefWorldgen, TileXY,
};

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

fn pristine(x: i32, y: i32) -> Tile {
    let dims = ChunkDims::new(RefGame::CHUNK_BITS);
    let chunk = dims.chunk_of(TilePos::new(x, y));
    let mut out = vec![Tile::new(0, 0, 0); 32 * 32];
    RefWorldgen::generate(SEED, &RefParams::default(), chunk, &mut out);
    out[((y & 31) * 32 + (x & 31)) as usize]
}

/// The first `n` land tiles with no resource in `[lo, hi)` on both axes (where a belt may stand).
fn free_tiles(lo: i32, hi: i32, n: usize) -> Vec<TilePos> {
    let mut found = Vec::new();
    for y in lo..hi {
        for x in lo..hi {
            let t = pristine(x, y);
            if t.resource() == 0 && t.base() >= content::SAND && found.len() < n {
                found.push(TilePos::new(x, y));
            }
        }
    }
    assert_eq!(found.len(), n, "free tiles at TEST_SEED");
    found
}

/// Inside the subscribed chunks (-1..=1 on both axes).
const WIDE: TileRect = TileRect::new(TilePos::new(-8, -8), TilePos::new(60, 40));

fn add_client(lb: &mut Loopback<RefGame>, delay: u32) -> (usize, PlayerId) {
    let (idx, who) = lb.add_client(
        delay,
        ChunkDims::new(RefGame::CHUNK_BITS),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    );
    lb.set_camera(idx, camera(10, 10));
    (idx, who)
}

/// Two clients, `A` (index 0) and `B` (index 1), both `delay` ticks of downlink latency. `B` acts
/// first (a belt at `b_belt`, settled): a client added after the first has acted never saw its own
/// `ActionResults` in this harness (`furnace_predict.rs`'s `world`).
fn two_clients(delay: u32, b_belt: TilePos) -> (Loopback<RefGame>, usize, usize) {
    let mut lb = Loopback::new(WorldParams::<RefGame> {
        seed: SEED,
        worldgen: RefParams::default(),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: engine::transport::DEFAULT_MAX_ITEMS,
    });
    let (a, _) = add_client(&mut lb, delay);
    let (b, _) = add_client(&mut lb, delay);
    lb.run(4);
    let v = dispatch_settled(&mut lb, b, place(b_belt, Dir::East, BeltKind::Belt));
    assert_eq!(v, Ok(()), "B's first belt");
    (lb, a, b)
}

fn place(at: TilePos, dir: Dir, kind: BeltKind) -> RefAction {
    RefAction::PlaceBelt {
        at: TileXY::from_tile(at),
        dir,
        kind,
    }
}

fn game_verdict(r: &Result<engine::sim::Applied, Rejected<RefGame>>) -> Result<(), RefReject> {
    match r {
        Ok(_) => Ok(()),
        Err(Rejected::Game(r)) => Err(*r),
        Err(Rejected::Engine(e)) => panic!("unexpected engine reject: {e:?}"),
    }
}

/// Steps until client `idx`'s action `seq` is answered and nothing is pending (bounded).
fn settle(lb: &mut Loopback<RefGame>, idx: usize, seq: u32) -> Result<(), RefReject> {
    let mut verdict = None;
    for _ in 0..40 {
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq {
                verdict = Some(game_verdict(r));
            }
        });
        if verdict.is_some() && lb.pending(idx).count() == 0 {
            break;
        }
    }
    verdict.expect("the host answered")
}

fn dispatch_settled(
    lb: &mut Loopback<RefGame>,
    idx: usize,
    action: RefAction,
) -> Result<(), RefReject> {
    let (seq, _) = lb.dispatch(idx, action);
    settle(lb, idx, seq)
}

fn host_belt(lb: &Loopback<RefGame>, at: TilePos) -> Option<(EntityId, Belt)> {
    let auth = lb.host.sim().expect("genesis ran").authority();
    let id = auth.entity_at(at).expect("host reads are total")?;
    let b = *auth.entity(id).expect("host reads are total")?.as_belt()?;
    Some((id, b))
}

/// The belt at `at` in client `idx`'s prediction-merged view.
fn seen_belt(lb: &Loopback<RefGame>, idx: usize, at: TilePos) -> Option<Belt> {
    lb.visible(idx, TileRect::new(at, at)).cells[0]
        .2
        .and_then(|e| e.as_belt().copied())
}

/// Each belt action shows at once under prediction and is then acked: the placement under a
/// provisional id that swaps to the host's, the rotation in the replica's direction before the host
/// has it, the pick-up as a `removing` belt (drawn as nothing, M52) before the host despawns. Fails
/// if any of the three is opted out of prediction (`Game::predict`) or `NotPredictable` (an unread
/// `?`, an id-addressed action), or if the ack does not leave the client on the host's state.
#[test]
fn belt_actions_are_predicted() {
    let spots = free_tiles(-8, 30, 2);
    let (mut lb, a, _b) = two_clients(3, spots[1]);
    let at = spots[0];
    assert!(seen_belt(&lb, a, at).is_none());

    // Place.
    let (seq, st) = lb.dispatch(a, place(at, Dir::West, BeltKind::Spawner));
    assert_eq!(st, Prediction::Applied);
    let ghost = lb.entity_at(a, at).expect("predicted occupant");
    assert!(ghost.is_provisional());
    assert_eq!(seen_belt(&lb, a, at).map(|b| b.dir), Some(Dir::West));
    assert!(host_belt(&lb, at).is_none(), "the host has not heard yet");
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    assert_eq!(lb.overlay_len(a), 0, "authoritative again");
    let (real, hb) = host_belt(&lb, at).expect("the host placed it");
    assert_eq!(
        lb.entity_at(a, at),
        Some(real),
        "provisional swapped to real"
    );
    assert_eq!(
        hb,
        Belt::new(TileXY::from_tile(at), Dir::West, BeltKind::Spawner)
    );
    assert_eq!(seen_belt(&lb, a, at), Some(hb));

    // Rotate: west to north at once, the host still west.
    let (seq, st) = lb.dispatch(
        a,
        RefAction::RotateBelt {
            at: TileXY::from_tile(at),
        },
    );
    assert_eq!(st, Prediction::Applied);
    assert_eq!(seen_belt(&lb, a, at).map(|b| b.dir), Some(Dir::North));
    assert_eq!(lb.entity_at(a, at), Some(real), "same entity");
    assert_eq!(host_belt(&lb, at).unwrap().1.dir, Dir::West);
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    assert_eq!(
        host_belt(&lb, at),
        Some((
            real,
            Belt {
                dir: Dir::North,
                ..hb
            }
        ))
    );
    assert_eq!(seen_belt(&lb, a, at).map(|b| b.dir), Some(Dir::North));

    // Pick up: marked `removing` at once (M52: drawn as nothing, the tile still occupied until the
    // host's tick unmaps and despawns it), the host still has it.
    let (seq, st) = lb.dispatch(
        a,
        RefAction::PickUpBelt {
            at: TileXY::from_tile(at),
        },
    );
    assert_eq!(st, Prediction::Applied);
    assert_eq!(lb.entity_at(a, at), Some(real), "still occupied");
    assert_eq!(
        seen_belt(&lb, a, at).map(|b| b.removing),
        Some(true),
        "removing"
    );
    assert!(!host_belt(&lb, at).unwrap().1.removing);
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    assert!(host_belt(&lb, at).is_none());
    assert_eq!(lb.entity_at(a, at), None);
    assert_eq!(lb.overlay_len(a), 0);
}

/// M52: a predicted belt shows its curve at once. `A` has an east belt; it places a north belt in
/// front of it, whose only input is that side neighbour: `apply` derives `CurveLeft` under
/// prediction, so the predicted sprite is the north left curve before the host has the action, and
/// after the ack the host's belt (the tick's authoritative shape) is the same curve and the sprite
/// unchanged. Fails if `apply` stops writing the edited tile's shape (the predicted belt draws
/// straight until the host's put) or the tick disagrees with `apply`.
#[test]
fn predicted_belt_shows_its_curve() {
    // Two free land tiles side by side, plus one apart for `B`.
    let (x, y) = (-8..30)
        .flat_map(|y| (-8..30).map(move |x| (x, y)))
        .find(|&(x, y)| {
            [pristine(x, y), pristine(x + 1, y)]
                .iter()
                .all(|t| t.resource() == 0 && t.base() >= content::SAND)
        })
        .expect("two free tiles side by side at TEST_SEED");
    let (feeder, at) = (TilePos::new(x, y), TilePos::new(x + 1, y));
    let other = free_tiles(-8, 30, 8)
        .into_iter()
        .find(|t| (t.x - x).abs() > 2 || (t.y - y).abs() > 2)
        .expect("a free tile apart");
    let (mut lb, a, _b) = two_clients(3, other);
    assert_eq!(
        dispatch_settled(&mut lb, a, place(feeder, Dir::East, BeltKind::Belt)),
        Ok(())
    );
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let mut out = DrawList::new();
    let mut region = vec![0u8; REGION_BYTES];
    let mut sprite_at = |lb: &Loopback<RefGame>| {
        let view = lb.frame_view(a, WIDE, TilePos::new(0, 0));
        out.begin_frame(TilePos::new(0, 0));
        client.extract(&view, &mut out);
        let n = out.sort_into(&mut region, 0.0, None);
        sprite_recs(&region, n)
            .into_iter()
            .find(|r| r.0 == [at.x as f32, at.y as f32])
            .map(|r| (r.5, r.1 & PREDICTED))
    };
    let curve_north = content::SPRITE_BELT_CURVE_LEFT + 2;

    let (seq, st) = lb.dispatch(a, place(at, Dir::North, BeltKind::Belt));
    assert_eq!(st, Prediction::Applied);
    assert!(host_belt(&lb, at).is_none(), "the host has not heard yet");
    assert_eq!(
        seen_belt(&lb, a, at).map(|b| b.shape),
        Some(BeltShape::CurveLeft),
        "predicted"
    );
    assert_eq!(
        sprite_at(&lb),
        Some((curve_north, PREDICTED)),
        "the predicted sprite"
    );
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    assert_eq!(
        host_belt(&lb, at).map(|(_, b)| b.shape),
        Some(BeltShape::CurveLeft)
    );
    assert_eq!(
        seen_belt(&lb, a, at).map(|b| b.shape),
        Some(BeltShape::CurveLeft),
        "acked"
    );
    assert_eq!(sprite_at(&lb), Some((curve_north, 0)), "the real sprite");
}

/// `B`'s belt lands first; `A`, still seeing a free tile, predicts its own: the host refuses
/// `NotBuildable` and `A` ends on `B`'s belt (its direction, the real id), never on its own. Fails if
/// a rejected prediction is kept or the replay leaves a second entity behind.
#[test]
fn rejected_predicted_place_restores() {
    let spots = free_tiles(-8, 30, 2);
    let (mut lb, a, b) = two_clients(3, spots[1]);
    let at = spots[0];
    lb.dispatch(b, place(at, Dir::South, BeltKind::Despawner));
    lb.step();
    assert!(host_belt(&lb, at).is_some(), "B landed first");
    assert!(seen_belt(&lb, a, at).is_none(), "not yet at A");

    let (seq, st) = lb.dispatch(a, place(at, Dir::North, BeltKind::Belt));
    assert_eq!(st, Prediction::Applied);
    assert_eq!(seen_belt(&lb, a, at).map(|b| b.dir), Some(Dir::North));
    assert_eq!(settle(&mut lb, a, seq), Err(RefReject::NotBuildable));
    assert_eq!(lb.overlay_len(a), 0);
    let (id, hb) = host_belt(&lb, at).unwrap();
    assert_eq!(lb.entity_at(a, at), Some(id), "the host's belt");
    assert_eq!(seen_belt(&lb, a, at), Some(hb));
    assert_eq!((hb.dir, hb.kind), (Dir::South, BeltKind::Despawner));
    assert_eq!(
        lb.entities_in(a, WIDE).len(),
        2,
        "B's two belts, nothing of A's"
    );
}

/// `B` picks a belt up first; `A`, still seeing it, predicts a rotate (shown turned at once) and then
/// a pick-up of a second belt `B` also took: the host answers `NoBeltHere` to both and `A` ends on
/// the host's state (no belt, an empty overlay). Fails if a rejected rotate or pick-up is kept, or
/// either is not predicted.
#[test]
fn rejected_predicted_rotate_and_pickup_restore() {
    let spots = free_tiles(-8, 30, 2);
    let (mut lb, a, b) = two_clients(3, spots[1]);
    assert_eq!(
        dispatch_settled(&mut lb, b, place(spots[0], Dir::East, BeltKind::Belt)),
        Ok(())
    );
    lb.run(8);
    for (i, at) in spots.into_iter().enumerate() {
        assert!(seen_belt(&lb, a, at).is_some(), "A sees belt {i}");
        lb.dispatch(
            b,
            RefAction::PickUpBelt {
                at: TileXY::from_tile(at),
            },
        );
        lb.step();
        assert!(host_belt(&lb, at).is_none(), "B's pick-up landed first");
        assert!(seen_belt(&lb, a, at).is_some(), "not yet at A");
        let xy = TileXY::from_tile(at);
        let (seq, st) = if i == 0 {
            let r = lb.dispatch(a, RefAction::RotateBelt { at: xy });
            assert_eq!(
                seen_belt(&lb, a, at).map(|b| b.dir),
                Some(Dir::South),
                "turned at A"
            );
            r
        } else {
            let r = lb.dispatch(a, RefAction::PickUpBelt { at: xy });
            assert_eq!(
                seen_belt(&lb, a, at).map(|b| b.removing),
                Some(true),
                "removing at A"
            );
            r
        };
        assert_eq!(st, Prediction::Applied, "belt {i}");
        assert_eq!(
            settle(&mut lb, a, seq),
            Err(RefReject::NoBeltHere),
            "belt {i}"
        );
        assert_eq!(lb.overlay_len(a), 0, "belt {i}");
        assert_eq!(lb.entity_at(a, at), None, "belt {i}: the host's empty tile");
        assert!(seen_belt(&lb, a, at).is_none());
    }
    assert!(lb.entities_in(a, WIDE).is_empty());
}

/// The first row in `ys` whose tiles `x` and `x + 2` are free land (an underground pair across a
/// gap of one; the tile between may hold anything).
fn free_pair(xs: std::ops::Range<i32>, ys: std::ops::Range<i32>) -> (TilePos, TilePos) {
    let free = |x: i32, y: i32| {
        let t = pristine(x, y);
        t.resource() == 0 && t.base() >= content::SAND
    };
    ys.flat_map(|y| xs.clone().map(move |x| (x, y)))
        .find(|&(x, y)| free(x, y) && free(x + 2, y))
        .map(|(x, y)| (TilePos::new(x, y), TilePos::new(x + 2, y)))
        .expect("two free tiles two apart at TEST_SEED")
}

/// M60: rotating an underground entrance is predicted as the host applies it, both ends at once:
/// `A`'s view shows the entrance an exit facing west and its partner an entrance facing west (two
/// puts) before the host has the action, the host then flips the same two, and after the ack `A`'s
/// view is the host's. Fails if the prediction turns one end only (the client and host disagree
/// until the ack) or the action is `NotPredictable` with every tile held.
#[test]
fn predicted_underground_rotate_flips_both_ends() {
    let (e, x) = free_pair(-8..28, -8..30);
    // `B`'s belt: a free tile on a row of a later pair (never `e`'s row).
    let (other, _) = free_pair(-8..28, e.y + 3..30);
    let (mut lb, a, _b) = two_clients(3, other);
    for (at, kind) in [(e, BeltKind::UndergroundIn), (x, BeltKind::UndergroundOut)] {
        assert_eq!(
            dispatch_settled(&mut lb, a, place(at, Dir::East, kind)),
            Ok(())
        );
    }
    let ends = |b: Option<Belt>| b.map(|b| (b.dir, b.kind));
    let (seq, st) = lb.dispatch(
        a,
        RefAction::RotateBelt {
            at: TileXY::from_tile(e),
        },
    );
    assert_eq!(st, Prediction::Applied);
    let flipped = [
        Some((Dir::West, BeltKind::UndergroundOut)),
        Some((Dir::West, BeltKind::UndergroundIn)),
    ];
    assert_eq!(
        [ends(seen_belt(&lb, a, e)), ends(seen_belt(&lb, a, x))],
        flipped,
        "predicted: both ends"
    );
    assert_eq!(
        [
            ends(host_belt(&lb, e).map(|h| h.1)),
            ends(host_belt(&lb, x).map(|h| h.1))
        ],
        [
            Some((Dir::East, BeltKind::UndergroundIn)),
            Some((Dir::East, BeltKind::UndergroundOut))
        ],
        "the host has not heard yet"
    );
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    assert_eq!(lb.overlay_len(a), 0, "authoritative again");
    for at in [e, x] {
        assert_eq!(
            seen_belt(&lb, a, at),
            host_belt(&lb, at).map(|h| h.1),
            "{at:?}"
        );
    }
    assert_eq!(
        [
            ends(host_belt(&lb, e).map(|h| h.1)),
            ends(host_belt(&lb, x).map(|h| h.1))
        ],
        flipped,
        "the host flipped both"
    );
}

/// M60: an entrance on the last held column (x = 63; the camera's chunks reach 63) paired with an
/// exit at x = 65, outside `A`'s subscription: its rotation's pairing scan reads x = 64, `Unknown`
/// on the client, so the action is `NotPredictable` (no end turned in `A`'s view, never a guess
/// that flips one end alone) but still sent, and the host flips both ends. Fails if an unknown
/// read in the scan is skipped or taken as empty.
#[test]
fn predicted_underground_rotate_partner_unknown_not_predictable() {
    let (e, x) = free_pair(63..64, -30..60);
    let other = free_tiles(-8, 30, 1)[0];
    let (mut lb, a, _b) = two_clients(3, other);
    assert_eq!(
        dispatch_settled(&mut lb, a, place(e, Dir::East, BeltKind::UndergroundIn)),
        Ok(())
    );
    let (seq, st) = lb.dispatch(a, place(x, Dir::East, BeltKind::UndergroundOut));
    assert_eq!(
        st,
        Prediction::NotPredictable,
        "the exit is outside A's chunks"
    );
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    let (seq, st) = lb.dispatch(
        a,
        RefAction::RotateBelt {
            at: TileXY::from_tile(e),
        },
    );
    assert_eq!(st, Prediction::NotPredictable);
    assert_eq!(
        seen_belt(&lb, a, e).map(|b| (b.dir, b.kind)),
        Some((Dir::East, BeltKind::UndergroundIn)),
        "nothing predicted"
    );
    assert_eq!(settle(&mut lb, a, seq), Ok(()));
    let ends = |at| host_belt(&lb, at).map(|(_, b)| (b.dir, b.kind));
    assert_eq!(
        [ends(e), ends(x)],
        [
            Some((Dir::West, BeltKind::UndergroundOut)),
            Some((Dir::West, BeltKind::UndergroundIn))
        ],
        "the host flipped both"
    );
    assert_eq!(
        seen_belt(&lb, a, e).map(|b| (b.dir, b.kind)),
        Some((Dir::West, BeltKind::UndergroundOut)),
        "A on the host's state"
    );
}

/// Grass everywhere; traits from the game's own registry; one player with an empty inventory.
struct Grass<'a> {
    registry: &'a Registry,
    player: RefPlayer,
}

impl WorldRead<RefGame> for Grass<'_> {
    fn tick(&self) -> Tick {
        Tick(0)
    }
    fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
        Ok(Tile::new(content::GRASS, 0, 0))
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(self.registry.tile_traits(self.tile(p)?))
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(&self, _id: EntityId) -> Result<Option<&RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&RefPlayer, Unknown> {
        Ok(&self.player)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        &reference_sim::RefGlobal::EMPTY
    }
    fn entities_in(
        &self,
        _rect: TileRect,
        _f: &mut dyn FnMut(EntityId, &RefEntity),
    ) -> Result<(), Unknown> {
        Ok(())
    }
}

fn game_event(code: u32, a: i32) -> InputEvent {
    InputEvent {
        kind: kind::GAME,
        pick_id: code,
        tile: [a, 0],
        ..InputEvent::default()
    }
}

/// One decoded sprite record: `(pos, flags, color, param, pick_id, sprite id)`.
type SpriteRec = ([f32; 2], u8, u32, f32, u32, u16);

/// Every sprite record of one sorted DrawList region (0018 section 2's 32-byte layout).
fn sprite_recs(region: &[u8], n: u32) -> Vec<SpriteRec> {
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let u32_at = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut found = Vec::new();
    for i in 0..n as usize {
        let r = &region[HEADER_BYTES + i * 32..HEADER_BYTES + (i + 1) * 32];
        let ks = u16::from_le_bytes([r[16], r[17]]);
        if ks >> 12 == KIND_SPRITE {
            found.push((
                [f32_at(r, 0), f32_at(r, 4)],
                r[19],
                u32_at(r, 20),
                f32_at(r, 24),
                u32_at(r, 28),
                ks & 0x0fff,
            ));
        }
    }
    found
}

/// The three kinds in all four directions (one row of four per kind, twelve belts), one predicted belt and
/// the spawner ghost turned to face south, at tick 5.5 of the authoritative clock (no transport:
/// frame `floor(5.5 * 24 / 32) % 8 = 4`), hashed. The decoded records pin the sprite choice, the
/// west flip, the frame, the predicted tint and the cursor anchor. Fails if a direction or kind maps
/// to the wrong sprite, west is not mirrored, the frame ignores the clock, or the ghost is the
/// furnace quad.
#[test]
fn extract_hash_belts() {
    let mut registry = Registry::new();
    RefGame::register(&mut registry);
    let world = Grass {
        registry: &registry,
        player: RefPlayer::default(),
    };
    let dirs = [Dir::East, Dir::South, Dir::West, Dir::North];
    let kinds = [BeltKind::Belt, BeltKind::Spawner, BeltKind::Despawner];
    let mut entities = BTreeMap::new();
    let mut id = 1;
    for (row, kind) in kinds.into_iter().enumerate() {
        for (col, dir) in dirs.into_iter().enumerate() {
            let origin = TileXY {
                x: col as i32 - 2,
                y: row as i32 - 3,
            };
            entities.insert(EntityId(id), RefEntity::Belt(Belt::new(origin, dir, kind)));
            id += 1;
        }
    }
    let predicted = EntityId(0x8000_0001);
    assert!(predicted.is_provisional());
    entities.insert(
        predicted,
        RefEntity::Belt(Belt::new(TileXY { x: 3, y: 3 }, Dir::North, BeltKind::Belt)),
    );

    let mut client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    client.apply_local(&game_event(
        content::local::PLACE_MODE,
        content::local::TOOL_SPAWNER,
    ));
    client.apply_local(&game_event(content::local::ROTATE_TOOL, 0));
    let clocks = Clocks {
        authoritative: Tick(5),
        predicted: Tick(5),
        tick_fraction: 0.5,
        ticks_per_second: 20,
        lead: Ticks(0),
        correction: 0.0,
    };
    let remote = RemotePresences::<RefGame>::new();
    let view = FrameView::new(
        &world as &dyn WorldRead<RefGame>,
        clocks,
        PlayerId(1),
        &entities,
        &registry,
        TileRect::new(TilePos::new(-10, -10), TilePos::new(10, 10)),
        20.0,
        40.0,
        Some(TilePos::new(6, -1)),
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        &remote,
    );
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None);
    assert_eq!(
        n,
        12 + 1 + 1 + 2,
        "belts, the predicted one, the ghost, circle and ring"
    );

    let recs = sprite_recs(&region, n);
    assert_eq!(recs.len(), 14);
    let at = |x: f32, y: f32| {
        *recs
            .iter()
            .find(|r| r.0 == [x, y] && r.1 & ANCHOR_CURSOR_TILE == 0)
            .unwrap_or_else(|| panic!("a sprite at ({x}, {y})"))
    };
    let families = [
        content::SPRITE_BELT_STRAIGHT,
        content::SPRITE_BELT_SPAWNER,
        content::SPRITE_BELT_DESPAWNER,
    ];
    for (row, family) in families.into_iter().enumerate() {
        let y = row as f32 - 3.0;
        // East, south, west (= east mirrored), north.
        let want = [
            (family, 0),
            (family + 1, 0),
            (family, FLIP_X),
            (family + 2, 0),
        ];
        for (col, (sprite, flip)) in want.into_iter().enumerate() {
            let r = at(col as f32 - 2.0, y);
            assert_eq!((r.5, r.1 & FLIP_X), (sprite, flip), "row {row} col {col}");
            assert_eq!(r.3, 4.0, "frame from the clock");
            assert_eq!(r.2, 0xffff_ffff, "plain tint");
            assert_eq!(r.1 & PREDICTED, 0);
        }
    }
    let p = at(3.0, 3.0);
    assert_eq!(p.5, content::SPRITE_BELT_STRAIGHT + 2);
    assert_eq!(
        (p.1 & PREDICTED, p.2, p.4),
        (PREDICTED, 0x99ff_ffff, predicted.0)
    );
    let ghost = *recs
        .iter()
        .find(|r| r.1 & ANCHOR_CURSOR_TILE != 0)
        .expect("the belt ghost is a sprite");
    assert_eq!(
        ghost.5,
        content::SPRITE_BELT_SPAWNER + 1,
        "a spawner facing south"
    );
    assert_eq!((ghost.0, ghost.2, ghost.3), ([0.0, 0.0], 0x9040_ff40, 4.0));

    assert_golden_hash!("extract_hash_belts", hash_region(&region, n));
}

/// A curve's sprite and mirror (M52 writes shapes; the mapping is M51's): west swaps the side.
#[test]
fn belt_sprite_curves_mirror_on_west() {
    use reference_sim::client::belt_sprite;
    let (l, r) = (
        content::SPRITE_BELT_CURVE_LEFT,
        content::SPRITE_BELT_CURVE_RIGHT,
    );
    let k = BeltKind::Belt;
    assert_eq!(belt_sprite(k, BeltShape::CurveLeft, Dir::East), (l, false));
    assert_eq!(
        belt_sprite(k, BeltShape::CurveLeft, Dir::South),
        (l + 1, false)
    );
    assert_eq!(
        belt_sprite(k, BeltShape::CurveLeft, Dir::North),
        (l + 2, false)
    );
    assert_eq!(belt_sprite(k, BeltShape::CurveLeft, Dir::West), (r, true));
    assert_eq!(belt_sprite(k, BeltShape::CurveRight, Dir::West), (l, true));
    assert_eq!(
        belt_sprite(BeltKind::Spawner, BeltShape::CurveLeft, Dir::South),
        (content::SPRITE_BELT_SPAWNER + 1, false),
        "a spawner draws straight"
    );
}

/// `.claude/rules/hot-paths.md`: `extract` with belts of every kind in view (predicted, then real)
/// retains no allocation once warm (`extract_with_furnace_allocates_nothing`'s method and limits:
/// `engine::abi::arena` live and high-water bytes over 50 calls). Fails if the belt branch of
/// `RefClient::extract` allocates per call.
#[test]
fn extract_with_belts_allocates_nothing() {
    let spots = free_tiles(-8, 30, 4);
    let (mut lb, a, _b) = two_clients(3, spots[3]);
    for (i, kind) in [BeltKind::Belt, BeltKind::Spawner, BeltKind::Despawner]
        .into_iter()
        .enumerate()
    {
        let (_, st) = lb.dispatch(a, place(spots[i], Dir::West, kind));
        assert_eq!(st, Prediction::Applied);
    }
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let mut out = DrawList::new();
    let mut region = vec![0u8; REGION_BYTES];
    for phase in ["predicted", "real"] {
        if phase == "real" {
            for _ in 0..14 {
                lb.step();
            }
            assert_eq!(lb.overlay_len(a), 0, "acked");
        }
        let view = lb.frame_view(a, WIDE, TilePos::new(0, 0));
        out.begin_frame(TilePos::new(0, 0));
        client.extract(&view, &mut out);
        let n = out.sort_into(&mut region, 0.0, None);
        assert_eq!(sprite_recs(&region, n).len(), 4, "{phase}: four belts");

        let live_before = engine::abi::arena::thread_live_bytes();
        let hw_before = engine::abi::arena::thread_high_water_bytes();
        for _ in 0..50 {
            out.begin_frame(TilePos::new(0, 0));
            client.extract(&view, &mut out);
            assert_eq!(
                out.sort_into(&mut region, 0.0, None),
                n,
                "{phase}: the same records"
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
