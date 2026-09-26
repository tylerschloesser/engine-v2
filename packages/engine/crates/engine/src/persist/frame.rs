//! The write-ahead log's frame container (0005 Formats): "a segment holds one frame per tick that
//! had actions: `len varint | tick_delta varint | count varint | records | crc32`; a record is
//! `kind u8 | player_slot u8 | payload`." Ticks without actions are not logged; the gap is implied
//! by `tick_delta` (the number of ticks since the previous logged frame, counting this one).
//!
//! **`player_slot` is `PlayerId` truncated to a `u8`** (0003: "assigned at first join ... a small
//! integer" -- 2-8 players per world, `docs/spec/overview.md` Scale): the log format's own
//! justification for calling it a "slot" rather than repeating the full `u32` id. A `PlayerId`
//! that does not fit is a bug elsewhere (`debug_assert!`ed on write, never produced by this
//! milestone's own fixture or tests).
//!
//! **Each action payload is length-prefixed** (`seq varint | sized(G::Action)`, `crate::persist::
//! write_sized`/`read_sized`), not left to `Codec`'s own self-delimiting decode: this is a
//! deviation from 0005's bare `seq varint | G::Action` grammar, matching the same length-prefix
//! convention `Store::write_canonical` already uses for every game-typed value, so untrusted bytes
//! always go through `decode_canonical` over an exact, pre-sliced span (`.claude/rules/
//! determinism.md`) rather than a decode that reads "as much as it needs" from a longer, unverified
//! tail (docs/plan/22-persistence-log-and-snapshots.md Deviations has the reasoning).
//!
//! [`FrameReader`] is a resumable cursor: `push` accepts bytes in any split (one byte at a time or
//! the whole log at once) and returns [`FrameProgress::NeedMore`] until one whole, CRC-verified
//! frame is buffered, then [`FrameProgress::Frame`] -- extra already-buffered bytes are simply left
//! for the next `push` call (which may pass an empty slice to drain them).

use crate::bytes::{ByteReader, ByteSink};
use crate::game::{Game, PlayerEvent, PlayerId};
use crate::persist::{PersistError, VarintPeek, crc32, peek_varint, read_sized, write_sized};

/// A frame can never exceed the `Persist` region (Planning decisions 5 of docs/plan/
/// 22-persistence-log-and-snapshots.md: "pending-frame capacity is fixed ... well under the region
/// size", region sized at 256 KiB by that same brief's Seams). 64 KiB is a generous ceiling on the
/// *frame body* (excluding the leading `len` varint) a corrupt or adversarial `len` cannot inflate
/// past -- without this, [`FrameReader::push`] would happily buffer an unbounded amount of memory
/// chasing a bogus length before ever getting to see the CRC that would reject it.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecordKind {
    Action = 0,
    Connection = 1,
    /// Reserved (0005 "Panic recovery"): decodes as a no-op. Nothing in this milestone produces
    /// one -- M24 owns writing it during recovery.
    Skip = 2,
}

/// One decoded (or about-to-be-written) log record (0005 Formats). Distinct from `crate::sim::
/// Record<G>`: that type has no `Skip` variant (engine-internal, never produced by `Sim::step`'s
/// own callers), and this one is the wire shape, not the sim-facing one.
pub enum FrameRecord<G: Game> {
    Action {
        who: PlayerId,
        seq: u32,
        action: G::Action,
    },
    Connection {
        who: PlayerId,
        ev: PlayerEvent,
    },
    /// `segment`/`offset` name the frame whose replay panicked (0005 "Panic recovery" step 3);
    /// decoded and otherwise ignored by this milestone (`skip_kind_decodes_as_noop`).
    Skip {
        segment: u32,
        offset: u32,
    },
}

impl<G: Game> Clone for FrameRecord<G>
where
    G::Action: Clone,
{
    fn clone(&self) -> Self {
        match self {
            FrameRecord::Action { who, seq, action } => FrameRecord::Action {
                who: *who,
                seq: *seq,
                action: action.clone(),
            },
            FrameRecord::Connection { who, ev } => FrameRecord::Connection { who: *who, ev: *ev },
            FrameRecord::Skip { segment, offset } => FrameRecord::Skip {
                segment: *segment,
                offset: *offset,
            },
        }
    }
}

fn encode_player_event(ev: PlayerEvent) -> u8 {
    match ev {
        PlayerEvent::Joined => 0,
        PlayerEvent::Connected => 1,
        PlayerEvent::Disconnected => 2,
    }
}

fn decode_player_event(tag: u8) -> Result<PlayerEvent, PersistError> {
    match tag {
        0 => Ok(PlayerEvent::Joined),
        1 => Ok(PlayerEvent::Connected),
        2 => Ok(PlayerEvent::Disconnected),
        _ => Err(PersistError::Malformed),
    }
}

impl<G: Game> FrameRecord<G> {
    fn write(&self, sink: &mut impl ByteSink) {
        match self {
            FrameRecord::Action { who, seq, action } => {
                debug_assert!(who.0 <= u8::MAX as u32, "player_slot must fit a u8 (0005)");
                sink.put_u8(RecordKind::Action as u8);
                sink.put_u8(who.0 as u8);
                sink.put_varint(*seq as u64);
                write_sized(action, sink);
            }
            FrameRecord::Connection { who, ev } => {
                debug_assert!(who.0 <= u8::MAX as u32, "player_slot must fit a u8 (0005)");
                sink.put_u8(RecordKind::Connection as u8);
                sink.put_u8(who.0 as u8);
                sink.put_u8(encode_player_event(*ev));
            }
            FrameRecord::Skip { segment, offset } => {
                sink.put_u8(RecordKind::Skip as u8);
                sink.put_u8(0); // player_slot: unused for a Skip record.
                sink.put_u32(*segment);
                sink.put_u32(*offset);
            }
        }
    }

    fn read(reader: &mut ByteReader) -> Result<Self, PersistError> {
        let kind = reader.u8().map_err(|_| PersistError::Malformed)?;
        let player_slot = reader.u8().map_err(|_| PersistError::Malformed)?;
        let who = PlayerId(player_slot as u32);
        match kind {
            k if k == RecordKind::Action as u8 => {
                let seq = reader.varint().map_err(|_| PersistError::Malformed)? as u32;
                let action: G::Action = read_sized(reader)?;
                Ok(FrameRecord::Action { who, seq, action })
            }
            k if k == RecordKind::Connection as u8 => {
                let ev = decode_player_event(reader.u8().map_err(|_| PersistError::Malformed)?)?;
                Ok(FrameRecord::Connection { who, ev })
            }
            k if k == RecordKind::Skip as u8 => {
                let segment = reader.u32().map_err(|_| PersistError::Malformed)?;
                let offset = reader.u32().map_err(|_| PersistError::Malformed)?;
                Ok(FrameRecord::Skip { segment, offset })
            }
            _ => Err(PersistError::Malformed),
        }
    }
}

/// Builds one frame (Order of work step 1 of docs/plan/22-persistence-log-and-snapshots.md):
/// accumulate records with `push_*`, then [`FrameWriter::finish`] to encode the whole
/// `len | tick_delta | count | records | crc32` container.
#[derive(Default)]
pub struct FrameWriter<G: Game> {
    records: Vec<FrameRecord<G>>,
}

impl<G: Game> FrameWriter<G> {
    pub fn new() -> Self {
        FrameWriter {
            records: Vec::new(),
        }
    }

    pub fn push_action(&mut self, who: PlayerId, seq: u32, action: G::Action) {
        self.records.push(FrameRecord::Action { who, seq, action });
    }

    pub fn push_connection(&mut self, who: PlayerId, ev: PlayerEvent) {
        self.records.push(FrameRecord::Connection { who, ev });
    }

    pub fn push_skip(&mut self, segment: u32, offset: u32) {
        self.records.push(FrameRecord::Skip { segment, offset });
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Encodes `len varint | tick_delta varint | count varint | records | crc32` into `sink`.
    /// `tick_delta` is the number of ticks since the previous logged frame, counting this one
    /// (0005: "ticks without actions are not logged; they are implied by `tick_delta`").
    pub fn finish(&self, tick_delta: u32, sink: &mut impl ByteSink) {
        let mut body = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        {
            let mut v = V(&mut body);
            v.put_varint(tick_delta as u64);
            v.put_varint(self.records.len() as u64);
            for r in &self.records {
                r.write(&mut v);
            }
        }
        let crc = crc32(&body);
        sink.put_varint((body.len() + 4) as u64);
        sink.put(&body);
        sink.put_u32(crc);
    }
}

pub struct DecodedFrame<G: Game> {
    pub tick_delta: u32,
    pub records: Vec<FrameRecord<G>>,
    /// Byte offset of this frame's own leading `len` varint, relative to the first byte ever fed
    /// to this [`FrameReader`] (docs/plan/24-recovery-and-migration.md: `sim_replay_begin`'s own
    /// `offset` argument is what a caller adds to get an absolute segment offset -- the same basis
    /// [`FrameReader::buffered_len`]'s own callers already use, e.g. `sim_replay_valid_end`).
    pub frame_offset: u64,
    /// Byte offset of each record's own leading `kind` byte, one entry per `records` entry in the
    /// same order, same relative-to-reader-start basis as `frame_offset` (not relative to the
    /// frame itself) -- 0005's `Skip { segment, offset }` names exactly this position.
    pub record_offsets: Vec<u64>,
}

pub enum FrameProgress<G: Game> {
    NeedMore,
    Frame(DecodedFrame<G>),
}

/// A resumable, block-split-tolerant frame decoder (module doc comment; docs/plan/
/// 22-persistence-log-and-snapshots.md Seams: "`FrameReader::push` accept[s] arbitrary block
/// splits"). One `FrameReader` can decode many frames back to back, one `push` call at a time.
pub struct FrameReader<G: Game> {
    buf: Vec<u8>,
    /// Total bytes ever consumed by a successfully decoded frame (docs/plan/
    /// 24-recovery-and-migration.md): the basis `DecodedFrame::frame_offset`/`record_offsets` are
    /// measured from. Distinct from `buffered_len()`, which reports bytes *not yet* consumed.
    total_consumed: u64,
    _marker: core::marker::PhantomData<fn() -> G>,
}

impl<G: Game> Default for FrameReader<G> {
    fn default() -> Self {
        Self::new()
    }
}

impl<G: Game> FrameReader<G> {
    pub fn new() -> Self {
        FrameReader {
            buf: Vec::new(),
            total_consumed: 0,
            _marker: core::marker::PhantomData,
        }
    }

    /// Feeds `block` (any length, including empty -- an empty call just tries to drain whatever is
    /// already buffered) and returns at most one decoded frame. If more than one frame's worth of
    /// bytes is already buffered, the rest waits for the next call.
    /// Bytes still buffered and not yet consumed by a decoded frame (docs/plan/
    /// 22b-persistence-load-and-fs.md): the replay driver's own way to compute how many bytes of a
    /// segment tail were consumed by valid, CRC-checked frames (`fed - buffered_len()`) without this
    /// module exposing its internal parse state any further. On a decode error the malformed bytes
    /// are left in the buffer (never drained), so this correctly still names the byte just before
    /// them as "consumed".
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    pub fn push(&mut self, block: &[u8]) -> Result<FrameProgress<G>, PersistError> {
        self.buf.extend_from_slice(block);
        let (len, prefix) = match peek_varint(&self.buf) {
            VarintPeek::Incomplete => return Ok(FrameProgress::NeedMore),
            VarintPeek::Malformed => return Err(PersistError::Malformed),
            VarintPeek::Value(v, n) => (v as usize, n),
        };
        if len > MAX_FRAME_BYTES {
            return Err(PersistError::Malformed);
        }
        if len < 4 {
            // Every frame body ends with a 4-byte crc32; shorter than that is never valid.
            return Err(PersistError::Malformed);
        }
        if self.buf.len() < prefix + len {
            return Ok(FrameProgress::NeedMore);
        }
        let whole = &self.buf[prefix..prefix + len];
        let (body, crc_bytes) = whole.split_at(len - 4);
        let want_crc = u32::from_le_bytes(crc_bytes.try_into().expect("exactly 4 bytes"));
        if crc32(body) != want_crc {
            return Err(PersistError::Crc);
        }
        let mut reader = ByteReader::new(body);
        let tick_delta = reader.varint().map_err(|_| PersistError::Malformed)? as u32;
        let count = reader.varint().map_err(|_| PersistError::Malformed)? as u32;
        let frame_offset = self.total_consumed;
        let body_base = frame_offset + prefix as u64;
        let mut records = Vec::with_capacity(count as usize);
        let mut record_offsets = Vec::with_capacity(count as usize);
        for _ in 0..count {
            record_offsets.push(body_base + reader.pos() as u64);
            records.push(FrameRecord::read(&mut reader)?);
        }
        let consumed = prefix + len;
        self.buf.drain(..consumed);
        self.total_consumed += consumed as u64;
        Ok(FrameProgress::Frame(DecodedFrame {
            tick_delta,
            records,
            frame_offset,
            record_offsets,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{PrototypeId, Registry, TilePos};
    use crate::worldgen::Worldgen;

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum TAction {
        Ping(u32),
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal;
    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(
            _seed: u64,
            _params: &(),
            _chunk: crate::world::ChunkCoord,
            out: &mut [crate::world::Tile],
        ) {
            out.fill(crate::world::Tile::VOID);
        }
    }
    struct TGame;
    impl Game for TGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = TGen;
        type Action = TAction;
        type Reject = TReject;
        type Entity = TEntity;
        type Player = TPlayer;
        type Global = TGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &TEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: crate::game::PlayerId, _ev: PlayerEvent) {
        }
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: crate::game::PlayerId,
            _a: &TAction,
        ) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn sample_frame_bytes() -> Vec<u8> {
        let mut w: FrameWriter<TGame> = FrameWriter::new();
        w.push_action(PlayerId(1), 7, TAction::Ping(42));
        w.push_connection(PlayerId(2), PlayerEvent::Joined);
        let mut out = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        w.finish(3, &mut V(&mut out));
        out
    }

    // Feature `testing`, like every `assert_golden_bytes!` caller (`crate::testing::golden_bytes`
    // itself is behind that feature).
    #[cfg(feature = "testing")]
    #[test]
    fn persist_frame_golden_bytes() {
        let bytes = sample_frame_bytes();
        crate::assert_golden_bytes!("persist_frame_golden_bytes", &bytes);
    }

    #[test]
    fn frame_roundtrip_whole_buffer() {
        let bytes = sample_frame_bytes();
        let mut reader: FrameReader<TGame> = FrameReader::new();
        match reader.push(&bytes).unwrap() {
            FrameProgress::Frame(f) => {
                assert_eq!(f.tick_delta, 3);
                assert_eq!(f.records.len(), 2);
                assert!(matches!(
                    f.records[0],
                    FrameRecord::Action {
                        who: PlayerId(1),
                        seq: 7,
                        action: TAction::Ping(42),
                    }
                ));
                assert!(matches!(
                    f.records[1],
                    FrameRecord::Connection {
                        who: PlayerId(2),
                        ev: PlayerEvent::Joined,
                    }
                ));
            }
            FrameProgress::NeedMore => panic!("a whole frame must decode in one push"),
        }
        assert!(matches!(reader.push(&[]).unwrap(), FrameProgress::NeedMore));
    }

    #[test]
    fn frame_reader_accepts_arbitrary_block_splits() {
        let bytes = sample_frame_bytes();
        let mut reader: FrameReader<TGame> = FrameReader::new();
        let mut decoded = None;
        for byte in &bytes {
            match reader.push(std::slice::from_ref(byte)).unwrap() {
                FrameProgress::NeedMore => {}
                FrameProgress::Frame(f) => {
                    decoded = Some(f);
                    break;
                }
            }
        }
        let f = decoded.expect("must decode fed one byte at a time");
        assert_eq!(f.tick_delta, 3);
        assert_eq!(f.records.len(), 2);
    }

    #[test]
    fn frame_reader_decodes_two_frames_back_to_back() {
        let mut buf = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        let mut w1: FrameWriter<TGame> = FrameWriter::new();
        w1.push_action(PlayerId(1), 1, TAction::Ping(1));
        w1.finish(1, &mut V(&mut buf));
        let mut w2: FrameWriter<TGame> = FrameWriter::new();
        w2.push_action(PlayerId(1), 2, TAction::Ping(2));
        w2.finish(1, &mut V(&mut buf));

        let mut reader: FrameReader<TGame> = FrameReader::new();
        let first = match reader.push(&buf).unwrap() {
            FrameProgress::Frame(f) => f,
            FrameProgress::NeedMore => panic!("first frame must be ready"),
        };
        assert!(matches!(
            first.records[0],
            FrameRecord::Action { seq: 1, .. }
        ));
        let second = match reader.push(&[]).unwrap() {
            FrameProgress::Frame(f) => f,
            FrameProgress::NeedMore => panic!("second frame was already fully buffered"),
        };
        assert!(matches!(
            second.records[0],
            FrameRecord::Action { seq: 2, .. }
        ));
    }

    #[test]
    fn frame_reader_rejects_a_bad_crc() {
        let mut bytes = sample_frame_bytes();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        let mut reader: FrameReader<TGame> = FrameReader::new();
        match reader.push(&bytes) {
            Err(e) => assert_eq!(e, PersistError::Crc),
            Ok(_) => panic!("a bad crc must be rejected"),
        }
    }

    #[test]
    fn skip_kind_decodes_as_noop() {
        let mut w: FrameWriter<TGame> = FrameWriter::new();
        w.push_skip(5, 1234);
        let mut out = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        w.finish(1, &mut V(&mut out));
        let mut reader: FrameReader<TGame> = FrameReader::new();
        let frame = match reader.push(&out).unwrap() {
            FrameProgress::Frame(f) => f,
            FrameProgress::NeedMore => panic!("must decode"),
        };
        assert_eq!(frame.records.len(), 1);
        assert!(matches!(
            frame.records[0],
            FrameRecord::Skip {
                segment: 5,
                offset: 1234,
            }
        ));
    }
}
