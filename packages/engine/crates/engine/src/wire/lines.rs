//! `LineStructs` (section 12, M46, docs/decisions/0078 §1): line structures as whole-value puts.
//! A flat record list to the section's end, each record a `tag u8` (`0 Put`, `1 Gone`), ids
//! strictly ascending across the section; byte layout in `wire/CLAUDE.md` (its single home). The
//! output and segment fields are `engine::transport`'s own codec (`transport::write_out`,
//! `write_segment`): one encoding of an output and a segment, never a second.
//!
//! Allocation-free both ways: [`Put`] is a fixed-size value (its segments an inline array of
//! [`MAX_SEGMENTS`]), the writer is generic over `ByteSink`, the reader borrows. The reader rejects
//! (`Malformed`) an unknown tag, a truncated record, ids not ascending, and a put with `len == 0`,
//! `speed == 0`, an output tag with flag bits, or `seg_count` of 0 or past [`MAX_SEGMENTS`] (a line
//! without segments is never replicated). Whether the segments sum to `len` is the replica's
//! check (`Transport::apply_structure`), like every other rule of the store's.

use crate::bytes::{ByteReader, ByteSink};
use crate::transport::{
    Geometry, LineId, MAX_SEGMENTS, Output, Segment, read_out, read_segment, write_out,
    write_segment,
};
use crate::world::WorldPos;

use super::{WireError, varint_u32};

const TAG_PUT: u8 = 0;
const TAG_GONE: u8 = 1;

/// A line's structure (0078 §1): `len`, `speed`, `out` (without the fork toggle: item state) and
/// its segments front to back.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Put {
    pub id: LineId,
    pub len: u32,
    pub speed: u16,
    pub out: Output,
    pub seg_count: u8,
    pub segs: [Segment; MAX_SEGMENTS],
}

impl Put {
    /// A put of `id` with no structure yet (the reader's and `Transport::structure`'s start).
    pub fn empty(id: LineId) -> Self {
        Put {
            id,
            len: 0,
            speed: 0,
            out: Output::DeadEnd,
            seg_count: 0,
            segs: [Segment {
                len: 0,
                geometry: Geometry::Straight {
                    from: WorldPos::default(),
                    to: WorldPos::default(),
                },
            }; MAX_SEGMENTS],
        }
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segs[..usize::from(self.seg_count).min(MAX_SEGMENTS)]
    }
}

/// The line left the connection's scope (its chunk set no longer meets a held chunk) or was
/// destroyed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Gone {
    pub id: LineId,
}

/// One record. A put is borrowed: [`Put`] is large (its inline segments), and [`read`] hands each
/// record to its callback from one reused value.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Record<'a> {
    Put(&'a Put),
    Gone(Gone),
}

impl Record<'_> {
    pub fn id(&self) -> LineId {
        match self {
            Record::Put(p) => p.id,
            Record::Gone(g) => g.id,
        }
    }
}

/// One `Put` record, tag included (also the bytes `integrity::chunk_hash` covers per anchored
/// line).
pub fn write_put(sink: &mut (impl ByteSink + ?Sized), put: &Put) {
    sink.put_u8(TAG_PUT);
    sink.put_varint(u64::from(put.id.0));
    sink.put_u32(put.len);
    sink.put_u16(put.speed);
    write_out(sink, put.out, 0);
    sink.put_u8(put.seg_count);
    for s in put.segments() {
        write_segment(sink, s);
    }
}

/// One `Gone` record.
pub fn write_gone(sink: &mut (impl ByteSink + ?Sized), id: LineId) {
    sink.put_u8(TAG_GONE);
    sink.put_varint(u64::from(id.0));
}

/// A section writer's record (`write_put` or `write_gone`).
pub fn write(sink: &mut (impl ByteSink + ?Sized), rec: Record<'_>) {
    match rec {
        Record::Put(p) => write_put(sink, p),
        Record::Gone(g) => write_gone(sink, g.id),
    }
}

/// Reads one record into `put` (a `Put`) or as a `Gone`: returns the id and whether it was a put
/// (module doc for what is malformed; ordering is [`read`]'s).
fn read_record(r: &mut ByteReader, put: &mut Put) -> Result<(LineId, bool), WireError> {
    let tag = r.u8().map_err(WireError::from)?;
    let id = LineId(varint_u32(r)?);
    match tag {
        TAG_GONE => Ok((id, false)),
        TAG_PUT => {
            *put = Put::empty(id);
            put.len = r.u32().map_err(WireError::from)?;
            put.speed = r.u16().map_err(WireError::from)?;
            let (out, flags) = read_out(r).map_err(WireError::from)?;
            if put.len == 0 || put.speed == 0 || flags != 0 {
                return Err(WireError::Malformed);
            }
            put.out = out;
            let n = r.u8().map_err(WireError::from)?;
            if n == 0 || usize::from(n) > MAX_SEGMENTS {
                return Err(WireError::Malformed);
            }
            put.seg_count = n;
            for k in 0..usize::from(n) {
                put.segs[k] = read_segment(r).map_err(WireError::from)?;
            }
            Ok((id, true))
        }
        _ => Err(WireError::Malformed),
    }
}

/// Reads a whole `LineStructs` body, `f` per record in order; ids must strictly ascend.
pub fn read(r: &mut ByteReader, mut f: impl FnMut(Record<'_>)) -> Result<(), WireError> {
    let mut last: Option<LineId> = None;
    let mut put = Put::empty(LineId::NONE);
    while !r.rest().is_empty() {
        let (id, is_put) = read_record(r, &mut put)?;
        if last.is_some_and(|l| id <= l) {
            return Err(WireError::Malformed);
        }
        last = Some(id);
        f(if is_put {
            Record::Put(&put)
        } else {
            Record::Gone(Gone { id })
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    fn straight(len: u32) -> Segment {
        Segment {
            len,
            geometry: Geometry::Straight {
                from: WorldPos { x: 0, y: 128 },
                to: WorldPos {
                    x: len as i32,
                    y: 128,
                },
            },
        }
    }

    #[test]
    fn golden_line_structs() {
        let mut put = Put::empty(LineId(3));
        put.len = 512;
        put.speed = 24;
        put.out = Output::Next(LineId(7));
        put.seg_count = 1;
        put.segs[0] = straight(512);
        let mut buf = [0u8; 128];
        let mut sink = SliceSink::new(&mut buf);
        write_put(&mut sink, &put);
        write_gone(&mut sink, LineId(9));
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_line_structs", &buf[..n]);
    }
}
