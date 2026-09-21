//! Own test binary (mirrors `no_alloc_codec.rs`/`no_alloc_store.rs`: a `#[global_allocator]` only
//! counts allocations made inside the binary that installs it, so this cannot be an inline
//! `#[cfg(test)]` module inside `wire/mod.rs` itself). Budget (docs/plan/14-wire-framing.md
//! Budgets): "Zero allocation in encode/decode." Setup (building the `Store`, the frame/uplink
//! buffers, the values to encode) happens outside the measured region; only the wire encode/decode
//! calls themselves are checked.
//!
//! Covers every one of the eight `wire/*.rs` files' write and read paths in the same two measured
//! regions (M14 fix round 1: the first version of this file measured only `mod.rs`, `coordlist.rs`,
//! `overlay_runs.rs`, `snapshot.rs` and `results.rs` -- a leaked `Vec` planted in `write_global`
//! went undetected). `deltas.rs`'s `EntityDeltaOp::Put`, `global.rs`'s `read_global`/
//! `read_own_player` and `results.rs`'s `Rejected::Game` tag all decode an *owned* game-typed value
//! (`codec::decode::<T>`, not a reference); 0011's "Decode path, no JS allocation" already requires
//! `G::Entity`/`G::Player`/`G::Action` (and, by the same reasoning, `G::Global`/`G::Reject`) to be
//! plain data with no `Vec`/`String`/`Box` for exactly this reason, so a compliant game's decode
//! cannot allocate either -- this fixture's types are plain integer/tuple fields, and the measured
//! region below confirms it empirically rather than just by argument.

use engine::abi::Arena;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::sim::{Applied, EngineReject, Outcome, Rejected};
use engine::store::Store;
use engine::wire::{
    ActionResultsReader, ActionResultsWriter, CameraReport, ChunkCoordListReader,
    ChunkCoordListWriter, EntityDeltaOp, EntityOp, FrameHeader, FrameReader, FrameWriter,
    SectionId, SnapshotReader, SnapshotWriter, UplinkReader, UplinkWriter, read_chunk_deltas,
    read_global, read_own_player, write_chunk_deltas, write_global, write_own_player,
};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, TerrainStore,
    Tile, TilePos,
};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocEntity {
    anchor: (i32, i32),
    hp: u32,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocPlayer {
    score: u32,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NoAllocGlobal {
    day: u32,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NoAllocReject;
impl From<Unknown> for NoAllocReject {
    fn from(_: Unknown) -> Self {
        NoAllocReject
    }
}
struct NoAllocGen;
impl Worldgen for NoAllocGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}
struct NoAllocGame;
impl Game for NoAllocGame {
    const SCHEMA_VERSION: u32 = 1;
    const CHUNK_BITS: u32 = 4;
    type Worldgen = NoAllocGen;
    type Action = ();
    type Reject = NoAllocReject;
    type Entity = NoAllocEntity;
    type Player = NoAllocPlayer;
    type Global = NoAllocGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &NoAllocEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(e: &NoAllocEntity) -> TilePos {
        TilePos::new(e.anchor.0, e.anchor.1)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), NoAllocReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn store_with_data() -> Store<NoAllocGame> {
    use engine::delta::Delta;
    let terrain = TerrainStore::new(
        ChunkDims::new(4),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(16),
    );
    let mut s = Store::new(terrain, NoAllocGlobal { day: 0 });
    s.apply(&Delta::Tile {
        pos: TilePos::new(1, 1),
        tile: Tile::new(3, 0, 0),
    });
    s.apply(&Delta::Tile {
        pos: TilePos::new(2, 1),
        tile: Tile::new(3, 0, 0),
    });
    s.apply(&Delta::EntityPut {
        id: EntityId(1),
        entity: NoAllocEntity {
            anchor: (0, 0),
            hp: 10,
        },
    });
    s.apply(&Delta::EntityPut {
        id: EntityId(2),
        entity: NoAllocEntity {
            anchor: (5, 0),
            hp: 20,
        },
    });
    s
}

#[test]
fn encode_decode_no_alloc() {
    let store = store_with_data();
    let outcomes = [
        Outcome::<NoAllocGame> {
            seq: 1,
            result: Ok(Applied),
        },
        Outcome::<NoAllocGame> {
            seq: 2,
            result: Ok(Applied),
        },
        // `Rejected::Game` decodes an owned `G::Reject` (`codec::decode`, not a reference) --
        // exercised here so `results.rs`'s allocation-prone path is actually measured, not just
        // its `Applied` tag.
        Outcome::<NoAllocGame> {
            seq: 3,
            result: Err(Rejected::Game(NoAllocReject)),
        },
        Outcome::<NoAllocGame> {
            seq: 4,
            result: Err(Rejected::Engine(EngineReject::RateLimited)),
        },
    ];
    let chunks = [ChunkCoord::new(0, 0), ChunkCoord::new(1, 0)];
    let roster = [(PlayerId(1), true), (PlayerId(2), false)];
    let global_value = NoAllocGlobal { day: 7 };
    let own_player = NoAllocPlayer { score: 99 };
    let delta_tiles: [(u16, Tile); 1] = [(0, Tile::new(4, 0, 0))];
    let delta_groups = [(ChunkCoord::new(2, 0), delta_tiles.as_slice())];
    let delta_entity = NoAllocEntity {
        anchor: (33, 0),
        hp: 3,
    };
    let delta_ops = [
        EntityOp::Put {
            id: EntityId(3),
            entity: &delta_entity,
        },
        EntityOp::Gone { id: EntityId(4) },
    ];
    let camera = CameraReport {
        center_x: 12,
        center_y: -8,
        half_w: 20,
        half_h: 11,
        vel_x: 2,
        vel_y: -1,
    };
    let action_bytes = [9u8, 8, 7];
    let presence_bytes = [1u8, 2, 3, 4];

    let mut buf = vec![0u8; 16 * 1024];
    let mut uplink_buf = vec![0u8; 1024];

    // --- encode: every wire file's write path, one FrameWriter plus one standalone uplink batch
    let before = live();
    let (n, un) = {
        use engine::bytes::SliceSink;
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 42,
                ack_seq: 1,
            },
        );
        // results.rs
        fw.section(SectionId::ActionResults, |s| {
            ActionResultsWriter::write(s, outcomes.iter());
        });
        // global.rs (both halves: roster + OwnPlayer)
        fw.section(SectionId::Global, |s| {
            write_global::<NoAllocGame>(s, Some(roster.iter().copied()), Some(&global_value));
        });
        fw.section(SectionId::OwnPlayer, |s| {
            write_own_player::<NoAllocGame>(s, PlayerId(1), &own_player);
        });
        // coordlist.rs
        fw.section(SectionId::ChunkEnterPristine, |s| {
            let mut w = ChunkCoordListWriter::new();
            w.write(s, ChunkCoord::new(3, 3));
        });
        // snapshot.rs (which itself calls overlay_runs.rs)
        fw.section(SectionId::ChunkSnapshots, |s| {
            let mut w = SnapshotWriter::new();
            for &c in &chunks {
                w.write_chunk(s, &store, c, 42);
            }
        });
        // deltas.rs
        fw.section(SectionId::ChunkDeltas, |s| {
            write_chunk_deltas::<NoAllocGame>(s, &delta_groups, &delta_ops);
        });
        let n = sink.finish().unwrap();

        // uplink.rs (a separate top-level message, not a frame section) + its CameraReport
        let mut usink = SliceSink::new(&mut uplink_buf);
        UplinkWriter::write(
            &mut usink,
            7,
            [(1u32, action_bytes.as_slice())].into_iter(),
            Some(camera),
            Some(&presence_bytes),
        );
        let un = usink.finish().unwrap();

        (n, un)
    };
    assert_eq!(live(), before, "wire encode allocated");

    // --- decode: every wire file's read path
    let before = live();
    {
        let mut r = FrameReader::new(&buf[..n]).unwrap();
        let mut total_results = 0;
        let mut total_chunks = 0;
        let mut got_roster = 0;
        let mut got_global = None;
        let mut got_own_player = None;
        let mut got_delta_tiles = 0;
        let mut got_delta_ops = 0;
        while let Some((id, body)) = r.next_section().unwrap() {
            let mut br = engine::bytes::ByteReader::new(body);
            match id {
                SectionId::ActionResults => {
                    ActionResultsReader::read::<NoAllocGame>(&mut br, |_, _| total_results += 1)
                        .unwrap();
                }
                SectionId::Global => {
                    got_global =
                        read_global::<NoAllocGame>(&mut br, |_, _| got_roster += 1).unwrap();
                }
                SectionId::OwnPlayer => {
                    got_own_player = Some(read_own_player::<NoAllocGame>(&mut br).unwrap());
                }
                SectionId::ChunkEnterPristine => {
                    let mut reader = ChunkCoordListReader::new();
                    while !br.rest().is_empty() {
                        reader.read(&mut br).unwrap();
                    }
                }
                SectionId::ChunkSnapshots => {
                    let mut reader = SnapshotReader::new();
                    while !br.rest().is_empty() {
                        reader
                            .read_chunk::<NoAllocGame>(&mut br, |_, _| {}, |_, _| total_chunks += 1)
                            .unwrap();
                    }
                }
                SectionId::ChunkDeltas => {
                    read_chunk_deltas::<NoAllocGame>(
                        &mut br,
                        |_, _, _| got_delta_tiles += 1,
                        |_op: EntityDeltaOp<NoAllocGame>| got_delta_ops += 1,
                    )
                    .unwrap();
                }
                _ => {}
            }
        }
        assert_eq!(total_results, 4);
        assert_eq!(total_chunks, 2); // one entity in each of the two chunks
        assert_eq!(got_roster, 2);
        assert_eq!(got_global, Some(global_value));
        assert_eq!(got_own_player, Some((PlayerId(1), own_player)));
        assert_eq!(got_delta_tiles, 1);
        assert_eq!(got_delta_ops, 2);

        // uplink.rs + CameraReport
        let mut got_actions = 0;
        let batch = UplinkReader::read(&uplink_buf[..un], |_, _| got_actions += 1).unwrap();
        assert_eq!(got_actions, 1);
        assert_eq!(batch.camera, Some(camera));
        assert_eq!(batch.presence, Some(presence_bytes.as_slice()));
    }
    assert_eq!(live(), before, "wire decode allocated");
}
