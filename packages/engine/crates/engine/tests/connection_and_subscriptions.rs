//! M15 (docs/plan/15-connection-and-subscriptions.md "Tests added"): `SubscriptionSet` is tested
//! inline (`host::subs`); this file is the native, byte-level `Loopback` proof end to end --
//! `Host::{connect, on_uplink, tick, build_frame, seal, region_hash}` into
//! `ClientCore::{on_frame, view, set_camera, poll_uplink, region_hash}`.

use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, Footprint, PristineSource, PrototypeId, Registry, Tile,
    TilePos, TraitSet,
};
use engine::worldgen::Worldgen;

// -- A small, real game (mirrors `fixtures/puts`'s own shape, native so this crate never depends
// on a fixture crate): `Paint` (chunk-scoped tile put), `Spawn`/`Move`/`Despawn` (chunk-scoped
// entity puts, `Move` exercising a cross-chunk anchor change), `SetNote` (player-scoped). --------

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
pub struct LPos {
    pub x: i32,
    pub y: i32,
}
impl LPos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub enum LAction {
    Paint {
        pos: LPos,
        base: u8,
    },
    Spawn {
        id_hint: u32,
        pos: LPos,
    },
    /// A 2x1-footprint entity (`PrototypeId(1)`, registered in `LGame::register`), used only by
    /// the footprint-straddling tests (docs/plan/21-entities-and-timers.md Deviations: M15's
    /// `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once` needed a real
    /// footprint to rewrite against). Every other test's `Spawn`/`Move` stays 1x1, unaffected.
    SpawnWide {
        id_hint: u32,
        pos: LPos,
    },
    Move {
        id: u32,
        pos: LPos,
    },
    Despawn {
        id: u32,
    },
    SetNote {
        n: u32,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub enum LReject {
    Unknown,
    NotFound,
}
impl From<Unknown> for LReject {
    fn from(_: Unknown) -> Self {
        LReject::Unknown
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct LEntity {
    pub pos: LPos,
    /// `0` = ordinary 1x1 entity (`PrototypeId(0)`); `1` = the 2x1 "wide" entity `SpawnWide`
    /// creates (`PrototypeId(1)`). See `LAction::SpawnWide`'s own doc comment.
    pub wide: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct LPlayer {
    pub note: u32,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct LGlobal {
    pub n: u32,
}

pub struct LWorldgen;
impl Worldgen for LWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

pub struct LGame;
impl Game for LGame {
    const SCHEMA_VERSION: u32 = 1;
    const CHUNK_BITS: u32 = 5; // edge 32, 0010's own worked numbers
    type Worldgen = LWorldgen;
    type Action = LAction;
    type Reject = LReject;
    type Entity = LEntity;
    type Player = LPlayer;
    type Global = LGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 }); // PrototypeId(0): ordinary
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 2, h: 1 }); // PrototypeId(1): wide
    }
    fn prototype(e: &LEntity) -> PrototypeId {
        if e.wide {
            PrototypeId(1)
        } else {
            PrototypeId(0)
        }
    }
    fn anchor(e: &LEntity) -> TilePos {
        e.pos.tile()
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(LGlobal::default());
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, LPlayer::default());
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &LAction) -> Result<(), LReject> {
        match a {
            LAction::Paint { pos, base } => {
                w.set_tile(pos.tile(), Tile::new(*base, 0, 0));
                Ok(())
            }
            LAction::Spawn { pos, .. } => {
                w.spawn(LEntity {
                    pos: *pos,
                    wide: false,
                });
                Ok(())
            }
            LAction::SpawnWide { pos, .. } => {
                w.spawn(LEntity {
                    pos: *pos,
                    wide: true,
                });
                Ok(())
            }
            LAction::Move { id, pos } => {
                w.put_entity(
                    engine::game::EntityId(*id),
                    LEntity {
                        pos: *pos,
                        wide: false,
                    },
                );
                Ok(())
            }
            LAction::Despawn { id } => {
                w.despawn(engine::game::EntityId(*id));
                Ok(())
            }
            LAction::SetNote { n } => {
                let mut p = *w.player(who)?;
                p.note = *n;
                w.put_player(who, p);
                Ok(())
            }
        }
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn dims() -> ChunkDims {
    ChunkDims::new(LGame::CHUNK_BITS)
}

struct FlatSource;
impl PristineSource for FlatSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

fn params(seed: u64) -> WorldParams<LGame> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<LGame> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<LGame>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(FlatSource),
        CacheCapacity::Chunks(1024),
    )
}

fn small_camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

// -- Tests -----------------------------------------------------------------------------------

#[test]
fn first_frame_has_global_and_own_player() {
    let mut lb = loopback(1);
    let (idx, who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    let summary = *lb.client(idx).last_summary();
    assert!(summary.chunk_enters_pristine > 0 || summary.chunk_snapshots > 0);
    assert_eq!(lb.client(idx).view().player(who), Ok(&LPlayer::default()));
    assert_eq!(lb.client(idx).view().global(), &LGlobal::default());
}

#[test]
fn pristine_chunk_enters_as_coord_only() {
    let mut lb = loopback(2);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    // Wilderness: every entered chunk this tick is pristine (no overlay, no entity).
    let c = ChunkCoord::new(0, 0);
    assert!(lb.client(idx).view().is_held(c));
    assert_eq!(
        lb.client(idx).view().tile(TilePos::new(1, 1)),
        Ok(Tile::new(1, 0, 0))
    );
}

#[test]
fn modified_chunk_enters_as_snapshot_then_deltas_from_next_tick() {
    let mut lb = loopback(3);
    let (idx, who) = add_client(&mut lb, 0);
    // Paint a tile in chunk (0,0) before the client ever subscribes.
    lb.action(
        who,
        LAction::Paint {
            pos: LPos { x: 2, y: 2 },
            base: 9,
        },
    );
    lb.step(); // tick 1: paint applied, no client subscribed yet
    lb.set_camera(idx, small_camera(0, 0));
    lb.step(); // tick 2: client subscribes, chunk (0,0) must arrive as a snapshot
    assert_eq!(
        lb.client(idx).view().tile(TilePos::new(2, 2)),
        Ok(Tile::new(9, 0, 0))
    );
    // A further paint in the same chunk arrives as a delta on the *next* tick.
    lb.action(
        who,
        LAction::Paint {
            pos: LPos { x: 3, y: 3 },
            base: 5,
        },
    );
    lb.step();
    assert_eq!(
        lb.client(idx).view().tile(TilePos::new(3, 3)),
        Ok(Tile::new(5, 0, 0))
    );
}

#[test]
fn leave_frees_overlay_keeps_pristine() {
    let mut lb = loopback(4);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    assert!(lb.client(idx).view().is_held(ChunkCoord::new(0, 0)));
    // Pan far enough, and wait past the hold time, to unsubscribe chunk (0,0).
    lb.set_camera(idx, small_camera(100_000, 0));
    let hold = LGame::TICK_RATE.secs(5).0;
    for _ in 0..(hold + 2) {
        lb.step();
    }
    assert!(!lb.client(idx).view().is_held(ChunkCoord::new(0, 0)));
    assert_eq!(
        lb.client(idx).view().tile(TilePos::new(1, 1)),
        Err(Unknown),
        "left chunk is Unknown, not stale data"
    );
}

/// 0011 Scopes, M21-widened (docs/plan/21-entities-and-timers.md Deviations: this test was
/// M12b/M14's own `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once`, written
/// against anchor-only delivery -- "straddling" meant only that an entity's *anchor* moved between
/// a subscribed and an unsubscribed chunk, since no wider footprint existed in that milestone's
/// entity model. Rewritten here to cover a real footprint straddling a subscribed chunk and an
/// unsubscribed one: `SpawnWide`'s 2x1 footprint is anchored on the boundary between chunk `(1,0)`
/// and chunk `(2,0)`, and the camera is set up so ring1 (`host::subs`) subscribes `(0,0)` and its
/// eight neighbours -- including `(1,0)` -- but not `(2,0)`, one ring farther out. The entity must
/// still be delivered once (through the subscribed half of its footprint), not `Unknown` and not
/// rejected for touching an unheld chunk.
#[test]
fn entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once() {
    let mut lb = loopback(5);
    let (idx, who) = add_client(&mut lb, 0);
    // Visible = exactly chunk (0,0) (camera well inside it, minimal half-extent): ring1 =
    // chunks -1..=1 on both axes, so (1,0) is subscribed and (2,0) is not.
    lb.set_camera(
        idx,
        CameraReport {
            center_x: 10,
            center_y: 10,
            half_w: 1,
            half_h: 1,
            vel_x: 0,
            vel_y: 0,
        },
    );
    lb.step();
    assert!(lb.client(idx).view().is_held(ChunkCoord::new(1, 0)));
    assert!(!lb.client(idx).view().is_held(ChunkCoord::new(2, 0)));

    // Anchor at local tile 31 of chunk (1,0): a 2-wide footprint covers world tile 63 (chunk
    // (1,0), subscribed) and world tile 64 (chunk (2,0), not subscribed).
    lb.action(
        who,
        LAction::SpawnWide {
            id_hint: 0,
            pos: LPos { x: 63, y: 0 },
        },
    );
    lb.step();
    let id = engine::game::EntityId(1);
    assert_eq!(
        lb.client(idx).view().entity(id),
        Ok(Some(&LEntity {
            pos: LPos { x: 63, y: 0 },
            wide: true,
        })),
        "an entity overlapping a subscribed chunk must be delivered even though the rest of its \
         footprint touches an unheld chunk"
    );
}

/// The anchor-move case M15 originally covered (kept per docs/plan/
/// 21-entities-and-timers.md Deviations, "keep an equivalent anchor-move case if one existed"): a
/// plain (1x1) entity whose *anchor* moves from a subscribed chunk to a far, unsubscribed one must
/// be seen leaving, exactly once.
#[test]
fn entity_move_between_subscribed_and_unsubscribed_delivered_once() {
    let mut lb = loopback(31);
    let (idx, who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    lb.action(
        who,
        LAction::Spawn {
            id_hint: 0,
            pos: LPos { x: 1, y: 1 },
        },
    );
    lb.step();
    let id = engine::game::EntityId(1);
    assert_eq!(
        lb.client(idx).view().entity(id),
        Ok(Some(&LEntity {
            pos: LPos { x: 1, y: 1 },
            wide: false,
        }))
    );
    // Move it far away, to an unsubscribed chunk: the client must see it go, exactly once.
    lb.action(
        who,
        LAction::Move {
            id: 1,
            pos: LPos { x: 100_000, y: 0 },
        },
    );
    lb.step();
    assert_eq!(lb.client(idx).view().entity(id), Ok(None));
}

#[test]
fn frame_is_atomic_on_malformed_tail() {
    let mut lb = loopback(6);
    let (idx, who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    let before = lb.client(idx).region_hash();
    let good = lb.last_built_frame(idx).to_vec();

    // Append-corrupted: a valid frame plus one trailing byte. `FrameReader::next_section` treats
    // any unconsumed tail as another section header, and 0xFF is not a valid `SectionId`, so this
    // is guaranteed malformed too (a different corruption *shape* than truncation: extra bytes,
    // not missing ones).
    let mut appended = good.clone();
    appended.push(0xFF);
    let result = lb.client_mut(idx).on_frame(&appended);
    assert!(
        result.is_err(),
        "a frame with a trailing garbage byte must be rejected"
    );
    assert_eq!(
        before,
        lb.client(idx).region_hash(),
        "a rejected append-corrupted frame must not mutate the replica"
    );

    // Truncated: guaranteed malformed (a partial header or a partial section body).
    let mut truncated = good.clone();
    truncated.truncate(good.len().saturating_sub(1).max(10));
    if truncated.len() < good.len() {
        let result = lb.client_mut(idx).on_frame(&truncated);
        assert!(result.is_err(), "a truncated frame must be rejected");
    }
    let after = lb.client(idx).region_hash();
    assert_eq!(
        before, after,
        "a rejected frame must not mutate the replica"
    );
    let _ = who;
}

#[test]
fn view_unknown_outside_subscription() {
    let mut lb = loopback(7);
    let (idx, _who) = add_client(&mut lb, 0);
    // Never send a camera report: nothing is subscribed.
    lb.step();
    assert_eq!(lb.client(idx).view().tile(TilePos::new(0, 0)), Err(Unknown));
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    assert!(lb.client(idx).view().tile(TilePos::new(0, 0)).is_ok());
    // Far outside the subscribed rect: still Unknown.
    assert_eq!(
        lb.client(idx).view().tile(TilePos::new(100_000, 0)),
        Err(Unknown)
    );
}

#[test]
fn idle_tick_builds_no_frame() {
    let mut lb = loopback(8);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step(); // first frame: non-empty
    // Nothing changes: camera unchanged, no actions, no game-tick mutation (`LGame::tick` is a
    // no-op).
    for _ in 0..10 {
        lb.step();
        assert_eq!(
            lb.last_build_frame_len(idx),
            0,
            "an idle tick must build nothing"
        );
    }
}

#[test]
fn replica_hash_equals_host_region_hash() {
    let mut lb = loopback(9);
    let mut rng = engine::rng::SimRng::new(0x00C0_FFEE);
    let (c0, p0) = add_client(&mut lb, 0);
    let (c1, p1) = add_client(&mut lb, 2);
    let (c2, p2) = add_client(&mut lb, 5);
    let clients = [c0, c1, c2];
    let players = [p0, p1, p2];
    for &c in &clients {
        lb.set_camera(c, small_camera(0, 0));
    }
    for t in 0..600u32 {
        // A seeded camera walk per client.
        for (i, &c) in clients.iter().enumerate() {
            if t % (7 + i as u32) == 0 {
                let dx = (rng.below(9) as i32) - 4;
                let dy = (rng.below(9) as i32) - 4;
                let vx = (rng.below(3) as i16) - 1;
                let vy = (rng.below(3) as i16) - 1;
                lb.set_camera(
                    c,
                    CameraReport {
                        center_x: dx * 8,
                        center_y: dy * 8,
                        half_w: 20,
                        half_h: 20,
                        vel_x: vx,
                        vel_y: vy,
                    },
                );
            }
            if t % 13 == i as u32 {
                lb.action(
                    players[i],
                    LAction::Paint {
                        pos: LPos {
                            x: (rng.below(20) as i32) - 10,
                            y: (rng.below(20) as i32) - 10,
                        },
                        base: (rng.below(200)) as u8,
                    },
                );
            }
        }
        lb.step();
    }
    // Drain every remaining in-flight frame (the largest delay is 5 ticks).
    for _ in 0..10 {
        lb.step();
    }
    for (i, &c) in clients.iter().enumerate() {
        let host_hash = lb.host.region_hash(lb.conn(c));
        let client_hash = lb.client(c).region_hash();
        assert_eq!(host_hash, client_hash, "client {i} region_hash mismatch");
    }
}

#[test]
fn camera_walk_changes_no_state() {
    let run = |with_camera: bool| {
        let mut lb = loopback(11);
        let (idx, who) = add_client(&mut lb, 0);
        let mut hashes = Vec::new();
        for t in 0..50u32 {
            if with_camera {
                lb.set_camera(idx, small_camera((t as i32) % 7, (t as i32) % 5));
            }
            if t % 5 == 0 {
                lb.action(
                    who,
                    LAction::Paint {
                        pos: LPos { x: t as i32, y: 0 },
                        base: 3,
                    },
                );
            }
            lb.step();
            hashes.push(lb.host.sim().unwrap().state_hash());
        }
        hashes
    };
    assert_eq!(run(true), run(false));
}

#[test]
fn uplink_at_most_one_batch_per_interval() {
    let mut lb = loopback(12);
    let (idx, _who) = add_client(&mut lb, 0);
    let core = lb.client_mut(idx);
    core.set_camera(small_camera(1, 1), 0);
    let mut buf = [0u8; 256];
    let n0 = core.poll_uplink(0, &mut buf);
    assert!(n0 > 0, "first poll sends");
    core.set_camera(small_camera(2, 2), 10);
    let n1 = core.poll_uplink(10, &mut buf);
    assert_eq!(n1, 0, "10ms after the first send is inside the 50ms floor");
    let n2 = core.poll_uplink(49, &mut buf);
    assert_eq!(n2, 0);
    let n3 = core.poll_uplink(50, &mut buf);
    assert!(
        n3 > 0,
        "50ms after the first send, the pending change goes out"
    );
}

#[test]
fn uplink_keepalive_batch_every_1s() {
    let mut lb = loopback(13);
    let (idx, _who) = add_client(&mut lb, 0);
    let core = lb.client_mut(idx);
    let mut buf = [0u8; 256];
    let mut t = 0u32;
    let n0 = core.poll_uplink(t, &mut buf);
    assert!(n0 > 0);
    let mut sends = 0;
    for _ in 0..3 {
        t += 1000;
        loop {
            let n = core.poll_uplink(t, &mut buf);
            if n > 0 {
                sends += 1;
                break;
            }
            t += 50;
        }
    }
    assert_eq!(sends, 3, "exactly one keepalive batch per second");
}

#[test]
fn camera_report_on_change_leading_and_trailing() {
    let mut lb = loopback(14);
    let (idx, _who) = add_client(&mut lb, 0);
    let core = lb.client_mut(idx);
    let mut buf = [0u8; 256];
    let at_rest = CameraReport {
        center_x: 0,
        center_y: 0,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    };
    core.set_camera(at_rest, 0);
    let n0 = core.poll_uplink(0, &mut buf);
    assert!(n0 > 0, "leading: first report sends at once");

    // No change: nothing new to send before the keepalive deadline.
    core.set_camera(at_rest, 60);
    let n1 = core.poll_uplink(60, &mut buf);
    assert_eq!(
        n1, 0,
        "unchanged report below the keepalive interval sends nothing"
    );

    // Motion starts.
    let moving = CameraReport {
        vel_x: 5,
        ..at_rest
    };
    core.set_camera(moving, 100);
    let n2 = core.poll_uplink(100, &mut buf);
    assert!(n2 > 0, "leading edge: motion starting sends at once");

    // Coming to rest: one final report with zero velocity.
    core.set_camera(at_rest, 150);
    let n3 = core.poll_uplink(150, &mut buf);
    assert!(n3 > 0, "trailing: coming to rest sends one final report");

    let n4 = core.poll_uplink(160, &mut buf);
    assert_eq!(n4, 0, "no further sends once at rest and unchanged");
}

#[test]
fn budgets_join_wilderness_and_modified() {
    use engine::testing::budgets::expect_within_budget;

    let mut lb = loopback(20);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    expect_within_budget(
        "counters.subscription.joinWildernessBytesDown",
        lb.last_build_frame_len(idx) as u64,
    );

    let mut lb2 = loopback(21);
    let (idx2, who2) = add_client(&mut lb2, 0);
    for i in 0..5i32 {
        lb2.action(
            who2,
            LAction::Paint {
                pos: LPos { x: i, y: i },
                base: 7,
            },
        );
    }
    lb2.step();
    lb2.set_camera(idx2, small_camera(0, 0));
    lb2.step();
    expect_within_budget(
        "counters.subscription.joinModifiedBytesDown",
        lb2.last_build_frame_len(idx2) as u64,
    );
}

/// Exact wilderness-join frame bytes (Tests added). Pinned so a change to header/section framing,
/// coordinate coding, or the join scenario itself is a reviewed diff, not a silent drift --
/// `pnpm golden:bytes` is the only writer.
#[test]
fn golden_frame_bytes_join_wilderness() {
    let mut lb = loopback(20);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step();
    engine::assert_golden_bytes!("join_wilderness_frame", lb.last_built_frame(idx));
}

/// Deviations #1: `chunksWarmed` was structurally unreachable since M13 (nothing ever called
/// `host::warm::set_view`). `build_frame` now pushes the connection's subscribed view rect into it
/// on every call, so the between-tick warmer has something real to generate from.
#[test]
fn chunks_warmed_becomes_live() {
    use engine::abi::Instance;
    let mut lb = loopback(22);
    let (idx, _who) = add_client(&mut lb, 0);
    lb.set_camera(idx, small_camera(0, 0));
    lb.step(); // build_frame runs once: `Warm::set_view` now has a real rect for conn 0
    let mut warmed = 0u32;
    // `sim_warm_one` is `Instance`'s own ABI-facing method; calling it directly natively (no ABI
    // plumbing) still exercises the exact same `Host::warm` state `build_frame` just fed.
    for _ in 0..64 {
        warmed += lb.host.sim_warm_one();
    }
    assert!(
        warmed > 0,
        "chunksWarmed must be reachable once a real subscribed view has been pushed"
    );
}

/// Measurement, not an assertion (docs/plan/15-connection-and-subscriptions.md Planning
/// decisions: "flag this as a known cost to measure... not a defect to fix blind"):
/// `encode_chunk_snapshot`'s O(all entities in Store), twice, per chunk (M14 Deviations) under a
/// realistic many-chunk join. 2,000 entities spread across a 121-chunk view (0010's own worked
/// "ring1 is 11x11=121" at the view clamp), one fresh connection joining at once.
#[test]
fn measure_join_cost_many_chunks_many_entities() {
    let mut lb = loopback(30);
    let (idx, who) = add_client(&mut lb, 0);
    // Spread 2000 entities across a wide area so they land throughout the 121-chunk view.
    for i in 0..2000i32 {
        lb.action(
            who,
            LAction::Spawn {
                id_hint: 0,
                pos: LPos {
                    x: (i * 37) % 320 - 160,
                    y: (i * 53) % 320 - 160,
                },
            },
        );
    }
    lb.step(); // apply every spawn; still no camera set for the connection

    // Wall-clock timing for a printed measurement only (never state, never hashed, never
    // replayed): the determinism ban on `Instant` (0002 §2) is about sim/apply code, not a
    // test's own stopwatch.
    #[allow(clippy::disallowed_types)]
    let start = std::time::Instant::now();
    lb.set_camera(idx, small_camera_wide());
    lb.step();
    let elapsed = start.elapsed();
    // Not a pass/fail budget (that is M31/M36's, Planning decisions: "flag ... not fix blind"):
    // just proves the join completes and prints the measured cost for the record.
    assert_eq!(lb.client(idx).view().held_count(), 121);
    eprintln!(
        "join_cost: {} chunks, {} bytes, {:?}",
        lb.client(idx).view().held_count(),
        lb.last_build_frame_len(idx),
        elapsed
    );
}

fn small_camera_wide() -> CameraReport {
    CameraReport {
        center_x: 0,
        center_y: 0,
        half_w: 128,
        half_h: 128,
        vel_x: 0,
        vel_y: 0,
    }
}
