//! Own test binary (mirrors `no_alloc_codec.rs`/`no_alloc_store.rs`: a `#[global_allocator]` only
//! counts allocations made inside the binary that installs it, so this cannot be an inline
//! `#[cfg(test)]` module inside `wire/mod.rs` itself). Budget (docs/plan/14-wire-framing.md
//! Budgets): "Zero allocation in encode/decode." Setup (building the `Store`, the frame buffer)
//! happens outside the measured region; only the wire encode/decode calls themselves are checked.

use engine::abi::Arena;
use engine::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::sim::{Applied, Outcome};
use engine::store::Store;
use engine::wire::{
    ActionResultsReader, ActionResultsWriter, ChunkCoordListReader, ChunkCoordListWriter,
    FrameHeader, FrameReader, FrameWriter, SectionId, SnapshotReader, SnapshotWriter,
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
    ];
    let chunks = [ChunkCoord::new(0, 0), ChunkCoord::new(1, 0)];
    let mut buf = vec![0u8; 16 * 1024];

    // --- encode ---
    let before = live();
    let n = {
        use engine::bytes::SliceSink;
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 42,
                ack_seq: 1,
            },
        );
        fw.section(SectionId::ActionResults, |s| {
            ActionResultsWriter::write(s, outcomes.iter());
        });
        fw.section(SectionId::ChunkEnterPristine, |s| {
            let mut w = ChunkCoordListWriter::new();
            w.write(s, ChunkCoord::new(3, 3));
        });
        fw.section(SectionId::ChunkSnapshots, |s| {
            let mut w = SnapshotWriter::new();
            for &c in &chunks {
                w.write_chunk(s, &store, c, 42);
            }
        });
        sink.finish().unwrap()
    };
    assert_eq!(live(), before, "wire encode allocated");

    // --- decode ---
    let before = live();
    {
        let mut r = FrameReader::new(&buf[..n]).unwrap();
        let mut total_results = 0;
        let mut total_chunks = 0;
        while let Some((id, body)) = r.next_section().unwrap() {
            let mut br = engine::bytes::ByteReader::new(body);
            match id {
                SectionId::ActionResults => {
                    ActionResultsReader::read::<NoAllocGame>(&mut br, |_, _| total_results += 1)
                        .unwrap();
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
                _ => {}
            }
        }
        assert_eq!(total_results, 2);
        assert_eq!(total_chunks, 2); // one entity in each of the two chunks
    }
    assert_eq!(live(), before, "wire decode allocated");
}
