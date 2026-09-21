//! Chunk-coordinate list coding (Planning decisions "Chunk-coordinate list"): sections 4
//! (`ChunkEnterPristine`), 6 (`ChunkLeaves`), 11 (`ChunkKeeps`), and the chunk keys inside sections
//! 5 (`ChunkSnapshots`) and 7 (`ChunkDeltas`). The first coordinate a cursor writes/reads is
//! absolute (two zigzag varints); every later one is a zigzag delta from the previous. Sorting
//! entries by `(cy, cx)` before writing them (a caller's own job, not this module's) is what makes
//! the deltas small and the bytes canonical (0011).

use crate::bytes::{ByteReader, ByteSink};
use crate::world::ChunkCoord;

use super::{WireError, unzigzag32, varint_u32, zigzag32};

/// One coordinate-list cursor. Reused across every entry in a list (or, inside a snapshot/deltas
/// section, across every chunk entry): `ChunkCoordListWriter::new()` starts a fresh chain, so a
/// [`super::SectionWriter`] body that owns one must construct it *inside* the body closure (module
/// doc comment "The 'measure, then write' trick").
#[derive(Default)]
pub struct ChunkCoordListWriter {
    prev: Option<ChunkCoord>,
}

impl ChunkCoordListWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Writes `coord`: absolute if this is the cursor's first call, a zigzag delta from the
    /// previous coordinate otherwise. Debug-asserts ascending `(cy, cx)` order (Planning decisions:
    /// "entries sorted by (cy, cx)" is the caller's invariant to uphold; this only catches it in
    /// debug builds, since a release build must still emit *some* bytes for a caller bug rather
    /// than panic).
    pub fn write(&mut self, sink: &mut (impl ByteSink + ?Sized), coord: ChunkCoord) {
        match self.prev {
            None => {
                sink.put_varint(zigzag32(coord.x) as u64);
                sink.put_varint(zigzag32(coord.y) as u64);
            }
            Some(prev) => {
                debug_assert!(
                    (coord.y, coord.x) >= (prev.y, prev.x),
                    "chunk coordinate list entries must be sorted by (cy, cx): {prev:?} then {coord:?}"
                );
                sink.put_varint(zigzag32(coord.x.wrapping_sub(prev.x)) as u64);
                sink.put_varint(zigzag32(coord.y.wrapping_sub(prev.y)) as u64);
            }
        }
        self.prev = Some(coord);
    }
}

/// The read half of [`ChunkCoordListWriter`].
#[derive(Default)]
pub struct ChunkCoordListReader {
    prev: Option<ChunkCoord>,
}

impl ChunkCoordListReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn read(&mut self, r: &mut ByteReader) -> Result<ChunkCoord, WireError> {
        let dx = unzigzag32(varint_u32(r)?);
        let dy = unzigzag32(varint_u32(r)?);
        let coord = match self.prev {
            None => ChunkCoord::new(dx, dy),
            Some(prev) => ChunkCoord::new(prev.x.wrapping_add(dx), prev.y.wrapping_add(dy)),
        };
        self.prev = Some(coord);
        Ok(coord)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    fn encode(coords: &[ChunkCoord]) -> Vec<u8> {
        let mut buf = vec![0u8; 4096];
        let mut sink = SliceSink::new(&mut buf);
        let mut w = ChunkCoordListWriter::new();
        for &c in coords {
            w.write(&mut sink, c);
        }
        let n = sink.finish().unwrap();
        buf.truncate(n);
        buf
    }

    fn decode(bytes: &[u8], count: usize) -> Vec<ChunkCoord> {
        let mut r = ByteReader::new(bytes);
        let mut reader = ChunkCoordListReader::new();
        (0..count).map(|_| reader.read(&mut r).unwrap()).collect()
    }

    #[test]
    fn roundtrip_negative_and_far() {
        let coords = [
            ChunkCoord::new(-3, -3),
            ChunkCoord::new(-2, -3),
            ChunkCoord::new(0, 0),
            ChunkCoord::new(-262_144, 262_144), // near +/- 2^18
            ChunkCoord::new(-262_140, 262_145),
        ];
        // sorted by (cy, cx) already
        let bytes = encode(&coords);
        assert_eq!(decode(&bytes, coords.len()), coords);
    }

    /// Exit criterion: "a pristine enter of one chunk adjacent to the previous costs 2 bytes".
    /// Adjacent means a delta of `(1, 0)` or `(0, 1)` etc: zigzag(1) = 2 (one byte), zigzag(0) = 0
    /// (one byte) -- 2 bytes total.
    #[test]
    fn golden_coord_list_adjacent_costs_2_bytes() {
        let coords = [ChunkCoord::new(5, 5), ChunkCoord::new(6, 5)];
        let bytes = encode(&coords);
        // First entry (absolute, arbitrary) plus the adjacent delta entry: isolate the second.
        let first_len = encode(&coords[..1]).len();
        let second_len = bytes.len() - first_len;
        assert_eq!(second_len, 2, "adjacent delta entry: {bytes:02x?}");
    }

    /// Exit criterion: "a lone entry within +/-63 chunks of the origin costs 2 bytes plus section
    /// overhead". +/-63 zigzags to at most 126 (< 128, one varint byte per axis) -> 2 bytes total
    /// for the absolute coordinate itself; "section overhead" (id + len byte) is `FrameWriter`'s
    /// concern, asserted separately in `golden_coord_list_negative_and_far`'s sibling frame test.
    #[test]
    fn golden_coord_list_lone_entry_within_63_chunks_of_origin() {
        for &c in &[
            ChunkCoord::new(0, 0),
            ChunkCoord::new(63, -63),
            ChunkCoord::new(-63, 63),
        ] {
            let bytes = encode(&[c]);
            assert_eq!(bytes.len(), 2, "{c:?}: {bytes:02x?}");
        }
        // One more chunk out on one axis needs a second varint byte on that axis.
        let bytes = encode(&[ChunkCoord::new(64, 0)]);
        assert_eq!(bytes.len(), 3, "{bytes:02x?}");
    }

    #[test]
    fn golden_coord_list_negative_and_far() {
        let coords = [
            ChunkCoord::new(-3, -3),
            ChunkCoord::new(-2, -3),
            ChunkCoord::new(0, 0),
            ChunkCoord::new(-262_144, 262_144),
        ];
        crate::assert_golden_bytes!("wire_coord_list_negative_and_far", &encode(&coords));
    }

    #[test]
    fn decoder_rejects_truncated_list() {
        // Two entries; drop the last byte so the second entry's `y` delta is truncated. The first
        // read must still succeed (it doesn't touch the missing byte); the second must fail, never
        // panic.
        let bytes = encode(&[ChunkCoord::new(1, 1), ChunkCoord::new(300, 300)]);
        let truncated = &bytes[..bytes.len() - 1];
        let mut r = ByteReader::new(truncated);
        let mut reader = ChunkCoordListReader::new();
        assert_eq!(reader.read(&mut r), Ok(ChunkCoord::new(1, 1)));
        assert_eq!(reader.read(&mut r), Err(WireError::Malformed));

        let mut r2 = ByteReader::new(&[0x80]); // continuation byte with nothing after it
        let mut reader2 = ChunkCoordListReader::new();
        assert_eq!(reader2.read(&mut r2), Err(WireError::Malformed));
    }
}
