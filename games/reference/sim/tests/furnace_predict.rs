//! Furnace actions through the real host <-> client round trip (`Loopback`, M25's testkit),
//! M33b Tests added: prediction of deposit and pick-up, the
//! `FurnaceTake` prediction (R2), a rejected predicted pick-up, and the host-side half of a pick-up racing
//! another player's panel. The client's `open` panel state is step 3's and is asserted there.
//!
//! Players earn their items the honest way (the loopback host offers no direct write): the iron and
//! stone landmarks (`tests/fixtures/landmarks.json`) are within collect range of one standing point.

use engine::client::{ClientSide, DrawList};
use engine::game::Game as _;
use engine::game::{EntityId, PlayerId, Unknown, WorldRead};
use engine::predict::Prediction;
use engine::sim::{Rejected, WorldParams};
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Registry, Tile, TilePos, TileRect,
    TraitSet,
};
use engine::worldgen::Worldgen;
use reference_sim::client::PlayerPresence;
use reference_sim::content::{self, ItemId, RECIPE_FURNACE};
use reference_sim::rules::place::can_place;
use reference_sim::{
    Furnace, RefAction, RefClient, RefGame, RefParams, RefReject, RefWorldgen, TileXY, WorldXY,
};

const SEED: u64 = content::SEED;
const SMELT: u32 = content::SMELT.0;

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

fn buildable(x: i32, y: i32) -> bool {
    let t = pristine(x, y);
    t.resource() == 0 && t.base() >= content::SAND
}

/// Top-left of the first fully buildable, resource-free 2x2 in `[lo, hi)` on both axes.
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

/// Inside the subscribed chunks (-1..=1 on both axes).
const WIDE: TileRect = TileRect::new(TilePos::new(-8, -8), TilePos::new(60, 40));

/// The standing point that reaches both the stone landmark (-1, 2) and the iron landmark (0, 0).
fn stand(lb: &mut Loopback<RefGame>, idx: usize) -> WorldXY {
    let from = WorldXY {
        x: -256 + 128,
        y: 2 * 256 + 128,
    };
    lb.set_presence(
        idx,
        PlayerPresence {
            pos: [from.x, from.y],
            vel: [0, 0],
        },
    );
    from
}

fn collect(lb: &mut Loopback<RefGame>, idx: usize, who: PlayerId, tile: TilePos, times: u32) {
    let from = stand(lb, idx);
    for _ in 0..times {
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
                tile: TileXY::from_tile(tile),
                from,
            },
        );
        lb.run(content::COLLECT.0 + 2);
    }
    lb.run(8); // the completion reaches this client's replica.
}

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

fn items(lb: &Loopback<RefGame>, idx: usize, item: ItemId) -> u32 {
    lb.visible(idx, TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)))
        .me
        .expect("own player")
        .inventory
        .get(item)
}

fn host_furnace(lb: &Loopback<RefGame>, at: TilePos) -> Option<Furnace> {
    let auth = lb.host.sim().expect("genesis ran").authority();
    let id = auth.entity_at(at).expect("host reads are total")?;
    auth.entity(id).expect("host reads are total").copied()
}

/// The furnace at `at` in client `idx`'s prediction-merged view.
fn seen_furnace(lb: &Loopback<RefGame>, idx: usize, at: TilePos) -> Option<Furnace> {
    lb.visible(idx, TileRect::new(at, at)).cells[0].2
}

/// One client (`delay` ticks of downlink latency) that has crafted `furnaces` furnace items and
/// collected `iron` iron, with the world settled.
fn world(delay: u32, furnaces: u32, iron: u32) -> (Loopback<RefGame>, usize, PlayerId) {
    // The second client is connected up front and has sent one action before the first client's:
    // a client added after the first has acted never saw its own `ActionResults` in this harness
    // (observed, unexplained; see Deviations).
    let (lb, idx, who, _) = world_with_b(delay, furnaces, iron, 1);
    (lb, idx, who)
}

/// [`world`] plus a second client `B` (index 1) that has collected `iron_b` iron first.
fn world_with_b(
    delay: u32,
    furnaces: u32,
    iron: u32,
    iron_b: u32,
) -> (Loopback<RefGame>, usize, PlayerId, (usize, PlayerId)) {
    let mut lb = Loopback::new(WorldParams::<RefGame> {
        seed: SEED,
        worldgen: RefParams::default(),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    });
    let (idx, who) = add_client(&mut lb, delay);
    let b = add_client(&mut lb, delay);
    lb.run(4);
    collect(&mut lb, b.0, b.1, TilePos::new(0, 0), iron_b);
    collect(&mut lb, idx, who, TilePos::new(-1, 2), 5 * furnaces);
    collect(&mut lb, idx, who, TilePos::new(0, 0), iron);
    for n in 1..=furnaces {
        lb.action(
            who,
            RefAction::StartCraft {
                recipe: RECIPE_FURNACE,
            },
        );
        for _ in 0..content::RECIPES[0].secs * 20 + 30 {
            lb.step();
            if items(&lb, idx, ItemId::Furnace) == n {
                break;
            }
        }
        assert_eq!(items(&lb, idx, ItemId::Furnace), n, "craft {n} landed");
    }
    (lb, idx, who, b)
}

fn game_verdict(r: &Result<engine::sim::Applied, Rejected<RefGame>>) -> Result<(), RefReject> {
    match r {
        Ok(_) => Ok(()),
        Err(Rejected::Game(r)) => Err(*r),
        Err(Rejected::Engine(e)) => panic!("unexpected engine reject: {e:?}"),
    }
}

/// Dispatches `action` from client `idx` and steps until it is acked (bounded); returns its verdict.
fn dispatch_settled(
    lb: &mut Loopback<RefGame>,
    idx: usize,
    action: RefAction,
) -> Result<(), RefReject> {
    let (seq, _) = lb.dispatch(idx, action);
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

fn place_settled(lb: &mut Loopback<RefGame>, idx: usize, origin: TilePos) {
    dispatch_settled(
        lb,
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    )
    .expect("placement accepted");
}

/// A deposit sent right behind the placement, before the ack, is applied to the ghost at once and is
/// valid on the host (addressed by tile, not by the provisional id). Fails if `FurnaceDeposit` names
/// an entity id, or is opted out of prediction.
#[test]
fn deposit_into_predicted_furnace_before_ack() {
    let (mut lb, idx, _who) = world(3, 1, 1);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    assert_eq!(items(&lb, idx, ItemId::Iron), 1);

    let (_, st) = lb.dispatch(idx, RefAction::PlaceFurnace { origin: at });
    assert_eq!(st, Prediction::Applied);
    assert!(lb.entity_at(idx, origin).unwrap().is_provisional());
    let (_, st) = lb.dispatch(
        idx,
        RefAction::FurnaceDeposit {
            at,
            item: ItemId::Iron as u8,
            count: 1,
        },
    );
    assert_eq!(st, Prediction::Applied, "deposit is predicted");
    let ghost = seen_furnace(&lb, idx, origin).expect("the ghost is there");
    assert_eq!(ghost.iron_in, 1, "the deposit is inside the ghost at once");
    assert_eq!(items(&lb, idx, ItemId::Iron), 0, "spent locally at once");
    assert!(
        host_furnace(&lb, origin).is_none(),
        "the host has not heard"
    );

    lb.run(20);
    assert_eq!(lb.pending(idx).count(), 0, "both acked");
    assert_eq!(lb.overlay_len(idx), 0, "authoritative again");
    let real = host_furnace(&lb, origin).expect("the host placed it");
    assert_eq!(real.iron_in, 1, "and applied the deposit to it");
    assert_eq!(seen_furnace(&lb, idx, origin), Some(real));
    assert_eq!(items(&lb, idx, ItemId::Iron), 0);
}

/// `Game::predict` says yes to every action, `FurnaceTake` included (R2, Tyler 2026-10-10); a take
/// dispatched at a furnace holding ingots shows its effect at once (`Applied`) and the host's ack
/// leaves the same state (`Confirmed`).
#[test]
fn take_is_predicted() {
    let all = |at| {
        [
            RefAction::StartCollect {
                tile: at,
                from: WorldXY::default(),
            },
            RefAction::CancelCollect,
            RefAction::StartCraft { recipe: 0 },
            RefAction::PlaceFurnace { origin: at },
            RefAction::FurnaceDeposit {
                at,
                item: 1,
                count: 1,
            },
            RefAction::FurnaceTake { at },
            RefAction::FurnacePickUp { at },
        ]
    };
    for a in all(TileXY { x: 1, y: 1 }) {
        assert!(RefGame::predict(&a), "{a:?}");
    }

    // Through the real client path: a furnace that has smelted one ingot on the host.
    let (mut lb, idx, who) = world(3, 1, 1);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    // One wood smelts two: gather it at the wood landmark (-4, -2).
    let wood_from = WorldXY {
        x: -3 * 256 - 128,
        y: -2 * 256,
    };
    lb.set_presence(
        idx,
        PlayerPresence {
            pos: [wood_from.x, wood_from.y],
            vel: [0, 0],
        },
    );
    lb.action(
        who,
        RefAction::StartCollect {
            tile: TileXY { x: -4, y: -2 },
            from: wood_from,
        },
    );
    lb.run(content::COLLECT.0 + 2);
    place_settled(&mut lb, idx, origin);
    for (item, count) in [(ItemId::Iron, 1), (ItemId::Wood, 1)] {
        dispatch_settled(
            &mut lb,
            idx,
            RefAction::FurnaceDeposit {
                at,
                item: item as u8,
                count,
            },
        )
        .expect("deposit accepted");
    }
    lb.run(SMELT + 20);
    assert_eq!(host_furnace(&lb, origin).unwrap().ingots_out, 1);
    assert_eq!(seen_furnace(&lb, idx, origin).unwrap().ingots_out, 1);

    let (seq, st) = lb.dispatch(idx, RefAction::FurnaceTake { at });
    assert_eq!(st, Prediction::Applied, "predicted like every other action");
    assert!(
        lb.overlay_len(idx) > 0,
        "an overlay entry carries the prediction"
    );
    assert_eq!(items(&lb, idx, ItemId::Ingot), 1, "the ingot shows at once");
    assert_eq!(seen_furnace(&lb, idx, origin).unwrap().ingots_out, 0);
    assert_eq!(lb.pending(idx).count(), 1, "sent and tracked until the ack");
    let mut acked = false;
    for _ in 0..12 {
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            acked |= s == seq && r.is_ok();
        });
    }
    assert!(acked, "the host took it: Confirmed");
    assert_eq!(
        lb.overlay_len(idx),
        0,
        "the overlay entry is gone after the ack"
    );
    assert_eq!(
        items(&lb, idx, ItemId::Ingot),
        1,
        "the same state after the ack"
    );
    assert_eq!(seen_furnace(&lb, idx, origin).unwrap().ingots_out, 0);
    assert_eq!(host_furnace(&lb, origin).unwrap().ingots_out, 0);
}

/// The furnace item's sprite records `extract` emits for client `idx`'s prediction-merged view.
fn furnace_sprites(lb: &Loopback<RefGame>, idx: usize) -> usize {
    use engine::client::drawlist::{HEADER_BYTES, KIND_SPRITE, REGION_BYTES};
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let view = lb.frame_view(idx, WIDE, TilePos::new(0, 0));
    let mut out = DrawList::new();
    out.begin_frame(TilePos::new(0, 0));
    client.extract(&view, &mut out);
    let mut region = vec![0u8; REGION_BYTES];
    let n = out.sort_into(&mut region, 0.0, None);
    (0..n as usize)
        .filter(|i| {
            let r = &region[HEADER_BYTES + i * 32..HEADER_BYTES + (i + 1) * 32];
            let kind = u16::from_le_bytes([r[16], r[17]]) >> 12;
            kind == KIND_SPRITE
        })
        .count()
}

/// Client `idx`'s prediction-merged view as a `WorldRead` (tile and occupant through the testkit's
/// overlay-aware reads; traits from the game's own registry), so the real `can_place` runs over it.
struct Merged<'a> {
    lb: &'a Loopback<RefGame>,
    idx: usize,
    registry: Registry,
}

impl WorldRead<RefGame> for Merged<'_> {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        self.lb.visible(self.idx, TileRect::new(p, p)).cells[0]
            .1
            .ok_or(Unknown)
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        let mut t = self.registry.tile_traits(self.tile(p)?);
        if self.lb.entity_at(self.idx, p).is_some() {
            t = t.union(self.registry.prototype_traits(content::FURNACE_PROTO));
        }
        Ok(t)
    }
    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(self.lb.entity_at(self.idx, p))
    }
    fn entity(&self, _id: EntityId) -> Result<Option<&Furnace>, Unknown> {
        Err(Unknown)
    }
    fn player(&self, _who: PlayerId) -> Result<&reference_sim::RefPlayer, Unknown> {
        Err(Unknown)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        &reference_sim::RefGlobal::EMPTY
    }
    fn entities_in(
        &self,
        _rect: TileRect,
        _f: &mut dyn FnMut(EntityId, &Furnace),
    ) -> Result<(), Unknown> {
        Err(Unknown)
    }
}

/// `entity_at` and `can_place` over client `idx`'s prediction-merged view.
fn merged(lb: &Loopback<RefGame>, idx: usize, origin: TilePos) -> (Option<EntityId>, bool) {
    let mut registry = Registry::new();
    content::register(&mut registry);
    let world = Merged { lb, idx, registry };
    (
        lb.entity_at(idx, origin),
        can_place(&world, origin).expect("held"),
    )
}

/// A delayed client that picks up its empty furnace sees it vanish at once, and it never comes back
/// across the ack. Fails if the pick-up is not predicted, the tombstone is not honoured by
/// `entity_at`, `can_place` or `extract`, or the item is not returned locally.
#[test]
fn predicted_pickup_tombstone_then_ack() {
    let (mut lb, idx, _who) = world(3, 1, 0);
    let origin = free_spot(-8, 30);
    place_settled(&mut lb, idx, origin);
    lb.run(6);
    assert_eq!(items(&lb, idx, ItemId::Furnace), 0);
    assert!(merged(&lb, idx, origin).0.is_some());
    assert!(!merged(&lb, idx, origin).1, "occupied: not buildable");
    assert_eq!(furnace_sprites(&lb, idx), 1, "control: the furnace draws");

    let (seq, st) = lb.dispatch(
        idx,
        RefAction::FurnacePickUp {
            at: TileXY::from_tile(origin),
        },
    );
    assert_eq!(st, Prediction::Applied, "pick-up is predicted");
    let mut acked = false;
    let mut steps_before_ack = 0;
    for step in 0..14 {
        let (id, placeable) = merged(&lb, idx, origin);
        assert_eq!(id, None, "step {step}: entity_at over the overlay is none");
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            assert_eq!(
                merged(&lb, idx, TilePos::new(origin.x + dx, origin.y + dy)).0,
                None
            );
        }
        assert!(
            placeable,
            "step {step}: the tiles are buildable in the view"
        );
        assert_eq!(
            items(&lb, idx, ItemId::Furnace),
            1,
            "step {step}: item back"
        );
        assert_eq!(
            furnace_sprites(&lb, idx),
            0,
            "step {step}: no furnace record"
        );
        if acked {
            break;
        }
        steps_before_ack += 1;
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            acked |= s == seq && r.is_ok();
        });
    }
    assert!(steps_before_ack > 0 && acked, "the host accepted it");
    lb.run(6);
    assert_eq!(lb.overlay_len(idx), 0);
    assert!(host_furnace(&lb, origin).is_none());
    assert_eq!(merged(&lb, idx, origin), (None, true));
    assert_eq!(items(&lb, idx, ItemId::Furnace), 1);
    assert_eq!(furnace_sprites(&lb, idx), 0);
}

/// Another player's deposit lands first: the host rejects the pick-up `FurnaceNotEmpty`, and on the
/// replay the tombstone and the local +1 are gone and the furnace is back with the deposit inside.
#[test]
fn predicted_pickup_rejected_restores_furnace() {
    let (mut lb, a, _who_a, (b, _who_b)) = world_with_b(3, 1, 0, 1);
    assert_eq!(items(&lb, b, ItemId::Iron), 1);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    place_settled(&mut lb, a, origin);
    lb.run(8);
    assert!(seen_furnace(&lb, b, origin).is_some(), "B sees it");

    // B's deposit reaches the host first; A, still seeing an empty furnace, picks it up.
    lb.dispatch(
        b,
        RefAction::FurnaceDeposit {
            at,
            item: ItemId::Iron as u8,
            count: 1,
        },
    );
    lb.step();
    assert_eq!(
        host_furnace(&lb, origin).unwrap().iron_in,
        1,
        "landed first"
    );
    assert_eq!(
        seen_furnace(&lb, a, origin).unwrap().iron_in,
        0,
        "not yet at A"
    );
    let (seq, st) = lb.dispatch(a, RefAction::FurnacePickUp { at });
    assert_eq!(st, Prediction::Applied);
    assert!(seen_furnace(&lb, a, origin).is_none(), "tombstoned at A");
    assert_eq!(items(&lb, a, ItemId::Furnace), 1);

    let mut verdict = None;
    for _ in 0..16 {
        lb.step();
        lb.client_mut(a).drain_results(|s, r| {
            if s == seq {
                verdict = Some(game_verdict(r));
            }
        });
    }
    assert_eq!(verdict, Some(Err(RefReject::FurnaceNotEmpty)));
    assert_eq!(lb.overlay_len(a), 0);
    let back = seen_furnace(&lb, a, origin).expect("the furnace is back at A");
    assert_eq!(back.iron_in, 1, "with B's deposit inside");
    assert_eq!(Some(back), host_furnace(&lb, origin));
    assert_eq!(items(&lb, a, ItemId::Furnace), 0, "the local +1 is gone");
    assert!(!merged(&lb, a, origin).1, "occupied again");
}

/// The host and replica halves of a pick-up that races another player's deposit: A picks up, B's
/// deposit (sent before B could hear of it) is rejected having written nothing, B's replica drops
/// the furnace (`EntityGone`) and every replica ends on the host's state. B's panel state (`open`,
/// `Ui.furnace`) is asserted in step 3.
#[test]
fn pickup_sends_entity_gone_and_closes_other_panel() {
    let (mut lb, a, _who_a, (b, _who_b)) = world_with_b(3, 1, 0, 1);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    place_settled(&mut lb, a, origin);
    lb.run(8);
    assert!(seen_furnace(&lb, b, origin).is_some(), "B sees it");

    lb.dispatch(a, RefAction::FurnacePickUp { at });
    lb.step();
    assert!(host_furnace(&lb, origin).is_none(), "the host applied it");
    // B's deposit is in flight: dispatched before B's replica has heard the furnace is gone.
    assert!(
        seen_furnace(&lb, b, origin).is_some(),
        "B has not heard yet"
    );
    // B has the panel open on it.
    let mut client_b = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    client_b.apply_tap(
        &tap(TilePos::new(origin.x + 1, origin.y + 1)),
        &lb.frame_view(b, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client_b.open(), Some(origin));
    assert_eq!(ui_of(&lb, b, &client_b).furnace.map(|f| f.at), Some(at));
    let (seq, st) = lb.dispatch(
        b,
        RefAction::FurnaceDeposit {
            at,
            item: ItemId::Iron as u8,
            count: 1,
        },
    );
    assert_eq!(st, Prediction::Applied, "B still predicts it");
    let hash_before = lb.host.sim().unwrap().state_hash();
    let mut verdict = None;
    for _ in 0..16 {
        lb.step();
        lb.client_mut(b).drain_results(|s, r| {
            if s == seq {
                verdict = Some(game_verdict(r));
            }
        });
    }
    assert_eq!(verdict, Some(Err(RefReject::NoFurnaceHere)));
    assert!(
        seen_furnace(&lb, b, origin).is_none(),
        "EntityGone reached B"
    );
    // B's next `frame` closes the panel, and the `Ui` after it has no furnace.
    client_b.recheck_open(&lb.frame_view(b, WIDE, TilePos::new(0, 0)));
    assert_eq!(client_b.open(), None, "B's panel closed");
    assert_eq!(ui_of(&lb, b, &client_b).furnace, None);
    assert_eq!(merged(&lb, b, origin), (None, true));
    assert_eq!(items(&lb, b, ItemId::Iron), 1, "B's iron never left");
    assert_eq!(items(&lb, a, ItemId::Furnace), 1);
    let _ = hash_before;
    // Every replica equals the host over the furnace's tiles and the players' items.
    for idx in [a, b] {
        assert_eq!(lb.overlay_len(idx), 0);
        assert_eq!(lb.entities_in(idx, WIDE).len(), 0);
    }
    assert_eq!(host_count(&lb), 0);
    // Both replicas hash equal to the host over everything each holds (chunks, `Global`, own player).
    lb.run(8);
    for idx in [a, b] {
        assert_eq!(
            lb.client(idx).view().region_hash(),
            lb.host.region_hash(lb.conn(idx)),
            "client {idx} replica hash equals the host's"
        );
    }
}

fn host_count(lb: &Loopback<RefGame>) -> usize {
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

/// A tap on `tile` (the furnace is found by tile, `RefClient::apply_tap`).
fn tap(tile: TilePos) -> engine::client::InputEvent {
    engine::client::InputEvent {
        kind: engine::client::input::kind::TAP,
        tile: [tile.x, tile.y],
        ..Default::default()
    }
}

fn local(code: u32, a: i32) -> engine::client::InputEvent {
    engine::client::InputEvent {
        kind: engine::client::input::kind::GAME,
        pick_id: code,
        tile: [a, 0],
        ..Default::default()
    }
}

fn ui_of(lb: &Loopback<RefGame>, idx: usize, client: &RefClient) -> reference_sim::RefUi {
    let view = lb.frame_view(idx, WIDE, TilePos::new(0, 0));
    let mut ui = reference_sim::RefUi::default();
    client.ui(&view, &mut ui);
    ui
}

/// The panel rules of `RefClient`, tile-keyed: a tap on a furnace (predicted or real) opens it, a
/// tap on nothing or `CLOSE_PANEL` closes it, construction mode ignores taps, it survives the
/// ghost-to-real swap, and it closes the moment the furnace is gone from the merged view (a predicted
/// pick-up included). Fails if `open` is keyed by entity id, or the gone-check reads the raw replica.
#[test]
fn panel_open_close_rules() {
    let (mut lb, idx, _who) = world(3, 1, 0);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    let mut client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);

    let (_, st) = lb.dispatch(idx, RefAction::PlaceFurnace { origin: at });
    assert_eq!(st, Prediction::Applied);
    let ghost = lb.entity_at(idx, origin).unwrap();
    assert!(ghost.is_provisional());
    client.apply_tap(
        &tap(TilePos::new(origin.x + 1, origin.y)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), Some(origin), "opened on the provisional id");
    assert_eq!(ui_of(&lb, idx, &client).furnace.map(|f| f.at), Some(at));

    // Across the ack the id changes, the panel does not.
    for step in 0..14 {
        lb.step();
        client.recheck_open(&lb.frame_view(idx, WIDE, TilePos::new(0, 0)));
        assert_eq!(client.open(), Some(origin), "step {step}");
        assert!(ui_of(&lb, idx, &client).furnace.is_some(), "step {step}");
    }
    assert!(
        !lb.entity_at(idx, origin).unwrap().is_provisional(),
        "swapped"
    );

    // Close by a tap on nothing, and by CLOSE_PANEL; reopen by a tap on the real id.
    client.apply_tap(
        &tap(TilePos::new(origin.x + 5, origin.y)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), None);
    client.apply_tap(
        &tap(TilePos::new(origin.x, origin.y + 1)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), Some(origin));
    client.apply_local(&local(content::local::CLOSE_PANEL, 0));
    assert_eq!(client.open(), None);
    assert_eq!(ui_of(&lb, idx, &client).furnace, None);

    // Construction mode: taps belong to placement.
    client.apply_local(&local(content::local::PLACE_MODE, 1));
    client.apply_tap(
        &tap(TilePos::new(origin.x, origin.y + 1)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), None, "ignored while placing");
    client.apply_local(&local(content::local::PLACE_MODE, 0));
    client.apply_tap(
        &tap(TilePos::new(origin.x, origin.y + 1)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), Some(origin));

    // A predicted pick-up hides the furnace from the merged view, so the panel closes at once, before
    // the host has heard of it.
    let (_, st) = lb.dispatch(idx, RefAction::FurnacePickUp { at });
    assert_eq!(st, Prediction::Applied);
    client.recheck_open(&lb.frame_view(idx, WIDE, TilePos::new(0, 0)));
    assert_eq!(client.open(), None, "tombstoned: gone");
}

/// A furnace keeps smelting while its chunk is unsubscribed, and the replica has the ingot on
/// return. The middle assertion is the one that can fail: the chunk really is not held then, and the
/// open panel stays open through `Unknown`.
#[test]
fn furnace_smelts_while_unsubscribed() {
    let (mut lb, idx, who) = world(3, 1, 1);
    let origin = free_spot(-8, 30);
    let at = TileXY::from_tile(origin);
    let wood_from = WorldXY {
        x: -3 * 256 - 128,
        y: -2 * 256,
    };
    lb.set_presence(
        idx,
        PlayerPresence {
            pos: [wood_from.x, wood_from.y],
            vel: [0, 0],
        },
    );
    lb.action(
        who,
        RefAction::StartCollect {
            tile: TileXY { x: -4, y: -2 },
            from: wood_from,
        },
    );
    lb.run(content::COLLECT.0 + 2);
    place_settled(&mut lb, idx, origin);
    for (item, count) in [(ItemId::Iron, 1), (ItemId::Wood, 1)] {
        dispatch_settled(
            &mut lb,
            idx,
            RefAction::FurnaceDeposit {
                at,
                item: item as u8,
                count,
            },
        )
        .expect("deposit accepted");
    }
    let mut client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    client.apply_tap(
        &tap(TilePos::new(origin.x + 1, origin.y + 1)),
        &lb.frame_view(idx, WIDE, TilePos::new(0, 0)),
    );
    assert_eq!(client.open(), Some(origin));
    let chunk = ChunkDims::new(RefGame::CHUNK_BITS).chunk_of(origin);
    assert!(lb.client(idx).view().is_held(chunk), "held to begin with");
    assert_eq!(seen_furnace(&lb, idx, origin).unwrap().ingots_out, 0);

    // Pan far away and wait for the chunk to leave the subscription (ring plus hold time).
    lb.set_camera(idx, camera(4000, 4000));
    let mut left = false;
    for _ in 0..600 {
        lb.step();
        if !lb.client(idx).view().is_held(chunk) {
            left = true;
            break;
        }
    }
    assert!(left, "the furnace's chunk left the subscription");
    // Unknown leaves the panel open.
    let far = lb.frame_view(
        idx,
        TileRect::new(TilePos::new(3990, 3990), TilePos::new(4010, 4010)),
        TilePos::new(0, 0),
    );
    client.recheck_open(&far);
    assert_eq!(client.open(), Some(origin), "Unknown leaves the panel open");
    // The host smelts on regardless.
    lb.run(SMELT + 20);
    assert_eq!(
        host_furnace(&lb, origin).unwrap().ingots_out,
        1,
        "smelted unwatched"
    );
    assert!(!lb.client(idx).view().is_held(chunk), "still unsubscribed");

    // Back: the resnapshot carries the ingot.
    lb.set_camera(idx, camera(10, 10));
    for _ in 0..200 {
        lb.step();
        if lb.client(idx).view().is_held(chunk) {
            break;
        }
    }
    lb.run(10);
    assert!(lb.client(idx).view().is_held(chunk), "held again");
    assert_eq!(
        seen_furnace(&lb, idx, origin).unwrap().ingots_out,
        1,
        "the ingot is there"
    );
    client.recheck_open(&lb.frame_view(idx, WIDE, TilePos::new(0, 0)));
    assert_eq!(client.open(), Some(origin));
    assert_eq!(ui_of(&lb, idx, &client).furnace.unwrap().ingots_out, 1);
}

/// R1 through the real client path: a furnace placed over the iron landmark (0, 0) is `Applied`
/// and confirmed; a `StartCollect` at the covered tile is declined locally (`Rejected`, nothing
/// sent to wait on) and the host agrees; after the pick-up the same collect is predicted and
/// confirmed with the tile's units intact.
#[test]
fn covered_resource_predicted_and_confirmed() {
    let (mut lb, idx, _who) = world(3, 1, 1);
    let origin = TilePos::new(0, -1); // covers (0,-1),(1,-1),(0,0),(1,0): the iron landmark at (0,0)
    let iron = TilePos::new(0, 0);
    let units_before = pristine(0, 0).aux().min(host_tile(&lb, iron).aux());
    let from = stand(&mut lb, idx);
    let collect_iron = RefAction::StartCollect {
        tile: TileXY::from_tile(iron),
        from,
    };

    let (seq, st) = lb.dispatch(
        idx,
        RefAction::PlaceFurnace {
            origin: TileXY::from_tile(origin),
        },
    );
    assert_eq!(
        st,
        Prediction::Applied,
        "placing over a resource is predicted"
    );
    for _ in 0..12 {
        lb.step();
        lb.client_mut(idx).drain_results(|_, _| {});
    }
    let _ = seq;
    assert!(
        host_furnace(&lb, origin).is_some(),
        "Confirmed: the host placed it"
    );

    let (_, st) = lb.dispatch(idx, collect_iron);
    assert_eq!(
        st,
        Prediction::Rejected(RefReject::NoResource),
        "predicted: covered, refused locally"
    );
    assert_eq!(
        dispatch_settled(&mut lb, idx, collect_iron),
        Err(RefReject::NoResource),
        "the host agrees"
    );
    assert_eq!(host_tile(&lb, iron).aux(), units_before, "units untouched");

    dispatch_settled(
        &mut lb,
        idx,
        RefAction::FurnacePickUp {
            at: TileXY::from_tile(origin),
        },
    )
    .expect("an empty furnace is picked up");
    let (_, st) = lb.dispatch(idx, collect_iron);
    assert_eq!(st, Prediction::Applied, "collectable again, predicted");
    lb.run(content::COLLECT.0 + 8);
    assert_eq!(
        host_tile(&lb, iron).aux(),
        units_before - 1,
        "one unit taken"
    );
}

fn host_tile(lb: &Loopback<RefGame>, at: TilePos) -> Tile {
    lb.host
        .sim()
        .expect("genesis ran")
        .authority()
        .tile(at)
        .expect("host reads are total")
}
