//! `Identity` (docs/decisions/0005-persistence-and-recovery.md "Sim identity"): the first 128 bits
//! of the build hash (SHA-256 of the `.wasm`, computed once by the build, 0017), plus readable
//! `engine_version`/`game_version`, `SCHEMA_VERSION`, `tick_rate_hz` and the worldgen stamp
//! (`WORLDGEN_VERSION` + fingerprint, 0007 §9). Embedded, not length-prefixed as a whole, inside
//! [`crate::persist::SegmentHeader`] and a snapshot's own container.
//!
//! `Identity::compare` (M24b, docs/plan/24b-upgrade-and-migration.md Planning decisions 5): the
//! whole reason `Identity` exists ("a log replays only against the `.wasm` that produced it",
//! 0002) is this comparison. `container_version` is deliberately not a field of `Identity` (it
//! lives in the snapshot envelope, 0005 Formats) and is never checked here: `SnapshotReader`
//! already rejects a mismatched container before `Identity::read` ever runs, so by the time two
//! `Identity` values reach [`Identity::compare`] the envelope has already agreed.

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

/// Which of the three "does the world need `Game::migrate`" fields (0006 point 2, 0007 §9) first
/// differs, in the fixed priority order this milestone picks when more than one does: schema,
/// then tick rate, then worldgen. `engine_version`/`game_version` never appear here (0005
/// Upgrades: "informational only").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MismatchReason {
    Schema,
    TickRate,
    Worldgen,
}

/// `Identity::compare`'s own outcome (docs/plan/24b-upgrade-and-migration.md Order of work 1;
/// decision 5's matrix, followed literally): `Same` (identical build hash, load the log tail
/// as-is), `Direct` (a different build, but schema/tick-rate/worldgen all agree: load the
/// snapshot then re-execute the tail), `NeedsMigrate` (`Game::migrate` must run first;
/// `MismatchReason` says which field forced it). A `SCHEMA_VERSION` difference is `NeedsMigrate`
/// **in either direction**: decision 5 never singles out a stored schema newer than the running
/// build's as its own case, and `Game::migrate` deciding is exactly the seam 0005 gives a game to
/// accept an older build's save written by a newer one, if it chooses to (fix round 1: an earlier
/// revision of this module added its own `Incompatible(Schema)` branch for that case instead --
/// reverted per the orchestrator's ruling, this milestone's own Deviations). Every `Incompatible`
/// outcome in the full pipeline (`Container`, `MigrateDeclined` -- `Game::migrate`'s own default
/// `Err(SaveIncompatible)`, `Decode`, `ChunkSize`) is decided above this module, never by
/// `compare` itself -- see `crate::migrate`'s own module doc comment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comparison {
    Same,
    Direct,
    NeedsMigrate(MismatchReason),
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

    /// `self` is the identity a save was written with; `running` is the executing build's own.
    /// 0005 Upgrades: "if the running identity hash differs from the stored one" means the
    /// 128-bit build hash specifically (0005 Formats "Sim identity") -- an equal build hash is
    /// definitionally the same schema/tick-rate/worldgen too, since those are all compiled into
    /// the one `.wasm` the hash names.
    ///
    /// ```
    /// use engine::persist::{Comparison, Identity, MismatchReason};
    /// use engine::worldgen::WorldgenStamp;
    ///
    /// fn id(build_hash: u8, schema: u32, hz: u32) -> Identity {
    ///     Identity {
    ///         build_hash: [build_hash; 16],
    ///         engine_version: "0.1.0".into(),
    ///         game_version: "0.1.0".into(),
    ///         schema_version: schema,
    ///         tick_rate_hz: hz,
    ///         worldgen: WorldgenStamp { version: 1, fingerprint: 7 },
    ///     }
    /// }
    ///
    /// let running = id(1, 2, 20);
    /// assert_eq!(id(1, 2, 20).compare(&running), Comparison::Same);
    /// assert_eq!(id(2, 2, 20).compare(&running), Comparison::Direct);
    /// // Either direction is `NeedsMigrate`; `Game::migrate` decides whether it can bring an
    /// // older schema forward, or (the game's own choice) an older build accepting a newer one.
    /// assert_eq!(
    ///     id(2, 1, 20).compare(&running),
    ///     Comparison::NeedsMigrate(MismatchReason::Schema)
    /// );
    /// assert_eq!(
    ///     id(2, 3, 20).compare(&running),
    ///     Comparison::NeedsMigrate(MismatchReason::Schema)
    /// );
    /// ```
    pub fn compare(&self, running: &Identity) -> Comparison {
        if self.build_hash == running.build_hash {
            return Comparison::Same;
        }
        if self.schema_version == running.schema_version
            && self.tick_rate_hz == running.tick_rate_hz
            && self.worldgen == running.worldgen
        {
            return Comparison::Direct;
        }
        if self.schema_version != running.schema_version {
            return Comparison::NeedsMigrate(MismatchReason::Schema);
        }
        if self.tick_rate_hz != running.tick_rate_hz {
            return Comparison::NeedsMigrate(MismatchReason::TickRate);
        }
        Comparison::NeedsMigrate(MismatchReason::Worldgen)
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

    fn id_at(build_hash: u8, schema: u32, hz: u32, wg_version: u32, wg_fp: u64) -> Identity {
        Identity {
            build_hash: [build_hash; 16],
            engine_version: "0.1.0".to_string(),
            game_version: "0.1.0".to_string(),
            schema_version: schema,
            tick_rate_hz: hz,
            worldgen: WorldgenStamp {
                version: wg_version,
                fingerprint: wg_fp,
            },
        }
    }

    fn running() -> Identity {
        id_at(1, 2, 20, 1, 100)
    }

    /// 0005 Upgrades' whole matrix (decision 5), one case per row, followed literally (fix round
    /// 1: a schema mismatch is `NeedsMigrate` in *either* direction, never `Incompatible` -- an
    /// earlier revision of this test asserted the opposite for a newer stored schema; reverted per
    /// the orchestrator's ruling), plus the "more than one field differs" priority order.
    #[test]
    fn identity_compare_matrix() {
        let r = running();

        // Same build hash: everything else is irrelevant.
        assert_eq!(id_at(1, 2, 20, 1, 100).compare(&r), Comparison::Same);
        assert_eq!(id_at(1, 99, 99, 9, 9).compare(&r), Comparison::Same);

        // Different hash, everything else equal: direct load + tail re-execution.
        assert_eq!(id_at(2, 2, 20, 1, 100).compare(&r), Comparison::Direct);

        // engine_version/game_version alone never matter (0005: "informational only").
        let mut differing_versions = id_at(2, 2, 20, 1, 100);
        differing_versions.engine_version = "9.9.9".to_string();
        differing_versions.game_version = "9.9.9".to_string();
        assert_eq!(differing_versions.compare(&r), Comparison::Direct);

        // Schema differs alone, stored older: migrate.
        assert_eq!(
            id_at(2, 1, 20, 1, 100).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::Schema)
        );
        // Schema differs alone, stored *newer*: still migrate -- `Game::migrate` decides (its
        // default `Err(SaveIncompatible)` is `MigrateDeclined`, not a `compare`-level verdict); a
        // game may choose to accept an older build's save written by a newer one.
        assert_eq!(
            id_at(2, 3, 20, 1, 100).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::Schema)
        );
        // Tick rate differs alone: migrate, even with schema and worldgen equal (0006 point 2:
        // "even if the author forgot to bump [SCHEMA_VERSION]").
        assert_eq!(
            id_at(2, 2, 30, 1, 100).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::TickRate)
        );
        // Worldgen version differs alone.
        assert_eq!(
            id_at(2, 2, 20, 2, 100).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::Worldgen)
        );
        // Worldgen fingerprint differs alone, same version (0007 §9).
        assert_eq!(
            id_at(2, 2, 20, 1, 101).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::Worldgen)
        );
        // More than one field differs: schema takes priority over tick rate and worldgen.
        assert_eq!(
            id_at(2, 1, 30, 2, 101).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::Schema)
        );
        // Tick rate takes priority over worldgen when schema agrees.
        assert_eq!(
            id_at(2, 2, 30, 2, 101).compare(&r),
            Comparison::NeedsMigrate(MismatchReason::TickRate)
        );
    }
}
