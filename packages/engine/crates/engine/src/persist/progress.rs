//! `Progress` (0005 "Panic recovery"; docs/plan/24-recovery-and-migration.md): a fixed 12-byte
//! cursor `Host<G>` writes into `RegionId::Progress` before starting risky (game-authored or
//! container-decode) work, so a *dead* instance's own linear memory still names exactly what it
//! was doing when it trapped -- read by the host with no export call at all (`inst.region(id).u8`
//! / `inst.mem`, 0014 §6).
//!
//! Not sim state: never part of a hash, a snapshot or the log. Plain, allocation-free stores only
//! (`.claude/rules/hot-paths.md`).

/// What `Host<G>` was doing at the moment a [`ProgressCursor`] was last written. `Idle` is also
/// the resting value every completed export leaves behind (`Host::mark_idle`), which is why
/// `sim_test_trap` -- which panics without writing anything of its own -- is seen to have
/// "panicked in phase `Idle`" (whatever the previous, successfully-finished call left behind).
#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Idle = 0,
    Admit = 1,
    ApplyRecord = 2,
    OnPlayer = 3,
    Tick = 4,
    BuildFrame = 5,
    Snapshot = 6,
    Replay = 7,
}

impl Phase {
    pub const fn from_u32(n: u32) -> Option<Phase> {
        match n {
            0 => Some(Phase::Idle),
            1 => Some(Phase::Admit),
            2 => Some(Phase::ApplyRecord),
            3 => Some(Phase::OnPlayer),
            4 => Some(Phase::Tick),
            5 => Some(Phase::BuildFrame),
            6 => Some(Phase::Snapshot),
            7 => Some(Phase::Replay),
            _ => None,
        }
    }
}

/// Size of the `Progress` region (`phase u32 | tick u32 | record u32`, little-endian).
pub const PROGRESS_BYTES: u32 = 12;

/// `record`'s meaning is phase-specific: an index into whatever's being iterated for `ApplyRecord`/
/// `OnPlayer` while ticking live, but the **absolute byte offset of the record within its segment**
/// (0005's `Skip { segment, offset }`) for `ApplyRecord` while replaying (docs/plan/
/// 24-recovery-and-migration.md Seams) -- `0` for phases with nothing to name (`Tick`, `Idle`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProgressCursor {
    pub phase: Phase,
    pub tick: u32,
    pub record: u32,
}

impl Default for ProgressCursor {
    fn default() -> Self {
        ProgressCursor {
            phase: Phase::Idle,
            tick: 0,
            record: 0,
        }
    }
}

impl ProgressCursor {
    /// Writes the 12-byte layout into `out[..12]`. Never allocates: three plain stores into a
    /// fixed slice (`.claude/rules/hot-paths.md`).
    pub fn write(&self, out: &mut [u8]) {
        out[0..4].copy_from_slice(&(self.phase as u32).to_le_bytes());
        out[4..8].copy_from_slice(&self.tick.to_le_bytes());
        out[8..12].copy_from_slice(&self.record.to_le_bytes());
    }

    /// The inverse, for native tests (the TS side reads the same 12 bytes with its own
    /// `DataView`/`inst.mem.u32`, docs/plan/24-recovery-and-migration.md Seams).
    pub fn read(bytes: &[u8]) -> Option<Self> {
        let phase = Phase::from_u32(u32::from_le_bytes(bytes.get(0..4)?.try_into().ok()?))?;
        let tick = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?);
        let record = u32::from_le_bytes(bytes.get(8..12)?.try_into().ok()?);
        Some(ProgressCursor {
            phase,
            tick,
            record,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_cursor_roundtrips_through_its_own_byte_layout() {
        let cursor = ProgressCursor {
            phase: Phase::ApplyRecord,
            tick: 42,
            record: 7,
        };
        let mut bytes = [0u8; PROGRESS_BYTES as usize];
        cursor.write(&mut bytes);
        assert_eq!(ProgressCursor::read(&bytes), Some(cursor));
    }

    #[test]
    fn progress_cursor_read_rejects_short_or_unknown_phase() {
        assert_eq!(ProgressCursor::read(&[0u8; 4]), None);
        let mut bytes = [0u8; PROGRESS_BYTES as usize];
        bytes[0..4].copy_from_slice(&99u32.to_le_bytes());
        assert_eq!(ProgressCursor::read(&bytes), None);
    }
}
