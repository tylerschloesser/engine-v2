//! `SegmentHeader` (0005 Formats: "A segment header carries the identity and names its base
//! snapshot"): identity plus whether this segment starts from genesis or from a snapshot taken at
//! a given tick -- the binary counterpart of `ManifestV1`'s own `base: 'genesis' | tick`
//! (docs/plan/22-persistence-log-and-snapshots.md Planning decisions 3, TS/manifest side, M22b).
//! No trailing CRC of its own (unlike a frame or a snapshot): 0005 does not specify one, and a
//! segment header that fails to parse is simply an unreadable segment, a case this milestone does
//! not yet recover from (Non-scope: torn-frame truncation, segment rolling).

use crate::bytes::{ByteReader, ByteSink};
use crate::persist::{Identity, PersistError};
use crate::time::Tick;

/// What a segment's log frames replay on top of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentBase {
    /// Segment 0: replay starts from `Game::genesis` (seed + world params, held by the manifest,
    /// not repeated here).
    Genesis,
    /// A later segment, opened after the upgrade path re-executed a tail and wrote a fresh
    /// snapshot (0005 "Upgrades"): replay starts by loading the snapshot at this tick.
    Snapshot(Tick),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentHeader {
    pub identity: Identity,
    pub base: SegmentBase,
}

impl SegmentHeader {
    pub fn write(&self, sink: &mut impl ByteSink) {
        self.identity.write(sink);
        match self.base {
            SegmentBase::Genesis => sink.put_u8(0),
            SegmentBase::Snapshot(tick) => {
                sink.put_u8(1);
                sink.put_u32(tick.0);
            }
        }
    }

    pub fn read(reader: &mut ByteReader) -> Result<Self, PersistError> {
        let identity = Identity::read(reader)?;
        let tag = reader.u8().map_err(|_| PersistError::Malformed)?;
        let base = match tag {
            0 => SegmentBase::Genesis,
            1 => SegmentBase::Snapshot(Tick(reader.u32().map_err(|_| PersistError::Malformed)?)),
            _ => return Err(PersistError::Malformed),
        };
        Ok(SegmentHeader { identity, base })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worldgen::WorldgenStamp;

    fn identity() -> Identity {
        Identity {
            build_hash: [7; 16],
            engine_version: "0.1.0".to_string(),
            game_version: "1.0.0".to_string(),
            schema_version: 1,
            tick_rate_hz: 20,
            worldgen: WorldgenStamp {
                version: 1,
                fingerprint: 42,
            },
        }
    }

    struct VecSink(Vec<u8>);
    impl ByteSink for VecSink {
        fn put(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }

    #[test]
    fn segment_header_roundtrips_genesis() {
        let h = SegmentHeader {
            identity: identity(),
            base: SegmentBase::Genesis,
        };
        let mut sink = VecSink(Vec::new());
        h.write(&mut sink);
        let mut reader = ByteReader::new(&sink.0);
        assert_eq!(SegmentHeader::read(&mut reader).unwrap(), h);
        assert!(reader.rest().is_empty());
    }

    #[test]
    fn segment_header_roundtrips_snapshot_base() {
        let h = SegmentHeader {
            identity: identity(),
            base: SegmentBase::Snapshot(Tick(12_345)),
        };
        let mut sink = VecSink(Vec::new());
        h.write(&mut sink);
        let mut reader = ByteReader::new(&sink.0);
        assert_eq!(SegmentHeader::read(&mut reader).unwrap(), h);
    }

    #[test]
    fn segment_header_rejects_unknown_base_tag() {
        let h = SegmentHeader {
            identity: identity(),
            base: SegmentBase::Genesis,
        };
        let mut sink = VecSink(Vec::new());
        h.write(&mut sink);
        *sink.0.last_mut().unwrap() = 9; // the base tag byte
        let mut reader = ByteReader::new(&sink.0);
        assert_eq!(
            SegmentHeader::read(&mut reader),
            Err(PersistError::Malformed)
        );
    }
}
