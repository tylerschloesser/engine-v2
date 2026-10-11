//! The transport store's canonical bytes (0076 §7: encoded, hashed and snapshotted byte for byte;
//! M42). Ascending `LineId`, every field, no `usize`:
//!
//! ```text
//! line_count u32
//! per line: id u32 | len u32 | speed u16 | out | sunk u64 | jam u32 | run_count u32 | runs
//!   out: tag u8 (0 DeadEnd, 1 Next + id u32, 2 Sink, 3 Merge + line u32 + at u32, 4 Fork + a u32 + b u32)
//!   jam: the cursor's run index from the front (>= 1), 0 = unknown, u32::MAX = "all packed"
//!   run: item u16 | count u16 | dist u32
//!     dist: the front run's first item position; for a later run, the distance from the item
//!     ahead to its first item (`gap + SPACING`)
//! next_id u32
//! ```
//!
//! A later run's `dist` carries the spacing, so a spacing violation is representable in bytes and
//! decode rejects it (`CodecError::Malformed`): `dist < SPACING`, a position past `len - 1`, a
//! `count` of 0, `Item(0)`, `speed` outside `[1, len)`, ids not ascending or not below `next_id`,
//! an output naming a missing line or itself, a `Next` target shorter than the feeder's `speed`,
//! `Merge`/`Fork` (M44), a `jam` index past the runs or one with a gapped run between it and the
//! front run (the cursor's invariant).
//! Spacing is checked within a line only: a squashed pair across a hand-off is legal (0077 A6b
//! (i)). Run merging is not re-checked: an unmerged same-item pair is legal state (a `u16` merge
//! guard, or a pair the `jam` skip has not revisited) and decodes as it was.

use super::line::{Line, NIL, Run};
use super::{LineId, Output, SPACING, Transport};
use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;

const JAM_UNKNOWN: u32 = 0;
const JAM_END: u32 = u32::MAX;

impl Transport {
    pub fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.index.len() as u32);
        for &(id, slot) in &self.index {
            let line = &self.lines[slot as usize];
            sink.put_u32(id.0);
            sink.put_u32(line.len);
            sink.put_u16(line.speed);
            match line.out {
                Output::DeadEnd => sink.put_u8(0),
                Output::Next(t) => {
                    sink.put_u8(1);
                    sink.put_u32(t.0);
                }
                Output::Sink => sink.put_u8(2),
                Output::Merge { line, at } => {
                    sink.put_u8(3);
                    sink.put_u32(line.0);
                    sink.put_u32(at);
                }
                Output::Fork { a, b } => {
                    sink.put_u8(4);
                    sink.put_u32(a.0);
                    sink.put_u32(b.0);
                }
            }
            sink.put_u64(line.sunk);
            sink.put_u32(self.jam_index(slot));
            sink.put_u32(line.runs);
            let mut cur = line.head;
            let mut first = true;
            while cur != NIL {
                let n = self.nodes[cur as usize];
                sink.put_u16(n.run.item);
                sink.put_u16(n.run.count);
                sink.put_u32(if first {
                    n.run.gap
                } else {
                    n.run.gap + SPACING
                });
                first = false;
                cur = n.next;
            }
        }
        sink.put_u32(self.next_id);
    }

    /// The `jam` field of the encoding (module doc).
    fn jam_index(&self, slot: u32) -> u32 {
        let line = &self.lines[slot as usize];
        if !line.jam_valid {
            return JAM_UNKNOWN;
        }
        if line.jam == NIL {
            return JAM_END;
        }
        let mut k = 0u32;
        let mut cur = line.head;
        while cur != line.jam {
            k += 1;
            cur = self.nodes[cur as usize].next;
        }
        k
    }

    /// Replaces the whole store with the one encoded in `reader`; if this store's arena was
    /// reserved, the decoded one is reserved at the same caps (else it stays unreserved for the
    /// caller's `set_caps`). The store is untouched on `Err`.
    pub fn read_canonical(&mut self, reader: &mut ByteReader) -> Result<(), CodecError> {
        let mut t = Self::decode(reader)?;
        if self.reserved {
            t.set_caps(self.max_lines, self.max_items)
                .expect("a decoded store has no caps yet");
        }
        *self = t;
        Ok(())
    }

    fn decode(reader: &mut ByteReader) -> Result<Transport, CodecError> {
        let bad = CodecError::Malformed;
        let line_count = reader.u32()?;
        // Never trust a count to size an allocation before the bytes back it: a line is at least
        // 27 bytes, so a count past the remaining bytes is malformed.
        if u64::from(line_count) * 27 > reader.rest().len() as u64 {
            return Err(bad);
        }
        let mut t = Transport::empty();
        // Decoding grows the arena to fit the content; the caller's `set_caps` settles the bound.
        t.node_cap = u32::MAX;
        t.lines.reserve_exact(line_count as usize);
        t.index.reserve_exact(line_count as usize);
        let mut prev_id = 0u32;
        for slot in 0..line_count {
            let id = reader.u32()?;
            if id <= prev_id {
                return Err(bad);
            }
            prev_id = id;
            let len = reader.u32()?;
            let speed = reader.u16()?;
            if speed == 0 || u32::from(speed) >= len {
                return Err(bad);
            }
            let out = match reader.u8()? {
                0 => Output::DeadEnd,
                1 => Output::Next(LineId(reader.u32()?)),
                2 => Output::Sink,
                // `Merge`/`Fork` (tags 3, 4) are refused until M44, like `set_out` refuses them.
                _ => return Err(bad),
            };
            let sunk = reader.u64()?;
            let jam = reader.u32()?;
            let runs = reader.u32()?;
            if u64::from(runs) * 8 > reader.rest().len() as u64 {
                return Err(bad);
            }
            let mut line = Line::new(LineId(id), len, speed);
            line.out = out;
            line.sunk = sunk;
            t.lines.push(line);
            t.index.push((LineId(id), slot));
            let mut last_pos: Option<u64> = None;
            let mut jam_node = None;
            // The first run after the front with a gap (`u32::MAX`: none): the cursor's invariant
            // is that every run strictly between the front run and it has gap 0.
            let mut first_gap = u32::MAX;
            for k in 0..runs {
                let item = reader.u16()?;
                let count = reader.u16()?;
                let dist = reader.u32()?;
                if item == 0 || count == 0 {
                    return Err(bad);
                }
                let (first, gap) = match last_pos {
                    None => (u64::from(dist), dist),
                    Some(p) => {
                        if dist < SPACING {
                            return Err(bad);
                        }
                        (p + u64::from(dist), dist - SPACING)
                    }
                };
                let last = first + u64::from(SPACING) * (u64::from(count) - 1);
                if last > u64::from(len) - 1 {
                    return Err(bad);
                }
                last_pos = Some(last);
                if k > 0 && gap > 0 && first_gap == u32::MAX {
                    first_gap = k;
                }
                t.push_back(slot, Run { item, count, gap });
                if k == jam && jam != JAM_UNKNOWN {
                    jam_node = Some(t.lines[slot as usize].tail);
                }
                let rec = &mut t.lines[slot as usize];
                rec.items += u32::from(count);
                rec.tail_pos = last as u32;
                t.items = t.items.checked_add(u32::from(count)).ok_or(bad)?;
            }
            let rec = &mut t.lines[slot as usize];
            match jam {
                JAM_UNKNOWN => {}
                // An empty line never carries a valid cursor (it would re-encode as unknown).
                JAM_END if runs > 0 && first_gap == u32::MAX => {
                    rec.jam = NIL;
                    rec.jam_valid = true;
                }
                JAM_END => return Err(bad),
                _ => match jam_node {
                    Some(n) if first_gap >= jam => {
                        rec.jam = n;
                        rec.jam_valid = true;
                    }
                    _ => return Err(bad),
                },
            }
        }
        let next_id = reader.u32()?;
        if next_id == 0 || prev_id >= next_id {
            return Err(bad);
        }
        t.next_id = next_id;
        // Resolve `Next` targets to slots; a missing target or the line itself is malformed.
        for slot in 0..t.lines.len() {
            if let Output::Next(target) = t.lines[slot].out {
                let s = t.slot(target).ok_or(bad)?;
                // Not itself, and at least one tick's travel long (`set_out`'s hand-off bound).
                if s as usize == slot || t.lines[s as usize].len < u32::from(t.lines[slot].speed) {
                    return Err(bad);
                }
                t.lines[slot].next_slot = s;
            }
        }
        t.graph_dirty = true;
        Ok(t)
    }
}
