//! Engine persistence containers (docs/decisions/0005-persistence-and-recovery.md Formats;
//! docs/plan/22-persistence-log-and-snapshots.md): `Identity`, the log's `SegmentHeader` and
//! frame writer/reader, and the streaming snapshot writer/reader. Write side and native
//! replay/heavy mode only -- loading a stored world, the `node:fs` adapter and the ABI exports
//! that expose these are `docs/plan/22b-persistence-load-and-fs.md`'s.
//!
//! **Field order is fixed wire format**, owned by 0005 Formats: see `persist/CLAUDE.md`. Never
//! iterate an unordered container here (`.claude/rules/determinism.md`).

mod crc32;
mod frame;
mod identity;
mod segment;
mod snapshot;

pub use crc32::crc32;
pub use frame::{DecodedFrame, FrameProgress, FrameReader, FrameRecord, FrameWriter, RecordKind};
pub use identity::Identity;
pub use segment::{SegmentBase, SegmentHeader};
pub use snapshot::{SnapshotInfo, SnapshotProgress, SnapshotReader, SnapshotWriter};

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{Codec, CodecError, decode_canonical, encode_to, encoded_len};

/// Every error this module's readers can report: a truncated or otherwise malformed container, or
/// one whose trailing CRC-32 does not match its bytes (0005 Recovery: "re-apply frames until the
/// first truncated or CRC-failing frame"). Deliberately not `From<CodecError>` at the type level
/// for callers outside this module -- inside it, `crc32::tests` and the reader modules convert
/// explicitly, since a bare `?` from a `CodecError` would blur "ran out of bytes" (`Malformed`,
/// correct) with a genuine postcard/`Codec` decode failure (also `Malformed` here, but worth a
/// named conversion site instead of an implicit blanket `impl`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistError {
    /// Not enough bytes, an out-of-range tag, an overlong varint, or a `Codec` value that failed
    /// to decode canonically.
    Malformed,
    /// A trailing CRC-32 did not match the bytes it protects.
    Crc,
    /// docs/plan/22b-persistence-load-and-fs.md: a snapshot's own `container_version` did not match
    /// this build's (`snapshot::CONTAINER_VERSION`) -- distinct from `Malformed` so the ABI layer
    /// can report `Status::ContainerVersion` rather than a generic `Status::Corrupt`.
    ContainerVersion,
}

impl From<CodecError> for PersistError {
    fn from(_: CodecError) -> Self {
        PersistError::Malformed
    }
}

/// A length-prefixed `Codec` value: varint byte count, then canonical bytes (mirrors
/// `crate::store`'s own private `write_sized`/`read_sized` -- duplicated here, not imported,
/// since `crate::store`'s copy is private to that module and this crate's own convention is a
/// small free function beside its one caller, not a shared-utility module for two lines).
pub(crate) fn write_sized<T: Codec>(value: &T, sink: &mut impl ByteSink) {
    sink.put_varint(encoded_len(value) as u64);
    encode_to(value, sink).expect("encoding into a ByteSink cannot fail");
}

/// The untrusted-bytes half of [`write_sized`]: goes through `decode_canonical`
/// (`.claude/rules/determinism.md`: "untrusted bytes go through `codec::decode_canonical`, never
/// plain `decode`"), since every reader in this module parses bytes that came from storage.
pub(crate) fn read_sized<T: Codec>(reader: &mut ByteReader) -> Result<T, PersistError> {
    let len = reader.varint().map_err(|_| PersistError::Malformed)? as usize;
    let bytes = reader.bytes(len).map_err(|_| PersistError::Malformed)?;
    decode_canonical(bytes).map_err(|_| PersistError::Malformed)
}

/// A leading varint's value, peeked without committing to consuming it from a growing buffer that
/// may not yet hold the whole thing (the streaming readers' own "arbitrary block splits" contract,
/// docs/plan/22-persistence-log-and-snapshots.md Seams). Same 10-byte `u64` bound as
/// `ByteReader::varint`, but distinguishes "not enough bytes buffered yet" from "this varint is
/// simply too long to be valid" -- a distinction `ByteReader` itself has no reason to make, since
/// it always reads from a single already-complete slice.
pub(crate) enum VarintPeek {
    /// Every byte seen so far had its continuation bit set: wait for more.
    Incomplete,
    /// Ten bytes in and still not terminated: not a valid varint, ever.
    Malformed,
    /// The value, and how many bytes of `buf` it occupied.
    Value(u64, usize),
}

pub(crate) fn peek_varint(buf: &[u8]) -> VarintPeek {
    let mut out: u64 = 0;
    for i in 0..10 {
        let Some(&byte) = buf.get(i) else {
            return VarintPeek::Incomplete;
        };
        let carry = (byte & 0x7f) as u64;
        if i == 9 && carry > 1 {
            return VarintPeek::Malformed;
        }
        out |= carry << (7 * i);
        if byte & 0x80 == 0 {
            return VarintPeek::Value(out, i + 1);
        }
    }
    VarintPeek::Malformed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peek_varint_matches_reader_varint_once_complete() {
        let mut bytes = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        V(&mut bytes).put_varint(300);
        match peek_varint(&bytes) {
            VarintPeek::Value(v, n) => {
                assert_eq!(v, 300);
                assert_eq!(n, bytes.len());
            }
            _ => panic!("expected a complete value"),
        }
    }

    #[test]
    fn peek_varint_reports_incomplete_on_a_short_buffer() {
        let mut bytes = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        V(&mut bytes).put_varint(300); // two bytes, both with the continuation bit meaningful
        assert!(matches!(peek_varint(&bytes[..1]), VarintPeek::Incomplete));
    }

    #[test]
    fn peek_varint_rejects_an_overlong_varint() {
        let bytes = [0x80u8; 11];
        assert!(matches!(peek_varint(&bytes), VarintPeek::Malformed));
    }
}
