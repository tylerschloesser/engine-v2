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
pub mod presence;
pub mod results;
pub mod snapshot;
pub mod uplink;

use crate::bytes::{ByteReader, ByteSink, CountSink};
use crate::codec::CodecError;

pub use coordlist::{ChunkCoordListReader, ChunkCoordListWriter};
pub use deltas::{EntityDeltaOp, EntityOp, read_chunk_deltas, write_chunk_deltas};
pub use global::{read_global, read_own_player, write_global, write_own_player};
pub use overlay_runs::{OverlayRunsReader, OverlayRunsWriter};
pub use presence::{PresenceDeltaOp, PresenceOp, read_presence, write_presence};
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

    // -- `roundtrip_random_frames` / `decoder_never_panics` (Tests added) -------------------------
    //
    // A shared test `Game` with some real variety in its associated types (an `Option`, an enum
    // with payload, a couple of fields), so the generator exercises more than one trivial shape.

    use crate::game::{EntityId, Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::rng::SimRng;
    use crate::sim::{Applied, EngineReject, Outcome, Rejected};
    use crate::store::Store;
    use crate::world::{
        CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    };
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct WEntity {
        anchor: (i32, i32),
        hp: u32,
        tag: Option<u16>,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct WPlayer {
        score: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct WGlobal {
        day: u32,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum WReject {
        Bad(u16),
        NotFound,
    }
    impl From<Unknown> for WReject {
        fn from(_: Unknown) -> Self {
            WReject::NotFound
        }
    }
    struct WGen;
    impl Worldgen for WGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct WGame;
    impl Game for WGame {
        const SCHEMA_VERSION: u32 = 1;
        const CHUNK_BITS: u32 = 4;
        type Worldgen = WGen;
        type Action = ();
        type Reject = WReject;
        type Entity = WEntity;
        type Player = WPlayer;
        type Global = WGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &WEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(e: &WEntity) -> TilePos {
            TilePos::new(e.anchor.0, e.anchor.1)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), WReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    fn rand_below(rng: &mut SimRng, bound: u32) -> u32 {
        rng.below(bound.max(1))
    }

    /// A `Store<WGame>` with a handful of chunks worth of tiles and entities, reused across every
    /// generated frame (`encode_chunk_snapshot`/deltas read from it; nothing here mutates it after
    /// construction).
    fn corpus_store() -> Store<WGame> {
        use crate::delta::Delta;
        let terrain = TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(64),
        );
        let mut s = Store::new(terrain, WGlobal { day: 0 });
        for i in 0..8u16 {
            s.apply(&Delta::Tile {
                pos: TilePos::new(i as i32, 0),
                tile: Tile::new(i as u8, 0, 0),
            });
            s.apply(&Delta::EntityPut {
                id: EntityId((i + 1) as u32),
                entity: WEntity {
                    anchor: (i as i32, (i % 3) as i32 * 16), // spread across a few chunks
                    hp: i as u32,
                    tag: if i % 2 == 0 { Some(i) } else { None },
                },
            });
        }
        s
    }

    use crate::world::TerrainStore;

    /// One generated frame's expected content, checked back against what `FrameReader` +
    /// section-body readers hand back -- the coverage this test asserts (Tests added:
    /// `roundtrip_random_frames`).
    #[derive(Default)]
    struct Coverage {
        section_ids_seen: std::collections::BTreeSet<u8>,
        overlay_empty_seen: bool,
        overlay_nonempty_seen: bool,
        snapshot_entities_zero_seen: bool,
        snapshot_entities_nonzero_seen: bool,
        global_roster_only_seen: bool,
        global_value_only_seen: bool,
        global_both_seen: bool,
        deltas_with_groups_seen: bool,
        deltas_ops_only_seen: bool,
        action_results_applied_seen: bool,
        action_results_game_reject_seen: bool,
        action_results_engine_reject_seen: bool,
    }

    #[test]
    fn roundtrip_random_frames() {
        let mut rng = SimRng::new(0xC0FF_EE00_1234_5678);
        let store = corpus_store();
        let chunks: Vec<ChunkCoord> = (0..6)
            .map(|i| ChunkCoord::new(0, i)) // ascending (cy, cx): valid for coord lists as-is
            .collect();
        let mut cov = Coverage::default();

        for frame_no in 0..1000u32 {
            let mut buf = vec![0u8; 16 * 1024];
            let mut sink = SliceSink::new(&mut buf);
            let header = FrameHeader {
                tick: frame_no,
                ack_seq: frame_no,
            };
            let mut fw = FrameWriter::new(&mut sink, header);

            // ActionResults
            let outcomes: Vec<Outcome<WGame>> = if rng.below(4) != 0 {
                let n = 1 + rand_below(&mut rng, 3);
                (0..n)
                    .map(|seq| {
                        let result = match rng.below(3) {
                            0 => {
                                cov.action_results_applied_seen = true;
                                Ok(Applied)
                            }
                            1 => {
                                cov.action_results_game_reject_seen = true;
                                Err(Rejected::Game(WReject::Bad(seq as u16)))
                            }
                            _ => {
                                cov.action_results_engine_reject_seen = true;
                                Err(Rejected::Engine(EngineReject::RateLimited))
                            }
                        };
                        Outcome { seq, result }
                    })
                    .collect()
            } else {
                Vec::new()
            };
            if !outcomes.is_empty() {
                fw.section(SectionId::ActionResults, |s| {
                    ActionResultsWriter::write(s, outcomes.iter());
                });
            }

            // Global
            let want_roster = rng.below(3) != 0;
            let want_value = rng.below(3) != 0;
            let roster: Vec<(PlayerId, bool)> = if want_roster {
                (1..=1 + rand_below(&mut rng, 3))
                    .map(|id| (PlayerId(id), rng.below(2) == 1))
                    .collect()
            } else {
                Vec::new()
            };
            let global_value = WGlobal {
                day: rand_below(&mut rng, 1000),
            };
            if want_roster || want_value {
                match (want_roster, want_value) {
                    (true, false) => cov.global_roster_only_seen = true,
                    (false, true) => cov.global_value_only_seen = true,
                    (true, true) => cov.global_both_seen = true,
                    (false, false) => unreachable!(),
                }
                fw.section(SectionId::Global, |s| {
                    write_global::<WGame>(
                        s,
                        want_roster.then(|| roster.iter().copied()),
                        want_value.then_some(&global_value),
                    );
                });
            }

            // OwnPlayer
            if rng.below(2) == 1 {
                let own_player = WPlayer {
                    score: rand_below(&mut rng, 500),
                };
                fw.section(SectionId::OwnPlayer, |s| {
                    write_own_player::<WGame>(s, PlayerId(1), &own_player);
                });
            }

            // ChunkEnterPristine
            let n_enter = rand_below(&mut rng, 3);
            if n_enter > 0 {
                let entries: Vec<ChunkCoord> = chunks[..n_enter as usize].to_vec();
                fw.section(SectionId::ChunkEnterPristine, |s| {
                    let mut w = ChunkCoordListWriter::new();
                    for &c in &entries {
                        w.write(s, c);
                    }
                });
            }

            // ChunkSnapshots: pick distinct random chunks out of the full set (not just a fixed
            // prefix) so both entity-bearing chunks (0..=2, per `corpus_store`'s spread) and empty
            // ones (3..=5) get exercised -- a fixed prefix here previously never reached the empty
            // ones, so `snapshot_entities_zero_seen` never fired.
            let n_snap = rand_below(&mut rng, 3) as usize;
            let mut snap_idxs: Vec<usize> = Vec::new();
            while snap_idxs.len() < n_snap {
                let idx = rand_below(&mut rng, chunks.len() as u32) as usize;
                if !snap_idxs.contains(&idx) {
                    snap_idxs.push(idx);
                }
            }
            snap_idxs.sort_unstable();
            let snap_chunks: Vec<ChunkCoord> = snap_idxs.iter().map(|&i| chunks[i]).collect();
            if !snap_chunks.is_empty() {
                fw.section(SectionId::ChunkSnapshots, |s| {
                    let mut w = SnapshotWriter::new();
                    for &c in &snap_chunks {
                        w.write_chunk(s, &store, c, frame_no);
                    }
                });
            }

            // ChunkLeaves
            let n_leave = rand_below(&mut rng, 2);
            let leave_chunks: Vec<ChunkCoord> = if n_leave > 0 {
                vec![chunks[chunks.len() - 1]]
            } else {
                Vec::new()
            };
            if !leave_chunks.is_empty() {
                fw.section(SectionId::ChunkLeaves, |s| {
                    let mut w = ChunkCoordListWriter::new();
                    for &c in &leave_chunks {
                        w.write(s, c);
                    }
                });
            }

            // ChunkDeltas: tile groups sometimes, entity ops sometimes, independently.
            let has_groups = rng.below(3) != 0;
            let tile_a: Vec<(u16, Tile)> = if has_groups {
                vec![(0, Tile::new(rand_below(&mut rng, 250) as u8, 0, 0))]
            } else {
                Vec::new()
            };
            let groups: Vec<(ChunkCoord, &[(u16, Tile)])> = if has_groups {
                vec![(chunks[0], tile_a.as_slice())]
            } else {
                Vec::new()
            };
            let entity_val = WEntity {
                anchor: (2, 2),
                hp: rand_below(&mut rng, 100),
                tag: None,
            };
            let has_ops = rng.below(2) == 1;
            let ops: Vec<EntityOp<'_, WGame>> = if has_ops {
                if rng.below(2) == 1 {
                    vec![EntityOp::Put {
                        id: EntityId(1),
                        entity: &entity_val,
                    }]
                } else {
                    vec![EntityOp::Gone { id: EntityId(1) }]
                }
            } else {
                Vec::new()
            };
            if has_groups || has_ops {
                if has_groups {
                    cov.deltas_with_groups_seen = true;
                }
                if has_ops && !has_groups {
                    cov.deltas_ops_only_seen = true;
                }
                fw.section(SectionId::ChunkDeltas, |s| {
                    write_chunk_deltas::<WGame>(s, &groups, &ops);
                });
            }

            // Presence / Hashes / ChunkKeeps: opaque bytes (Non-scope bodies), still exercised so
            // every SectionId this milestone builds is covered.
            let presence_bytes: Vec<u8> = (0..(1 + rand_below(&mut rng, 4)))
                .map(|_| rng.below(256) as u8)
                .collect();
            fw.section(SectionId::Presence, |s| s.put(&presence_bytes));
            let hash_bytes: Vec<u8> = (0..8).map(|_| rng.below(256) as u8).collect();
            fw.section(SectionId::Hashes, |s| s.put(&hash_bytes));
            if rng.below(3) == 0 {
                fw.section(SectionId::ChunkKeeps, |s| {
                    let mut w = ChunkCoordListWriter::new();
                    w.write(s, chunks[0]);
                });
            }

            let n = sink
                .finish()
                .unwrap_or_else(|e| panic!("frame {frame_no} overflowed: {e:?}"));

            // Decode and check every present section round-trips, tallying coverage.
            let mut r = FrameReader::new(&buf[..n]).unwrap();
            assert_eq!(r.header(), header);
            while let Some((id, body)) = r.next_section().unwrap() {
                cov.section_ids_seen.insert(id as u8);
                let mut br = ByteReader::new(body);
                match id {
                    SectionId::ActionResults => {
                        let mut got = Vec::new();
                        ActionResultsReader::read::<WGame>(&mut br, |seq, res| {
                            got.push((seq, res))
                        })
                        .unwrap();
                        assert_eq!(got.len(), outcomes.len());
                    }
                    SectionId::Global => {
                        let mut got_roster = Vec::new();
                        let got_value =
                            read_global::<WGame>(&mut br, |p, o| got_roster.push((p, o))).unwrap();
                        if want_roster {
                            assert_eq!(got_roster, roster);
                        } else {
                            assert!(got_roster.is_empty());
                        }
                        assert_eq!(got_value, want_value.then_some(global_value));
                    }
                    SectionId::OwnPlayer => {
                        let (who, _state) = read_own_player::<WGame>(&mut br).unwrap();
                        assert_eq!(who, PlayerId(1));
                    }
                    SectionId::ChunkEnterPristine => {
                        let mut reader = ChunkCoordListReader::new();
                        let mut got = Vec::new();
                        while !br.rest().is_empty() {
                            got.push(reader.read(&mut br).unwrap());
                        }
                        assert_eq!(got, chunks[..n_enter as usize]);
                    }
                    SectionId::ChunkSnapshots => {
                        let mut reader = SnapshotReader::new();
                        let mut got_chunks = Vec::new();
                        while !br.rest().is_empty() {
                            let mut n_tiles = 0u32;
                            let mut n_entities = 0u32;
                            let (c, v) = reader
                                .read_chunk::<WGame>(
                                    &mut br,
                                    |_, _| n_tiles += 1,
                                    |_, _| n_entities += 1,
                                )
                                .unwrap();
                            if n_tiles == 0 {
                                cov.overlay_empty_seen = true;
                            } else {
                                cov.overlay_nonempty_seen = true;
                            }
                            if n_entities == 0 {
                                cov.snapshot_entities_zero_seen = true;
                            } else {
                                cov.snapshot_entities_nonzero_seen = true;
                            }
                            assert_eq!(v, frame_no);
                            got_chunks.push(c);
                        }
                        assert_eq!(got_chunks, snap_chunks);
                    }
                    SectionId::ChunkLeaves => {
                        let mut reader = ChunkCoordListReader::new();
                        let mut got = Vec::new();
                        while !br.rest().is_empty() {
                            got.push(reader.read(&mut br).unwrap());
                        }
                        assert_eq!(got, leave_chunks);
                    }
                    SectionId::ChunkDeltas => {
                        let mut got_tiles = 0;
                        let mut got_ops = 0;
                        read_chunk_deltas::<WGame>(
                            &mut br,
                            |_, _, _| got_tiles += 1,
                            |_op: EntityDeltaOp<WGame>| got_ops += 1,
                        )
                        .unwrap();
                        assert_eq!(got_tiles, tile_a.len());
                        assert_eq!(got_ops, ops.len());
                    }
                    SectionId::Presence => assert_eq!(body, presence_bytes.as_slice()),
                    SectionId::Hashes => assert_eq!(body, hash_bytes.as_slice()),
                    SectionId::ChunkKeeps => {} // opaque here; just proves it round-trips as bytes
                    SectionId::ChunkTiles => panic!("ChunkTiles is unbuilt; never generated"),
                }
            }
        }

        // Coverage assertions (Tests added, anti-vacuity instruction): every SectionId this
        // milestone builds must have appeared, and both the empty and non-empty shape of the
        // interesting variable-length fields must have appeared. If the generator regresses to
        // "always include everything" or "always include nothing", one of these fails loudly.
        let built_ids: [u8; 9] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        for id in built_ids {
            assert!(
                cov.section_ids_seen.contains(&id),
                "section id {id} never appeared in 1000 generated frames"
            );
        }
        assert!(
            cov.overlay_empty_seen && cov.overlay_nonempty_seen,
            "overlay coverage"
        );
        assert!(
            cov.snapshot_entities_zero_seen && cov.snapshot_entities_nonzero_seen,
            "snapshot entity-count coverage"
        );
        assert!(
            cov.global_roster_only_seen && cov.global_value_only_seen && cov.global_both_seen,
            "global mask coverage"
        );
        assert!(
            cov.deltas_with_groups_seen && cov.deltas_ops_only_seen,
            "chunk-deltas shape coverage"
        );
        assert!(
            cov.action_results_applied_seen
                && cov.action_results_game_reject_seen
                && cov.action_results_engine_reject_seen,
            "action-results tag coverage"
        );
    }

    /// Seeded corpus of malformed inputs: truncations, single-bit flips, an oversized varint, and
    /// descending section ids, run through `FrameReader`. Never panics; asserts the corpus actually
    /// *reaches* the interesting decoders rather than being rejected at byte 0 every time (Tests
    /// added, anti-vacuity instruction).
    #[test]
    fn decoder_never_panics() {
        let mut rng = SimRng::new(0xDEC0_DE00_BAD0_0001);
        let store = corpus_store();

        // A handful of well-formed frames to mutate.
        let mut good_frames: Vec<Vec<u8>> = Vec::new();
        for tick in 0..8u32 {
            let mut buf = vec![0u8; 4096];
            let mut sink = SliceSink::new(&mut buf);
            let mut fw = FrameWriter::new(
                &mut sink,
                FrameHeader {
                    tick,
                    ack_seq: tick,
                },
            );
            fw.section(SectionId::ActionResults, |s| {
                let outcomes = [Outcome::<WGame> {
                    seq: 1,
                    result: Ok(Applied),
                }];
                ActionResultsWriter::write(s, outcomes.iter());
            });
            fw.section(SectionId::Global, |s| {
                write_global::<WGame>(
                    s,
                    Some([(PlayerId(1), true)].into_iter()),
                    Some(&WGlobal { day: tick }),
                );
            });
            fw.section(SectionId::ChunkSnapshots, |s| {
                let mut w = SnapshotWriter::new();
                w.write_chunk(s, &store, ChunkCoord::new(0, 0), tick);
            });
            fw.section(SectionId::ChunkDeltas, |s| {
                let tiles: &[(u16, Tile)] = &[(0, Tile::new(1, 0, 0))];
                let groups = [(ChunkCoord::new(0, 0), tiles)];
                write_chunk_deltas::<WGame>(s, &groups, &[]);
            });
            let n = sink.finish().unwrap();
            buf.truncate(n);
            good_frames.push(buf);
        }

        let mut reached_sections = 0u32;
        let mut malformed_count = 0u32;
        let mut full_count = 0u32;
        const CASES: u32 = 2000;

        for i in 0..CASES {
            let base = &good_frames[(i as usize) % good_frames.len()];
            let mut mutated = base.clone();
            match rng.below(4) {
                0 => {
                    // Truncate to a random prefix (including possibly 0 bytes).
                    let cut = rand_below(&mut rng, mutated.len() as u32) as usize;
                    mutated.truncate(cut);
                }
                1 => {
                    // Flip a single random bit.
                    if !mutated.is_empty() {
                        let idx = rand_below(&mut rng, mutated.len() as u32) as usize;
                        let bit = 1u8 << (rng.below(8) as u8);
                        mutated[idx] ^= bit;
                    }
                }
                2 => {
                    // Splice in an oversized varint continuation run right after the header.
                    let mut spliced = mutated[..10.min(mutated.len())].to_vec();
                    spliced.extend(std::iter::repeat_n(0xFFu8, 12));
                    spliced.extend_from_slice(&mutated[10.min(mutated.len())..]);
                    mutated = spliced;
                }
                _ => {
                    // Force descending section ids: swap the header-adjacent section id byte (at
                    // offset 10, if present) with something smaller/larger.
                    if mutated.len() > 10 {
                        mutated[10] = rng.below(255) as u8 + 1;
                    }
                }
            }

            match FrameReader::new(&mutated) {
                Err(_) => malformed_count += 1,
                Ok(mut r) => loop {
                    match r.next_section() {
                        Ok(Some((id, body))) => {
                            reached_sections += 1;
                            let mut br = ByteReader::new(body);
                            let result: Result<(), WireError> = match id {
                                SectionId::ActionResults => {
                                    ActionResultsReader::read::<WGame>(&mut br, |_, _| {})
                                }
                                SectionId::Global => {
                                    read_global::<WGame>(&mut br, |_, _| {}).map(|_| ())
                                }
                                SectionId::OwnPlayer => {
                                    read_own_player::<WGame>(&mut br).map(|_| ())
                                }
                                SectionId::ChunkEnterPristine
                                | SectionId::ChunkLeaves
                                | SectionId::ChunkKeeps => {
                                    let mut reader = ChunkCoordListReader::new();
                                    let mut res = Ok(());
                                    while !br.rest().is_empty() {
                                        if let Err(e) = reader.read(&mut br) {
                                            res = Err(e);
                                            break;
                                        }
                                    }
                                    res
                                }
                                SectionId::ChunkSnapshots => {
                                    let mut reader = SnapshotReader::new();
                                    let mut res = Ok(());
                                    while !br.rest().is_empty() {
                                        if let Err(e) = reader.read_chunk::<WGame>(
                                            &mut br,
                                            |_, _| {},
                                            |_, _| {},
                                        ) {
                                            res = Err(e);
                                            break;
                                        }
                                    }
                                    res
                                }
                                SectionId::ChunkDeltas => {
                                    read_chunk_deltas::<WGame>(&mut br, |_, _, _| {}, |_| {})
                                }
                                SectionId::Presence | SectionId::Hashes | SectionId::ChunkTiles => {
                                    Ok(())
                                }
                            };
                            match result {
                                Ok(()) => {}
                                Err(WireError::Malformed) => malformed_count += 1,
                                Err(WireError::Full) => full_count += 1,
                            }
                        }
                        Ok(None) => break,
                        Err(_) => {
                            malformed_count += 1;
                            break;
                        }
                    }
                },
            }
        }

        let _ = full_count;
        // Anti-vacuity: prove the corpus isn't uniformly rejected at byte 0 -- a healthy fraction
        // of mutated inputs must reach at least one section body. The corpus is seeded (a fixed
        // `SimRng` seed and a fixed `CASES`), so its reach is deterministic: measured 2624 on this
        // exact generator (`cargo test --lib wire::tests::decoder_never_panics -- --nocapture`
        // with a temporary `eprintln!`). `2600` leaves only trivial slack for that -- if this ever
        // fires, the generator lost real reach, not noise. Changing the seed, `CASES`, or a
        // mutator deliberately: re-measure and move this bound to match, in the same commit.
        assert!(
            reached_sections >= 2600,
            "corpus barely reaches section bodies: {reached_sections} of {CASES} cases produced a section (expected >= 2600, measured 2624 on this exact generator)"
        );
        // And prove mutation actually produces malformed input at least sometimes (otherwise the
        // mutators themselves could have degenerated into no-ops).
        assert!(
            malformed_count > 0,
            "no mutation ever produced malformed input"
        );

        // -- Uplink batch corpus (M14 fix round 1) ---------------------------------------------
        //
        // An uplink batch is a top-level message off the network, exactly like a `Frame` is (0009
        // "Message classes"), so it gets the same never-panics treatment: `UplinkReader::read`
        // (and, inside it, `CameraReport::read`) must never panic on any byte string, and the
        // corpus must actually reach it rather than be rejected at byte 0.
        let mut good_batches: Vec<Vec<u8>> = Vec::new();
        for i in 0..4u32 {
            let mut buf = vec![0u8; 512];
            let mut sink = SliceSink::new(&mut buf);
            let action_bytes = [1u8, 2, 3];
            let camera = uplink::CameraReport {
                center_x: i as i32,
                center_y: -(i as i32),
                half_w: 64,
                half_h: 36,
                vel_x: 1,
                vel_y: -1,
            };
            let presence = [9u8, 8, 7];
            UplinkWriter::write(
                &mut sink,
                i,
                [(i, action_bytes.as_slice())].into_iter(),
                Some(camera),
                Some(&presence),
            );
            let n = sink.finish().unwrap();
            buf.truncate(n);
            good_batches.push(buf);
        }

        let mut uplink_reached = 0u32;
        let mut uplink_malformed = 0u32;
        const UPLINK_CASES: u32 = 1000;

        for i in 0..UPLINK_CASES {
            let base = &good_batches[(i as usize) % good_batches.len()];
            let mut mutated = base.clone();
            match rng.below(4) {
                0 => {
                    let cut = rand_below(&mut rng, mutated.len() as u32) as usize;
                    mutated.truncate(cut);
                }
                1 => {
                    if !mutated.is_empty() {
                        let idx = rand_below(&mut rng, mutated.len() as u32) as usize;
                        let bit = 1u8 << (rng.below(8) as u8);
                        mutated[idx] ^= bit;
                    }
                }
                2 => {
                    // Splice an oversized varint run right after the fixed 6-byte prefix
                    // (type + flags + last_received_tick), where the action-count varint starts.
                    let mut spliced = mutated[..6.min(mutated.len())].to_vec();
                    spliced.extend(std::iter::repeat_n(0xFFu8, 12));
                    spliced.extend_from_slice(&mutated[6.min(mutated.len())..]);
                    mutated = spliced;
                }
                _ => {
                    // Corrupt the flags byte: forces a camera/presence bit combination that may
                    // not match what actually follows in the bytes.
                    if mutated.len() > 1 {
                        mutated[1] = rng.below(256) as u8;
                    }
                }
            }

            let mut got_actions = 0u32;
            match UplinkReader::read(&mutated, |_, _| got_actions += 1) {
                Ok(_) => uplink_reached += 1,
                Err(WireError::Malformed) => uplink_malformed += 1,
                Err(WireError::Full) => {}
            }
        }

        // Anti-vacuity, same shape as the frame corpus above: seeded and deterministic, so a tight
        // bound is not flaky. Measured 478 of 1000 on this exact generator (temporary `eprintln!`,
        // same procedure as the frame corpus); `460` leaves only trivial slack. Re-measure and move
        // this bound in the same commit as any deliberate seed/`UPLINK_CASES`/mutator change.
        assert!(
            uplink_reached >= 460,
            "uplink corpus barely reaches a decoded batch: {uplink_reached} of {UPLINK_CASES} (expected >= 460, measured 478 on this exact generator)"
        );
        assert!(
            uplink_malformed > 0,
            "no uplink mutation ever produced malformed input"
        );
    }
}
