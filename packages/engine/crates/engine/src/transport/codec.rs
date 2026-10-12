//! The transport store's canonical bytes (0076 §7: encoded, hashed and snapshotted byte for byte;
//! M42). Ascending `LineId`, every field, no `usize`:
//!
//! ```text
//! line_count u32
//! per line: id u32 | len u32 | speed u16 | out | sunk u64 | jam u32 | run_count u32 | runs
//!           [| seg_count u8 | segments]
//!   out: tag u8 (0 DeadEnd, 1 Next + id u32, 2 Sink, 3 Merge + line u32 + at u32,
//!     4 Fork + a u32 + b u32 + toggle u8), bit 7 (`SEGMENTS`) set when segments follow the runs
//!     (M43); the toggle (M44, 0 or 1) is encoded only with a fork, the one output that has one
//!   jam: the cursor's run index from the front (>= 1), 0 = unknown, u32::MAX = "all packed"
//!   run: item u16 | count u16 | dist u32
//!     dist: the front run's first item position; for a later run, the distance from the item
//!     ahead to its first item (`gap + SPACING`)
//!   segment (M43): len u32 | tag u8, then 0 Straight: from.x i32 | from.y i32 | to.x i32 | to.y i32,
//!     1 Arc: centre.x i32 | centre.y i32 | radius_q8 u32 | start_turn_q8 u16 | sweep_q8 i16 (u16)
//! next_id u32
//! ```
//!
//! A later run's `dist` carries the spacing, so a spacing violation is representable in bytes.
//! Decode rejects (`CodecError::Malformed`) `dist == 0` (two items at one position), a position
//! past `len - 1`, a `count` of 0, `Item(0)`, `len` past `MAX_LEN`, `speed` outside `[1, len)`, ids
//! not ascending or not below `next_id`, an output naming a missing line or itself, a `Next` or
//! `Fork` target shorter than the feeder's `speed`, a `Fork` with `a == b` or a toggle byte other
//! than 0 or 1, a `jam` index past the runs or one with
//! a gapped run between it and the front run (the cursor's invariant), and segments `set_segments`
//! would refuse (`seg_count` 0 with the bit set, more than `MAX_SEGMENTS`, lengths not summing to
//! `len`, an arc field out of range, a path entering more than `MAX_LINE_TILES` tiles). A `dist`
//! in `[1, SPACING)` is a squashed pair (M43: `rescale` and `join` keep them, `line.rs`), legal
//! state. Spacing across a hand-off is never checked (0077 A6b (i)). Run merging is not
//! re-checked: an unmerged same-item pair is legal state (a `u16` merge guard, or a pair the `jam`
//! skip has not revisited) and decodes as it was.
//!
//! The segments bit keeps a line without segments byte-identical to its M42 record, so every
//! pre-M43 golden (no world registered segments before M43) keeps its hash.

use super::geometry::{
    Geometry, MAX_LINE_TILES, MAX_SEGMENTS, Segment, check_segments, count_tiles,
};
use super::line::{Line, NIL, Run};
use super::{LineId, MAX_LEN, Output, SPACING, Transport};
use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::world::WorldPos;

const JAM_UNKNOWN: u32 = 0;
const JAM_END: u32 = u32::MAX;
/// The `out` tag bit announcing segments after the runs (module doc).
const SEGMENTS: u8 = 0x80;

/// The `out` field (0079 §15): `tag u8` with `flags` ORed in (bit 7 is `SEGMENTS` in the
/// canonical record, never set in a `LineStructs` put), then the variant's fields; a `Fork`'s
/// toggle is not written here (the canonical record appends it, a structure put has none). The one
/// encoding of an output: the canonical record (this module) and `wire::lines` both call it.
pub(crate) fn write_out(sink: &mut (impl ByteSink + ?Sized), out: Output, flags: u8) {
    match out {
        Output::DeadEnd => sink.put_u8(flags),
        Output::Next(t) => {
            sink.put_u8(1 | flags);
            sink.put_u32(t.0);
        }
        Output::Sink => sink.put_u8(2 | flags),
        Output::Merge { line, at } => {
            sink.put_u8(3 | flags);
            sink.put_u32(line.0);
            sink.put_u32(at);
        }
        Output::Fork { a, b } => {
            sink.put_u8(4 | flags);
            sink.put_u32(a.0);
            sink.put_u32(b.0);
        }
    }
}

/// Reads [`write_out`]'s bytes: the output and the tag's flag bits (`SEGMENTS`); an unknown tag
/// is `Malformed`.
pub(crate) fn read_out(reader: &mut ByteReader) -> Result<(Output, u8), CodecError> {
    let tag = reader.u8()?;
    let out = match tag & !SEGMENTS {
        0 => Output::DeadEnd,
        1 => Output::Next(LineId(reader.u32()?)),
        2 => Output::Sink,
        3 => Output::Merge {
            line: LineId(reader.u32()?),
            at: reader.u32()?,
        },
        4 => Output::Fork {
            a: LineId(reader.u32()?),
            b: LineId(reader.u32()?),
        },
        _ => return Err(CodecError::Malformed),
    };
    Ok((out, tag & SEGMENTS))
}

/// One segment (module doc's layout), shared with `wire::lines`.
pub(crate) fn write_segment(sink: &mut (impl ByteSink + ?Sized), seg: &Segment) {
    sink.put_u32(seg.len);
    match seg.geometry {
        Geometry::Straight { from, to } => {
            sink.put_u8(0);
            sink.put_i32(from.x);
            sink.put_i32(from.y);
            sink.put_i32(to.x);
            sink.put_i32(to.y);
        }
        Geometry::Arc {
            centre,
            radius_q8,
            start_turn_q8,
            sweep_q8,
        } => {
            sink.put_u8(1);
            sink.put_i32(centre.x);
            sink.put_i32(centre.y);
            sink.put_u32(radius_q8);
            sink.put_u16(start_turn_q8);
            sink.put_u16(sweep_q8 as u16);
        }
    }
}

/// Reads [`write_segment`]'s bytes (shape only: `check_segments` is the caller's).
pub(crate) fn read_segment(reader: &mut ByteReader) -> Result<Segment, CodecError> {
    let len = reader.u32()?;
    let geometry = match reader.u8()? {
        0 => Geometry::Straight {
            from: WorldPos {
                x: reader.i32()?,
                y: reader.i32()?,
            },
            to: WorldPos {
                x: reader.i32()?,
                y: reader.i32()?,
            },
        },
        1 => Geometry::Arc {
            centre: WorldPos {
                x: reader.i32()?,
                y: reader.i32()?,
            },
            radius_q8: reader.u32()?,
            start_turn_q8: reader.u16()?,
            sweep_q8: reader.u16()? as i16,
        },
        _ => return Err(CodecError::Malformed),
    };
    Ok(Segment { len, geometry })
}

impl Transport {
    pub fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.index.len() as u32);
        for &(id, slot) in &self.index {
            let line = &self.lines[slot as usize];
            sink.put_u32(id.0);
            sink.put_u32(line.len);
            sink.put_u16(line.speed);
            let flag = if line.seg_count > 0 { SEGMENTS } else { 0 };
            write_out(sink, line.out, flag);
            if let Output::Fork { .. } = line.out {
                sink.put_u8(u8::from(line.toggle));
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
                    n.run.gap as u32
                } else {
                    (n.run.gap + SPACING as i32) as u32
                });
                first = false;
                cur = n.next;
            }
            if line.seg_count > 0 {
                sink.put_u8(line.seg_count);
                for r in self.seg_slice(slot) {
                    write_segment(sink, &r.seg);
                }
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
        t.seg_cap = u32::MAX;
        t.tile_cap = u32::MAX;
        t.lines.reserve_exact(line_count as usize);
        t.struct_ver.reserve_exact(line_count as usize);
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
            if speed == 0 || u32::from(speed) >= len || len > MAX_LEN {
                return Err(bad);
            }
            let (out, flags) = read_out(reader)?;
            let has_segments = flags & SEGMENTS != 0;
            let toggle = match out {
                Output::Fork { .. } => match reader.u8()? {
                    0 => false,
                    1 => true,
                    _ => return Err(bad),
                },
                _ => false,
            };
            let sunk = reader.u64()?;
            let jam = reader.u32()?;
            let runs = reader.u32()?;
            if u64::from(runs) * 8 > reader.rest().len() as u64 {
                return Err(bad);
            }
            let mut line = Line::new(LineId(id), len, speed);
            line.out = out;
            line.toggle = toggle;
            line.sunk = sunk;
            t.lines.push(line);
            t.struct_ver.push(0);
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
                    // Positions are below `len <= MAX_LEN`: the checks below keep `gap` an `i32`.
                    None => (u64::from(dist), i64::from(dist)),
                    Some(p) => {
                        if dist == 0 {
                            return Err(bad);
                        }
                        (p + u64::from(dist), i64::from(dist) - i64::from(SPACING))
                    }
                };
                let last = first + u64::from(SPACING) * (u64::from(count) - 1);
                if last > u64::from(len) - 1 {
                    return Err(bad);
                }
                let gap = gap as i32;
                last_pos = Some(last);
                if k > 0 && gap != 0 && first_gap == u32::MAX {
                    first_gap = k;
                }
                if k > 0 && gap < 0 {
                    t.lines[slot as usize].squashed = true;
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
            if has_segments {
                let n = usize::from(reader.u8()?);
                if n == 0 || n > MAX_SEGMENTS {
                    return Err(bad);
                }
                let mut segs = [Segment {
                    len: 0,
                    geometry: Geometry::Straight {
                        from: WorldPos::default(),
                        to: WorldPos::default(),
                    },
                }; MAX_SEGMENTS];
                for s in &mut segs[..n] {
                    *s = read_segment(reader)?;
                }
                if !check_segments(len, &segs[..n]) || count_tiles(&segs[..n]) > MAX_LINE_TILES {
                    return Err(bad);
                }
                t.decode_segments(slot, &segs[..n]);
            }
        }
        let next_id = reader.u32()?;
        if next_id == 0 || prev_id >= next_id {
            return Err(bad);
        }
        t.next_id = next_id;
        // Resolve output targets to slots: a missing target, the line itself or a fork with
        // `a == b` is malformed, and so is a `Next` or `Fork` target shorter than one tick's
        // travel (`set_out`'s hand-off bound, 0079 §8).
        for slot in 0..t.lines.len() {
            let speed = u32::from(t.lines[slot].speed);
            let resolve = |t: &Transport, id: LineId, bounded: bool| -> Result<u32, CodecError> {
                let s = t.slot(id).ok_or(bad)?;
                if s as usize == slot || (bounded && t.lines[s as usize].len < speed) {
                    return Err(bad);
                }
                Ok(s)
            };
            let (next_slot, alt_slot) = match t.lines[slot].out {
                Output::DeadEnd | Output::Sink => (NIL, NIL),
                Output::Next(id) => (resolve(&t, id, true)?, NIL),
                Output::Merge { line, .. } => (resolve(&t, line, false)?, NIL),
                Output::Fork { a, b } => {
                    if a == b {
                        return Err(bad);
                    }
                    (resolve(&t, a, true)?, resolve(&t, b, true)?)
                }
            };
            t.lines[slot].next_slot = next_slot;
            t.lines[slot].alt_slot = alt_slot;
        }
        t.graph_dirty = true;
        // Derived (never encoded): the tile index is rebuilt from the decoded segments.
        t.rebuild_index();
        Ok(t)
    }
}
