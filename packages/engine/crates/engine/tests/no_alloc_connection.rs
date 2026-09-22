//! Own test binary (mirrors `no_alloc_terrain.rs`/`no_alloc_authority.rs`: only a dedicated
//! binary's global allocator is actually counted). Two measured workloads:
//!
//! `host_and_client_steady_state_no_alloc`: once a connection's subscription has settled (no chunk
//! enters/leaves that tick), a steady stream of tile writes and entity moves inside the held view
//! -- `Host::tick`, `Host::build_frame`'s `ChunkDeltas` routing, `Host::seal`,
//! `ClientCore::on_frame`'s decode-twice-then-apply, `ClientCore::poll_uplink`, and
//! `Replica::apply_tile_delta`/`apply_entity_put` -- allocate zero bytes. Does not cover
//! `ChunkEnterPristine`/`ChunkSnapshots`/`ChunkLeaves`, `Global`/`OwnPlayer` changes, or
//! `EntityGone`: none of those fire with a fixed camera. **`host_and_client_panning_no_alloc`**
//! covers exactly that gap (M15 fix round 1) with a continuously panning camera, and **does not
//! pass**: it measures a real, reproducible allocation of **90.72 B/tick** (27,216 B over the
//! 300-tick measured window, exact and deterministic given the fixed seeds) in
//! `TerrainStore::replace_overlay` (`Overlays`' `BTreeMap<u64, ChunkOverlay>` allocating a new
//! B-tree node for a chunk key it has never held before -- `~48 B/call`, `world/overlay.rs`, via
//! `Store::terrain_mut`) and in `Replica::held`'s own `BTreeMap<ChunkCoord, u32>::insert` for the
//! same reason (`~144 B/call`, `client/replica.rs`). Both are genuinely new B-tree keys every call
//! here because this workload pans forever in one direction, discovering territory the replica has
//! never held before, tick after tick -- `.claude/rules/hot-paths.md` already names exactly this
//! shape as the accepted exception for `world/cache.rs`'s overlay growth ("overlay growth (writes,
//! world state) is the one allowed exception"); `Replica::held`'s own growth is the same *kind* of
//! thing (subscription-state growth, not per-frame garbage) but is not literally covered by that
//! sentence, which names only `TerrainStore`. **Left failing on purpose** (docs/plan/
//! 15-connection-and-subscriptions.md Deviations, and the coordinator's own fix-round instruction:
//! "do not make it pass ... report ... and stop there" -- accepting or budgeting this is not this
//! milestone's decision). Three inject-fail-revert sensitivity proofs (8 B/call injected, then
//! reverted, confirming the *other* new paths are genuinely measured despite the test already
//! failing) are in the Deviations doc, not repeated here.
//!
//! Both tests drive `Host`/`ClientCore` directly, not `testing::testkit::Loopback` (`Loopback::step`
//! itself allocates a fresh `Vec<u8>` per client per call, by design -- a test-only convenience,
//! never claimed allocation-free).

use engine::abi::Arena;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::host::Host;
use engine::sim::WorldParams;
use engine::wire::{CameraReport, UplinkWriter};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
struct NPos {
    x: i32,
    y: i32,
}
impl NPos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum NAction {
    Paint { pos: NPos, base: u8 },
    Spawn { pos: NPos },
    Move { id: u32, pos: NPos },
    Despawn { id: u32 },
    SetGlobal { n: u32 },
    SetPlayer { n: u32 },
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NReject;
impl From<Unknown> for NReject {
    fn from(_: Unknown) -> Self {
        NReject
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NEntity {
    pos: NPos,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NPlayer {
    n: u32,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NGlobal {
    n: u32,
}

struct NWorldgen;
impl Worldgen for NWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

struct NGame;
impl Game for NGame {
    const SCHEMA_VERSION: u32 = 1;
    const CHUNK_BITS: u32 = 5;
    type Worldgen = NWorldgen;
    type Action = NAction;
    type Reject = NReject;
    type Entity = NEntity;
    type Player = NPlayer;
    type Global = NGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &NEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &NEntity) -> TilePos {
        e.pos.tile()
    }
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(NGlobal::default());
    }
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, NPlayer::default());
        }
    }
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &NAction) -> Result<(), NReject> {
        match a {
            NAction::Paint { pos, base } => {
                w.set_tile(pos.tile(), Tile::new(*base, 0, 0));
                Ok(())
            }
            NAction::Spawn { pos } => {
                w.spawn(NEntity { pos: *pos });
                Ok(())
            }
            NAction::Move { id, pos } => {
                w.put_entity(EntityId(*id), NEntity { pos: *pos });
                Ok(())
            }
            NAction::Despawn { id } => {
                w.despawn(EntityId(*id));
                Ok(())
            }
            NAction::SetGlobal { n } => {
                w.put_global(NGlobal { n: *n });
                Ok(())
            }
            NAction::SetPlayer { n } => {
                w.put_player(who, NPlayer { n: *n });
                Ok(())
            }
        }
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

struct FlatSource;
impl PristineSource for FlatSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

#[test]
fn host_and_client_steady_state_no_alloc() {
    use engine::client::{ClientCore, Replica};

    let mut host = Host::<NGame>::genesis_for_test(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    });
    let player = host.connect(0);
    let mut client = ClientCore::new(Replica::<NGame>::new(
        ChunkDims::new(NGame::CHUNK_BITS),
        Box::new(FlatSource),
        CacheCapacity::Chunks(256),
        player,
    ));

    let mut s = Scratch {
        frame_buf: [0u8; 16384],
        uplink_buf: [0u8; 256],
        seq: 0,
        t_ms: 0,
    };

    // Warm-up: connect, subscribe, spawn one entity, let the join burst (pristine/snapshot enters)
    // fully settle. None of this is measured.
    let camera = CameraReport {
        center_x: 0,
        center_y: 0,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    };
    {
        let mut sink = engine::bytes::SliceSink::new(&mut s.uplink_buf);
        UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(camera), None);
        let n = sink.finish().unwrap();
        host.on_uplink(0, &s.uplink_buf[..n]);
    }
    s.seq += 1;
    host.queue_action_for_test(
        player,
        s.seq,
        NAction::Spawn {
            pos: NPos { x: 0, y: 0 },
        },
    );
    for _ in 0..5 {
        host.tick();
        let n = host.build_frame(0, &mut s.frame_buf);
        if n > 0 {
            client.on_frame(&s.frame_buf[..n]).unwrap();
        }
        host.seal();
    }

    // A second warm-up phase, running the *exact* steady workload below: every scratch buffer
    // this loop touches (`Host`'s tile/entity-op scratch, `Replica::dirty`, `ClientCore`'s own
    // decode scratch, ...) settles at its steady-state capacity within a handful of iterations of
    // first seeing this workload's shape, not necessarily within the join warm-up above (measured:
    // `live_bytes()` was still climbing past iteration 5 the first time this test was written --
    // that was a too-short warm-up, not a leak; see this file's own Deviations note). 40 iterations
    // is comfortably past where it was observed to stop climbing (by iteration ~10).
    for i in 0..40u32 {
        run_steady_tick(&mut host, player, &mut client, &mut s, i);
    }

    let before = live();
    for i in 0..300u32 {
        run_steady_tick(&mut host, player, &mut client, &mut s, i);
    }
    assert_eq!(
        live(),
        before,
        "steady-state host+client tick loop allocated"
    );
}

/// Scratch this test's per-tick loop reuses across calls, bundled so `run_steady_tick` takes one
/// argument for it instead of four.
struct Scratch {
    frame_buf: [u8; 16384],
    uplink_buf: [u8; 256],
    seq: u32,
    t_ms: u32,
}

/// One steady-state tick: a tile write and an entity move inside the already-held view, `Host`
/// then `ClientCore` all the way through (`ChunkDeltas` on both sides, never a chunk enter, leave
/// or snapshot), then `drain_dirty` and one `poll_uplink` poll (camera unchanged: almost always a
/// no-op send).
fn run_steady_tick(
    host: &mut Host<NGame>,
    player: PlayerId,
    client: &mut engine::client::ClientCore<NGame>,
    s: &mut Scratch,
    i: u32,
) {
    let base = (i % 200) as u8;
    s.seq += 1;
    host.queue_action_for_test(
        player,
        s.seq,
        NAction::Paint {
            pos: NPos { x: 1, y: 1 },
            base,
        },
    );
    s.seq += 1;
    host.queue_action_for_test(
        player,
        s.seq,
        NAction::Move {
            id: 1,
            pos: NPos {
                x: (i % 5) as i32 - 2,
                y: 0,
            },
        },
    );
    host.tick();
    let n = host.build_frame(0, &mut s.frame_buf);
    assert!(n > 0, "a tile + entity delta every tick must build a frame");
    client.on_frame(&s.frame_buf[..n]).unwrap();
    assert_eq!(
        client.last_summary().chunk_enters_pristine
            + client.last_summary().chunk_snapshots
            + client.last_summary().chunk_leaves,
        0,
        "steady state: no enter/leave/snapshot this tick"
    );
    host.seal();
    client.drain_dirty(|_| {});
    s.t_ms += 50;
    let _ = client.poll_uplink(s.t_ms, &mut s.uplink_buf);
}

/// Panning state `run_panning_tick` carries across calls (bundled for the same reason as
/// `Scratch`): the camera's current x, the next entity id to spawn (ids are the store's own
/// monotonic counter, so this must track it exactly -- only `Spawn` ever consumes one here), and
/// the id spawned last tick, due to be despawned this tick.
struct PanState {
    pan_x: i32,
    next_id: u32,
    pending_despawn: Option<u32>,
}

/// One panning tick: the camera moves one full chunk edge (32 tiles) in x, so a whole new column
/// enters `ring1` every tick and the trailing column becomes eligible to leave once past ring 3 and
/// the 5s hold (0010) -- in the steady state this reaches, both an enter and a leave happen on
/// essentially every tick. An entity is spawned at the new leading edge every tick (making that
/// one chunk of the new column a snapshot, not pristine) and the *previous* tick's entity is
/// despawned (its chunk is by now held and not entering, so this routes as a wire `EntityGone`,
/// `ClientCore`/`Replica`'s own path for it). A tile is painted ahead of the pan path every other
/// tick, so some future pristine columns arrive as snapshots too. `Global`/`OwnPlayer` change every
/// 50/70 ticks.
fn run_panning_tick(
    host: &mut Host<NGame>,
    player: PlayerId,
    client: &mut engine::client::ClientCore<NGame>,
    s: &mut Scratch,
    p: &mut PanState,
    i: u32,
) {
    p.pan_x += 32;
    let camera = CameraReport {
        center_x: p.pan_x,
        center_y: 0,
        half_w: 16,
        half_h: 16,
        vel_x: 32,
        vel_y: 0,
    };
    {
        let mut sink = engine::bytes::SliceSink::new(&mut s.uplink_buf);
        UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(camera), None);
        let n = sink.finish().unwrap();
        host.on_uplink(0, &s.uplink_buf[..n]);
    }

    if i % 2 == 0 {
        s.seq += 1;
        host.queue_action_for_test(
            player,
            s.seq,
            NAction::Paint {
                pos: NPos {
                    x: p.pan_x + 200,
                    y: 0,
                },
                base: (i % 250) as u8,
            },
        );
    }

    s.seq += 1;
    let id = p.next_id;
    p.next_id += 1;
    host.queue_action_for_test(
        player,
        s.seq,
        NAction::Spawn {
            pos: NPos { x: p.pan_x, y: 0 },
        },
    );
    if let Some(prev) = p.pending_despawn.take() {
        s.seq += 1;
        host.queue_action_for_test(player, s.seq, NAction::Despawn { id: prev });
    }
    p.pending_despawn = Some(id);

    if i % 50 == 0 {
        s.seq += 1;
        host.queue_action_for_test(player, s.seq, NAction::SetGlobal { n: i });
    }
    if i % 70 == 0 {
        s.seq += 1;
        host.queue_action_for_test(player, s.seq, NAction::SetPlayer { n: i });
    }

    host.tick();
    let n = host.build_frame(0, &mut s.frame_buf);
    if n > 0 {
        client.on_frame(&s.frame_buf[..n]).unwrap();
    }
    host.seal();
    client.drain_dirty(|_| {});
    s.t_ms += 50;
    let _ = client.poll_uplink(s.t_ms, &mut s.uplink_buf);
}

/// The gap `.claude/rules/hot-paths.md` names but `host_and_client_steady_state_no_alloc` cannot
/// prove: it holds the camera fixed, so `ChunkEnterPristine`/`ChunkSnapshots`/`ChunkLeaves`/
/// `EntityGone` and `Global`/`OwnPlayer` changes never fire in its measured window. A panning
/// camera makes those the *common* case, not a rare one, so this measures them for real instead of
/// leaving them an unproven claim -- and the measurement is negative: see this file's own module
/// doc comment for the exact allocating calls and bytes/tick. The assertion below is the real,
/// unweakened claim ("zero"), left failing rather than loosened to match what was measured.
#[test]
fn host_and_client_panning_no_alloc() {
    use engine::client::{ClientCore, Replica};

    let mut host = Host::<NGame>::genesis_for_test(WorldParams {
        seed: 2,
        worldgen: (),
        max_entities: 65536,
        max_modified_tiles: 65536,
        max_action_growth: 65536,
    });
    let player = host.connect(0);
    let mut client = ClientCore::new(Replica::<NGame>::new(
        ChunkDims::new(NGame::CHUNK_BITS),
        Box::new(FlatSource),
        CacheCapacity::Chunks(1024),
        player,
    ));
    let mut s = Scratch {
        frame_buf: [0u8; 16384],
        uplink_buf: [0u8; 256],
        seq: 0,
        t_ms: 0,
    };
    let mut p = PanState {
        pan_x: 0,
        next_id: 1,
        pending_despawn: None,
    };

    // Connect + join burst, unmeasured.
    for _ in 0..5 {
        host.tick();
        let n = host.build_frame(0, &mut s.frame_buf);
        if n > 0 {
            client.on_frame(&s.frame_buf[..n]).unwrap();
        }
        host.seal();
    }

    // Warm-up phase 1: run the panning body long enough to clear the hold time (5s = 100 ticks at
    // 20 Hz) so leaves actually start firing, reaching the steady state where enter and leave rates
    // match -- not just the join/pan-start transient.
    let hold = NGame::TICK_RATE.secs(5).0;
    for i in 0..(hold + 20) {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, i);
    }

    // Warm-up phase 2: the exact measured body again, so every scratch buffer this specific shape
    // touches settles at its own steady-state capacity before `before` is sampled (the same
    // discipline `host_and_client_steady_state_no_alloc` already needed).
    for i in 0..40u32 {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 1_000 + i);
    }

    let before = live();
    for i in 0..300u32 {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 2_000 + i);
    }
    let after = live();
    assert_eq!(
        after,
        before,
        "panning host+client tick loop allocated (bytes over 300 ticks: {})",
        after as i64 - before as i64
    );
}
