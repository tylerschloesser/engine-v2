//! Ported from `spikes/prediction-api/game/tests/prediction.rs` (docs/plan/25-prediction-core.md
//! Tests added), driving `fx-predict`'s own `Place`/`Deposit`/`Collect` through the real
//! `Host<Predict>` <-> `ClientCore<Predict>` round trip (`Loopback`) instead of the spike's own
//! simplified harness. What each test would still pass without (the repo's own recurring-defect
//! guard, `.claude/rules/prediction.md`) is noted per test.

use engine::game::{EntityId, Game, PlayerId, WorldRead};
use engine::predict::Prediction;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos, TileRect,
};
use engine::worldgen::Worldgen;
use fx_predict::{
    Action, Machine, Player, Pos, Predict, PredictWorldgen, Reject, START_COAL, START_FURNACES,
};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        PredictWorldgen::generate(0, &(), chunk, out);
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(Predict::CHUNK_BITS)
}

fn params(seed: u64) -> WorldParams<Predict> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<Predict> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<Predict>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    )
}

/// A camera centred at `(cx, cy)` with a minimal half-extent: the *visible* rect is just the one
/// chunk `(cx, cy)` lies in, but the *subscription* set is that chunk's ring1 (`host::subs`), 3x3
/// chunks (fx-machines' own `camera_visible_only_chunk_0_0` comment).
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

const WIDE: TileRect = TileRect::new(TilePos::new(0, 0), TilePos::new(11, 11));

fn tile_rect(p: TilePos) -> TileRect {
    TileRect::new(p, p)
}

/// The occupant at `p` through client `i`'s prediction-merged view, by value (ids are compared
/// separately, `Loopback::entity_at`).
fn furnace_at(lb: &Loopback<Predict>, i: usize, p: Pos) -> Option<Machine> {
    lb.visible(i, tile_rect(p.tile())).cells[0].2
}

/// This client's own predicted player state (overlay-then-replica, unlike `ClientCore::view()`
/// alone, which never sees an overlaid `put_player`).
fn my_state(lb: &Loopback<Predict>, i: usize) -> Player {
    lb.visible(i, tile_rect(TilePos::new(0, 0)))
        .me
        .expect("own player state replicated")
}

/// **Placement is immediate, and converges with no visible change** (spike:
/// `predicted_placement_is_immediate_and_converges_with_no_visible_change`). Without the overlay
/// merge this would still show `Applied`, but the ghost would never appear in `visible()` and
/// `entity_at` would never report a provisional id -- both asserted below, not implied.
#[test]
fn predict_placement_is_immediate_and_converges() {
    let mut lb = loopback(1);
    let (idx, _who) = add_client(&mut lb, 3);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };
    let before = lb.visible(idx, WIDE);

    let (seq, st) = lb.dispatch(idx, Action::Place { origin });
    assert_eq!(st, Prediction::Applied);
    let predicted = lb.visible(idx, WIDE);
    assert_ne!(
        predicted, before,
        "shows immediately, before any network traffic"
    );
    assert_eq!(
        furnace_at(&lb, idx, origin),
        Some(Machine { origin, coal: 0 })
    );
    assert_eq!(my_state(&lb, idx).furnaces, START_FURNACES - 1);
    let ghost_id = lb
        .entity_at(idx, origin.tile())
        .expect("predicted occupant");
    assert!(ghost_id.is_provisional());
    assert!(
        lb.host
            .sim()
            .unwrap()
            .authority()
            .entity_at(origin.tile())
            .unwrap()
            .is_none(),
        "host has not heard of it yet"
    );

    let mut confirmed = false;
    for step in 0..12 {
        lb.step();
        assert_eq!(
            lb.visible(idx, WIDE),
            predicted,
            "visible change at step {step}"
        );
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq && r.is_ok() {
                confirmed = true;
            }
        });
        if lb.pending(idx).count() == 0 {
            break;
        }
    }
    assert!(confirmed);
    assert_eq!(lb.pending(idx).count(), 0);
    assert_eq!(
        lb.overlay_len(idx),
        0,
        "overlay is empty: the view is now purely authoritative"
    );
    let real_id = lb.entity_at(idx, origin.tile()).expect("now authoritative");
    assert!(!real_id.is_provisional());
}

/// **A rival's real placement rolls the local prediction back cleanly** (spike:
/// `rejected_because_another_player_took_the_spot_rolls_back_cleanly`): never a torn frame (ghost
/// XOR refunded item). Without the mark/rollback-to-mark truncation this would still decline, but
/// leave a half-spent inventory or a dangling ghost -- the per-step invariant below is what catches
/// that, not the final state alone.
#[test]
fn predict_rival_takes_the_spot_never_torn() {
    let mut lb = loopback(2);
    let (slow, _who_slow) = add_client(&mut lb, 4);
    let (_fast, who_fast) = add_client(&mut lb, 1);
    lb.set_camera(slow, camera(10, 10));
    lb.set_camera(_fast, camera(10, 10));
    lb.run(4);

    // The rival's placement is admitted for real before `slow` ever predicts its own (bypassing
    // `slow`'s own prediction is not the point of this test).
    lb.action(
        who_fast,
        Action::Place {
            origin: Pos { x: 6, y: 6 },
        },
    );
    lb.step();

    let before = my_state(&lb, slow);
    let mine_origin = Pos { x: 5, y: 5 };
    let (seq, st) = lb.dispatch(
        slow,
        Action::Place {
            origin: mine_origin,
        },
    );
    assert_eq!(
        st,
        Prediction::Applied,
        "slow has not yet heard about the rival's real machine"
    );

    let mut rejected = false;
    for _ in 0..14 {
        lb.step();
        let inv = my_state(&lb, slow).furnaces;
        let mine = furnace_at(&lb, slow, mine_origin).is_some();
        assert!(
            (mine && inv == START_FURNACES - 1) || (!mine && inv == START_FURNACES),
            "torn rollback: mine={mine} inv={inv}"
        );
        lb.client_mut(slow).drain_results(|s, r| {
            if s == seq && r.is_err() {
                rejected = true;
            }
        });
    }
    assert!(rejected);
    let after = my_state(&lb, slow);
    assert_eq!(after, before, "inventory fully restored");
    assert_eq!(furnace_at(&lb, slow, mine_origin), None);
    assert_eq!(
        furnace_at(&lb, slow, Pos { x: 6, y: 6 }).map(|m| m.origin),
        Some(Pos { x: 6, y: 6 })
    );
    assert_eq!(lb.overlay_len(slow), 0);
}

/// **The third placement depends on the first two still-pending ones having spent the item**
/// (spike: `insufficient_inventory_is_rejected_locally_and_by_the_host`): overlay writes from
/// earlier pending actions are visible to a later one predicted the same frame. Without replaying
/// every still-pending action against the *same* overlay (rather than each against a fresh one)
/// this would predict `Applied` locally and only fail once the host's own reject arrives.
#[test]
fn predict_insufficient_inventory_with_pending_spend() {
    let mut lb = loopback(3);
    let (idx, _who) = add_client(&mut lb, 2);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    assert_eq!(
        lb.dispatch(
            idx,
            Action::Place {
                origin: Pos { x: 0, y: 0 }
            }
        )
        .1,
        Prediction::Applied
    );
    assert_eq!(
        lb.dispatch(
            idx,
            Action::Place {
                origin: Pos { x: 3, y: 0 }
            }
        )
        .1,
        Prediction::Applied
    );
    let (seq3, st) = lb.dispatch(
        idx,
        Action::Place {
            origin: Pos { x: 6, y: 0 },
        },
    );
    assert_eq!(st, Prediction::Rejected(Reject::NoItem));
    assert_eq!(
        furnace_at(&lb, idx, Pos { x: 6, y: 0 }),
        None,
        "no ghost for a locally rejected action"
    );
    let shown = lb.visible(idx, TileRect::new(TilePos::new(0, 0), TilePos::new(11, 3)));

    let mut reasons = Vec::new();
    for _ in 0..8 {
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq3 {
                reasons.push(r.is_err());
            }
        });
    }
    assert_eq!(reasons, vec![true], "host agrees, via the same handler");
    assert_eq!(
        lb.visible(idx, TileRect::new(TilePos::new(0, 0), TilePos::new(11, 3))),
        shown
    );
}

/// A 2x2 footprint anchored at world tile (63, 5): covers chunks (1,0) and (2,0) only. A camera
/// centred in chunk (0,0) subscribes chunk (1,0) (ring1) but not chunk (2,0) (fx-machines' own
/// `BORDER_ORIGIN`, same worldgen shape).
const BORDER_ORIGIN: Pos = Pos { x: 63, y: 5 };

/// **An action spanning the subscription edge is not predicted, but still resolves** (spike:
/// `action_touching_an_unsubscribed_chunk_is_not_predicted_but_still_resolves`). Without the
/// `Unknown`-triggered rollback this would leave a partial ghost or a partial inventory spend; the
/// mid-test assertions catch that, not just the final `NotPredictable` status.
#[test]
fn predict_edge_action_declines_but_resolves() {
    let mut lb = loopback(4);
    let (idx, _who) = add_client(&mut lb, 2);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    // Entirely inside the subscription: predicted.
    assert_eq!(
        lb.dispatch(
            idx,
            Action::Place {
                origin: Pos { x: 2, y: 2 }
            }
        )
        .1,
        Prediction::Applied
    );

    let watch = TileRect::new(TilePos::new(60, 3), TilePos::new(65, 8));
    let before = lb.visible(idx, watch);
    let (seq, st) = lb.dispatch(
        idx,
        Action::Place {
            origin: BORDER_ORIGIN,
        },
    );
    assert_eq!(st, Prediction::NotPredictable);
    assert_eq!(lb.visible(idx, watch), before, "no partial ghost");
    assert_eq!(
        my_state(&lb, idx).furnaces,
        START_FURNACES - 1,
        "no partial inventory spend"
    );
    assert_eq!(
        lb.pending(idx).count(),
        2,
        "still sent, still tracked: UI can show 'pending'"
    );

    let mut confirmed = false;
    for _ in 0..8 {
        lb.step();
        lb.client_mut(idx).drain_results(|s, r| {
            if s == seq && r.is_ok() {
                confirmed = true;
            }
        });
    }
    assert!(confirmed, "the host has the full world and accepts it");
    assert_eq!(
        furnace_at(&lb, idx, BORDER_ORIGIN).map(|m| m.origin),
        Some(BORDER_ORIGIN)
    );

    // Subscribing chunk (2,0) too (camera now centred in chunk (1,0), ring1 reaches (2,0)): the
    // second tile of the same footprint becomes predictable.
    lb.set_camera(idx, camera(48, 5));
    lb.run(4);
    assert_eq!(
        lb.dispatch(
            idx,
            Action::Deposit {
                at: Pos { x: 64, y: 6 },
                count: 1
            }
        )
        .1,
        Prediction::Applied
    );
}

/// **Two pending actions that depend on each other replay correctly across the first's own ack**
/// (spike: `two_pending_actions_that_depend_on_each_other_replay_correctly`): `Deposit` addresses
/// the machine by tile while it is still only a prediction, and keeps working once it becomes
/// authoritative mid-replay. Without tile addressing (0022 §6) this could not even be attempted
/// before the ack; without re-predicting *every* still-pending action every frame (not just new
/// ones) the deposit would stop applying the instant `Place` is acked and the id changes under it.
#[test]
fn predict_dependent_actions_replay_across_ack() {
    let mut lb = loopback(5);
    let (idx, _who) = add_client(&mut lb, 3);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };
    assert_eq!(
        lb.dispatch(idx, Action::Place { origin }).1,
        Prediction::Applied
    );
    lb.step(); // stagger so the two acks arrive in different frames
    let at = Pos { x: 6, y: 6 };
    assert_eq!(
        lb.dispatch(idx, Action::Deposit { at, count: 3 }).1,
        Prediction::Applied
    );
    let shown = lb.visible(idx, WIDE);
    assert_eq!(furnace_at(&lb, idx, at), Some(Machine { origin, coal: 3 }));
    assert_eq!(my_state(&lb, idx).coal, START_COAL - 3);

    let mut pendings = Vec::new();
    for _ in 0..10 {
        lb.step();
        pendings.push(lb.pending(idx).count());
        assert_eq!(
            lb.visible(idx, WIDE),
            shown,
            "visible change while replaying"
        );
        assert!(lb.pending(idx).all(|p| p.status == Prediction::Applied));
    }
    assert!(
        pendings.contains(&1),
        "a frame with only the dependent action pending: {pendings:?}"
    );
    assert_eq!(*pendings.last().unwrap(), 0);
}

/// **The predicted tick is frozen per pending action, not re-estimated on replay** (0012 "Frozen
/// predicted tick"). A second, unrelated client keeps sending `SetGlobal` every tick throughout
/// (`who_noise`) purely so *some* non-empty frame keeps arriving for our own client every tick
/// (0011: no delta means no bytes, and an all-empty-frame window would make live and frozen ticks
/// indistinguishable by accident, not by this property) -- without it, this test could still pass
/// with `Predicting::tick` wired to the live replica tick instead of the frozen one, exactly the
/// failure mode this proof exists to catch. Inject-fail-revert: in
/// `crates/engine/src/predict/predicting.rs`, change `Predicting::tick`'s body from `self.tick` to
/// `self.base.tick()` -- `started_at`/`done_at` then grow by one every replay instead of staying
/// put (`left: Some(Collecting { ..., started_at: 1 ... }), right: Some(Collecting { ...,
/// started_at: 2, ... })`, confirmed by hand); reverted.
#[test]
fn predict_frozen_predicted_tick() {
    let mut lb = loopback(6);
    let (idx, _who) = add_client(&mut lb, 3);
    let (_noise, who_noise) = add_client(&mut lb, 0);
    lb.set_camera(idx, camera(10, 10));
    for i in 0..4 {
        lb.action(who_noise, Action::SetGlobal { value: i });
        lb.step();
    }

    let tile = Pos { x: 9, y: 9 }; // inside the COLLECTABLE patch (8..12 x 8..12)
    let (_seq, st) = lb.dispatch(idx, Action::Collect { tile });
    assert_eq!(st, Prediction::Applied);
    let predicted = my_state(&lb, idx).collecting.expect("predicted collection");

    let mut saw_pending = false;
    for i in 4..14 {
        if lb.pending(idx).count() == 0 {
            break;
        }
        lb.action(who_noise, Action::SetGlobal { value: i });
        lb.step();
        if lb.pending(idx).count() == 0 {
            break; // acked this step; the replica now shows the host's own (unfrozen) value
        }
        saw_pending = true;
        let now = my_state(&lb, idx).collecting;
        assert_eq!(
            now,
            Some(predicted),
            "predicted_tick must not drift across replays"
        );
    }
    assert!(
        saw_pending,
        "the action must still be pending for at least one replay to prove anything"
    );
}

/// **A provisional id is stable across replays** (0022 §5: "identical on every reset-and-replay").
/// `EntityId::provisional(seq, index)` is a pure function of the two, and `spawned` (this
/// `Predicting`'s own per-replay spawn counter) restarts at 0 every replay in the same handler
/// order, so this would already hold with no extra bookkeeping -- the assertion is what actually
/// pins it, not an inference from the implementation.
#[test]
fn predict_provisional_id_stable_across_replays() {
    let mut lb = loopback(7);
    let (idx, _who) = add_client(&mut lb, 3);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };
    assert_eq!(
        lb.dispatch(idx, Action::Place { origin }).1,
        Prediction::Applied
    );
    let id0 = lb
        .entity_at(idx, origin.tile())
        .expect("predicted occupant");
    assert!(id0.is_provisional());

    for _ in 0..3 {
        lb.step();
        if lb.pending(idx).count() == 0 {
            break; // acked already: no longer a replay to compare against
        }
        let id_n = lb
            .entity_at(idx, origin.tile())
            .expect("still predicted, still provisional");
        assert_eq!(id_n, id0, "same provisional id every replay");
    }
}

/// The 0022 §5 layout is exercised end to end here too: a real, ordinary dispatch's provisional id
/// is never the placeholder value `EntityId(EntityId::PROVISIONAL_BIT)` a 513th-spawn overflow
/// would fall back to (`predicting.rs`'s own `spawn`) -- a cheap sanity check that this fixture's
/// single-spawn actions never trip that path by accident.
#[test]
fn predict_provisional_id_is_not_the_overflow_placeholder() {
    let mut lb = loopback(8);
    let (idx, _who) = add_client(&mut lb, 2);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };
    lb.dispatch(idx, Action::Place { origin });
    let id = lb
        .entity_at(idx, origin.tile())
        .expect("predicted occupant");
    assert_ne!(id, EntityId(EntityId::PROVISIONAL_BIT));
}
