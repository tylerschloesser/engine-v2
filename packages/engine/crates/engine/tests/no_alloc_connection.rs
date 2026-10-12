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
//! table in M15: `TerrainStore`'s overlay `BTreeMap` node
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
//! `host_admit_path_allocates_zero_bytes_per_action` (M16,
//! orchestrator gate item 3): the real admit path (`UplinkWriter` -> `Host::on_uplink` ->
//! `codec::decode_canonical` -> `G::admit` -> `pending_records`, then the real per-tick
//! `tick()`/`build_frame`/`seal()` order) allocates zero bytes per action, measured rather than
//! left to `Host::queue_action_for_test`'s own bypass of it (see that test's own doc comment for
//! the number and for a real measurement bug this test's first draft found in itself).
//!
//! M46: the world has transport lines (`NGame::genesis`: 64 two-chunk lines along tile row 2,
//! tiles 0..4,096) and `NGame::tick` changes one line's speed every 7 ticks, so every workload
//! above routes line structures and the replica applies them; the client reserves the world's caps
//! as `Welcome` would (`Replica::set_transport_caps`). In the 512-tile band the chunks come back
//! within the 5 s hold, so only the speed changes' puts are routed there;
//! `host_and_client_wide_band_routes_lines_no_alloc` pans a 4,096-tile band, where chunks enter
//! and leave inside the measured windows: puts (on enter, riding snapshots, on change) and gones
//! (on leave) are counted there and must both be above zero, at zero growth.
//!
//! M47: the lines form one chain into a sink fed by declared spawners (`NGame::genesis`), so items
//! flow and the forecasts (section 13: run lists riding puts, states on the speed changes and the
//! jams, arrivals from lines the client does not hold) are routed and applied inside every
//! measured window; the wide band counts them and needs them above zero.
//!
//! Every test here drives `Host`/`ClientCore` directly, not `testing::testkit::Loopback` (`Loopback::step`
//! itself allocates a fresh `Vec<u8>` per client per call, by design -- a test-only convenience,
//! never claimed allocation-free).

use engine::abi::Arena;
use engine::abi::arena::thread_high_water_bytes as high_water_bytes;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::host::Host;
use engine::host::pacing::BandwidthConfig;
use engine::sim::WorldParams;
use engine::transport::{Geometry, Item, LineId, Output, Schedule, Segment};
use engine::wire::{CameraReport, UplinkWriter};
use engine::world::WorldPos;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> isize {
    engine::abi::arena::thread_live_bytes()
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
        if NO_LINES.with(|n| n.get()) {
            // The pre-M42 shape (entities and tiles only): the lost-frame control.
            return;
        }
        // M46: lines in the world (module doc).
        let t = w.transport_mut().expect("genesis: transport_mut is Ok");
        for k in 0..LINES {
            let l = t.create(64 * 256, 24).expect("the caps hold the lines");
            let x = (k as i32 * 64) * 256 + 128;
            let seg = Segment {
                len: 64 * 256,
                geometry: Geometry::Straight {
                    from: WorldPos {
                        x,
                        y: 2 * 256 + 128,
                    },
                    to: WorldPos {
                        x: x + 64 * 256,
                        y: 2 * 256 + 128,
                    },
                },
            };
            t.set_segments(l, &[seg]).expect("one straight segment");
        }
        // M47: the lines form one chain toward line 1, which sinks; every eighth line has a
        // full-rate spawner the tracker is told of, so items flow, hand off and get corrected.
        for k in 2..=LINES {
            t.set_out(LineId(k), Output::Next(LineId(k - 1))).unwrap();
        }
        t.set_out(LineId(1), Output::Sink).unwrap();
        // M47 review 2, finding 6: one line whose list is larger than a frame (1,600 tiles, 6,000
        // items of alternating kinds): the client holds it `unknown`.
        let long = t.create(1_600 * 256, 24).unwrap();
        t.set_segments(
            long,
            &[Segment {
                len: 1_600 * 256,
                geometry: Geometry::Straight {
                    from: WorldPos {
                        x: 128,
                        y: 3 * 256 + 128,
                    },
                    to: WorldPos {
                        x: 1_600 * 256 + 128,
                        y: 3 * 256 + 128,
                    },
                },
            }],
        )
        .unwrap();
        for k in 0..6_000u32 {
            t.insert_at(long, 10 + 64 * k, Item(1 + (k % 2) as u16))
                .unwrap();
        }
        for k in (8..=LINES).step_by(8) {
            t.set_spawner(
                LineId(k),
                Some(Schedule {
                    period: 256,
                    acc: 0,
                    kinds: 0,
                    next: Item(1),
                }),
            );
        }
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
    /// M46: every 7 ticks one line's speed alternates between 12 and 24 (a structure change).
    fn tick(cx: &mut TickCx<'_, Self>) {
        let now = cx.tick().0;
        let n = now / 7;
        if NO_LINES.with(|n| n.get()) {
            return;
        }
        let t = cx.transport_mut().expect("tick: transport_mut is Ok");
        // M47: the declared spawners' rule (period 256: an attempt every tick).
        for k in (8..=LINES).step_by(8) {
            let _ = t.insert_back(LineId(k), Item(1));
        }
        if !now.is_multiple_of(7) {
            return;
        }
        let speed = if n.is_multiple_of(2) { 12 } else { 24 };
        let _ = t.set_speed(LineId(1 + n % LINES), speed);
    }
}

/// Lines `NGame::genesis` creates (ids 1 ..= LINES), every 64 tiles along row 2: they cover
/// `WIDE_BAND_TILES`.
const LINES: u32 = 64;

struct FlatSource;
impl PristineSource for FlatSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

/// A client replica reserved for the world's transport caps, as `Welcome` does (M46).
fn lined_replica(chunks: u32, player: PlayerId) -> engine::client::Replica<NGame> {
    let mut r = engine::client::Replica::<NGame>::new(
        ChunkDims::new(NGame::CHUNK_BITS),
        Box::new(FlatSource),
        CacheCapacity::Chunks(chunks),
        player,
    );
    r.set_transport_caps(
        engine::transport::DEFAULT_MAX_LINES,
        engine::transport::DEFAULT_MAX_ITEMS,
    );
    r
}

#[test]
fn host_and_client_steady_state_no_alloc() {
    use engine::client::ClientCore;

    let mut host = Host::<NGame>::genesis_for_test(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: engine::transport::DEFAULT_MAX_ITEMS,
    });
    let player = host.connect(0);
    let mut client = ClientCore::new(lined_replica(256, player));

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
        let _ = host.on_uplink(0, &s.uplink_buf[..n]);
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
    /// True for the bounded-camera control: the camera turns around at the edges of a band
    /// (`band` tiles) instead of panning forever, so the world it touches is finite and *every*
    /// byte the tick loop still allocates is a per-tick allocation.
    bounded: bool,
    band: i32,
    /// `LineStructs` records built so far (M46 review: the measured windows must route lines).
    puts: u64,
    gones: u64,
    /// `Forecasts` records built so far (M47: the measured windows must route forecasts).
    forecasts: u64,
    /// `ChunkSnapshots` and `LineStructs` bytes built so far (M48: what a lost frame's
    /// re-snapshots cost; a re-snapshot re-puts the chunk's anchored lines).
    snaps: u64,
    line_bytes: u64,
    /// `live_bytes()` growth inside the host's own calls so far.
    host_bytes: i64,
    /// Lose a frame every 32 ticks (M47 review 2).
    lossy: bool,
    /// Degrade levels seen (bit `level`) and bundles sent (M48's degraded window).
    levels: u32,
    /// M48's degraded window: paint a 24 x 16 block around the camera every tick, so each frame
    /// carries a few KB and a level-4 bundle outgrows the old 8 KiB hold.
    paint_block: bool,
    /// The largest message `build_frame` returned.
    max_msg: usize,
}

/// Counts the `LineStructs` and `Forecasts` records of one built message (a frame or a bundle of
/// frames), and its `ChunkSnapshots` bytes, with no allocation.
fn count_line_records(
    msg: &[u8],
    puts: &mut u64,
    gones: &mut u64,
    forecasts: &mut u64,
    snaps: &mut u64,
    line_bytes: &mut u64,
) {
    use engine::wire::lines::{Record, read};
    use engine::wire::{BundleReader, FrameReader, MsgType, SectionId};
    let mut one = |frame: &[u8]| {
        let mut r = FrameReader::new(frame).unwrap();
        while let Some((id, body)) = r.next_section().unwrap() {
            if id == SectionId::ChunkSnapshots {
                *snaps += body.len() as u64;
            }
            if id == SectionId::LineStructs {
                *line_bytes += body.len() as u64;
                read(&mut engine::bytes::ByteReader::new(body), |rec| match rec {
                    Record::Put(_) => *puts += 1,
                    Record::Gone(_) => *gones += 1,
                })
                .unwrap();
            }
            if id == SectionId::Forecasts {
                engine::wire::forecast::read(&mut engine::bytes::ByteReader::new(body), |_| {
                    *forecasts += 1
                })
                .unwrap();
            }
        }
    };
    if msg[0] == MsgType::FrameBundle as u8 {
        let mut b = BundleReader::new(msg).unwrap();
        while let Some(f) = b.next_frame().unwrap() {
            one(f);
        }
    } else {
        one(msg);
    }
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
        if p.pan_x >= p.band {
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
        let b = live();
        let _ = host.on_uplink(0, &s.uplink_buf[..n]);
        p.host_bytes += live() as i64 - b as i64;
    }

    if i.is_multiple_of(2) {
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

    if p.paint_block {
        for k in 0..384i32 {
            s.seq += 1;
            host.queue_action_for_test(
                player,
                s.seq,
                NAction::Paint {
                    pos: NPos {
                        x: p.pan_x - 12 + k % 24,
                        y: -8 + k / 24,
                    },
                    base: ((i as i32 + k) % 250) as u8,
                },
            );
        }
    }
    if i.is_multiple_of(50) {
        s.seq += 1;
        host.queue_action_for_test(player, s.seq, NAction::SetGlobal { n: i });
    }
    if i.is_multiple_of(70) {
        s.seq += 1;
        host.queue_action_for_test(player, s.seq, NAction::SetPlayer { n: i });
    }

    let b = live();
    host.tick();
    p.host_bytes += live() as i64 - b as i64;
    // M47 review 2, finding 6: a frame too small for what it must carry every 32 ticks of a lossy
    // run (the lost-frame path inside the window; 32 divides the 256-tick round trip, so both
    // windows end at the same phase of the losses).
    let len = if p.lossy && i % 32 == 7 {
        64
    } else {
        s.frame_buf.len()
    };
    let b = live();
    let n = host.build_frame(0, &mut s.frame_buf[..len]);
    p.host_bytes += live() as i64 - b as i64;
    p.max_msg = p.max_msg.max(n);
    if n > 0 {
        count_line_records(
            &s.frame_buf[..n],
            &mut p.puts,
            &mut p.gones,
            &mut p.forecasts,
            &mut p.snaps,
            &mut p.line_bytes,
        );
        client.on_frame(&s.frame_buf[..n]).unwrap();
    }
    let b = live();
    host.seal();
    p.host_bytes += live() as i64 - b as i64;
    if let Some(c) = host.pacing_counters(0) {
        p.levels |= 1 << c.degrade_level;
    }
    client.drain_dirty(|_| {});
    s.t_ms += 50;
    let _ = client.poll_uplink(s.t_ms, &mut s.uplink_buf);
}

/// The wide band (M46 review): 128 chunks, a 256-tick round trip, so a chunk at either end is
/// away past the 5 s (100-tick) hold and leaves, and the lines in it are `Gone`; they enter again
/// (by snapshot, their anchored puts riding it) on the way back.
const WIDE_BAND_TILES: i32 = 4096;

/// One camera band for the bounded control: 16 chunks wide at `CHUNK_BITS = 5`.
const BAND_TILES: i32 = 512;

/// What one measured window of [`pan_run`] produced.
struct PanRun {
    /// `live_bytes()` growth over the measured window.
    bytes: i64,
    /// The part of `bytes` allocated inside the host's own calls (`on_uplink`, `tick`,
    /// `build_frame`, `seal`); the rest is the client's.
    host_bytes: i64,
    /// Lossy runs only: growth from the window's start to two lossless round trips after it.
    settled: i64,
    /// Lossy runs only: growth over the two lossless round trips after that.
    tail_bytes: i64,
    /// Client desync reports raised inside the window.
    desyncs: u64,
    /// Chunks the host saw a replicated change in for the first time during the window -- the
    /// "newly reached chunks" the panning ceiling is expressed per.
    new_chunks: u64,
    /// Cache events the host's own `TerrainStore` had queued at the end of the window.
    host_queued_cache_events: usize,
    /// Line structures the client held at the end of the window (M46: the routing is live).
    lines_held: u32,
    /// `LineStructs` puts and gones built inside the window.
    puts: u64,
    gones: u64,
    /// `Forecasts` records built inside the window (M47).
    forecasts: u64,
    /// Frames lost and `unknown` lists applied inside the window (M47 review 2).
    overflows: u64,
    lists_unknown: u64,
    /// Held chunks re-snapshotted because a lost frame carried their deltas (M48), and the
    /// `ChunkSnapshots` bytes built inside the window.
    lost_resnapshots: u64,
    snap_bytes: u64,
    /// `LineStructs` bytes built inside the window.
    line_bytes: u64,
    /// Degrade levels seen inside the window (bit `level`) and bundles sent (M48).
    levels: u32,
    bundles: u64,
    /// The largest message built inside the window.
    max_msg: usize,
}

/// Warm up a host + client to the panning workload's steady state, then measure `window` ticks of
/// it. `bounded` picks the control (camera oscillating over `BAND_TILES`, finite territory) over
/// the pan (camera advancing forever, one fresh chunk column per tick). Each call builds a fresh
/// `Host`/`ClientCore`, so two windows are two independent runs from the same warm-up, never a
/// short prefix of a long one.
fn pan_run(bounded: bool, window: u32) -> PanRun {
    pan_run_band(bounded, BAND_TILES, window)
}

fn pan_run_band(bounded: bool, band: i32, window: u32) -> PanRun {
    use engine::client::ClientCore;

    let mut host = Host::<NGame>::genesis_for_test(WorldParams {
        seed: 2,
        worldgen: (),
        max_entities: 65536,
        max_modified_tiles: 65536,
        max_action_growth: 65536,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: engine::transport::DEFAULT_MAX_ITEMS,
    });
    if DEGRADED.with(|d| d.get()) > 0 {
        // Undegraded until the window: the painted block alone is over the default soft cap.
        host.set_bandwidth(BandwidthConfig {
            soft_cap_bytes_per_s: u32::MAX / 4,
            ..BandwidthConfig::default()
        });
    }
    let player = host.connect(0);
    let mut client = ClientCore::new(lined_replica(1024, player));
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
        band,
        puts: 0,
        gones: 0,
        forecasts: 0,
        snaps: 0,
        line_bytes: 0,
        levels: 0,
        paint_block: DEGRADED.with(|d| d.get()) > 0,
        max_msg: 0,
        lossy: LOSSY.with(|l| l.get()),
        host_bytes: 0,
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
    // A bounded camera first covers its band twice (a round trip is `2 x band / 32` ticks), so the
    // measured windows reach no territory the warm-up has not.
    let round_trip = if bounded { (2 * band / 32) as u32 } else { 0 };
    for i in 0..(hold + 20).max(2 * round_trip) {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, i);
    }
    for i in 0..40u32 {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 1_000 + i);
    }

    // M48: the degraded window's soft cap engages at its first tick, so degrade (level 2, then 4
    // after 2 s over the cap) and the bundles it holds happen inside the measured window.
    let soft_cap = DEGRADED.with(|d| d.get());
    if soft_cap > 0 {
        host.set_conn_bandwidth(
            0,
            BandwidthConfig {
                soft_cap_bytes_per_s: soft_cap,
                ..BandwidthConfig::default()
            },
        );
    }
    p.levels = 0;
    p.max_msg = 0;
    let bundles_before = host.pacing_counters(0).map_or(0, |c| c.bundles);
    let chunks_before = host.debug_chunk_version_count();
    let (puts_before, gones_before, forecasts_before) = (p.puts, p.gones, p.forecasts);
    let snaps_before = p.snaps;
    let line_bytes_before = p.line_bytes;
    let overflows_before = host.debug_overflows(0);
    let resnaps_before = host.debug_lost_resnapshots(0);
    let unknown_before = client.replica().forecast_counters().lists_unknown;
    let desyncs_before = client.desyncs().count();
    let before = live();
    let host_before = p.host_bytes;
    for i in 0..window {
        run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 2_000 + i);
    }
    let bytes = live() as i64 - before as i64;
    let host_bytes = p.host_bytes - host_before;
    let (puts, gones, forecasts) = (
        p.puts - puts_before,
        p.gones - gones_before,
        p.forecasts - forecasts_before,
    );
    let new_chunks = (host.debug_chunk_version_count() - chunks_before) as u64;
    let host_queued_cache_events = host
        .sim()
        .unwrap()
        .authority()
        .store()
        .terrain()
        .queued_cache_events();
    let lines_held = client.replica().transport().lines_len();
    let desyncs_in_window = client.desyncs().count() - desyncs_before;
    let overflows = host.debug_overflows(0) - overflows_before;
    let lost_resnapshots = host.debug_lost_resnapshots(0) - resnaps_before;
    let bundles = host.pacing_counters(0).map_or(0, |c| c.bundles) - bundles_before;
    let levels = p.levels;
    let max_msg = p.max_msg;
    let snap_bytes = p.snaps - snaps_before;
    let line_bytes = p.line_bytes - line_bytes_before;
    let lists_unknown = client.replica().forecast_counters().lists_unknown - unknown_before;
    // The lossy windows' recovery (M47 review 3): losses stop, two round trips settle the pacing
    // state, and the next two must not move a byte.
    let (mut settled, mut tail_bytes) = (0, 0);
    if p.lossy {
        p.lossy = false;
        for i in 0..2 * round_trip {
            run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 4_000 + i);
        }
        let mid = live();
        settled = mid as i64 - before as i64;
        for i in 0..2 * round_trip {
            run_panning_tick(&mut host, player, &mut client, &mut s, &mut p, 5_000 + i);
        }
        tail_bytes = live() as i64 - mid as i64;
    }
    PanRun {
        bytes,
        host_bytes,
        settled,
        tail_bytes,
        desyncs: desyncs_in_window,
        new_chunks,
        host_queued_cache_events,
        lines_held,
        puts,
        gones,
        forecasts,
        overflows,
        lists_unknown,
        lost_resnapshots,
        snap_bytes,
        line_bytes,
        levels,
        bundles,
        max_msg,
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
    assert!(
        short.lines_held > 0 && long.lines_held > 0,
        "the band's lines are routed to the client (M46)"
    );
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

/// M46 review: the bounded guarantee with line structures routed inside the measured windows. The
/// wide band makes chunks enter and leave all the time, so lines are put (riding snapshots) and
/// `Gone` inside both windows, and the growth is equal at one round trip (256 ticks) and at four
/// (1,024). The windows are whole round trips: the held set's size (and so the live bytes of the
/// client's held-chunk map) depends on where in the sweep the camera is, so windows ending at
/// different points of the sweep differ by that, not by growth (measured: 0 B at every multiple
/// of 256 ticks up to 2,048, 368 B at 300 against 416 B at 1,200).
#[test]
fn host_and_client_wide_band_routes_lines_no_alloc() {
    let short = pan_run_band(true, WIDE_BAND_TILES, 256);
    let long = pan_run_band(true, WIDE_BAND_TILES, 1_024);
    for (name, r) in [("256", &short), ("1,024", &long)] {
        assert!(
            r.puts > 0 && r.gones > 0,
            "the {name}-tick window routed {} puts and {} gones",
            r.puts,
            r.gones
        );
        println!(
            "{name}-tick window: {} puts, {} gones, {} forecast records, {} B",
            r.puts, r.gones, r.forecasts, r.bytes
        );
        assert!(
            r.lists_unknown > 0,
            "the {name}-tick window applied {} unknown lists",
            r.lists_unknown
        );
        assert!(
            r.forecasts > 0,
            "the {name}-tick window routed {} forecast records",
            r.forecasts
        );
    }
    assert_eq!(
        long.bytes, short.bytes,
        "wide-band host+client loop allocates per tick: {} B over 256 ticks, {} B over 1,024",
        short.bytes, long.bytes
    );
}

thread_local! {
    /// Lose a frame every 32 ticks in the next `pan_run_band` (M47 review 2).
    static LOSSY: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    /// Build the next world with no transport line (the lost-frame control).
    static NO_LINES: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    /// A soft cap (B/s) the next `pan_run_band` sets at its window's start (0: none; M48).
    static DEGRADED: core::cell::Cell<u32> = const { core::cell::Cell::new(0) };
}

/// M47 review 2, finding 6, and review 3: the lost-frame path inside the measured windows (the
/// wide band, a frame too small for what it must carry every 32 ticks: the next frame drops what
/// the lost one named and puts it again), on the lined world and on the same world with no line
/// (`NO_LINES`, the pre-M42 shape: the control). Every assertion is exact:
/// - the host's own calls allocate 0 B over every lossy window (the lost set, unknown lists and
///   routing of `host/lines.rs` included);
/// - once losses stop, two round trips later the live bytes do not move by one byte over the next
///   two;
/// - no client desync report (M48: a lost frame re-snapshots the held chunks it changed).
///
/// What the client's `on_frame` does allocate inside a lossy window is not M47's: measured by
/// bracketing every section (Deviations, "Review fixes, round 3"), sections `LineStructs` and
/// `Forecasts` and the follower's catch-up allocate 0 B; the residue is the replica's chunk store
/// (`ChunkReplica::held`, a `BTreeMap` whose node layout follows its insertion history, and the
/// overlay's per-chunk `Vec<Entry>` capacities: a re-snapshot replaces a grown vector with an
/// exact one), which losses reshuffle in both worlds alike: lined 48, 48, 288, 48 B; no lines
/// 288, 528, 528, 288 B over 256, 512, 1,024 and 2,048 ticks (M48; before it, the desyncs the
/// losses raised added 64 B once in `check_hashes`).
#[test]
fn host_and_client_lost_frames_do_not_grow() {
    LOSSY.with(|l| l.set(true));
    let mut table = Vec::new();
    for no_lines in [false, true] {
        NO_LINES.with(|n| n.set(no_lines));
        for w in [256u32, 512, 1_024, 2_048] {
            table.push((no_lines, w, pan_run_band(true, WIDE_BAND_TILES, w)));
        }
    }
    NO_LINES.with(|n| n.set(false));
    LOSSY.with(|l| l.set(false));
    for (no_lines, w, r) in &table {
        let world = if *no_lines { "no lines" } else { "lined" };
        if std::env::var_os("MEASURE").is_some() {
            println!(
                "lossy {world} {w}: {} B ({} B host), {} lost frames, {} desyncs, {} lost \
                 re-snapshots, {} B of snapshots; settled {} B, tail {} B",
                r.bytes,
                r.host_bytes,
                r.overflows,
                r.desyncs,
                r.lost_resnapshots,
                r.snap_bytes,
                r.settled,
                r.tail_bytes
            );
        }
        assert!(r.overflows > 0, "{world} {w}: frames were lost");
        assert_eq!(r.host_bytes, 0, "{world} {w}: the host allocated");
        assert_eq!(r.desyncs, 0, "{world} {w}: client desyncs");
        assert_eq!(
            r.tail_bytes, 0,
            "{world} {w}: the recovered run still moves"
        );
        assert_eq!(
            r.lines_held == 0,
            *no_lines,
            "{world} {w}: the world's lines"
        );
    }
}

/// M48: a lost frame never leaves a held chunk desynced. `Host::seal` clears the change log after
/// every connection's build, so a frame that does not fit (`SliceSink::finish` `Err`) loses its
/// `ChunkDeltas` for good; the host now queues every held chunk the lost frame carried a delta for
/// as a snapshot (deltas suppressed until it goes), as the lines send `Gone`. The lossy wide band of
/// `host_and_client_lost_frames_do_not_grow` (a 64 B frame every 32 ticks) over 1,024 ticks, on the
/// lined world and the `NO_LINES` control: no client desync report (the `DesyncLog` count; before
/// the rule 9 and 12), and the lost frames, the re-snapshots they caused and the window's
/// `ChunkSnapshots` and `LineStructs` bytes are pinned.
#[test]
fn lost_frame_never_desyncs_a_held_chunk() {
    LOSSY.with(|l| l.set(true));
    // `(no_lines, lost frames, held chunks re-snapshotted, ChunkSnapshots B, LineStructs B)`,
    // pinned: with the rule off the bytes read 8,528 / 22,645 (lined, 9 desyncs) and 5,344 / 0
    // (no lines), so the rule's cost (+673 + 124 B, +548 B) cannot drift unseen. M48c: a snapshot
    // no longer re-puts the lines the client holds at their current version, so the lined
    // `LineStructs` fell from 29,842 to 22,769 (7,073 B of such re-puts; forcing every anchored
    // line again, the replica keeping them, reads 29,842 exactly) and the rule's line part from
    // +1,018 to +124 B (before M48c the rule off read 28,824).
    for (no_lines, lost, resnaps, snaps, lines) in
        [(false, 30, 60, 9_201, 22_769), (true, 24, 48, 5_892, 0)]
    {
        NO_LINES.with(|n| n.set(no_lines));
        let r = pan_run_band(true, WIDE_BAND_TILES, 1_024);
        let world = if no_lines { "no lines" } else { "lined" };
        if std::env::var_os("MEASURE").is_some() {
            println!(
                "{world}: {} lost frames, {} re-snapshots, {} B of snapshots, {} B of line structures, \
                 {} desyncs",
                r.overflows, r.lost_resnapshots, r.snap_bytes, r.line_bytes, r.desyncs
            );
        }
        assert_eq!(
            r.desyncs, 0,
            "{world}: client desync reports over 1,024 ticks"
        );
        assert_eq!(r.overflows, lost, "{world}: lost frames");
        assert_eq!(
            r.lost_resnapshots, resnaps,
            "{world}: lost-frame re-snapshots"
        );
        assert_eq!(
            (r.snap_bytes, r.line_bytes),
            (snaps, lines),
            "{world}: ChunkSnapshots and LineStructs bytes"
        );
    }
    NO_LINES.with(|n| n.set(false));
    LOSSY.with(|l| l.set(false));
}

/// M48: bundles of held frames allocate nothing on the host. `Pacing::hold` was 8 KiB and grew
/// the first time a degraded connection held more; it is now reserved at attach for two frames of
/// the `Tx` buffer (`pacing::hold_bytes`), which the emission rule never exceeds. The lined wide
/// band with a 1,000 B/s soft cap set at the window's first tick: inside the 512-tick window the
/// connection degrades to level 2 and then 4 and sends bundles, the host's own calls allocate 0 B,
/// and no client desync is reported.
#[test]
fn host_and_client_degraded_bundles_do_not_grow() {
    DEGRADED.with(|d| d.set(1_000));
    let r = pan_run_band(true, WIDE_BAND_TILES, 512);
    DEGRADED.with(|d| d.set(0));
    if std::env::var_os("MEASURE").is_some() {
        println!(
            "degraded 512: {} B ({} B host), levels {:#b}, {} bundles (largest {} B), {} desyncs, \
             {} lines held",
            r.bytes, r.host_bytes, r.levels, r.bundles, r.max_msg, r.desyncs, r.lines_held
        );
    }
    assert_eq!(r.levels, 0b10100, "degrade levels seen (bit 2, bit 4)");
    assert_eq!(r.bundles, 234, "bundles sent in the window");
    assert_eq!(r.host_bytes, 0, "the host allocated while degraded");
    assert_eq!(r.desyncs, 0, "client desyncs while degraded");
    assert_eq!(r.lines_held, 21, "lines held at the window's end (routed)");
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

/// One tick of the *admit-only* workload (M16, orchestrator gate
/// item 3): the real wire path an action actually takes to get admitted -- `UplinkWriter::write`
/// one action into a batch, `Host::on_uplink` (`codec::decode_canonical` -> `G::admit` ->
/// `pending_records`), then `Host::tick()` every call so `pending_records` never holds more than
/// one entry between calls (the same one-action-per-tick rate `run_steady_tick`'s own
/// `queue_action_for_test` calls already exercise for `Host::tick` itself, above). This is the
/// one path `Host::queue_action_for_test` exists specifically to bypass (host/mod Deviations,
/// `testing::testkit::Loopback::action`'s own doc comment): measured here instead of asserted
/// zero, since nothing upstream has actually measured it before.
fn run_admit_tick(
    host: &mut Host<NGame>,
    seq: &mut u32,
    uplink_buf: &mut [u8; 256],
    frame_buf: &mut [u8; 4096],
) {
    *seq += 1;
    let action = NAction::Paint {
        pos: NPos { x: 1, y: 1 },
        base: (*seq % 200) as u8,
    };
    let mut action_buf = [0u8; 32];
    let alen = engine::codec::encode(&action, &mut action_buf).expect("action fits action_buf");
    let mut sink = engine::bytes::SliceSink::new(uplink_buf);
    UplinkWriter::write(
        &mut sink,
        0,
        core::iter::once((*seq, &action_buf[..alen])),
        None,
        None,
    );
    let n = sink.finish().expect("uplink_buf is generously sized");
    let _ = host.on_uplink(0, &uplink_buf[..n]);
    // Real per-tick call order (host/mod Deviations, "Seam shapes as landed"): `tick()` once,
    // `build_frame(conn)` once per connection, `seal()` once. `build_frame` is what drains
    // `ConnSlot::pending_results` -- omitting it (an earlier draft of this test did) left every
    // action's own `Outcome` accumulating forever and measured that Vec's own growth instead of
    // the admit path.
    host.tick();
    let _ = host.build_frame(0, frame_buf);
    host.seal();
}

/// Builds and warms up (40 unmeasured ticks) one admit-only `Host`, shared by `admit_run` and
/// `admit_run_traced` so a diagnostic re-run (M19c
/// step B.4) drives the exact same setup as the measured one, not a hand-copied approximation of
/// it.
fn warmed_admit_host() -> (Host<NGame>, u32, [u8; 256], [u8; 4096]) {
    let mut host = Host::<NGame>::genesis_for_test(WorldParams {
        seed: 7,
        worldgen: (),
        max_entities: 65536,
        max_modified_tiles: 65536,
        max_action_growth: 65536,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: engine::transport::DEFAULT_MAX_ITEMS,
    });
    let _player = host.connect(0);
    let mut seq = 0u32;
    let mut uplink_buf = [0u8; 256];
    let mut frame_buf = [0u8; 4096];
    for _ in 0..40 {
        run_admit_tick(&mut host, &mut seq, &mut uplink_buf, &mut frame_buf);
    }
    (host, seq, uplink_buf, frame_buf)
}

/// `window` admit-only ticks (after a 40-tick warm-up, unmeasured), returning `live_bytes()`
/// growth over that window -- same `i64`-signed-difference shape `pan_run` uses above, since a
/// window that nets negative (more freed than allocated) is possible in principle and must not
/// underflow a `usize` subtraction.
fn admit_run(window: u32) -> i64 {
    let (mut host, mut seq, mut uplink_buf, mut frame_buf) = warmed_admit_host();
    let before = live();
    for _ in 0..window {
        run_admit_tick(&mut host, &mut seq, &mut uplink_buf, &mut frame_buf);
    }
    live() as i64 - before as i64
}

/// M19c step B.4: never collected on the passing
/// path (would itself allocate a `Vec<i64>`, defeating the measurement it would be diagnosing) --
/// called only after `admit_run` has already shown a non-zero net, to name where the bytes went
/// for whichever run reproduces this next. Re-runs the identical admit-only workload once more
/// (a fresh `Host`, same seed, same warm-up) and returns `high_water_bytes()` before/after the
/// window (a real per-action leak grows the high-water mark right alongside the net; a one-off
/// background allocation that later frees would not) plus each tick's own `live()` delta, so a
/// future failure names *which* tick(s) inside the window actually grew, not just the total.
fn admit_run_traced(window: u32) -> (isize, isize, Vec<i64>) {
    let (mut host, mut seq, mut uplink_buf, mut frame_buf) = warmed_admit_host();
    // Allocated, and `hw_before`/`prev` both captured, *before* the loop starts: this `Vec`'s own
    // upfront allocation (`window * size_of::<i64>()` B -- 800 B at `window = 100`) must not be
    // counted in either the per-tick trace or the high-water delta -- found by injection, below,
    // first as a phantom tick-0 entry, then (once that was excluded from `prev`) as a phantom 800 B
    // still inflating `hw_before`..`hw_after` because `hw_before` was read one line too early.
    let mut per_tick = Vec::with_capacity(window as usize);
    let hw_before = high_water_bytes();
    let mut prev = live();
    for _ in 0..window {
        run_admit_tick(&mut host, &mut seq, &mut uplink_buf, &mut frame_buf);
        let now = live();
        per_tick.push(now as i64 - prev as i64);
        prev = now;
    }
    (hw_before, high_water_bytes(), per_tick)
}

/// The tail appended to a failure message on either window (below): which ticks, by index into
/// the re-run window, actually grew `live_bytes()`, and the high-water mark's own before/after.
fn admit_diagnostic_tail(window: u32) -> String {
    let (hw_before, hw_after, per_tick) = admit_run_traced(window);
    let nonzero: Vec<(usize, i64)> = per_tick
        .iter()
        .enumerate()
        .filter(|&(_, &d)| d != 0)
        .map(|(i, &d)| (i, d))
        .collect();
    format!(
        "; re-run: high_water {hw_before} B -> {hw_after} B ({:+} B), nonzero-delta ticks \
         (index, bytes) = {nonzero:?}",
        hw_after as i64 - hw_before as i64,
    )
}

/// M16 (orchestrator gate item 3): bytes the *real* admit path
/// allocates per action -- `Host::queue_action_for_test` exists specifically to bypass measuring
/// this (host/mod Deviations, `testing::testkit::Loopback::action`'s own doc comment), so nothing
/// upstream had actually measured it before this test.
///
/// **Measured: 0 B/action, at every window length tried (100 through 25,600, in a throwaway
/// geometric probe not kept here) and both windows this test keeps.** `UplinkReader::read`'s
/// per-call `raw_actions: Vec` and `Host::on_uplink`'s per-call `decoded: Vec`
/// (`codec::decode_canonical`'s own scratch buffer inside it) are all local to one `on_uplink`
/// call and freed before it returns -- `live_bytes()` is allocated-minus-freed (`abi::arena`'s
/// own doc comment), so a matched alloc/free pair inside one measured call nets to zero in it,
/// the same "gross vs. net" lesson M15 fix round 3 already drew (M15). `pending_records` and `scratch_action_players` settle at
/// a steady capacity after the warm-up and are cleared every `Host::tick`.
///
/// **First draft of this test measured a real, non-zero, *not*-per-action cost, and it was a
/// test-harness bug, not a production one.** `run_admit_tick` originally called only `on_uplink`
/// and `tick()`, never `build_frame` -- but `build_frame` is what drains a connection's
/// `ConnSlot::pending_results` (this milestone's own new queue), and every action here is
/// admitted and applied successfully (`NGame` never overrides `admit`), so every single tick
/// pushed one more `Outcome` that nothing ever drained: 13,824 B/100 actions, 32,256 B/400,
/// converging toward ~92 B/action as the window grew -- a real, reproducible number, but a
/// `Vec<Outcome<G>>` growing forever because the test never called the one method that empties
/// it, not a cost the admit path itself imposes. Fixed by giving `run_admit_tick` the real
/// per-tick call order (`tick()`, `build_frame(conn)`, `seal()` -- host/mod Deviations, "Seam
/// shapes as landed"), which is what a real connection always does every tick; re-measured at 0
/// across the same window range. Recorded here rather than silently discarded, since it is
/// exactly the kind of number this gate item asked to have on record.
///
/// Measured at two window lengths (M15's own template, `host_and_client_bounded_camera_no_alloc`
/// above): a one-off warm-up artifact would shrink as the window grows; this stays at exactly
/// zero at both, which is why the checks below are equality to zero, not a ceiling.
///
/// **CI red, M19c step B**: run 36087861610 (a
/// doc-only commit) failed with `short = 900` -- the first failure of this test in the last 40
/// failed CI runs, passing locally every time since. 500 bounded local reproduction attempts this
/// session (300 quiet + 200 under a 12-way `yes` CPU load, both `cargo nextest run --workspace
/// --no-tests=pass -E 'test(host_admit_path)'` in a loop, this Mac) never reproduced it, and a
/// grep of `src/host/`, `src/store.rs`/`src/store/`, `src/wire/` found no `HashMap`/`HashSet`/
/// `RandomState` (the orchestrator's own first guess) anywhere in the crate outside a code comment
/// in `world/cache.rs` explicitly saying it is *not* one. Since the cause could not be attributed
/// this session, `assert_eq!`'s bare net-total message is replaced with one that also names where
/// the bytes went the next time this fails (`admit_diagnostic_tail`, below): `high_water_bytes()`
/// before/after a diagnostic re-run of the same window, and which tick(s) inside it actually grew
/// `live_bytes()` -- collected only on this, already-failing path, never on the path that passes
/// today, so it costs nothing there.
#[test]
fn host_admit_path_allocates_zero_bytes_per_action() {
    let short = admit_run(100);
    let long = admit_run(1_600);
    if short != 0 {
        panic!(
            "the real admit path (on_uplink -> decode_canonical -> G::admit -> pending_records, \
             then tick/build_frame/seal) allocated {short} B over 100 actions{}",
            admit_diagnostic_tail(100),
        );
    }
    if long != 0 {
        panic!(
            "the real admit path allocated {long} B over 1,600 actions{}",
            admit_diagnostic_tail(1_600),
        );
    }
}
