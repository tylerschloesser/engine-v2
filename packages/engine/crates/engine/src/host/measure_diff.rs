//! Cargo feature `measure-diff` (docs/plan/36b-suite-audit-and-measurements.md, 0011 "byte
//! diffing" deferral): what a field-mask diff of an entity put would have saved, counted beside the
//! real encoding and never acted on. Compiled out of every normal build: the module, the per-
//! connection cache and the counters exist only with the feature, which no `buildGame` call and no
//! shipped `.wasm` enables (`.claude/rules/hot-paths.md`; `tests/wasm/measure-diff.test.ts` greps a
//! names-kept module for this file's symbols with and without the feature).
//!
//! For every entity `Put` in a frame that was actually sent to a connection:
//! - `diff_bytes_whole`: what the frame carries now, tag byte + id varint + the entity's encoding;
//! - `diff_bytes_masked`: tag + id + a one-bit-per-byte mask + the bytes that changed since the
//!   connection's previous encoding of the same entity, when that is known (a previous `Put`, or the
//!   chunk snapshot the client holds) and has the same length; otherwise the whole put. The sender
//!   keeps the smaller of the two, as a real scheme with a flag bit would.
//!
//! The mask is byte-granular over the encoded value, so it is a fair stand-in for a field mask: it
//! pays more mask bytes than a per-field mask would and can save a few bytes more inside a field.

use std::collections::BTreeMap;

use super::{ConnCounters, EntityOpKind};
use crate::bytes::ByteSink;
use crate::codec::encode_to;
use crate::game::{EntityId, Game};
use crate::store::Store;
use crate::world::ChunkCoord;

/// One connection's memory of the last encoding it was sent per entity.
#[derive(Default)]
pub(super) struct Prev(BTreeMap<EntityId, Vec<u8>>);

struct VecSink<'a>(&'a mut Vec<u8>);

impl ByteSink for VecSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

fn varint_len(mut v: u64) -> u64 {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn encode_entity<G: Game>(store: &Store<G>, id: EntityId, out: &mut Vec<u8>) -> bool {
    out.clear();
    match store.entity(id) {
        Some(e) => {
            encode_to(e, &mut VecSink(out))
                .expect("encoding an entity into a ByteSink cannot fail");
            true
        }
        None => false,
    }
}

/// Called once per frame that is sent, with the chunks it carried as snapshots and its entity ops.
#[inline(never)]
pub(super) fn record_frame<G: Game>(
    prev: &mut Prev,
    counters: &mut ConnCounters,
    store: &Store<G>,
    snapshots: &[ChunkCoord],
    ops: &[(EntityId, EntityOpKind)],
) {
    let mut cur = Vec::new();
    for &(id, kind) in ops {
        match kind {
            EntityOpKind::Put => {
                if !encode_entity(store, id, &mut cur) {
                    continue;
                }
                let head = 1 + varint_len(id.0 as u64);
                let whole = head + cur.len() as u64;
                let mut masked = whole;
                counters.diff_puts += 1;
                if let Some(old) = prev.0.get(&id)
                    && old.len() == cur.len()
                {
                    counters.diff_puts_known += 1;
                    let changed = old.iter().zip(&cur).filter(|(a, b)| a != b).count() as u64;
                    let mask = (cur.len() as u64).div_ceil(8);
                    masked = masked.min(head + mask + changed);
                }
                counters.diff_bytes_whole += whole;
                counters.diff_bytes_masked += masked;
                prev.0.insert(id, cur.clone());
            }
            EntityOpKind::Gone => {
                prev.0.remove(&id);
            }
        }
    }
    // What the client now holds for the entities of a chunk that went out as a snapshot.
    for &chunk in snapshots {
        for &id in store.chunk_overlapping(chunk) {
            if encode_entity(store, id, &mut cur) {
                prev.0.insert(id, cur.clone());
            }
        }
    }
}
