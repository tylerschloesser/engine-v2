//! Own test binary (mirrors `no_alloc_terrain.rs`/`no_alloc_authority.rs`: only a dedicated
//! binary's global allocator is actually counted). Three measured workloads, all driving the
//! connection path end to end:
//!
//! `host_and_client_steady_state_no_alloc`: once a connection's subscription has settled (no chunk
//! enters/leaves that tick), a steady stream of tile writes and entity moves inside the held view
//! -- `Host::tick`, `Host::build_frame`'s `ChunkDeltas` routing, `Host::seal`,
//! `ClientCore::on_frame`'s decode-twice-then-apply, `ClientCore::poll_uplink`, and
//! `Replica::apply_tile_delta`/`apply_entity_put` -- allocate zero bytes. Does not cover
//! `ChunkEnterPristine`/`ChunkSnapshots`/`ChunkLeaves`, `Global`/`OwnPlayer` changes, or
//! `EntityGone`: none of those fire with a fixed camera.
//!
//! `host_and_client_bounded_camera_no_alloc` covers exactly that gap and is **the zero-allocation
//! guarantee for this path**: a camera oscillating over a 16-chunk band makes chunk enters,
//! snapshots, leaves, `EntityGone` and `Global`/`OwnPlayer` changes the common case while the
//! territory stays finite, and asserts the measured growth is **equal at 300 and at 1,200 ticks**
//! -- so a reused buffer settling at its capacity is allowed (it costs the same in both windows)
//! and anything per-tick is not. There is no budget in it to widen.
//!
//! `host_and_client_panning_allocates_per_new_chunk_not_per_tick` measures the case that *does*
//! allocate: a camera panning forever reaches territory nobody has ever written to, and the host
//! keeps state for it. Its ceiling is per **newly reached chunk** (88 B; 83.32 B measured), never
//! per tick -- a per-tick ceiling would pass silently if the cost per chunk doubled while the pan
//! rate halved. The three terms, attributed with `live_bytes()` brackets in M15 fix round 3 (full
//! table in docs/plan/15-connection-and-subscriptions.md): `TerrainStore`'s overlay `BTreeMap` node
//! and the chunk's first `Vec<Entry>` (~112 B per chunk first written to -- `.claude/rules/
//! hot-paths.md`'s own named exception, "overlay growth (writes, world state) is the one allowed
//! exception"), and `Host::chunk_versions`' per-chunk version entry (~26 B per chunk ever touched
//! by a replicated change, retained for the host's lifetime -- accepted for M15 with that
//! measurement on record). Every byte is host-side: the client (`on_frame`, `drain_dirty`,
//! `poll_uplink`) and `Host::build_frame`/`seal`/`on_uplink` allocate **exactly zero**, at every
//! window length measured. Earlier rounds blamed `Replica::held::insert` and
//! `TerrainStore::replace_overlay` on the client; both do allocate, but the trailing-edge leave
//! frees the same bytes in the same tick, and `live_bytes()` is live bytes (allocated minus
//! freed), so their net contribution is 0.
//!
//! `host_terrain_queues_no_cache_events` pins the one term that was a real defect rather than
//! territory-proportional growth: the host's `TerrainStore` queued a `CacheEvent` per load and
//! evict for a consumer that does not exist in the sim role. Recording is opt-in now
//! (`TerrainStore::enable_cache_events`), so that queue stays empty here forever.
//!
//! Every test here drives `Host`/`ClientCore` directly, not `testing::testkit::Loopback` (`Loopback::step`
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
    /// +1 / -1: the direction the camera is currently moving in. Always +1 while `bounded` is
    /// false (the camera pans forever, reaching new territory every tick).
    dir: i32,
    /// True for the bounded-camera control: the camera turns around at the edges of a 16-chunk
    /// band instead of panning forever, so the world it touches is finite and *every* byte the
    /// tick loop still allocates is a per-tick allocation.
    bounded: bool,
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
    if p.bounded {
        if p.pan_x >= BAND_TILES {
            p.dir = -1;
        } else if p.pan_x <= 0 {
            p.dir = 1;
        }
        p.pan_x += 32 * p.dir;
    } else {
        p.pan_x += 32;
    }
    let camera = CameraReport {
        center_x: p.pan_x,
        center_y: 0,
        half_w: 16,
        half_h: 16,
        vel_x: (32 * p.dir) as i16,
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

/// One camera band for the bounded control: 16 chunks wide at `CHUNK_BITS = 5`.
const BAND_TILES: i32 = 512;

/// What one measured window of [`pan_run`] produced.
struct PanRun {
    /// `live_bytes()` growth over the measured window.
    bytes: i64,
    /// Chunks the host saw a replicated change in for the first time during the window -- the
    /// "newly reached chunks" the panning ceiling is expressed per.
    new_chunks: u64,
    /// Cache events the host's own `TerrainStore` had queued at the end of the window.
    host_queued_cache_events: usize,
}

/// Warm up a host + client to the panning workload's steady state, then measure `window` ticks of
/// it. `bounded` picks the control (camera oscillating over `BAND_TILES`, finite territory) over
/// the pan (camera advancing forever, one fresh chunk column per tick). Each call builds a fresh
/// `Host`/`ClientCore`, so two windows are two independent runs from the same warm-up, never a
/// short prefix of a long one.
fn pan_run(bounded: bool, window: u32) -> PanRun {
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
        dir: 1,
        bounded,
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
    // Warm-up phase 1: past the 5 s (100-tick) unsubscribe hold, so leaves fire at their steady
    // rate rather than the join/pan-start transient. Phase 2: 40 more iterations of the exact
    // measured body, so every scratch buffer this shape touches settles at its own steady-state
    // capacity before `before` is sampled.
    let hold = NGame::TICK_RATE.secs(5).0;
    for i in 0..(hold + 20) {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, i);
    }
    for i in 0..40u32 {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 1_000 + i);
    }

    let chunks_before = host.debug_chunk_version_count();
    let before = live();
    for i in 0..window {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 2_000 + i);
    }
    let bytes = live() as i64 - before as i64;
    let new_chunks = (host.debug_chunk_version_count() - chunks_before) as u64;
    let host_queued_cache_events = host
        .sim()
        .unwrap()
        .authority()
        .store()
        .terrain()
        .queued_cache_events();
    PanRun {
        bytes,
        new_chunks,
        host_queued_cache_events,
    }
}

/// **The zero-allocation guarantee for the connection path.** A camera that turns around inside a
/// 16-chunk band reaches no new territory, so a finite world is all this workload ever touches --
/// and then *any* byte that scales with the number of ticks is a per-tick allocation, which is
/// exactly what `.claude/rules/hot-paths.md` forbids. Measured over two window lengths and
/// asserted **equal**: a reused buffer reaching its steady-state capacity costs the same once at
/// 300 ticks as at 1,200, while anything allocating per tick, per frame or per chunk event costs
/// four times as much in the longer window. Asserting equality rather than "under N bytes" is what
/// keeps this from being a number that cannot fail -- there is no budget here to widen.
///
/// Unlike `host_and_client_steady_state_no_alloc` (fixed camera), this exercises the full set:
/// `ChunkEnterPristine`, `ChunkSnapshots`, `ChunkLeaves`, `EntityGone` and `Global`/`OwnPlayer`
/// changes all fire, on both sides of the wire.
#[test]
fn host_and_client_bounded_camera_no_alloc() {
    let short = pan_run(true, 300);
    let long = pan_run(true, 1_200);
    assert_eq!(
        long.bytes,
        short.bytes,
        "bounded-camera host+client tick loop allocates per tick: {} B over 300 ticks but {} B \
         over 1,200 ticks ({} B/tick of growth that the longer window alone paid for). Only \
         one-off buffer capacity steps may differ from zero here, and those cost the same in both \
         windows.",
        short.bytes,
        long.bytes,
        (long.bytes - short.bytes) as f64 / 900.0,
    );
}

/// The other half: a camera panning forever *does* allocate, and legitimately so -- it reaches
/// territory nobody has ever written to, and the host keeps state for it (`TerrainStore`'s overlay
/// map plus each newly written chunk's first `Vec<Entry>`, which is `.claude/rules/hot-paths.md`'s
/// own named exception, "overlay growth (writes, world state) is the one allowed exception", plus
/// `Host::chunk_versions`' per-chunk version). That growth is bounded by **territory**, not by
/// time, so the ceiling here is per newly reached chunk and never per tick: a per-tick ceiling
/// would pass silently if the cost per chunk doubled while the pan rate halved.
///
/// The number below is the sum of M15 fix round 3's measured unit costs, not a budget picked to
/// fit: ~48 B for a newly overlaid chunk's first `Vec<Entry>` (exact) plus ~64 B for its node in
/// `Overlays`' `BTreeMap`, which this workload pays on every second reached chunk (it paints one
/// tile every other tick), so ~56 B per reached chunk; plus ~26 B for the chunk's
/// `Host::chunk_versions` entry, paid on every reached chunk. ~82 B measured; 88 B here, the
/// headroom covering how full a B-tree node happens to be at a given window length (the measured
/// per-chunk cost of the two `BTreeMap` terms moves by ~1.5 B between 300- and 4,800-tick windows).
#[test]
fn host_and_client_panning_allocates_per_new_chunk_not_per_tick() {
    const CEILING_BYTES_PER_NEW_CHUNK: f64 = 88.0;
    let run = pan_run(false, 1_200);
    assert!(run.new_chunks > 0, "the pan reached no new chunks");
    let per_chunk = run.bytes as f64 / run.new_chunks as f64;
    assert!(
        per_chunk <= CEILING_BYTES_PER_NEW_CHUNK,
        "panning host+client tick loop allocated {per_chunk:.2} B per newly reached chunk, over \
         the {CEILING_BYTES_PER_NEW_CHUNK} B ceiling ({} B over {} new chunks in 1,200 ticks)",
        run.bytes,
        run.new_chunks,
    );
}

/// The host's own `TerrainStore` has no consumer for `CacheEvent`s: nothing in the sim role calls
/// `drain_cache_events` (`client::upload`, M09's texel path, is the only caller in the crate).
/// Recording is opt-in for exactly that reason (M15 fix round 3 measured the undrained queue at
/// ~16 B per load/evict event, the one term of the panning workload's allocation that grew with
/// elapsed time rather than with territory), and this asserts the host really does opt out: a
/// long pan materializes and evicts constantly, so a return to unconditional queueing shows up
/// here immediately. The client `Replica`'s store has no consumer either today, and 15b is what
/// gives it one.
#[test]
fn host_terrain_queues_no_cache_events() {
    let run = pan_run(false, 600);
    assert_eq!(
        run.host_queued_cache_events, 0,
        "the host's TerrainStore queued {} cache events over a 600-tick pan, and nothing on the \
         host path ever drains them",
        run.host_queued_cache_events,
    );
}
