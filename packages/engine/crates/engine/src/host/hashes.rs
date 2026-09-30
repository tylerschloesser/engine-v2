//! The per-connection desync-hash schedule (docs/plan/31b-desync-hashes.md, 0013 "Per-chunk desync
//! hashes"): which subscribed chunk's hash rides which frame, when `Global` and `OwnPlayer` are
//! due, and the two test hooks that live per connection (`sim_skip_delta`, a pending scope resend).
//!
//! **Production cadence.** One chunk every [`CHUNK_HASH_EVERY_TICKS`] ticks: a chunk modified since
//! it was last hashed first (the most recently modified), otherwise round-robin in `(cy, cx)` order
//! from the cursor. Every [`FAIR_EVERY`]th pick is round-robin regardless, so a world that modifies
//! chunks faster than the sweep cannot starve a quiet, possibly corrupt, chunk forever. `Global`
//! and `OwnPlayer` every [`SCOPE_HASH_EVERY_SECONDS`] seconds.
//!
//! **Hash-all** ([`HashMode::All`], `Host::set_hash_mode`: the step-4 flag's landing place): every eligible chunk and
//! both scopes on every frame; [`HashSchedule::pick`] is not consulted.

use std::collections::BTreeMap;

use crate::world::ChunkCoord;

/// One chunk hash per this many ticks, per connection (0013: "one subscribed chunk per 4 ticks").
pub const CHUNK_HASH_EVERY_TICKS: u32 = 4;
/// `Global` and `OwnPlayer` hashes this often, in seconds (0013: "every 5 s").
pub const SCOPE_HASH_EVERY_SECONDS: u32 = 5;
/// Every this-many-th pick is round-robin even when a modified chunk is waiting.
pub const FAIR_EVERY: u32 = 4;

/// How much desync hashing a host does (`Host::set_hash_mode`; `SimConfig::hash_mode`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum HashMode {
    /// No `Hashes` sections at all (native pinned-byte tests, and any run that opts out).
    Off,
    /// The 0013 schedule: one chunk per 4 ticks, `Global`/`OwnPlayer` every 5 s.
    #[default]
    Production,
    /// Every eligible held chunk and both scopes on every frame (0013 "dev builds").
    All,
}

/// A schedule's choice for one frame.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pick {
    pub coord: ChunkCoord,
    /// Chosen by the round-robin cursor (not as a recently modified chunk).
    pub round_robin: bool,
}

/// One connection's schedule state.
#[derive(Debug)]
pub struct HashSchedule {
    next_chunk_tick: u32,
    next_scope_tick: u32,
    cursor: Option<ChunkCoord>,
    /// The tick each chunk was last hashed at.
    last_hashed: BTreeMap<ChunkCoord, u32>,
    picks: u32,
    /// A `ResyncChunk` for the reserved coordinate is owed: the next frame carries `Global` and
    /// `OwnPlayer` in full.
    pub resend_scopes: bool,
    /// `sim_skip_delta`: drop the next tile (or entity `Put`) delta of this chunk from a frame
    /// (the reserved coordinate: the next `Global` value update).
    pub skip_delta: Option<ChunkCoord>,
}

impl HashSchedule {
    /// A schedule for a connection made at `tick`: chunk hashes start at once, `Global` and
    /// `OwnPlayer` after one period.
    pub fn new(tick: u32, hz: u32) -> Self {
        HashSchedule {
            next_chunk_tick: tick,
            next_scope_tick: tick.wrapping_add(SCOPE_HASH_EVERY_SECONDS * hz),
            cursor: None,
            last_hashed: BTreeMap::new(),
            picks: 0,
            resend_scopes: false,
            skip_delta: None,
        }
    }

    /// A chunk hash is due at `tick`.
    pub fn chunk_due(&self, tick: u32) -> bool {
        tick.wrapping_sub(self.next_chunk_tick) < u32::MAX / 2
    }

    /// `Global` and `OwnPlayer` are due at `tick`.
    pub fn scope_due(&self, tick: u32) -> bool {
        tick.wrapping_sub(self.next_scope_tick) < u32::MAX / 2
    }

    /// Chooses the chunk to hash from `eligible` (sorted ascending by `(y, x)`); `version_of` is the
    /// host's last-modified tick of a chunk. Does not change the schedule: [`Self::commit`] does.
    pub fn pick(
        &self,
        eligible: &[ChunkCoord],
        version_of: impl Fn(ChunkCoord) -> u32,
    ) -> Option<Pick> {
        if eligible.is_empty() {
            return None;
        }
        let round_robin = || {
            let after = self
                .cursor
                .and_then(|cur| eligible.iter().find(|c| (c.y, c.x) > (cur.y, cur.x)));
            Pick {
                coord: *after.unwrap_or(&eligible[0]),
                round_robin: true,
            }
        };
        if self.picks % FAIR_EVERY == FAIR_EVERY - 1 {
            return Some(round_robin());
        }
        let mut best: Option<(u32, ChunkCoord)> = None;
        for &c in eligible {
            let v = version_of(c);
            let seen = self.last_hashed.get(&c).copied().unwrap_or(0);
            if v > seen && best.is_none_or(|(bv, _)| v > bv) {
                best = Some((v, c));
            }
        }
        match best {
            Some((_, coord)) => Some(Pick {
                coord,
                round_robin: false,
            }),
            None => Some(round_robin()),
        }
    }

    /// The frame carrying `pick` was sent at `tick`.
    pub fn commit(&mut self, tick: u32, pick: Pick) {
        self.last_hashed.insert(pick.coord, tick);
        if pick.round_robin {
            self.cursor = Some(pick.coord);
        }
        self.picks = self.picks.wrapping_add(1);
        self.next_chunk_tick = tick.wrapping_add(CHUNK_HASH_EVERY_TICKS);
    }

    /// A frame carrying every eligible chunk (hash-all) was sent: remember when each was hashed.
    pub fn commit_all(&mut self, tick: u32, chunk: ChunkCoord) {
        self.last_hashed.insert(chunk, tick);
    }

    /// The `Global`/`OwnPlayer` pair was sent at `tick`.
    pub fn commit_scopes(&mut self, tick: u32, hz: u32) {
        self.next_scope_tick = tick.wrapping_add(SCOPE_HASH_EVERY_SECONDS * hz);
    }

    /// `chunk` left the connection's held set.
    pub fn forget(&mut self, chunk: ChunkCoord) {
        self.last_hashed.remove(&chunk);
    }
}
