//! Chunk snapshots (Planning decisions "Chunk snapshot entry"): `coord (list coding) · version u32
//! LE · overlay runs · n varint x (EntityId varint, Codec entity)`.
//!
//! [`encode_chunk_snapshot`] writes only the *content* half (version, overlay runs, entity puts):
//! it is also the canonical form M31 hashes per chunk (0013 "Per-chunk desync hashes"), so it must
//! be self-contained and independent of any other chunk's bytes -- it cannot depend on a delta-
//! coded coordinate chained from a previous chunk. [`SnapshotWriter`] is the section-level type
//! that *does* chain coordinates (via its own [`ChunkCoordListWriter`]) across the several chunks a
//! real `ChunkSnapshots` section holds, calling [`encode_chunk_snapshot`] for each entry's content.
//!
//! "Every entity whose scope includes the chunk" (0011 Scopes) is, as of M12b, exactly "every
//! entity anchored to that chunk": `Authority`'s own scope derivation is anchor-chunk-only until
//! M21 widens it to the full footprint (`crate::authority::Scopes` doc comment), so a snapshot's
//! entity list matches exactly what live deltas would deliver for this chunk today.

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{self, encode_to};
use crate::game::{EntityId, Game};
use crate::store::Store;
use crate::world::ChunkCoord;

use super::{
    ChunkCoordListReader, ChunkCoordListWriter, OverlayRunsReader, OverlayRunsWriter, WireError,
    varint_u32,
};

/// Writes one chunk's snapshot *content*: `version u32 LE`, overlay runs, then every entity
/// **overlapping** `chunk` (0007 §5, widened from M14's anchor-chunk-only filter: docs/plan/
/// 21-entities-and-timers.md Scope, "`encode_chunk_snapshot`'s entity filter" widens together with
/// `Authority`'s scope derivation and M15's frame builder) as `(EntityId varint, Codec entity)`.
/// Does not write `chunk` itself (module doc comment); reused unmodified both by [`SnapshotWriter`]
/// and by M31's per-chunk hash. Reads `Store::chunk_overlapping` (a `ChunkIndex` lookup, already
/// ascending and deduplicated) instead of M14's own `O(all entities)` scan -- a side effect of the
/// widening, not a separate optimisation pass (M14 Deviations flagged the old scan as "a known
/// cost to measure ... not a defect to fix blind"; the fix falls out of `ChunkIndex` existing).
pub fn encode_chunk_snapshot<G: Game>(
    store: &Store<G>,
    chunk: ChunkCoord,
    version: u32,
    sink: &mut (impl ByteSink + ?Sized),
) {
    sink.put_u32(version);
    match store.terrain().overlay(chunk) {
        Some(overlay) => OverlayRunsWriter::write(sink, overlay.entries()),
        None => OverlayRunsWriter::write(sink, core::iter::empty()),
    }
    let overlapping = store.chunk_overlapping(chunk);
    sink.put_varint(overlapping.len() as u64);
    for &id in overlapping {
        if let Some(entity) = store.entity(id) {
            sink.put_varint(id.0 as u64);
            encode_to(entity, sink).expect("encoding an entity into a ByteSink cannot fail");
        }
    }
}

/// The section-level writer for `ChunkSnapshots` (id 5): chains chunk coordinates across several
/// [`SnapshotWriter::write_chunk`] calls, delegating each entry's content to
/// [`encode_chunk_snapshot`]. Construct one fresh per [`super::FrameWriter::section`] body call
/// (module doc comment on `crate::wire`, "The 'measure, then write' trick").
#[derive(Default)]
pub struct SnapshotWriter {
    coords: ChunkCoordListWriter,
}

impl SnapshotWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_chunk<G: Game>(
        &mut self,
        sink: &mut (impl ByteSink + ?Sized),
        store: &Store<G>,
        chunk: ChunkCoord,
        version: u32,
    ) {
        self.coords.write(sink, chunk);
        encode_chunk_snapshot(store, chunk, version, sink);
    }
}

/// The read half of [`SnapshotWriter`]. `on_tile`/`on_entity` are called for every overlay tile and
/// entity put of the chunk [`SnapshotReader::read_chunk`] just read.
#[derive(Default)]
pub struct SnapshotReader {
    coords: ChunkCoordListReader,
}

impl SnapshotReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads one chunk entry, returning its coordinate and version.
    pub fn read_chunk<G: Game>(
        &mut self,
        r: &mut ByteReader,
        mut on_tile: impl FnMut(u16, crate::world::Tile),
        mut on_entity: impl FnMut(EntityId, G::Entity),
    ) -> Result<(ChunkCoord, u32), WireError> {
        let coord = self.coords.read(r)?;
        let version = r.u32().map_err(WireError::from)?;
        OverlayRunsReader::read(r, &mut on_tile)?;
        let n = varint_u32(r)?;
        for _ in 0..n {
            let id = EntityId(varint_u32(r)?);
            let bytes = r.rest();
            let (entity, rest) = codec::decode::<G::Entity>(bytes).map_err(WireError::from)?;
            let consumed = bytes.len() - rest.len();
            r.bytes(consumed).map_err(WireError::from)?;
            on_entity(id, entity);
        }
        Ok((coord, version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{
        CacheCapacity, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    };
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct SEntity {
        anchor: (i32, i32),
        hp: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct SPlayer {
        score: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct SGlobal {
        day: u32,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct SReject;
    impl From<Unknown> for SReject {
        fn from(_: Unknown) -> Self {
            SReject
        }
    }
    struct SGen;
    impl Worldgen for SGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct SGame;
    impl Game for SGame {
        const SCHEMA_VERSION: u32 = 1;
        // Matches `store_with_data`'s own `ChunkDims::new(4)` (edge 16): `chunk_of::<G>` derives
        // the chunk edge from `G::CHUNK_BITS`, not from the `TerrainStore` it happens to be paired
        // with (`Sim::genesis` always builds both from the same `G::CHUNK_BITS`; a hand-built test
        // store must match that by hand).
        const CHUNK_BITS: u32 = 4;
        type Worldgen = SGen;
        type Action = ();
        type Reject = SReject;
        type Entity = SEntity;
        type Player = SPlayer;
        type Global = SGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &SEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(e: &SEntity) -> TilePos {
            TilePos::new(e.anchor.0, e.anchor.1)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), SReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn store_with_data() -> Store<SGame> {
        use crate::delta::Delta;
        let terrain = TerrainStore::new(
            ChunkDims::new(4), // edge 16
            Box::new(ZeroSource),
            CacheCapacity::Chunks(16),
        );
        let mut s = Store::new(terrain, SGlobal { day: 0 });
        // Chunk (0,0): tile overlay + two entities anchored there.
        s.apply(&Delta::Tile {
            pos: TilePos::new(3, 3),
            tile: Tile::new(9, 0, 0),
        });
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: SEntity {
                anchor: (1, 1),
                hp: 10,
            },
        });
        s.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: SEntity {
                anchor: (2, 2),
                hp: 20,
            },
        });
        // Chunk (1,0): one entity, no overlay -- proves entities are filtered per chunk.
        s.apply(&Delta::EntityPut {
            id: EntityId(3),
            entity: SEntity {
                anchor: (17, 1),
                hp: 30,
            },
        });
        s
    }

    use crate::world::TerrainStore;

    #[test]
    fn roundtrip_chunk_with_overlay_and_entities() {
        let s = store_with_data();
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        encode_chunk_snapshot(&s, ChunkCoord::new(0, 0), 42, &mut sink);
        let n = sink.finish().unwrap();

        let mut r = ByteReader::new(&buf[..n]);
        let version = r.u32().unwrap();
        assert_eq!(version, 42);
        let mut tiles = Vec::new();
        OverlayRunsReader::read(&mut r, |i, t| tiles.push((i, t))).unwrap();
        assert_eq!(
            tiles,
            vec![(
                ChunkDims::new(4).local_index(TilePos::new(3, 3)),
                Tile::new(9, 0, 0)
            )]
        );

        let n_entities = varint_u32(&mut r).unwrap();
        assert_eq!(n_entities, 2);
        let mut got = Vec::new();
        for _ in 0..2 {
            let id = EntityId(varint_u32(&mut r).unwrap());
            let bytes = r.rest();
            let (e, rest): (SEntity, _) = codec::decode(bytes).unwrap();
            let consumed = bytes.len() - rest.len();
            r.bytes(consumed).unwrap();
            got.push((id, e));
        }
        assert_eq!(
            got,
            vec![
                (
                    EntityId(1),
                    SEntity {
                        anchor: (1, 1),
                        hp: 10
                    }
                ),
                (
                    EntityId(2),
                    SEntity {
                        anchor: (2, 2),
                        hp: 20
                    }
                ),
            ]
        );
    }

    #[test]
    fn other_chunk_gets_only_its_own_entity() {
        let s = store_with_data();
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        encode_chunk_snapshot(&s, ChunkCoord::new(1, 0), 7, &mut sink);
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        let _version = r.u32().unwrap();
        OverlayRunsReader::read(&mut r, |_, _| panic!("chunk (1,0) has no overlay")).unwrap();
        let n_entities = varint_u32(&mut r).unwrap();
        assert_eq!(n_entities, 1);
    }

    #[test]
    fn snapshot_writer_chains_coords_and_round_trips_via_section_reader() {
        let s = store_with_data();
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        let mut w = SnapshotWriter::new();
        w.write_chunk(&mut sink, &s, ChunkCoord::new(0, 0), 1);
        w.write_chunk(&mut sink, &s, ChunkCoord::new(1, 0), 2);
        let n = sink.finish().unwrap();

        let mut r = ByteReader::new(&buf[..n]);
        let mut reader = SnapshotReader::new();
        let mut entities0 = Vec::new();
        let (c0, v0) = reader
            .read_chunk::<SGame>(&mut r, |_, _| {}, |id, e| entities0.push((id, e)))
            .unwrap();
        assert_eq!((c0, v0), (ChunkCoord::new(0, 0), 1));
        assert_eq!(entities0.len(), 2);

        let mut entities1 = Vec::new();
        let (c1, v1) = reader
            .read_chunk::<SGame>(&mut r, |_, _| {}, |id, e| entities1.push((id, e)))
            .unwrap();
        assert_eq!((c1, v1), (ChunkCoord::new(1, 0), 2));
        assert_eq!(
            entities1,
            vec![(
                EntityId(3),
                SEntity {
                    anchor: (17, 1),
                    hp: 30
                }
            )]
        );
    }

    #[test]
    fn golden_chunk_snapshot() {
        let s = store_with_data();
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        encode_chunk_snapshot(&s, ChunkCoord::new(0, 0), 42, &mut sink);
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_chunk_snapshot", &buf[..n]);
    }
}
