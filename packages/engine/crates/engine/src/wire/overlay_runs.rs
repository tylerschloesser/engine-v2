//! Overlay-run coding (Planning decisions "Overlay runs"): the sparse per-chunk tile overlay
//! (`ChunkOverlay::entries()`, ascending by index, no duplicates) packed as `n_runs varint`, then
//! per run `gap varint` (indices skipped since the previous run's end), `head varint = len << 1 |
//! repeat`, then `repeat ? one : len` tiles as `u32` LE. A maximal run of `>= 2` equal consecutive
//! (contiguous index) tiles is written as one `repeat` run; everything else is grouped into the
//! longest `literal` run that does not swallow the start of a following repeat.

use crate::bytes::{ByteReader, ByteSink, CountSink};
use crate::world::Tile;

use super::{WireError, varint_u32};

/// A cursor over `(index, tile)` pairs with two items of lookahead, cheap to fork
/// (`RunCursor::fork`) since it only clones the underlying iterator (a slice iterator under a
/// `.map`, O(1) to clone) plus its own two buffered items -- no heap allocation.
struct RunCursor<I: Iterator<Item = (u16, Tile)> + Clone> {
    it: I,
    peeked: Option<(u16, Tile)>,
}

impl<I: Iterator<Item = (u16, Tile)> + Clone> RunCursor<I> {
    fn new(mut it: I) -> Self {
        let peeked = it.next();
        RunCursor { it, peeked }
    }

    fn peek(&self) -> Option<(u16, Tile)> {
        self.peeked
    }

    fn bump(&mut self) -> Option<(u16, Tile)> {
        let out = self.peeked;
        self.peeked = self.it.next();
        out
    }

    /// An independent cursor at the same position: forking costs an `I::clone()` (cheap for a
    /// slice iterator) plus copying the one buffered item.
    fn fork(&self) -> Self {
        RunCursor {
            it: self.it.clone(),
            peeked: self.peeked,
        }
    }

    /// The length of the literal run starting here: how many items (peek-only, no mutation) belong
    /// to it before either the stream ends, a gap breaks contiguity, or the next pair would start a
    /// repeat of `>= 2`.
    fn literal_run_len(&self) -> u32 {
        let mut probe = self.fork();
        let mut len = 0u32;
        let mut prev_idx: Option<u16> = None;
        loop {
            let Some((idx, tile)) = probe.peek() else {
                break;
            };
            if let Some(p) = prev_idx
                && idx != p + 1
            {
                break; // a gap ends the contiguous span entirely
            }
            let mut ahead = probe.fork();
            ahead.bump();
            if let Some((nidx, ntile)) = ahead.peek()
                && nidx == idx + 1
                && ntile == tile
            {
                break; // the next pair starts a repeat; stop before it
            }
            probe.bump();
            len += 1;
            prev_idx = Some(idx);
        }
        len
    }

    /// Consumes and writes exactly one run (repeat or literal), returning the index it ends at.
    /// `last_end` is the previous run's end index (`-1` before the first run), used to compute
    /// `gap`.
    fn advance_one_run(&mut self, sink: &mut (impl ByteSink + ?Sized), last_end: i64) -> i64 {
        let (idx0, tile0) = self
            .peek()
            .expect("advance_one_run called with nothing left");
        let gap = idx0 as i64 - (last_end + 1);
        debug_assert!(gap >= 0, "overlay entries must be ascending by index");

        let mut look = self.fork();
        look.bump();
        let is_repeat = matches!(look.peek(), Some((i1, t1)) if i1 == idx0 + 1 && t1 == tile0);

        if is_repeat {
            self.bump();
            let mut len = 1u32;
            let mut end_idx = idx0;
            while let Some((ni, nt)) = self.peek() {
                if ni == end_idx + 1 && nt == tile0 {
                    self.bump();
                    len += 1;
                    end_idx = ni;
                } else {
                    break;
                }
            }
            sink.put_varint(gap as u64);
            sink.put_varint(((len as u64) << 1) | 1);
            sink.put(&tile0.to_le_bytes());
            end_idx as i64
        } else {
            let len = self.literal_run_len();
            sink.put_varint(gap as u64);
            sink.put_varint((len as u64) << 1);
            let mut end_idx = idx0;
            for _ in 0..len {
                let (i, t) = self.bump().expect("literal_run_len overcounted");
                sink.put(&t.to_le_bytes());
                end_idx = i;
            }
            end_idx as i64
        }
    }
}

pub struct OverlayRunsWriter;

impl OverlayRunsWriter {
    /// `entries` must be ascending by index with no duplicates (`ChunkOverlay::entries()`'s own
    /// contract). Two passes over a cloned iterator -- count the runs, then write them -- the same
    /// "measure, then write" trick `write_sized` (`crate::store`) uses for a length prefix, so no
    /// scratch buffer is needed for an unbounded number of variable-length runs.
    pub fn write(
        sink: &mut (impl ByteSink + ?Sized),
        entries: impl Iterator<Item = (u16, Tile)> + Clone,
    ) {
        let n_runs = Self::run_count(entries.clone());
        sink.put_varint(n_runs as u64);
        let mut cur = RunCursor::new(entries);
        let mut last_end: i64 = -1;
        while cur.peek().is_some() {
            last_end = cur.advance_one_run(sink, last_end);
        }
    }

    fn run_count(entries: impl Iterator<Item = (u16, Tile)> + Clone) -> u32 {
        let mut cur = RunCursor::new(entries);
        let mut discard = CountSink::default();
        let mut last_end: i64 = -1;
        let mut n = 0u32;
        while cur.peek().is_some() {
            last_end = cur.advance_one_run(&mut discard, last_end);
            n += 1;
        }
        n
    }
}

pub struct OverlayRunsReader;

impl OverlayRunsReader {
    /// Calls `on_tile(index, tile)` for every effective tile the runs describe, ascending index --
    /// the inverse of [`OverlayRunsWriter::write`]. Never panics: an oversized run, a run past
    /// `u16::MAX`, or truncated bytes are all [`WireError::Malformed`].
    pub fn read(r: &mut ByteReader, mut on_tile: impl FnMut(u16, Tile)) -> Result<(), WireError> {
        let n_runs = varint_u32(r)?;
        let mut cursor_end: i64 = -1;
        for _ in 0..n_runs {
            let gap = varint_u32(r)? as i64;
            let start = cursor_end + 1 + gap;
            // `varint_u32`, not a raw `r.varint()`, for the same reason every other count in this
            // module goes through it (docs/plan/14-wire-framing.md M14 fix round 1): a bound
            // consistent with `len`'s `u16`-range use below, so a future edit to the shift or mask
            // cannot reintroduce a silent truncation without review, even though today's
            // `checked_add`/`> u16::MAX` guard already catches an oversized run either way.
            let head = varint_u32(r)?;
            let repeat = head & 1 == 1;
            let len = head >> 1;
            if len == 0 {
                return Err(WireError::Malformed); // a run always covers >= 1 index
            }
            let end = start
                .checked_add(len as i64 - 1)
                .ok_or(WireError::Malformed)?;
            if start < 0 || end > u16::MAX as i64 {
                return Err(WireError::Malformed);
            }
            if repeat {
                let bytes = r.bytes(4).map_err(WireError::from)?;
                let tile = Tile(u32::from_le_bytes(bytes.try_into().unwrap()));
                for k in 0..len {
                    on_tile((start + k as i64) as u16, tile);
                }
            } else {
                for k in 0..len {
                    let bytes = r.bytes(4).map_err(WireError::from)?;
                    let tile = Tile(u32::from_le_bytes(bytes.try_into().unwrap()));
                    on_tile((start + k as i64) as u16, tile);
                }
            }
            cursor_end = end;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    fn encode(entries: &[(u16, Tile)]) -> Vec<u8> {
        let mut buf = vec![0u8; 8192];
        let mut sink = SliceSink::new(&mut buf);
        OverlayRunsWriter::write(&mut sink, entries.iter().copied());
        let n = sink.finish().unwrap();
        buf.truncate(n);
        buf
    }

    fn decode(bytes: &[u8]) -> Vec<(u16, Tile)> {
        let mut r = ByteReader::new(bytes);
        let mut out = Vec::new();
        OverlayRunsReader::read(&mut r, |i, t| out.push((i, t))).unwrap();
        out
    }

    #[test]
    fn empty_overlay_is_zero_runs() {
        let bytes = encode(&[]);
        assert_eq!(bytes, vec![0]); // n_runs varint(0) = one zero byte
        assert_eq!(decode(&bytes), vec![]);
    }

    #[test]
    fn roundtrip_mixed_literal_and_repeat() {
        let entries = vec![
            (0u16, Tile::new(1, 0, 0)),
            (1, Tile::new(2, 0, 0)), // literal: 0,1 distinct
            (5, Tile::new(9, 0, 0)),
            (6, Tile::new(9, 0, 0)),
            (7, Tile::new(9, 0, 0)),  // repeat of 3 at 5..=7
            (8, Tile::new(4, 0, 0)),  // literal again, contiguous with the repeat's end
            (20, Tile::new(4, 0, 0)), // isolated, far away (gap)
        ];
        let bytes = encode(&entries);
        assert_eq!(decode(&bytes), entries);
    }

    /// Proves the writer actually *uses* a repeat run rather than always emitting literals: 3
    /// equal contiguous tiles cost far fewer bytes than 3 independent literal runs would (3 * (gap
    /// + head + tile) ~= 3*6=18B vs. one repeat run's gap+head+tile ~= 3B).
    #[test]
    fn golden_overlay_runs_literal_and_repeat() {
        let entries = vec![
            (2u16, Tile::new(1, 0, 0)), // literal, isolated
            (10, Tile::new(7, 0, 0)),   // repeat start
            (11, Tile::new(7, 0, 0)),
            (12, Tile::new(7, 0, 0)),
            (13, Tile::new(7, 0, 0)),
            (30, Tile::new(2, 0, 0)), // literal, isolated
            (31, Tile::new(3, 0, 0)), // literal, distinct from its neighbour
        ];
        let bytes = encode(&entries);
        crate::assert_golden_bytes!("wire_overlay_runs_literal_and_repeat", &bytes);
        assert_eq!(decode(&bytes), entries);
        // The 4-long repeat must cost less than 4 independent single-tile literal runs would (a
        // literal run of len 1 costs the same gap+head+tile shape a repeat of len 1 would, so this
        // comparison is exact: at least one byte of `head` is saved per extra repeated tile).
        let all_literal: Vec<(u16, Tile)> = (10u16..14).map(|i| (i, Tile::new(7, 0, 0))).collect();
        // Encode the repeat block alone vs. as 4 length-1 literal runs (simulated by spacing them
        // out so the writer cannot merge them into one repeat).
        let spaced: Vec<(u16, Tile)> = all_literal
            .iter()
            .enumerate()
            .map(|(k, &(_, t))| ((k as u16) * 3, t))
            .collect();
        let repeat_bytes = encode(&all_literal);
        let literal_bytes = encode(&spaced);
        assert!(
            repeat_bytes.len() < literal_bytes.len(),
            "repeat run ({} bytes) should beat 4 separate literal runs ({} bytes)",
            repeat_bytes.len(),
            literal_bytes.len()
        );
    }

    #[test]
    fn decoder_rejects_zero_length_run() {
        // n_runs=1, gap=0, head=0 (len=0, repeat=0): a run must cover >= 1 index.
        let bytes = [1u8, 0, 0];
        let mut r = ByteReader::new(&bytes);
        assert_eq!(
            OverlayRunsReader::read(&mut r, |_, _| {}),
            Err(WireError::Malformed)
        );
    }

    #[test]
    fn decoder_rejects_run_past_u16_max() {
        // n_runs=1, gap=0, head = (len=65536)<<1|0 -- pushes past u16::MAX from index 0.
        let mut buf = [0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_varint(1); // n_runs
        sink.put_varint(0); // gap
        sink.put_varint((65536u64) << 1); // head: huge literal length
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(
            OverlayRunsReader::read(&mut r, |_, _| {}),
            Err(WireError::Malformed)
        );
    }

    #[test]
    fn decoder_rejects_truncated_tile_bytes() {
        let bytes = encode(&[(0, Tile::new(1, 2, 3))]);
        let mut r = ByteReader::new(&bytes[..bytes.len() - 1]); // drop the last tile byte
        assert_eq!(
            OverlayRunsReader::read(&mut r, |_, _| {}),
            Err(WireError::Malformed)
        );
    }
}
