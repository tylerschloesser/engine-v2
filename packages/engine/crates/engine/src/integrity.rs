//! Desync hashes and the desync report (docs/plan/31b-desync-hashes.md, 0013 "Per-chunk desync
//! hashes"): the one definition of "the hash of a chunk / of `Global` / of a player" both
//! `host::Host` and `client::Replica` call, and the fixed-size report ring both sides fill.
//!
//! **What is hashed.** M05's state hash ([`Fnv64`]) fed by [`encode_chunk_snapshot`] of one chunk:
//! there is no second canonical form. The snapshot's `version` field is written as `0` here, on
//! both sides: a chunk's version is resume bookkeeping (a host stamps every chunk an entity's
//! footprint touches, a replica bumps only the anchor chunk), not replicated state, so a version
//! difference alone is not a desync. Every byte that *is* state (overlay runs, overlapping entities)
//! is hashed. `Global` is the game value only (the roster is incremental and a replica's slot table
//! is not comparable); a player hash is that player's `Codec` value.
//!
//! **The reserved coordinate.** A `ResyncChunk` for the `Global` and `OwnPlayer` scopes carries
//! [`RESERVED_SCOPE_COORD`] instead of a chunk ([`crate::wire::hashes`]).

use crate::codec::encode_to;
use crate::game::{Game, PlayerId};
use crate::hash::Fnv64;
use crate::store::Store;
use crate::wire::encode_chunk_snapshot;
use crate::world::ChunkCoord;

pub use crate::wire::RESERVED_SCOPE_COORD;

/// How many reports a ring keeps (the newest win).
pub const REPORT_RING: usize = 16;

/// The hash of one chunk of `store` (module doc comment: version written as 0).
pub fn chunk_hash<G: Game>(store: &Store<G>, chunk: ChunkCoord) -> u64 {
    let mut h = Fnv64::new();
    encode_chunk_snapshot(store, chunk, 0, &mut h);
    h.finish()
}

/// The hash of `store`'s `Global` game value.
pub fn global_hash<G: Game>(store: &Store<G>) -> u64 {
    let mut h = Fnv64::new();
    encode_to(store.global(), &mut h).expect("hashing G::Global cannot fail");
    h.finish()
}

/// The hash of `who`'s player state (`0` hash of nothing when the player is unknown).
pub fn player_hash<G: Game>(store: &Store<G>, who: PlayerId) -> u64 {
    let mut h = Fnv64::new();
    if let Ok(player) = store.player(who) {
        encode_to(player, &mut h).expect("hashing G::Player cannot fail");
    }
    h.finish()
}

/// What a desync report is about.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(u8)]
pub enum DesyncScope {
    #[default]
    Chunk = 0,
    Global = 1,
    OwnPlayer = 2,
}

/// One desync report. `coord` is [`RESERVED_SCOPE_COORD`] for `Global`/`OwnPlayer`. On the client
/// both hashes are known; on the host `client_hash` is `0` (a `ResyncChunk` carries only the
/// coordinate) and `host_hash` is the host's hash when the request arrived.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DesyncReport {
    pub tick: u32,
    pub scope: DesyncScope,
    pub coord: ChunkCoord,
    pub host_hash: u64,
    pub client_hash: u64,
}

impl DesyncReport {
    const EMPTY: DesyncReport = DesyncReport {
        tick: 0,
        scope: DesyncScope::Chunk,
        coord: ChunkCoord::new(0, 0),
        host_hash: 0,
        client_hash: 0,
    };
}

/// A fixed ring of the last [`REPORT_RING`] reports plus a total counter. Never allocates.
#[derive(Clone, Debug)]
pub struct DesyncLog {
    ring: [DesyncReport; REPORT_RING],
    count: u64,
}

impl Default for DesyncLog {
    fn default() -> Self {
        DesyncLog {
            ring: [DesyncReport::EMPTY; REPORT_RING],
            count: 0,
        }
    }
}

impl DesyncLog {
    /// Records `report` and writes the one `engine.log` line (warn level: kept in release).
    pub fn record(&mut self, side: &str, report: DesyncReport) {
        self.ring[(self.count % REPORT_RING as u64) as usize] = report;
        self.count += 1;
        crate::abi::panic::log(
            crate::abi::LogLevel::Warn,
            &format!(
                "desync ({side}): tick {} {:?} chunk ({}, {}) host {:016x} client {:016x}",
                report.tick,
                report.scope,
                report.coord.x,
                report.coord.y,
                report.host_hash,
                report.client_hash
            ),
        );
    }

    /// Total reports ever recorded.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// How many reports the ring holds (`min(count, 16)`).
    pub fn len(&self) -> usize {
        self.count.min(REPORT_RING as u64) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The `i`th retained report, oldest first.
    pub fn get(&self, i: usize) -> Option<DesyncReport> {
        if i >= self.len() {
            return None;
        }
        let start = self.count - self.len() as u64;
        Some(self.ring[((start + i as u64) % REPORT_RING as u64) as usize])
    }

    /// The `ABI` shape of one report: `count u32 · retained u32 · tick u32 · scope u32 · cx i32 ·
    /// cy i32 · host_hash u64 · client_hash u64` (40 bytes, little endian) for the `index`th
    /// retained report, or only the two leading counts (rest zero) when `index` is out of range.
    pub fn write_result(&self, index: u32, result: &mut [u8]) {
        result[..40].fill(0);
        result[0..4].copy_from_slice(&(self.count as u32).to_le_bytes());
        result[4..8].copy_from_slice(&(self.len() as u32).to_le_bytes());
        if let Some(r) = self.get(index as usize) {
            result[8..12].copy_from_slice(&r.tick.to_le_bytes());
            result[12..16].copy_from_slice(&(r.scope as u32).to_le_bytes());
            result[16..20].copy_from_slice(&r.coord.x.to_le_bytes());
            result[20..24].copy_from_slice(&r.coord.y.to_le_bytes());
            result[24..32].copy_from_slice(&r.host_hash.to_le_bytes());
            result[32..40].copy_from_slice(&r.client_hash.to_le_bytes());
        }
    }
}
