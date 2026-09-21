//! Wire framing (docs/decisions/0011-wire-format-and-deltas.md, 0010 "Rates"/"Camera report",
//! 0009 "Message classes"): the frame header and sections, chunk-coordinate lists, overlay runs,
//! chunk snapshots, action results and the uplink batch. Every writer here is generic over M05's
//! [`ByteSink`] and allocates nothing; every reader borrows `&[u8]` through [`ByteReader`] and
//! never panics on any input -- a malformed byte is [`WireError::Malformed`], never a panic.
//!
//! Exact id tables and byte layouts: `crates/engine/src/wire/CLAUDE.md` (their single home; this
//! module's doc comments link there instead of repeating the numbers).
//!
//! **The "measure, then write" trick.** A section's `[id][len varint][bytes]` framing needs `len`
//! before the bytes it counts, and a varint's own width depends on the value -- the same problem
//! M05's `write_sized` (`crate::store`) solves for one `Codec` value's length prefix. [`SectionWriter`]
//! extends it to a whole section body: it runs the caller's `body` closure twice, once into a
//! [`CountSink`] to learn the byte count, again into the real sink. **A `body` closure must be a
//! pure function of its captured inputs**: if it owns mutable state (like a nested
//! [`ChunkCoordListWriter`](coordlist::ChunkCoordListWriter) threading deltas across several chunk
//! entries), that state must be constructed *inside* the closure so each of the two calls starts
//! fresh -- never captured by `&mut` from outside it. [`OverlayRunsWriter`](overlay_runs) and a few
//! section bodies (`ActionResultsWriter`, uplink's action list) use the same trick internally for
//! their own `n varint` count prefixes, over a `Clone` iterator instead of a closure.
//!
//! Game-typed values (`G::Entity`, `G::Player`, `G::Global`, `G::Reject`) go through M05
//! `codec::{encode_to, decode}` (plain `decode`, not `decode_canonical`: canonicalising untrusted
//! uplink bytes is M16's concern, not this milestone's, per the brief's Scope). Most of them carry
//! no explicit length prefix on the wire (`Codec`'s own encoding is unambiguous, and the postcard
//! spec is not self-describing only in the sense of *type* -- boundaries are exact): a reader
//! decodes from [`ByteReader::rest`] and advances past exactly the bytes `codec::decode` consumed.

pub mod coordlist;
pub mod deltas;
pub mod global;
pub mod overlay_runs;
pub mod results;
pub mod snapshot;
pub mod uplink;

use crate::bytes::{ByteReader, ByteSink, CountSink};
use crate::codec::CodecError;

pub use coordlist::{ChunkCoordListReader, ChunkCoordListWriter};
pub use deltas::{EntityDeltaOp, EntityOp, read_chunk_deltas, write_chunk_deltas};
pub use global::{read_global, read_own_player, write_global, write_own_player};
pub use overlay_runs::{OverlayRunsReader, OverlayRunsWriter};
pub use results::{ActionResultsReader, ActionResultsWriter};
pub use snapshot::{SnapshotReader, SnapshotWriter, encode_chunk_snapshot};
pub use uplink::{CameraReport, UplinkBatch, UplinkReader, UplinkWriter};

/// Every failure a wire writer or reader can report. Readers never panic: any malformed input
/// (truncation, a bad tag, an out-of-range varint, descending section ids, ...) is
/// [`WireError::Malformed`]. A writer over a [`crate::bytes::SliceSink`] that runs out of room
/// surfaces [`WireError::Full`] once the caller finishes that sink and converts its
/// [`CodecError::Overflow`] (`From<CodecError>` below) -- wire writers themselves never fail
/// directly, matching [`ByteSink::put`]'s own "never panics or reports failure directly" contract.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WireError {
    /// A [`crate::bytes::SliceSink`] ran out of room (`CodecError::Overflow`).
    Full,
    /// Truncated bytes, a bad tag, an out-of-range value, descending/duplicate/unknown section
    /// ids, a non-zero reserved flag bit, or a `Codec` value that failed to decode.
    Malformed,
}

impl From<CodecError> for WireError {
    fn from(e: CodecError) -> Self {
        match e {
            CodecError::Overflow => WireError::Full,
            CodecError::Malformed | CodecError::NonCanonical | CodecError::Trailing => {
                WireError::Malformed
            }
        }
    }
}

/// Zigzag-encodes an `i32` into the `u32` M05's unsigned varint packs (small magnitudes, either
/// sign, cost few bytes): `0, -1, 1, -2, 2, ... -> 0, 1, 2, 3, 4, ...`.
#[inline]
pub fn zigzag32(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

/// The inverse of [`zigzag32`]. Total over every `u32` (zigzag is a bijection on 32-bit values), so
/// this never fails; the caller's varint decode is where an out-of-range value would be caught.
#[inline]
pub fn unzigzag32(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

/// Reads M05's unsigned varint and requires it fit a `u32` (Scope: "this milestone adds only
/// zigzag32/unzigzag32 and range checks: `u32` overflow is malformed"). Every wire count, length,
/// index and zigzag payload is bounded by `u32` in practice; a wider raw varint is untrusted-input
/// malformed, not a panic.
fn varint_u32(r: &mut ByteReader) -> Result<u32, WireError> {
    let v = r.varint().map_err(WireError::from)?;
    u32::try_from(v).map_err(|_| WireError::Malformed)
}

/// The post-handshake message-type byte (Planning decisions "Message type byte"): the first byte
/// of every message in either direction. `0x06..=0x7F` are free; `Hello`/`Reject` (0013, M28) start
/// with the frozen magic `u32` instead, whose first byte is `>= 0x80` (0024 §8) so the two framings
/// never collide.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum MsgType {
    Frame = 0x01,
    UplinkBatch = 0x02,
    Welcome = 0x03,
    ResyncChunk = 0x04,
    Bye = 0x05,
}

/// A frame section id (Planning decisions "Section ids" -- the table is this crate's single home
/// at `wire/CLAUDE.md`). Ascending order of appearance, each at most once, unknown malformed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum SectionId {
    ActionResults = 1,
    Global = 2,
    OwnPlayer = 3,
    ChunkEnterPristine = 4,
    ChunkSnapshots = 5,
    ChunkLeaves = 6,
    ChunkDeltas = 7,
    Presence = 8,
    Hashes = 9,
    /// Reserved by 0008 §3; unbuilt (Non-scope). The id round-trips through `FrameReader`; nothing
    /// interprets its body yet.
    ChunkTiles = 10,
    /// Resume "keep" entries (M28); body opaque here (Non-scope).
    ChunkKeeps = 11,
}

impl SectionId {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            1 => Self::ActionResults,
            2 => Self::Global,
            3 => Self::OwnPlayer,
            4 => Self::ChunkEnterPristine,
            5 => Self::ChunkSnapshots,
            6 => Self::ChunkLeaves,
            7 => Self::ChunkDeltas,
            8 => Self::Presence,
            9 => Self::Hashes,
            10 => Self::ChunkTiles,
            11 => Self::ChunkKeeps,
            _ => return None,
        })
    }
}

/// The 10-byte frame header (0011 "Frame"): `tick`/`ack_seq` only -- `type` is always
/// [`MsgType::Frame`] and `flags` is always 0 (every bit reserved, Planning decisions), so
/// [`FrameWriter::new`] writes them itself rather than taking them as fields here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FrameHeader {
    pub tick: u32,
    pub ack_seq: u32,
}

/// Writes one section's `[id][len varint][bytes]`, running `body` twice (module doc comment "The
/// 'measure, then write' trick"). An empty body (`len == 0`) is omitted entirely (Planning
/// decisions: "empty sections omitted").
pub struct SectionWriter;

impl SectionWriter {
    pub fn write(sink: &mut impl ByteSink, id: SectionId, body: impl Fn(&mut dyn ByteSink)) {
        let mut count = CountSink::default();
        body(&mut count);
        if count.0 == 0 {
            return;
        }
        sink.put_u8(id as u8);
        sink.put_varint(count.0 as u64);
        body(sink);
    }
}

/// Builds one frame into `sink`: the 10-byte header, then zero or more sections in strictly
/// ascending id order (debug-asserted; a real caller's own call order can only go forward since
/// nothing lets it name an id twice). A frame with no [`FrameWriter::section`] calls is the
/// heartbeat (Planning decisions: "A frame with no sections is the heartbeat").
pub struct FrameWriter<'a, S: ByteSink> {
    sink: &'a mut S,
    last_section: u8,
}

impl<'a, S: ByteSink> FrameWriter<'a, S> {
    pub fn new(sink: &'a mut S, header: FrameHeader) -> Self {
        sink.put_u8(MsgType::Frame as u8);
        sink.put_u8(0); // flags: every bit reserved, written 0 (Planning decisions).
        sink.put_u32(header.tick);
        sink.put_u32(header.ack_seq);
        FrameWriter {
            sink,
            last_section: 0,
        }
    }

    /// Writes one section's body via [`SectionWriter::write`]. Panics (debug only) if `id` is not
    /// strictly greater than the last section written -- a caller bug, not untrusted input.
    pub fn section(&mut self, id: SectionId, body: impl Fn(&mut dyn ByteSink)) {
        debug_assert!(
            (id as u8) > self.last_section,
            "frame sections must be written in strictly ascending id order"
        );
        self.last_section = id as u8;
        SectionWriter::write(self.sink, id, body);
    }
}

/// Parses one frame's header and hands back its sections one at a time via [`FrameReader::next_section`].
pub struct FrameReader<'a> {
    reader: ByteReader<'a>,
    header: FrameHeader,
    last_section: u8,
}

impl<'a> FrameReader<'a> {
    /// Reads the header; rejects a message that is not [`MsgType::Frame`] or has a non-zero
    /// (reserved) flags byte.
    pub fn new(buf: &'a [u8]) -> Result<Self, WireError> {
        let mut reader = ByteReader::new(buf);
        let msg_type = reader.u8().map_err(WireError::from)?;
        if msg_type != MsgType::Frame as u8 {
            return Err(WireError::Malformed);
        }
        let flags = reader.u8().map_err(WireError::from)?;
        if flags != 0 {
            return Err(WireError::Malformed);
        }
        let tick = reader.u32().map_err(WireError::from)?;
        let ack_seq = reader.u32().map_err(WireError::from)?;
        Ok(FrameReader {
            reader,
            header: FrameHeader { tick, ack_seq },
            last_section: 0,
        })
    }

    pub fn header(&self) -> FrameHeader {
        self.header
    }

    /// The next `(id, body)` pair, or `Ok(None)` once every byte is consumed. Rejects a zero,
    /// repeated, descending or unknown id (Planning decisions "Section ids").
    pub fn next_section(&mut self) -> Result<Option<(SectionId, &'a [u8])>, WireError> {
        if self.reader.rest().is_empty() {
            return Ok(None);
        }
        let id_byte = self.reader.u8().map_err(WireError::from)?;
        if id_byte == 0 || id_byte <= self.last_section {
            return Err(WireError::Malformed);
        }
        let id = SectionId::from_u8(id_byte).ok_or(WireError::Malformed)?;
        self.last_section = id_byte;
        let len = varint_u32(&mut self.reader)? as usize;
        let body = self.reader.bytes(len).map_err(WireError::from)?;
        Ok(Some((id, body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    #[test]
    fn golden_frame_header() {
        let mut buf = [0u8; 10];
        let mut sink = SliceSink::new(&mut buf);
        let _fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 7,
                ack_seq: 3,
            },
        );
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_frame_header", &buf[..n]);
    }

    #[test]
    fn golden_heartbeat_is_10_bytes() {
        let mut buf = [0u8; 10];
        let mut sink = SliceSink::new(&mut buf);
        let _fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 0,
                ack_seq: 0,
            },
        );
        let n = sink.finish().unwrap();
        assert_eq!(n, 10, "a frame with no sections is the 10-byte heartbeat");
    }

    #[test]
    fn golden_section_ids() {
        let mut buf = [0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 1,
                ack_seq: 0,
            },
        );
        fw.section(SectionId::ActionResults, |s| s.put(&[9]));
        fw.section(SectionId::Global, |s| s.put(&[1, 2]));
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_section_ids", &buf[..n]);

        let mut r = FrameReader::new(&buf[..n]).unwrap();
        let (id, body) = r.next_section().unwrap().unwrap();
        assert_eq!(id, SectionId::ActionResults);
        assert_eq!(body, &[9]);
        let (id, body) = r.next_section().unwrap().unwrap();
        assert_eq!(id, SectionId::Global);
        assert_eq!(body, &[1, 2]);
        assert_eq!(r.next_section().unwrap(), None);
    }

    #[test]
    fn empty_section_body_is_omitted() {
        let mut buf = [0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 0,
                ack_seq: 0,
            },
        );
        fw.section(SectionId::Global, |_s| {}); // writes nothing: omitted entirely
        fw.section(SectionId::OwnPlayer, |s| s.put(&[5]));
        let n = sink.finish().unwrap();
        let mut r = FrameReader::new(&buf[..n]).unwrap();
        let (id, body) = r.next_section().unwrap().unwrap();
        assert_eq!(
            id,
            SectionId::OwnPlayer,
            "the empty Global section vanished"
        );
        assert_eq!(body, &[5]);
        assert_eq!(r.next_section().unwrap(), None);
    }

    #[test]
    fn sections_out_of_order_rejected() {
        // Hand-built bytes: header, then Global(2) before ActionResults(1) -- descending.
        let mut buf = [0u8; 10];
        let mut sink = SliceSink::new(&mut buf);
        let _fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 0,
                ack_seq: 0,
            },
        );
        let n = sink.finish().unwrap();
        let mut bytes = buf[..n].to_vec();
        bytes.extend_from_slice(&[2, 1, 9]); // Global, len 1, byte 9
        bytes.extend_from_slice(&[1, 1, 5]); // ActionResults, len 1, byte 5 (descending: malformed)
        let mut r = FrameReader::new(&bytes).unwrap();
        assert_eq!(r.next_section().unwrap().unwrap().0, SectionId::Global);
        assert_eq!(r.next_section(), Err(WireError::Malformed));

        // A repeated id is equally malformed.
        let mut bytes2 = buf[..n].to_vec();
        bytes2.extend_from_slice(&[1, 1, 9]);
        bytes2.extend_from_slice(&[1, 1, 5]);
        let mut r2 = FrameReader::new(&bytes2).unwrap();
        assert!(r2.next_section().unwrap().is_some());
        assert_eq!(r2.next_section(), Err(WireError::Malformed));

        // Id 0 and an unknown id (e.g. 12) are equally malformed.
        let mut bytes3 = buf[..n].to_vec();
        bytes3.extend_from_slice(&[0, 1, 9]);
        assert_eq!(
            FrameReader::new(&bytes3).unwrap().next_section(),
            Err(WireError::Malformed)
        );

        let mut bytes4 = buf[..n].to_vec();
        bytes4.extend_from_slice(&[12, 1, 9]);
        assert_eq!(
            FrameReader::new(&bytes4).unwrap().next_section(),
            Err(WireError::Malformed)
        );
    }

    #[test]
    fn nonzero_flags_is_malformed() {
        let mut bytes = vec![MsgType::Frame as u8, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(FrameReader::new(&bytes).err(), Some(WireError::Malformed));
        bytes[1] = 0;
        assert!(FrameReader::new(&bytes).is_ok());
    }

    #[test]
    fn wrong_msg_type_is_malformed() {
        let bytes = [MsgType::UplinkBatch as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(FrameReader::new(&bytes).err(), Some(WireError::Malformed));
    }

    /// `writer_full_is_error_not_panic` (Tests added): a `SliceSink` too small for a frame's bytes
    /// never panics -- it overflows silently (`ByteSink::put`'s own contract) and reports through
    /// `finish`, which this module converts to `WireError::Full`.
    #[test]
    fn writer_full_is_error_not_panic() {
        let mut buf = [0u8; 4]; // too small even for the 10-byte header
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 1,
                ack_seq: 2,
            },
        );
        fw.section(SectionId::Global, |s| s.put(&[1, 2, 3, 4, 5, 6, 7, 8]));
        assert_eq!(sink.finish().map_err(WireError::from), Err(WireError::Full));
    }

    #[test]
    fn zigzag_roundtrip() {
        for v in [0i32, 1, -1, 2, -2, i32::MAX, i32::MIN, 12345, -12345] {
            assert_eq!(unzigzag32(zigzag32(v)), v, "zigzag32({v})");
        }
        // Small magnitudes cost the fewest bytes either sign (the whole point of zigzag).
        assert_eq!(zigzag32(0), 0);
        assert_eq!(zigzag32(-1), 1);
        assert_eq!(zigzag32(1), 2);
        assert_eq!(zigzag32(-2), 3);
    }

    #[test]
    fn varint_u32_rejects_overflow() {
        let mut buf = [0u8; 16];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_varint(u32::MAX as u64 + 1);
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(varint_u32(&mut r), Err(WireError::Malformed));

        let mut buf2 = [0u8; 16];
        let mut sink2 = SliceSink::new(&mut buf2);
        sink2.put_varint(u32::MAX as u64);
        let n2 = sink2.finish().unwrap();
        let mut r2 = ByteReader::new(&buf2[..n2]);
        assert_eq!(varint_u32(&mut r2), Ok(u32::MAX));
    }
}
