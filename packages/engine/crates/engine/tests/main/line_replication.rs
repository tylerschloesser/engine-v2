//! M46 (docs/decisions/0078 §1, §4, §6): line structure replication. The `LineStructs` section's
//! bytes (`wire_lines_*`), the store's structure version and change list, the replica's
//! `apply_structure` and its read side, the per-chunk hash over structures, and the host's routing
//! by chunk set end to end through `testkit::Loopback` (real wire bytes). The host scenarios use a
//! local test game whose `tick` runs a per-thread script of transport writes (nextest runs each
//! test in its own process; the script is per thread for `cargo test` too).

use std::cell::RefCell;

use engine::bytes::{ByteReader, SliceSink};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::host::hashes::HashMode;
use engine::integrity::chunk_hash;
use engine::sim::{Sim, WorldParams};
use engine::testing::testkit::{self, Loopback};
use engine::transport::{
    Geometry, Item, LineId, Output, Segment, Transport, TransportError, TransportRead,
    TransportWrite,
};
use engine::wire::lines::{self, Gone, Put, Record};
use engine::wire::{CameraReport, FrameReader, SectionId, WireError, encode_chunk_snapshot};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    WorldPos,
};
use engine::worldgen::Worldgen;

// -- A test game whose tick runs a script of transport writes --------------------------------

type Op = Box<dyn FnOnce(&mut dyn TransportWrite)>;

thread_local! {
    /// `(tick, op)`: run by `LrGame::tick` at that tick, in order.
    static SCRIPT: RefCell<Vec<(u32, Op)>> = RefCell::new(Vec::new());
    /// Ids the script's `create`/`split` calls returned, in order.
    static IDS: RefCell<Vec<LineId>> = const { RefCell::new(Vec::new()) };
}

fn at(tick: u32, op: impl FnOnce(&mut dyn TransportWrite) + 'static) {
    SCRIPT.with(|s| s.borrow_mut().push((tick, Box::new(op))));
}

fn id(k: usize) -> LineId {
    IDS.with(|i| i.borrow()[k])
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct LrEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct LrPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct LrGlobal;
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum LrAction {
    Noop,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum LrReject {
    Unknown,
}
impl From<Unknown> for LrReject {
    fn from(_: Unknown) -> Self {
        LrReject::Unknown
    }
}
struct LrGen;
impl Worldgen for LrGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}
struct Flat;
impl PristineSource for Flat {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

struct LrGame;
impl Game for LrGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = LrGen;
    type Action = LrAction;
    type Reject = LrReject;
    type Entity = LrEntity;
    type Player = LrPlayer;
    type Global = LrGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &LrEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &LrEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, LrPlayer);
        }
    }
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &LrAction) -> Result<(), LrReject> {
        Ok(())
    }
    fn tick(cx: &mut TickCx<'_, Self>) {
        let now = cx.tick().0;
        let due: Vec<Op> = SCRIPT.with(|s| {
            let mut s = s.borrow_mut();
            let mut due = Vec::new();
            let mut k = 0;
            while k < s.len() {
                if s[k].0 == now {
                    due.push(s.remove(k).1);
                } else {
                    k += 1;
                }
            }
            due
        });
        if due.is_empty() {
            return;
        }
        let t = cx.transport_mut().expect("tick: transport_mut is Ok");
        for op in due {
            op(t);
        }
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &LrAction,
    ) -> Result<(), LrReject> {
        Ok(())
    }
}

fn params() -> WorldParams<LrGame> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1024,
        max_modified_tiles: 1024,
        max_action_growth: 4096,
        max_lines: 64,
        max_items: 1024,
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(LrGame::CHUNK_BITS)
}

const TILE: i32 = 256;

/// A straight east-going path along tile row `row` from tile `x0` for `tiles` tiles (positions
/// through tile centres), as one segment of `tiles x 256` positions.
fn east(x0: i32, row: i32, tiles: u32) -> Segment {
    Segment {
        len: tiles * 256,
        geometry: Geometry::Straight {
            from: WorldPos {
                x: x0 * TILE + 128,
                y: row * TILE + 128,
            },
            to: WorldPos {
                x: (x0 + tiles as i32) * TILE + 128,
                y: row * TILE + 128,
            },
        },
    }
}

fn arc() -> Segment {
    Segment {
        len: 402,
        geometry: Geometry::Arc {
            centre: WorldPos { x: 0, y: 0 },
            radius_q8: 256,
            start_turn_q8: 0,
            sweep_q8: 64,
        },
    }
}

fn put(id: u32, len: u32, speed: u16, out: Output, segs: &[Segment]) -> Put {
    let mut p = Put::empty(LineId(id));
    p.len = len;
    p.speed = speed;
    p.out = out;
    p.seg_count = segs.len() as u8;
    p.segs[..segs.len()].copy_from_slice(segs);
    p
}

/// An owned record (`lines::Record` borrows its put): `(id, Some(put))` or `(id, None)` for gone.
type Rec = (LineId, Option<Put>);

fn p_(put: Put) -> Rec {
    (put.id, Some(put))
}

fn g_(id: u32) -> Rec {
    (LineId(id), None)
}

fn encode(recs: &[Rec]) -> Vec<u8> {
    let mut buf = vec![0u8; 4096];
    let mut sink = SliceSink::new(&mut buf);
    for (id, put) in recs {
        match put {
            Some(p) => lines::write(&mut sink, Record::Put(p)),
            None => lines::write(&mut sink, Record::Gone(Gone { id: *id })),
        }
    }
    let n = sink.finish().unwrap();
    buf.truncate(n);
    buf
}

fn owned(r: Record<'_>) -> Rec {
    match r {
        Record::Put(p) => (p.id, Some(*p)),
        Record::Gone(g) => (g.id, None),
    }
}

fn decode(bytes: &[u8]) -> Result<Vec<Rec>, WireError> {
    let mut got = Vec::new();
    lines::read(&mut ByteReader::new(bytes), |r| got.push(owned(r)))?;
    Ok(got)
}

// -- wire ----------------------------------------------------------------------------------------

/// Every output and both segment shapes round-trip, with `Gone` interleaved by id.
#[test]
fn wire_lines_round_trip() {
    let recs = [
        p_(put(1, 2048, 24, Output::DeadEnd, &[east(0, 0, 8)])),
        g_(2),
        p_(put(3, 2048, 24, Output::Next(LineId(1)), &[east(0, 1, 8)])),
        p_(put(
            4,
            2048,
            1,
            Output::Sink,
            &[east(0, 2, 4), east(4, 2, 4)],
        )),
        p_(put(
            300,
            402,
            24,
            Output::Merge {
                line: LineId(3),
                at: 1000,
            },
            &[arc()],
        )),
        p_(put(
            70_000,
            2048,
            24,
            Output::Fork {
                a: LineId(1),
                b: LineId(3),
            },
            &[east(0, 3, 8)],
        )),
        g_(u32::MAX),
    ];
    let bytes = encode(&recs);
    assert_eq!(decode(&bytes).unwrap(), recs);
    // A put's size: tag, id varint, len, speed, out, seg count, then 21 B per straight segment.
    assert_eq!(
        encode(&recs[..1]).len(),
        1 + 1 + 4 + 2 + 1 + 1 + 21,
        "a one-segment dead-end put is 31 B"
    );
}

/// Every rejection the module doc names, and every truncation of a valid section.
#[test]
fn wire_lines_rejects_malformed() {
    let good = put(5, 2048, 24, Output::Next(LineId(1)), &[east(0, 0, 8)]);
    let bytes = encode(&[p_(good)]);
    for cut in 1..bytes.len() {
        assert_eq!(
            decode(&bytes[..cut]),
            Err(WireError::Malformed),
            "cut {cut}"
        );
    }
    let field = |f: fn(&mut Put)| {
        let mut p = good;
        f(&mut p);
        decode(&encode(&[p_(p)]))
    };
    assert_eq!(field(|p| p.len = 0), Err(WireError::Malformed), "len 0");
    assert_eq!(field(|p| p.speed = 0), Err(WireError::Malformed), "speed 0");
    assert_eq!(
        field(|p| p.seg_count = 0),
        Err(WireError::Malformed),
        "no segments"
    );
    // `seg_count` past `MAX_SEGMENTS`: patch the count byte of a valid record (tag, id, len,
    // speed, out tag + target are 1 + 1 + 4 + 2 + 5 bytes).
    let mut over = bytes.clone();
    over[13] = 17;
    assert_eq!(decode(&over), Err(WireError::Malformed), "17 segments");
    let mut flag = bytes.clone();
    flag[8] |= 0x80;
    assert_eq!(decode(&flag), Err(WireError::Malformed), "out flag bit");
    let mut out_tag = bytes.clone();
    out_tag[8] = 5;
    assert_eq!(
        decode(&out_tag),
        Err(WireError::Malformed),
        "unknown out tag"
    );
    let mut seg_tag = bytes.clone();
    seg_tag[14 + 4] = 2;
    assert_eq!(
        decode(&seg_tag),
        Err(WireError::Malformed),
        "unknown segment tag"
    );
    assert_eq!(
        decode(&[2, 1]),
        Err(WireError::Malformed),
        "unknown record tag"
    );
    let gone = g_;
    assert_eq!(
        decode(&encode(&[gone(4), gone(4)])),
        Err(WireError::Malformed),
        "a repeated id"
    );
    assert_eq!(
        decode(&encode(&[p_(good), gone(4)])),
        Err(WireError::Malformed),
        "descending ids"
    );
    assert!(decode(&encode(&[gone(4), p_(good)])).is_ok());
}

// -- the store -----------------------------------------------------------------------------------

/// The change list as a sorted set (the order of a surgery's redirects is not the contract).
fn changes(t: &Transport) -> Vec<LineId> {
    let mut v = t.structure_changes().0.to_vec();
    v.sort();
    v
}

/// Every structure write stamps the line's version with the tick `set_now` set and queues it once
/// per drain; item writes and `advance` do neither. A destroyed line is queued; a full list
/// overflows instead of growing.
#[test]
fn transport_structure_version_and_changes() {
    let mut t = Transport::new(16, 256);
    t.set_now(5);
    let a = t.create(2048, 24).unwrap();
    let b = t.create(2048, 24).unwrap();
    assert_eq!(t.structure_version(a), Ok(5));
    t.set_out(b, Output::Next(a)).unwrap();
    assert_eq!(changes(&t), [a, b], "created, then b's output: each once");
    t.drain_structure_changes();
    assert!(changes(&t).is_empty());

    t.set_now(6);
    t.insert_back(a, Item(1)).unwrap();
    t.insert_at(b, 1000, Item(2)).unwrap();
    t.remove_at(b, 1000).unwrap();
    t.advance();
    t.take_front(a).unwrap();
    assert_eq!(t.structure_version(a), Ok(5), "items never bump");
    assert!(changes(&t).is_empty(), "items and advance queue nothing");

    let bump = |t: &mut Transport, now: u32, f: &dyn Fn(&mut Transport), want: &[LineId]| {
        t.set_now(now);
        f(t);
        for &l in want {
            assert_eq!(t.structure_version(l), Ok(now), "{l:?} at {now}");
        }
        let mut want = want.to_vec();
        want.sort();
        assert_eq!(changes(t), want, "queued at {now}");
        t.drain_structure_changes();
    };
    bump(&mut t, 7, &|t| t.set_speed(a, 12).unwrap(), &[a]);
    bump(
        &mut t,
        8,
        &|t| t.set_segments(a, &[east(0, 0, 8)]).unwrap(),
        &[a],
    );
    bump(&mut t, 9, &|t| t.set_out(a, Output::Sink).unwrap(), &[a]);
    bump(&mut t, 10, &|t| t.extend_back(a, 256).unwrap(), &[a]);
    bump(&mut t, 11, &|t| t.shrink_back(a, 256).unwrap(), &[a]);
    bump(&mut t, 12, &|t| t.rescale(a, 4096).unwrap(), &[a]);
    // `split` makes `c` and redirects `b` (which fed `a`) to it.
    t.set_now(13);
    let c = t.split(a, 2048).unwrap();
    assert_eq!(
        changes(&t),
        [a, b, c],
        "the cut line, the feeder's redirect, the new line"
    );
    for l in [a, b, c] {
        assert_eq!(t.structure_version(l), Ok(13));
    }
    t.drain_structure_changes();
    t.set_now(14);
    t.join(a, c).unwrap();
    assert_eq!(
        changes(&t),
        [a, b, c],
        "the joined line, the redirect, the joined-away line"
    );
    assert_eq!(t.structure_version(a), Ok(14));
    assert_eq!(t.structure_version(b), Ok(14));
    t.drain_structure_changes();
    t.set_now(15);
    t.destroy(b, &mut |_| {}).unwrap();
    assert_eq!(changes(&t), [b], "a destroyed line is queued");
    assert_eq!(t.structure_version(b), Err(Unknown));
    t.drain_structure_changes();

    // The list holds a quarter of `max_lines` (1 at 4 lines): a second change overflows it.
    let mut t = Transport::new(4, 16);
    t.set_now(16);
    let d = t.create(2048, 24).unwrap();
    t.set_speed(d, 8).unwrap();
    assert_eq!(
        t.structure_changes(),
        (&[d][..], false),
        "one entry per line"
    );
    let e = t.create(2048, 24).unwrap();
    assert_eq!(
        t.structure_changes(),
        (&[d][..], true),
        "overflowed, not grown"
    );
    assert_eq!(t.structure_version(e), Ok(16), "the version still moves");
    t.drain_structure_changes();
    assert_eq!(t.structure_changes(), (&[][..], false));
    t.set_speed(e, 8).unwrap();
    assert_eq!(
        t.structure_changes(),
        (&[e][..], false),
        "queued again after the drain"
    );
}

fn replica_store(max_lines: u32) -> Transport {
    let mut t = Transport::empty();
    t.set_replica();
    t.set_caps(max_lines, 64).unwrap();
    t
}

/// A put creates or replaces a held line with no items and indexes its tiles; a gone removes it;
/// item reads are `Unknown`; a put the store cannot hold or that breaks its rules changes nothing.
#[test]
fn replica_apply_structure_put_and_gone() {
    let mut t = replica_store(2);
    let p = put(7, 2048, 24, Output::Next(LineId(3)), &[east(30, 0, 8)]);
    t.apply_structure(Record::Put(&p)).unwrap();
    assert_eq!(t.len(LineId(7)), Ok(2048));
    assert_eq!(t.speed(LineId(7)), Ok(24));
    assert_eq!(
        t.out(LineId(7)),
        Ok(Output::Next(LineId(3))),
        "kept as data"
    );
    assert_eq!(t.structure(LineId(7)), Ok(p));
    let mut chunks = Vec::new();
    t.chunks_of(LineId(7), dims(), &mut |c| chunks.push(c))
        .unwrap();
    assert_eq!(chunks, [ChunkCoord::new(0, 0), ChunkCoord::new(1, 0)]);
    assert_eq!(t.anchor(LineId(7), dims()), Ok(Some(ChunkCoord::new(0, 0))));
    let mut at = Vec::new();
    t.lines_at(TilePos::new(33, 0), &mut |l, o| at.push((l, o)))
        .unwrap();
    assert_eq!(at, [(LineId(7), 3 * 256 - 128)], "tile 33's first position");
    for r in [
        t.count(LineId(7)).map(|_| ()),
        t.front(LineId(7)).map(|_| ()),
        t.items_in(LineId(7), &mut |_, _| {}),
        t.sunk(LineId(7)).map(|_| ()),
        t.toggle(LineId(7)).map(|_| ()),
    ] {
        assert_eq!(r, Err(Unknown), "item reads are M47's");
    }

    // Replace: a new length and path re-index the tiles.
    let q = put(7, 1024, 12, Output::Sink, &[east(0, 5, 4)]);
    t.apply_structure(Record::Put(&q)).unwrap();
    assert_eq!(t.structure(LineId(7)), Ok(q));
    let mut at = Vec::new();
    t.lines_at(TilePos::new(33, 0), &mut |l, o| at.push((l, o)))
        .unwrap();
    assert!(at.is_empty(), "the old path left the index");
    assert_eq!(t.anchor(LineId(7), dims()), Ok(Some(ChunkCoord::new(0, 0))));

    // Refusals leave the store as it was.
    let bad = put(7, 1024, 12, Output::Sink, &[east(0, 5, 3)]);
    assert_eq!(
        t.apply_structure(Record::Put(&bad)),
        Err(TransportError::BadSegments),
        "segments not summing to len"
    );
    assert_eq!(t.structure(LineId(7)), Ok(q));
    let nine = put(9, 1024, 12, Output::DeadEnd, &[east(0, 9, 4)]);
    t.apply_structure(Record::Put(&nine)).unwrap();
    let eleven = put(11, 1024, 12, Output::DeadEnd, &[east(0, 11, 4)]);
    assert_eq!(
        t.apply_structure(Record::Put(&eleven)),
        Err(TransportError::Full),
        "max_lines held"
    );
    assert_eq!(t.len(LineId(11)), Err(Unknown));
    assert_eq!(t.lines_len(), 2);

    t.apply_structure(Record::Gone(Gone { id: LineId(7) }))
        .unwrap();
    assert_eq!(t.len(LineId(7)), Err(Unknown));
    let mut at = Vec::new();
    t.lines_at(TilePos::new(1, 5), &mut |l, _| at.push(l))
        .unwrap();
    assert!(at.is_empty(), "a gone line leaves the index");
    assert_eq!(
        t.apply_structure(Record::Gone(Gone { id: LineId(7) })),
        Ok(()),
        "an unknown gone is a no-op"
    );
    assert!(
        t.structure_changes().0.is_empty(),
        "a replica queues nothing"
    );
}

/// Through a client's `Replica`: a line the connection does not hold is `Unknown` for every read,
/// and `lines_at` is `Unknown` outside the held chunks; a replica that never saw `Welcome`'s caps
/// is `Unknown` everywhere.
#[test]
fn replica_transport_reads_are_unknown_for_unheld() {
    let (lb, held, _) = routed_world();
    let replica = lb.client(0).replica();
    let tr = replica.transport();
    let other = LineId(999);
    assert_eq!(tr.len(other), Err(Unknown));
    assert_eq!(tr.speed(other), Err(Unknown));
    assert_eq!(tr.out(other), Err(Unknown));
    assert_eq!(tr.segments(other, &mut |_| {}), Err(Unknown));
    assert_eq!(tr.pos_to_world(other, 0), Err(Unknown));
    assert_eq!(tr.chunks_of(other, dims(), &mut |_| {}), Err(Unknown));
    assert_eq!(tr.anchor(other, dims()), Err(Unknown));
    assert_eq!(tr.len(held), Ok(32 * 256), "the held line is known");
    assert_eq!(tr.count(held), Err(Unknown), "its items are not");
    assert!(
        tr.lines_at(TilePos::new(16, 16), &mut |_, _| {}).is_ok(),
        "a held chunk's tile"
    );
    assert_eq!(
        tr.lines_at(TilePos::new(5000, 5000), &mut |_, _| {}),
        Err(Unknown),
        "a tile outside the held chunks"
    );
    let mut fresh = Transport::empty();
    fresh.set_replica();
    assert_eq!(
        fresh.lines_at(TilePos::new(0, 0), &mut |_, _| {}),
        Err(Unknown)
    );
}

// -- the hash ------------------------------------------------------------------------------------

fn sim_with_line(item: Option<(u32, u16)>, speed: u16) -> Sim<LrGame> {
    let mut sim = Sim::<LrGame>::genesis(params());
    let t = testkit::transport_mut(&mut sim);
    let l = t.create(32 * 256, speed).unwrap();
    t.set_segments(l, &[east(16, 16, 32)]).unwrap();
    if let Some((pos, kind)) = item {
        t.insert_at(l, pos, Item(kind)).unwrap();
    }
    sim
}

/// Equal structures, different items: the chunk hash is equal (0078 §6), the state hash is not.
#[test]
fn chunk_hash_excludes_items() {
    let a = sim_with_line(Some((1000, 1)), 24);
    let b = sim_with_line(Some((3000, 2)), 24);
    let c = sim_with_line(None, 24);
    let anchor = ChunkCoord::new(0, 0);
    let h = |s: &Sim<LrGame>| chunk_hash(s.authority().store(), anchor);
    assert_eq!(h(&a), h(&b));
    assert_eq!(h(&a), h(&c));
    assert_ne!(a.state_hash(), b.state_hash(), "the items differ");
}

/// A changed `speed` changes the anchor chunk's hash, not a chunk the line only crosses; a chunk
/// anchoring no line hashes as its snapshot bytes alone (pre-M46).
#[test]
fn chunk_hash_includes_structures() {
    let a = sim_with_line(None, 24);
    let b = sim_with_line(None, 12);
    let h = |s: &Sim<LrGame>, c| chunk_hash(s.authority().store(), c);
    assert_ne!(h(&a, ChunkCoord::new(0, 0)), h(&b, ChunkCoord::new(0, 0)));
    assert_eq!(h(&a, ChunkCoord::new(1, 0)), h(&b, ChunkCoord::new(1, 0)));
    let mut plain = engine::hash::Fnv64::new();
    encode_chunk_snapshot(a.authority().store(), ChunkCoord::new(1, 0), 0, &mut plain);
    assert_eq!(h(&a, ChunkCoord::new(1, 0)), plain.finish());
}

// -- the host's routing --------------------------------------------------------------------------

fn camera(tile_x: i32, tile_y: i32) -> CameraReport {
    CameraReport {
        center_x: tile_x,
        center_y: tile_y,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

/// The `LineStructs` records of the frame `build_frame` last made for client `i`.
fn records(lb: &Loopback<LrGame>, i: usize) -> Vec<Rec> {
    let bytes = lb.last_built_frame(i);
    let mut got = Vec::new();
    if bytes.is_empty() {
        return got;
    }
    let mut one = |frame: &[u8]| {
        let mut r = FrameReader::new(frame).unwrap();
        while let Some((sid, body)) = r.next_section().unwrap() {
            if sid == SectionId::LineStructs {
                lines::read(&mut ByteReader::new(body), |rec| got.push(owned(rec))).unwrap();
            }
        }
    };
    if bytes[0] == engine::wire::MsgType::FrameBundle as u8 {
        // A degraded connection's frames, bundled (`wire/bundle.rs`).
        let mut b = engine::wire::BundleReader::new(bytes).unwrap();
        while let Some(frame) = b.next_frame().unwrap() {
            one(frame);
        }
    } else {
        one(bytes);
    }
    got
}

/// Steps `n` ticks, collecting client 0's `LineStructs` records.
fn run(lb: &mut Loopback<LrGame>, n: u32, log: &mut Vec<Rec>) {
    for _ in 0..n {
        lb.step();
        log.extend(records(lb, 0));
    }
}

fn puts_of(log: &[Rec], l: LineId) -> usize {
    log.iter().filter(|r| r.0 == l && r.1.is_some()).count()
}

fn gones_of(log: &[Rec], l: LineId) -> usize {
    log.iter().filter(|r| r.0 == l && r.1.is_none()).count()
}

/// One client at tile (32, 16) holding the chunks around the origin; at tick 15 one line along
/// row 16 from tile 16 for 32 tiles (chunks (0, 0) and (1, 0)). Returns the line's id.
fn routed_world() -> (Loopback<LrGame>, LineId, Vec<Rec>) {
    IDS.with(|i| i.borrow_mut().clear());
    let mut lb = Loopback::<LrGame>::new(params());
    lb.host.set_hash_mode(HashMode::All);
    lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(0, camera(32, 16));
    at(15, |t| {
        let l = t.create(32 * 256, 24).unwrap();
        t.set_segments(l, &[east(16, 16, 32)]).unwrap();
        IDS.with(|i| i.borrow_mut().push(l));
    });
    let mut log = Vec::new();
    run(&mut lb, 20, &mut log);
    let l = id(0);
    (lb, l, log)
}

/// 0078 §4: a line spanning two held chunks is sent once; a version not bumped is never resent
/// (chunks entering on a pan that the line crosses); a structure change is sent once; the line
/// stays while any chunk of its set is held and is `Gone` once when the last leaves; a destroy is
/// `Gone`. Hash-all all along: no desync on either side.
#[test]
fn host_routes_structures_by_chunk_set() {
    let (mut lb, l, mut log) = routed_world();
    assert_eq!(
        puts_of(&log, l),
        1,
        "sent once although it spans (0, 0) and (1, 0)"
    );
    let held = |lb: &Loopback<LrGame>, l| lb.client(0).replica().transport().len(l).is_ok();
    assert!(held(&lb, l));
    assert_eq!(
        lb.client(0).replica().region_hash(),
        lb.host.region_hash(lb.conn(0)),
        "the region hashes cover the anchored structure"
    );

    // A pan along the line: chunks it crosses enter and leave; nothing about it is resent.
    lb.set_camera(0, camera(60, 16));
    run(&mut lb, 40, &mut log);
    assert_eq!(puts_of(&log, l), 1, "no version bump, no resend");

    // A second line, then its speed: one put each.
    let now = lb.host.sim().unwrap().tick().0;
    at(now + 3, |t| {
        let m = t.create(4 * 256, 24).unwrap();
        t.set_segments(m, &[east(40, 20, 4)]).unwrap();
        IDS.with(|i| i.borrow_mut().push(m));
    });
    at(now + 8, move |t| t.set_speed(l, 12).unwrap());
    run(&mut lb, 20, &mut log);
    let m = id(1);
    assert_eq!(puts_of(&log, m), 1);
    assert_eq!(puts_of(&log, l), 2, "the speed change, once");
    assert_eq!(lb.client(0).replica().transport().speed(l), Ok(12));

    // East: the view covers chunks 4 and 5, so (0, 0) is beyond ring 3 and leaves while (1, 0)
    // stays held: the line stays, nothing is sent for it.
    lb.set_camera(0, camera(4 * 32 + 16, 16));
    run(&mut lb, 200, &mut log);
    let held_chunks = lb.host.debug_held(lb.conn(0));
    assert!(
        !held_chunks.contains(&ChunkCoord::new(0, 0)),
        "the front chunk left"
    );
    assert!(
        held_chunks.contains(&ChunkCoord::new(1, 0)),
        "the second chunk is held"
    );
    assert!(held(&lb, l), "held through (1, 0)");
    assert_eq!(gones_of(&log, l), 0);
    // Farther: everything the line crosses leaves, and the line is `Gone`, once.
    lb.set_camera(0, camera(64 + 120, 16));
    run(&mut lb, 200, &mut log);
    assert_eq!(
        gones_of(&log, l),
        1,
        "gone once, when the last chunk of its set left"
    );
    assert!(!held(&lb, l));
    assert_eq!(gones_of(&log, m), 1);
    assert_eq!(puts_of(&log, l), 2, "nothing more was sent");

    // Back over the line: put again (a fresh hold), then destroyed: gone.
    lb.set_camera(0, camera(32, 16));
    run(&mut lb, 40, &mut log);
    assert_eq!(puts_of(&log, l), 3);
    let now = lb.host.sim().unwrap().tick().0 + 2;
    at(now, move |t| {
        t.destroy(l, &mut |_| {}).unwrap();
    });
    run(&mut lb, 5, &mut log);
    assert_eq!(gones_of(&log, l), 2, "destroy sends gone");
    assert!(!held(&lb, l));
    assert_eq!(lb.client(0).desyncs().count(), 0, "hash-all saw no desync");
    assert_eq!(lb.host.desyncs().count(), 0);
}

// -- review round: budget, deferral, overflow ----------------------------------------------------

fn params_with(max_lines: u32) -> WorldParams<LrGame> {
    WorldParams {
        max_lines,
        max_items: 1024,
        ..params()
    }
}

/// A two-segment one-tile line in tile `(x, y)` (half a tile east, then half a tile south).
fn tile_line(x: i32, y: i32) -> [Segment; 2] {
    let c = WorldPos {
        x: x * TILE + 64,
        y: y * TILE + 64,
    };
    let mid = WorldPos {
        x: c.x + 128,
        y: c.y,
    };
    [
        Segment {
            len: 128,
            geometry: Geometry::Straight { from: c, to: mid },
        },
        Segment {
            len: 128,
            geometry: Geometry::Straight {
                from: mid,
                to: WorldPos {
                    x: mid.x,
                    y: mid.y + 128,
                },
            },
        },
    ]
}

/// The `LineStructs` records of every client's last built frame, and whether each built a frame.
fn step_all(lb: &mut Loopback<LrGame>, clients: usize, logs: &mut [Vec<Rec>]) -> Vec<bool> {
    lb.step();
    (0..clients)
        .map(|i| {
            logs[i].extend(records(lb, i));
            lb.last_build_frame_len(i) > 0
        })
        .collect()
}

/// Frames keep reaching the client: none overflowed, and the client's last frame is at most 11
/// ticks behind the host's clock (a quiet connection hears a heartbeat every 500 ms, 10 ticks, and
/// the host's clock is already one past the last frame's tick). A stalled connection hears
/// nothing at all.
fn assert_flowing(lb: &Loopback<LrGame>, tick: u32) {
    assert_eq!(
        lb.host.debug_overflows(lb.conn(0)),
        0,
        "overflow at tick {tick}"
    );
    let host = lb.host.sim().unwrap().tick().0;
    let client = lb.client(0).last_summary().tick.0;
    assert!(
        host - client <= 11,
        "frames stalled at tick {tick}: host {host}, client {client}"
    );
}

/// Finding 1 of the M46 review: more structure puts fall due in one tick than a 64 KiB frame holds
/// (2,000 two-segment lines, 53 B a put, created in one tick, then all re-sped in one tick). The
/// puts spill over several frames under the byte budget; frames keep reaching the client, none
/// overflows, every structure arrives, and hash-all sees no desync (the frames that defer a held
/// line's put carry no chunk hash).
#[test]
fn host_puts_spill_over_frames() {
    const N: i32 = 2_000;
    IDS.with(|i| i.borrow_mut().clear());
    let mut lb = Loopback::<LrGame>::new(params_with(8_192));
    lb.host.set_hash_mode(HashMode::All);
    lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(0, camera(32, 16));
    let mut logs = vec![Vec::new()];
    for _ in 0..12 {
        step_all(&mut lb, 1, &mut logs);
    }
    let now = lb.host.sim().unwrap().tick().0;
    at(now, |t| {
        for k in 0..N {
            let l = t.create(256, 24).unwrap();
            t.set_segments(l, &tile_line(k % 64, k / 64)).unwrap();
            IDS.with(|i| i.borrow_mut().push(l));
        }
    });
    let held = |lb: &Loopback<LrGame>| lb.client(0).replica().transport().lines_len();
    let mut frames_with_puts = 0;
    for tick in 0..20 {
        let before = logs[0].len();
        step_all(&mut lb, 1, &mut logs);
        assert_flowing(&lb, tick);
        if logs[0].len() > before {
            frames_with_puts += 1;
        }
    }
    assert_eq!(held(&lb), N as u32, "every structure arrived");
    assert!(
        frames_with_puts >= 2,
        "the puts spilled over {frames_with_puts} frames"
    );
    assert_eq!(
        lb.host.debug_overflows(lb.conn(0)),
        0,
        "no frame overflowed"
    );

    // Every held line changes in one tick (2,000 changes, under the list's 2,048).
    let now = lb.host.sim().unwrap().tick().0;
    at(now, |t| {
        for k in 0..N as usize {
            t.set_speed(id(k), 12).unwrap();
        }
    });
    let mut frames_with_puts = 0;
    for tick in 0..20 {
        let before = logs[0].len();
        step_all(&mut lb, 1, &mut logs);
        assert_flowing(&lb, tick);
        if logs[0].len() > before {
            frames_with_puts += 1;
        }
    }
    assert!(frames_with_puts >= 2);
    let tr = lb.client(0).replica().transport();
    for k in 0..N as usize {
        assert_eq!(tr.speed(id(k)), Ok(12), "line {k} re-sped");
    }
    assert_eq!(lb.host.debug_overflows(lb.conn(0)), 0);
    assert_eq!(
        lb.client(0).replica().region_hash(),
        lb.host.region_hash(lb.conn(0))
    );
    assert_eq!(lb.client(0).desyncs().count(), 0, "hash-all saw no desync");
}

/// Finding 2a: lines anchored far outside the held chunks whose paths cross into the view arrive
/// when the view's chunks enter (the enter scan), past one frame's put budget (a 16 KiB frame
/// buffer: 4 KiB of puts a frame), so the deferred ones go out over the next frames.
#[test]
fn host_delivers_deferred_lines_crossing_into_the_view() {
    const ROWS: i32 = 30;
    const PER_ROW: i32 = 10;
    IDS.with(|i| i.borrow_mut().clear());
    let mut lb = Loopback::<LrGame>::new(params_with(8_192));
    lb.host.set_hash_mode(HashMode::All);
    lb.set_frame_buf_len(16 * 1024);
    lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(0, camera(-3000, -3000));
    // Each line runs west from tile 160 + k to tile 8 along a row of chunk row 0: anchored in
    // chunk (5, 0), which the view never holds.
    at(5, |t| {
        for y in 0..ROWS {
            for k in 0..PER_ROW {
                let x0 = 160 + k;
                let tiles = (x0 - 8) as u32;
                let l = t.create(tiles * 256, 24).unwrap();
                let seg = Segment {
                    len: tiles * 256,
                    geometry: Geometry::Straight {
                        from: WorldPos {
                            x: x0 * TILE + 128,
                            y: y * TILE + 128,
                        },
                        to: WorldPos {
                            x: 8 * TILE + 128,
                            y: y * TILE + 128,
                        },
                    },
                };
                t.set_segments(l, &[seg]).unwrap();
                IDS.with(|i| i.borrow_mut().push(l));
            }
        }
    });
    let mut logs = vec![Vec::new()];
    for _ in 0..10 {
        step_all(&mut lb, 1, &mut logs);
    }
    assert!(
        logs[0].is_empty(),
        "nothing routed while the view is elsewhere"
    );
    lb.set_camera(0, camera(16, 16));
    let mut frames_with_puts = 0;
    for _ in 0..40 {
        let before = logs[0].len();
        step_all(&mut lb, 1, &mut logs);
        if logs[0].len() > before {
            frames_with_puts += 1;
        }
    }
    let total = (ROWS * PER_ROW) as usize;
    let anchor = lb.client(0).replica().transport().anchor(id(0), dims());
    assert_eq!(
        anchor,
        Ok(Some(ChunkCoord::new(5, 0))),
        "anchored outside the view"
    );
    assert!(
        !lb.host
            .debug_held(lb.conn(0))
            .contains(&ChunkCoord::new(5, 0))
    );
    assert_eq!(
        lb.client(0).replica().transport().lines_len() as usize,
        total,
        "every crossing line delivered"
    );
    assert!(
        frames_with_puts >= 3,
        "deferred past the budget: {frames_with_puts} frames"
    );
    assert_eq!(logs[0].len(), total, "each sent once");
    assert_eq!(lb.client(0).desyncs().count(), 0);
}

/// Finding 2c: more structure changes in one tick than the change list holds (20 against
/// `max_lines / 4` = 16) overflow it; the plan reconciles every line once and both clients
/// converge, each line re-sent once.
#[test]
fn host_change_list_overflow_reconciles() {
    const N: usize = 20;
    IDS.with(|i| i.borrow_mut().clear());
    let mut lb = Loopback::<LrGame>::new(params_with(64));
    lb.host.set_hash_mode(HashMode::All);
    for _ in 0..2 {
        lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    }
    lb.set_camera(0, camera(32, 16));
    lb.set_camera(1, camera(16, 32));
    at(3, |t| {
        for k in 0..N as i32 {
            let l = t.create(256, 24).unwrap();
            t.set_segments(l, &tile_line(k, 4)).unwrap();
            IDS.with(|i| i.borrow_mut().push(l));
        }
    });
    let mut logs = vec![Vec::new(), Vec::new()];
    for _ in 0..12 {
        step_all(&mut lb, 2, &mut logs);
    }
    let now = lb.host.sim().unwrap().tick().0;
    at(now, |t| {
        for k in 0..N {
            t.set_speed(id(k), 12).unwrap();
        }
    });
    // 20 changes against a list of `max_lines / 4` = 16 (drained at `seal`, so the flag itself is
    // gone before a test can read it).
    let cap = lb
        .host
        .sim()
        .unwrap()
        .authority()
        .store()
        .transport()
        .max_lines()
        / 4;
    assert!((N as u32) > cap, "{N} changes overflow a list of {cap}");
    for _ in 0..10 {
        step_all(&mut lb, 2, &mut logs);
    }
    for (i, log) in logs.iter().enumerate() {
        let tr = lb.client(i).replica().transport();
        for k in 0..N {
            assert_eq!(tr.speed(id(k)), Ok(12), "client {i} line {k}");
            assert_eq!(puts_of(log, id(k)), 2, "created once, re-sped once");
        }
        assert_eq!(
            lb.client(i).replica().region_hash(),
            lb.host.region_hash(lb.conn(i))
        );
        assert_eq!(lb.client(i).desyncs().count(), 0);
    }
}
