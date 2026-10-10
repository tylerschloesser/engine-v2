//! `Hashes` (section 9) body and the `ResyncChunk` uplink message (M31b,
//! 0013 "Per-chunk desync hashes").
//!
//! **`Hashes`**: a flat entry list to the section's end (no leading count), each entry
//! `kind u8` then, by kind: `0 Chunk`: `cx zigzag varint · cy zigzag varint · hash u64 LE`;
//! `1 Global`: `hash u64 LE`; `2 OwnPlayer`: `hash u64 LE` (the receiving connection's own player;
//! no id on the wire). The chunk coordinate is absolute, never delta-chained, so an entry is
//! self-contained. The kind byte is kept extensible (M08 reserves a pristine-terrain kind), but an
//! entry carries no length, so a reader cannot skip a kind it does not know: an unknown kind is
//! [`WireError::Malformed`].
//!
//! **`ResyncChunk`**: `type 0x04 · cx zigzag varint · cy zigzag varint`. The reserved coordinate
//! [`RESERVED_SCOPE_COORD`] `(i32::MIN, i32::MIN)` asks for the `Global` and `OwnPlayer` scopes
//! instead of a chunk (0024 §8).

use crate::bytes::{ByteReader, ByteSink};
use crate::world::ChunkCoord;

use super::{MsgType, WireError, unzigzag32, varint_u32, zigzag32};

/// The `ResyncChunk` coordinate that names the `Global` + `OwnPlayer` scopes, not a chunk.
pub const RESERVED_SCOPE_COORD: ChunkCoord = ChunkCoord::new(i32::MIN, i32::MIN);

/// One `Hashes` entry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HashEntry {
    Chunk { coord: ChunkCoord, hash: u64 },
    Global { hash: u64 },
    OwnPlayer { hash: u64 },
}

const KIND_CHUNK: u8 = 0;
const KIND_GLOBAL: u8 = 1;
const KIND_OWN_PLAYER: u8 = 2;

pub fn write_hash_entry(sink: &mut (impl ByteSink + ?Sized), entry: HashEntry) {
    match entry {
        HashEntry::Chunk { coord, hash } => {
            sink.put_u8(KIND_CHUNK);
            sink.put_varint(zigzag32(coord.x) as u64);
            sink.put_varint(zigzag32(coord.y) as u64);
            sink.put_u64(hash);
        }
        HashEntry::Global { hash } => {
            sink.put_u8(KIND_GLOBAL);
            sink.put_u64(hash);
        }
        HashEntry::OwnPlayer { hash } => {
            sink.put_u8(KIND_OWN_PLAYER);
            sink.put_u64(hash);
        }
    }
}

/// Reads every entry of one `Hashes` body, in order.
pub fn read_hashes(
    r: &mut ByteReader,
    mut on_entry: impl FnMut(HashEntry),
) -> Result<(), WireError> {
    while !r.rest().is_empty() {
        let entry = match r.u8().map_err(WireError::from)? {
            KIND_CHUNK => {
                let x = unzigzag32(varint_u32(r)?);
                let y = unzigzag32(varint_u32(r)?);
                let hash = r.u64().map_err(WireError::from)?;
                HashEntry::Chunk {
                    coord: ChunkCoord::new(x, y),
                    hash,
                }
            }
            KIND_GLOBAL => HashEntry::Global {
                hash: r.u64().map_err(WireError::from)?,
            },
            KIND_OWN_PLAYER => HashEntry::OwnPlayer {
                hash: r.u64().map_err(WireError::from)?,
            },
            _ => return Err(WireError::Malformed),
        };
        on_entry(entry);
    }
    Ok(())
}

/// Writes one `ResyncChunk` message (the whole message, type byte included).
pub fn write_resync_chunk(sink: &mut (impl ByteSink + ?Sized), coord: ChunkCoord) {
    sink.put_u8(MsgType::ResyncChunk as u8);
    sink.put_varint(zigzag32(coord.x) as u64);
    sink.put_varint(zigzag32(coord.y) as u64);
}

/// Reads a whole `ResyncChunk` message: exactly the type byte, two varints, nothing after.
pub fn read_resync_chunk(bytes: &[u8]) -> Result<ChunkCoord, WireError> {
    let mut r = ByteReader::new(bytes);
    if r.u8().map_err(WireError::from)? != MsgType::ResyncChunk as u8 {
        return Err(WireError::Malformed);
    }
    let x = unzigzag32(varint_u32(&mut r)?);
    let y = unzigzag32(varint_u32(&mut r)?);
    if !r.rest().is_empty() {
        return Err(WireError::Malformed);
    }
    Ok(ChunkCoord::new(x, y))
}
