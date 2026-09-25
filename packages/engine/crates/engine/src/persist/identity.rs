//! `Identity` (docs/decisions/0005-persistence-and-recovery.md "Sim identity"): the first 128 bits
//! of the build hash (SHA-256 of the `.wasm`, computed once by the build, 0017), plus readable
//! `engine_version`/`game_version`, `SCHEMA_VERSION`, `tick_rate_hz` and the worldgen stamp
//! (`WORLDGEN_VERSION` + fingerprint, 0007 §9). Embedded, not length-prefixed as a whole, inside
//! [`crate::persist::SegmentHeader`] and a snapshot's own container.
//!
//! Comparing an `Identity` against the running build's own (the whole reason it exists: "a log
//! replays only against the `.wasm` that produced it", 0002) is Non-scope here -- M22b/M24b own
//! that check. This module is only the value and its wire shape.

use crate::bytes::{ByteReader, ByteSink};
use crate::persist::PersistError;
use crate::worldgen::WorldgenStamp;

/// See the module doc comment. Field order is fixed wire format (0005 Formats): changing it
/// bumps `container_version` (this crate's `persist/CLAUDE.md`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// First 128 bits of the build hash (0017): a `.wasm` content hash, computed by the build,
    /// not by this crate.
    pub build_hash: [u8; 16],
    pub engine_version: String,
    pub game_version: String,
    pub schema_version: u32,
    pub tick_rate_hz: u32,
    pub worldgen: WorldgenStamp,
}

fn write_str(s: &str, sink: &mut impl ByteSink) {
    sink.put_varint(s.len() as u64);
    sink.put(s.as_bytes());
}

fn read_str(reader: &mut ByteReader) -> Result<String, PersistError> {
    let len = reader.varint().map_err(|_| PersistError::Malformed)? as usize;
    let bytes = reader.bytes(len).map_err(|_| PersistError::Malformed)?;
    String::from_utf8(bytes.to_vec()).map_err(|_| PersistError::Malformed)
}

impl Identity {
    pub fn write(&self, sink: &mut impl ByteSink) {
        sink.put(&self.build_hash);
        write_str(&self.engine_version, sink);
        write_str(&self.game_version, sink);
        sink.put_u32(self.schema_version);
        sink.put_u32(self.tick_rate_hz);
        sink.put_u32(self.worldgen.version);
        sink.put_u64(self.worldgen.fingerprint);
    }

    pub fn read(reader: &mut ByteReader) -> Result<Self, PersistError> {
        let mut build_hash = [0u8; 16];
        build_hash.copy_from_slice(reader.bytes(16).map_err(|_| PersistError::Malformed)?);
        let engine_version = read_str(reader)?;
        let game_version = read_str(reader)?;
        let schema_version = reader.u32().map_err(|_| PersistError::Malformed)?;
        let tick_rate_hz = reader.u32().map_err(|_| PersistError::Malformed)?;
        let wg_version = reader.u32().map_err(|_| PersistError::Malformed)?;
        let wg_fingerprint = reader.u64().map_err(|_| PersistError::Malformed)?;
        Ok(Identity {
            build_hash,
            engine_version,
            game_version,
            schema_version,
            tick_rate_hz,
            worldgen: WorldgenStamp {
                version: wg_version,
                fingerprint: wg_fingerprint,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::CountSink;

    fn sample() -> Identity {
        Identity {
            build_hash: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            engine_version: "0.1.0".to_string(),
            game_version: "0.2.0".to_string(),
            schema_version: 3,
            tick_rate_hz: 20,
            worldgen: WorldgenStamp {
                version: 7,
                fingerprint: 0x0102_0304_0506_0708,
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
    fn identity_roundtrip() {
        let id = sample();
        let mut sink = VecSink(Vec::new());
        id.write(&mut sink);
        let mut reader = ByteReader::new(&sink.0);
        let back = Identity::read(&mut reader).expect("roundtrip");
        assert_eq!(id, back);
        assert!(reader.rest().is_empty(), "no trailing bytes");
    }

    #[test]
    fn identity_write_len_matches_count_sink() {
        let id = sample();
        let mut count = CountSink::default();
        id.write(&mut count);
        let mut sink = VecSink(Vec::new());
        id.write(&mut sink);
        assert_eq!(count.0, sink.0.len());
    }

    #[test]
    fn identity_read_rejects_truncated_bytes() {
        let id = sample();
        let mut sink = VecSink(Vec::new());
        id.write(&mut sink);
        sink.0.truncate(sink.0.len() - 1);
        let mut reader = ByteReader::new(&sink.0);
        assert_eq!(Identity::read(&mut reader), Err(PersistError::Malformed));
    }
}
