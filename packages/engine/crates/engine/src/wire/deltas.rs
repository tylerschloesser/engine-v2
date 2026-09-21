//! `ChunkDeltas` (section 7, Planning decisions "ChunkDeltas"): tile groups (`n_chunks`, per chunk
//! coord + `n varint` x `(index-gap varint, tile u32)`), then one flat entity-op list running to
//! the end of the section body (no count of its own -- the section's own length, from
//! `FrameReader`, bounds it). Entities are not grouped by chunk: the `Codec` value carries its own
//! anchor, and 0011 requires "one op must not repeat per overlapped chunk" -- the caller (M15) is
//! responsible for building that de-duplicated list; this module only encodes/decodes it.
//!
//! No dedicated `Writer`/`Reader` struct: unlike `ChunkSnapshots`/`ActionResults`, M15's own
//! `ChangeLog` shape (a plain ordered list of already-scoped deltas) maps directly onto plain
//! functions over slices, so nothing stateful needs to be threaded across calls beyond the
//! coordinate cursor these functions already own internally.

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{self, encode_to};
use crate::game::{EntityId, Game};
use crate::world::{ChunkCoord, Tile};

use super::{ChunkCoordListReader, ChunkCoordListWriter, WireError, varint_u32};

/// One entity op to write (borrowed: the writer never needs ownership).
pub enum EntityOp<'a, G: Game> {
    Put { id: EntityId, entity: &'a G::Entity },
    Gone { id: EntityId },
}

/// One entity op as decoded (owned: `codec::decode` produces an owned value).
pub enum EntityDeltaOp<G: Game> {
    Put(EntityId, G::Entity),
    Gone(EntityId),
}

/// `tile_groups`: `(chunk, tiles)` pairs, `tiles` ascending by local index within the chunk, groups
/// sorted by `(cy, cx)` (the same invariant [`ChunkCoordListWriter`] expects everywhere else).
/// `entity_ops` in write order.
pub fn write_chunk_deltas<G: Game>(
    sink: &mut (impl ByteSink + ?Sized),
    tile_groups: &[(ChunkCoord, &[(u16, Tile)])],
    entity_ops: &[EntityOp<'_, G>],
) {
    sink.put_varint(tile_groups.len() as u64);
    let mut coords = ChunkCoordListWriter::new();
    for (coord, tiles) in tile_groups {
        coords.write(sink, *coord);
        sink.put_varint(tiles.len() as u64);
        let mut prev_index: i64 = -1;
        for &(index, tile) in tiles.iter() {
            let gap = index as i64 - (prev_index + 1);
            debug_assert!(gap >= 0, "tile group entries must be ascending by index");
            sink.put_varint(gap as u64);
            sink.put(&tile.to_le_bytes());
            prev_index = index as i64;
        }
    }
    for op in entity_ops {
        match op {
            EntityOp::Put { id, entity } => {
                sink.put_u8(0);
                sink.put_varint(id.0 as u64);
                encode_to(*entity, sink).expect("encoding an entity into a ByteSink cannot fail");
            }
            EntityOp::Gone { id } => {
                sink.put_u8(1);
                sink.put_varint(id.0 as u64);
            }
        }
    }
}

/// Reads a `ChunkDeltas` section body written by [`write_chunk_deltas`]. `on_tile(chunk, index,
/// tile)` fires for every tile group entry; `on_entity_op` for every entity op, in write order.
pub fn read_chunk_deltas<G: Game>(
    r: &mut ByteReader,
    mut on_tile: impl FnMut(ChunkCoord, u16, Tile),
    mut on_entity_op: impl FnMut(EntityDeltaOp<G>),
) -> Result<(), WireError> {
    let n_chunks = varint_u32(r)?;
    let mut coords = ChunkCoordListReader::new();
    for _ in 0..n_chunks {
        let coord = coords.read(r)?;
        let n_tiles = varint_u32(r)?;
        let mut prev_index: i64 = -1;
        for _ in 0..n_tiles {
            let gap = varint_u32(r)? as i64;
            let index = prev_index + 1 + gap;
            if index > u16::MAX as i64 {
                return Err(WireError::Malformed);
            }
            let bytes = r.bytes(4).map_err(WireError::from)?;
            let tile = Tile(u32::from_le_bytes(bytes.try_into().unwrap()));
            on_tile(coord, index as u16, tile);
            prev_index = index;
        }
    }
    while !r.rest().is_empty() {
        let op = r.u8().map_err(WireError::from)?;
        match op {
            0 => {
                let id = EntityId(varint_u32(r)?);
                let bytes = r.rest();
                let (entity, rest) = codec::decode::<G::Entity>(bytes).map_err(WireError::from)?;
                let consumed = bytes.len() - rest.len();
                r.bytes(consumed).map_err(WireError::from)?;
                on_entity_op(EntityDeltaOp::Put(id, entity));
            }
            1 => {
                let id = EntityId(varint_u32(r)?);
                on_entity_op(EntityDeltaOp::Gone(id));
            }
            _ => return Err(WireError::Malformed),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{PrototypeId, Registry, TilePos};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DEntity {
        hp: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct DGlobal;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct DReject;
    impl From<Unknown> for DReject {
        fn from(_: Unknown) -> Self {
            DReject
        }
    }
    struct DGen;
    impl Worldgen for DGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct DGame;
    impl Game for DGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = DGen;
        type Action = ();
        type Reject = DReject;
        type Entity = DEntity;
        type Player = DPlayer;
        type Global = DGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &DEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &DEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), DReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn encode(groups: &[(ChunkCoord, &[(u16, Tile)])], ops: &[EntityOp<'_, DGame>]) -> Vec<u8> {
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        write_chunk_deltas::<DGame>(&mut sink, groups, ops);
        let n = sink.finish().unwrap();
        buf.truncate(n);
        buf
    }

    #[test]
    fn roundtrip_tiles_and_entity_ops() {
        let e1 = DEntity { hp: 5 };
        let tiles_a: &[(u16, Tile)] = &[(0, Tile::new(1, 0, 0)), (2, Tile::new(2, 0, 0))];
        let groups = [(ChunkCoord::new(0, 0), tiles_a)];
        let ops = [
            EntityOp::Put {
                id: EntityId(1),
                entity: &e1,
            },
            EntityOp::Gone { id: EntityId(2) },
        ];
        let bytes = encode(&groups, &ops);

        let mut r = ByteReader::new(&bytes);
        let mut got_tiles = Vec::new();
        let mut got_ops = Vec::new();
        read_chunk_deltas::<DGame>(
            &mut r,
            |c, i, t| got_tiles.push((c, i, t)),
            |op| got_ops.push(op),
        )
        .unwrap();
        assert_eq!(
            got_tiles,
            vec![
                (ChunkCoord::new(0, 0), 0, Tile::new(1, 0, 0)),
                (ChunkCoord::new(0, 0), 2, Tile::new(2, 0, 0)),
            ]
        );
        assert_eq!(got_ops.len(), 2);
        assert!(
            matches!(&got_ops[0], EntityDeltaOp::Put(id, e) if *id == EntityId(1) && e.hp == 5)
        );
        assert!(matches!(&got_ops[1], EntityDeltaOp::Gone(id) if *id == EntityId(2)));
    }

    #[test]
    fn golden_chunk_deltas() {
        let e1 = DEntity { hp: 7 };
        let tiles_a: &[(u16, Tile)] = &[(1, Tile::new(3, 0, 0))];
        let tiles_b: &[(u16, Tile)] = &[(0, Tile::new(4, 0, 0)), (1, Tile::new(4, 0, 0))];
        let groups = [
            (ChunkCoord::new(0, 0), tiles_a),
            (ChunkCoord::new(1, 0), tiles_b),
        ];
        let ops = [
            EntityOp::Put {
                id: EntityId(9),
                entity: &e1,
            },
            EntityOp::Gone { id: EntityId(3) },
        ];
        let bytes = encode(&groups, &ops);
        crate::assert_golden_bytes!("wire_chunk_deltas", &bytes);
    }

    #[test]
    fn decoder_rejects_unknown_op_tag() {
        let mut buf = vec![0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_varint(0); // n_chunks = 0
        sink.put_u8(9); // unknown op tag
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(
            read_chunk_deltas::<DGame>(&mut r, |_, _, _| {}, |_| {}),
            Err(WireError::Malformed)
        );
    }
}
