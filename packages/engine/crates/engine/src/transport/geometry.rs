//! Line geometry (0076 §4, M43): the game registers each line's path as [`Segment`]s front to
//! back (segment 0 starts at position 0, the front); the engine maps a position to a `WorldPos`
//! and derives each line's chunk set, its anchor chunk and a tile index. Exact integer code: the
//! segments are sim state (encoded with the line, `codec.rs`), and the client runs the same
//! `pos_to_world` in M49.
//!
//! - **Straight** `{ from, to }`: offset `o` of a segment of `len` is
//!   `from + floor((to - from) x o / len)` per axis, in `i64` (`|to - from| < 2^32`, `o < 2^31`:
//!   the product stays below `2^63`).
//! - **Arc** `{ centre, radius_q8, start_turn_q8, sweep_q8 }`: turns in 1/256 of a full turn
//!   (`start < 256`, `0 < |sweep| <= 256`); the angle at offset `o` is
//!   `a = start x 256 + floor(sweep x 256 x o / len)` in 1/65,536 turn, and the point is
//!   `centre + floor(radius x (cos a, sin a) / 65,536)`, a positive sweep turning from `+x` toward
//!   `+y`. `(cos, sin)` comes from a 16-interval quarter-circle table in Q0.16 ([`QUARTER_TABLE`],
//!   17 points) with linear interpolation, rotated by quadrant: no transcendentals
//!   (`determinism.md`). Decode and `set_segments` require `centre +- radius` inside `i32`.
//!
//! Within a straight segment, and within one quadrant of an arc, both coordinates are monotone in
//! the offset, so a tile, once left, is not re-entered inside that piece. The tile walk uses it:
//! from each tile entered it binary-searches the first offset whose `(tile, quadrant)` differs.
//! The index holds one entry per tile a line enters (`(tile, line, offset)`, `offset` the first
//! position in the tile; a line that leaves a tile and comes back has two). Chunk sets come from
//! each segment's exact tile box (the tiles of its positions `0 ..= len - 1`, from the pieces'
//! endpoints), so a straight segment ending on a tile edge does not claim the next tile.
//!
//! Storage (preallocated at `set_caps`, never reallocated): a segment pool of
//! `max_lines x SEGMENTS_PER_LINE` records, contiguous per line and compacted in place when the
//! tail is reached; the tile index, a sorted `Vec` of `max_lines x TILES_PER_LINE` entries plus
//! [`MAX_LINE_TILES`] of room for the in-place merge of one line's new entries. Past either cap
//! `set_segments` is `Full` (as is a path entering more than `MAX_LINE_TILES` tiles), the same
//! answer `create` gives at `max_lines`.

use super::line::NIL;
use super::{LineId, MAX_LEN, Transport, TransportError};
use crate::world::{ChunkCoord, ChunkDims, TilePos, WorldPos};

/// Segments one line may have (a merged straight run is one; a curve one arc per lane).
pub const MAX_SEGMENTS: usize = 16;
/// The most tiles one line's path may enter (its tile-index entries): the merge room the index
/// reserves beyond its cap.
pub const MAX_LINE_TILES: u32 = 4096;
/// Pool records per line on average (`max_lines x 4`).
const SEGMENTS_PER_LINE: u64 = 4;
/// Tile-index entries per line on average (`max_lines x 8`, M43 Planning decisions).
const TILES_PER_LINE: u64 = 8;

/// One piece of a line's path, `len` positions long (0076 §4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Segment {
    pub len: u32,
    pub geometry: Geometry,
}

/// A segment's shape (module doc for the exact mapping).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Geometry {
    Straight {
        from: WorldPos,
        to: WorldPos,
    },
    Arc {
        centre: WorldPos,
        radius_q8: u32,
        start_turn_q8: u16,
        sweep_q8: i16,
    },
}

/// A pooled segment: the segment, its first position on the line, and the owning line's slot
/// (`NIL`: a dead record, dropped at the next compaction).
#[derive(Clone, Copy, Debug)]
pub(super) struct SegRec {
    pub seg: Segment,
    pub start: u32,
    pub owner: u32,
}

/// A tile-index entry; the derived `Ord` is the index order `(y, x, line, offset)`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub(super) struct TileEntry {
    pub(super) y: i32,
    pub(super) x: i32,
    pub(super) line: u32,
    pub(super) offset: u32,
}

/// `(cos, sin)` of `k/16` of a quarter turn, `k = 0 ..= 16`, in Q0.16 (65,536 = 1), each the
/// nearest integer to `65,536 x cos(k pi / 32)` (and `sin`). Checked by
/// `quarter_table_is_a_unit_quarter_circle` without a transcendental: the 17 points are symmetric
/// about the diagonal, monotone, and each `c^2 + s^2` is within the rounding bound `c + s` of
/// `2^32` (and within 2 units of the unit circle's radius).
pub(super) const QUARTER_TABLE: [(i64, i64); 17] = [
    (65536, 0),
    (65220, 6424),
    (64277, 12785),
    (62714, 19024),
    (60547, 25080),
    (57798, 30893),
    (54491, 36410),
    (50660, 41576),
    (46341, 46341),
    (41576, 50660),
    (36410, 54491),
    (30893, 57798),
    (25080, 60547),
    (19024, 62714),
    (12785, 64277),
    (6424, 65220),
    (0, 65536),
];

/// Angle units: 65,536 per turn.
const QUARTER: i64 = 1 << 14;
const STEP: i64 = QUARTER / 16;
const ONE: i64 = 1 << 16;

/// `(cos a, sin a)` in Q0.16 for `a` in 1/65,536 turn (table and linear interpolation).
fn unit(a: i64) -> (i64, i64) {
    let q = a.div_euclid(QUARTER).rem_euclid(4);
    let r = a.rem_euclid(QUARTER);
    let i = (r / STEP) as usize;
    let f = r % STEP;
    let (c0, s0) = QUARTER_TABLE[i];
    let (c1, s1) = QUARTER_TABLE[i + 1];
    let c = c0 + ((c1 - c0) * f).div_euclid(STEP);
    let s = s0 + ((s1 - s0) * f).div_euclid(STEP);
    match q {
        0 => (c, s),
        1 => (-s, c),
        2 => (-c, -s),
        _ => (s, -c),
    }
}

/// The point at offset `o` (`o < seg.len`) and its monotone piece (0 for a straight segment, the
/// arc's quadrant index otherwise).
fn point(seg: &Segment, o: u32) -> (WorldPos, i64) {
    let len = i64::from(seg.len);
    let o = i64::from(o);
    match seg.geometry {
        Geometry::Straight { from, to } => {
            let x = i64::from(from.x) + ((i64::from(to.x) - i64::from(from.x)) * o).div_euclid(len);
            let y = i64::from(from.y) + ((i64::from(to.y) - i64::from(from.y)) * o).div_euclid(len);
            (
                WorldPos {
                    x: x as i32,
                    y: y as i32,
                },
                0,
            )
        }
        Geometry::Arc {
            centre,
            radius_q8,
            start_turn_q8,
            sweep_q8,
        } => {
            let a =
                i64::from(start_turn_q8) * 256 + (i64::from(sweep_q8) * 256 * o).div_euclid(len);
            let (c, s) = unit(a);
            let r = i64::from(radius_q8);
            (
                WorldPos {
                    x: (i64::from(centre.x) + (r * c).div_euclid(ONE)) as i32,
                    y: (i64::from(centre.y) + (r * s).div_euclid(ONE)) as i32,
                },
                a.div_euclid(QUARTER),
            )
        }
    }
}

/// The point at offset `o` of `seg` (`o < seg.len`): `replicate.rs`'s anchor of a put.
pub(super) fn point_of(seg: &Segment, o: u32) -> WorldPos {
    point(seg, o).0
}

/// `(tile, piece)` at offset `o`; `evals` counts the calls (the walk's cost, `walk_evals`).
#[inline]
fn state(seg: &Segment, o: u32, evals: &mut u64) -> (TilePos, i64) {
    *evals += 1;
    let (p, piece) = point(seg, o);
    (p.tile(), piece)
}

std::thread_local! {
    /// Point evaluations made by tile walks on this thread (tests and tools; not state).
    static WALK_EVALS: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
}

/// Point evaluations the tile walks (`set_segments`, decode, `rebuild_index`) made on the calling
/// thread so far: a cost counter a test can read instead of a timer (M43 review). Not state.
pub fn walk_evals() -> u64 {
    WALK_EVALS.with(|c| c.get())
}

/// The first offset in `(from, seg.len)` whose `(tile, piece)` differs from `at`'s, if any (the
/// predicate is a prefix property: module doc).
fn next_change(seg: &Segment, from: u32, at: (TilePos, i64), evals: &mut u64) -> Option<u32> {
    let (mut lo, mut hi) = (from + 1, seg.len);
    if lo >= hi || state(seg, seg.len - 1, evals) == at {
        return None;
    }
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if state(seg, mid, evals) != at {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Some(lo)
}

/// Every tile the segments enter, in path order, as `f(tile, offset on the line)`; a tile is
/// reported again only after the path left it. `f` returns whether to go on: the walk stops at
/// once on `false` (a count past `MAX_LINE_TILES` costs that many tiles, not the whole path).
fn walk_tiles<'a>(
    segs: impl Iterator<Item = &'a Segment>,
    f: &mut impl FnMut(TilePos, u32) -> bool,
) {
    let mut evals = 0u64;
    let mut base = 0u32;
    let mut last: Option<TilePos> = None;
    'segs: for seg in segs {
        let mut o = 0u32;
        let mut st = state(seg, 0, &mut evals);
        loop {
            if last != Some(st.0) {
                if !f(st.0, base + o) {
                    break 'segs;
                }
                last = Some(st.0);
            }
            match next_change(seg, o, st, &mut evals) {
                Some(n) => {
                    o = n;
                    st = state(seg, n, &mut evals);
                }
                None => break,
            }
        }
        base += seg.len;
    }
    WALK_EVALS.with(|c| c.set(c.get() + evals));
}

/// The tile box `(min, max)` of the segment's positions `0 ..= len - 1`: each monotone piece's
/// extremes are its endpoints.
pub(crate) fn tile_box(seg: &Segment) -> (TilePos, TilePos) {
    let mut lo = TilePos::new(i32::MAX, i32::MAX);
    let mut hi = TilePos::new(i32::MIN, i32::MIN);
    let mut add = |t: TilePos| {
        lo = TilePos::new(lo.x.min(t.x), lo.y.min(t.y));
        hi = TilePos::new(hi.x.max(t.x), hi.y.max(t.y));
    };
    let mut o = 0u32;
    loop {
        let piece = point(seg, o).1;
        // The last offset of this piece: binary search on the (monotone) piece index.
        let (mut a, mut b) = (o, seg.len - 1);
        while a < b {
            let mid = a + (b - a).div_ceil(2);
            if point(seg, mid).1 == piece {
                a = mid;
            } else {
                b = mid - 1;
            }
        }
        add(point(seg, o).0.tile());
        add(point(seg, a).0.tile());
        if a + 1 >= seg.len {
            break;
        }
        o = a + 1;
    }
    (lo, hi)
}

/// `(segment pool records, tile-index entries, tile-index merge room)` for `max_lines`.
pub(super) fn caps(max_lines: u32) -> (u32, u32, u32) {
    let clamp = |v: u64| v.min(u64::from(u32::MAX)) as u32;
    let lines = u64::from(max_lines);
    let headroom = if max_lines == 0 { 0 } else { MAX_LINE_TILES };
    (
        clamp(lines * SEGMENTS_PER_LINE),
        clamp(lines * TILES_PER_LINE),
        headroom,
    )
}

/// The checks `set_segments` and decode share: at most [`MAX_SEGMENTS`], every `len >= 1`, the
/// lengths summing to `line_len`, arc fields in range and the arc inside `i32`.
pub(super) fn check_segments(line_len: u32, segs: &[Segment]) -> bool {
    if segs.len() > MAX_SEGMENTS {
        return false;
    }
    let mut sum = 0u64;
    for s in segs {
        if s.len == 0 {
            return false;
        }
        sum += u64::from(s.len);
        if let Geometry::Arc {
            centre,
            radius_q8,
            start_turn_q8,
            sweep_q8,
        } = s.geometry
        {
            let r = i64::from(radius_q8);
            let fits = |c: i32| {
                i64::from(c) - r >= i64::from(i32::MIN) && i64::from(c) + r <= i64::from(i32::MAX)
            };
            if radius_q8 == 0
                || start_turn_q8 >= 256
                || sweep_q8 == 0
                || !(-256..=256).contains(&sweep_q8)
                || !fits(centre.x)
                || !fits(centre.y)
            {
                return false;
            }
        }
    }
    sum == u64::from(line_len) && sum <= u64::from(MAX_LEN)
}

/// Tiles the segments' path enters (the index entries it needs), stopping at `MAX_LINE_TILES + 1`
/// (any count past the cap is refused, so the walk need not go further).
pub(super) fn count_tiles(segs: &[Segment]) -> u32 {
    let mut n = 0u32;
    walk_tiles(segs.iter(), &mut |_, _| {
        n += 1;
        n <= MAX_LINE_TILES
    });
    n
}

impl Transport {
    /// The slot's pooled segments, front to back.
    pub(super) fn seg_slice(&self, l: u32) -> &[SegRec] {
        let rec = &self.lines[l as usize];
        if rec.seg_count == 0 {
            return &[];
        }
        let s = rec.seg_start as usize;
        &self.segs[s..s + rec.seg_count as usize]
    }

    pub(super) fn pos_to_world_slot(&self, l: u32, pos: u32) -> Option<WorldPos> {
        let segs = self.seg_slice(l);
        if segs.is_empty() || pos >= self.lines[l as usize].len {
            return None;
        }
        // The last segment starting at or before `pos` (prefix sums, binary search).
        let k = segs.partition_point(|r| r.start <= pos) - 1;
        let r = &segs[k];
        Some(point(&r.seg, pos - r.start).0)
    }

    /// `chunks_of`: every chunk of the union of the segments' chunk boxes, sorted `(cy, cx)`, once.
    pub(super) fn chunks_of_slot(&self, l: u32, dims: ChunkDims, f: &mut dyn FnMut(ChunkCoord)) {
        let segs = self.seg_slice(l);
        if segs.is_empty() {
            return;
        }
        let mut boxes = [(ChunkCoord::default(), ChunkCoord::default()); MAX_SEGMENTS];
        let (mut y0, mut y1) = (i32::MAX, i32::MIN);
        for (k, r) in segs.iter().enumerate() {
            let (lo, hi) = tile_box(&r.seg);
            let b = (dims.chunk_of(lo), dims.chunk_of(hi));
            y0 = y0.min(b.0.y);
            y1 = y1.max(b.1.y);
            boxes[k] = b;
        }
        let boxes = &boxes[..segs.len()];
        let mut row = [(0i32, 0i32); MAX_SEGMENTS];
        for cy in y0..=y1 {
            // This row's x-intervals, sorted by start (insertion sort: at most 16), then merged.
            let mut n = 0;
            for &(lo, hi) in boxes {
                if lo.y <= cy && cy <= hi.y {
                    let mut i = n;
                    while i > 0 && row[i - 1].0 > lo.x {
                        row[i] = row[i - 1];
                        i -= 1;
                    }
                    row[i] = (lo.x, hi.x);
                    n += 1;
                }
            }
            let mut next = i32::MIN; // the first cx not yet emitted in this row
            for &(a, b) in &row[..n] {
                let mut cx = a.max(next);
                while cx <= b {
                    f(ChunkCoord::new(cx, cy));
                    cx += 1;
                }
                next = next.max(b.saturating_add(1));
            }
        }
    }

    /// `lines_at`: the index entries of `tile`, ascending by line then offset.
    pub(super) fn lines_at_tile(&self, tile: TilePos, f: &mut dyn FnMut(LineId, u32)) {
        let key = (tile.y, tile.x);
        let mut k = self.tiles.partition_point(|e| (e.y, e.x) < key);
        while let Some(e) = self.tiles.get(k) {
            if (e.y, e.x) != key {
                break;
            }
            f(LineId(e.line), e.offset);
            k += 1;
        }
    }

    /// Frees the slot's segments and removes its tile-index entries (O(index)).
    pub(super) fn clear_geometry(&mut self, l: u32) {
        let rec = self.lines[l as usize];
        if rec.seg_count == 0 {
            return;
        }
        let s = rec.seg_start as usize;
        for r in &mut self.segs[s..s + rec.seg_count as usize] {
            r.owner = NIL;
        }
        self.seg_live -= u32::from(rec.seg_count);
        let id = rec.id.0;
        self.tiles.retain(|e| e.line != id);
        let line = &mut self.lines[l as usize];
        line.seg_start = NIL;
        line.seg_count = 0;
    }

    /// Moves every live pool record down over the dead ones, keeping each line's records
    /// contiguous and in order (O(pool), only when the pool's tail is reached).
    fn compact_segments(&mut self) {
        let mut w = 0usize;
        for i in 0..self.segs.len() {
            let r = self.segs[i];
            if r.owner == NIL {
                continue;
            }
            let line = &mut self.lines[r.owner as usize];
            if line.seg_start as usize == i {
                line.seg_start = w as u32;
            }
            self.segs[w] = r;
            w += 1;
        }
        self.segs.truncate(w);
    }

    /// Appends the slot's segments to the pool (the caller checked the room).
    fn push_segments(&mut self, l: u32, segs: &[Segment]) {
        if segs.is_empty() {
            return;
        }
        if self.segs.len() + segs.len() > self.seg_cap as usize {
            self.compact_segments();
        }
        let start = self.segs.len() as u32;
        let mut pos = 0u32;
        for &seg in segs {
            self.segs.push(SegRec {
                seg,
                start: pos,
                owner: l,
            });
            pos += seg.len;
        }
        self.seg_live += segs.len() as u32;
        let line = &mut self.lines[l as usize];
        line.seg_start = start;
        line.seg_count = segs.len() as u8;
    }

    /// Inserts the slot's tile entries (`k` of them, counted by the caller) into the sorted index
    /// in place: the new entries are written past the merge destination, sorted, and merged from
    /// the back, so no entry is read after it is overwritten and nothing allocates.
    fn index_line(&mut self, l: u32, k: u32) {
        if k == 0 {
            return;
        }
        let n0 = self.tiles.len();
        let k = k as usize;
        let id = self.lines[l as usize].id.0;
        self.tiles.resize(n0 + k, TileEntry::default());
        let tiles = &mut self.tiles;
        let s = self.lines[l as usize].seg_start as usize;
        let c = self.lines[l as usize].seg_count as usize;
        walk_tiles(self.segs[s..s + c].iter().map(|r| &r.seg), &mut |t, o| {
            tiles.push(TileEntry {
                y: t.y,
                x: t.x,
                line: id,
                offset: o,
            });
            true
        });
        debug_assert_eq!(
            self.tiles.len(),
            n0 + 2 * k,
            "count_tiles disagrees with the walk"
        );
        self.tiles[n0 + k..].sort_unstable();
        // Merge `[0, n0)` and `[n0 + k, n0 + 2k)` into `[0, n0 + k)`, largest first.
        let (mut i, mut j, mut d) = (n0, k, n0 + k);
        while j > 0 {
            d -= 1;
            if i > 0 && self.tiles[i - 1] > self.tiles[n0 + k + j - 1] {
                self.tiles[d] = self.tiles[i - 1];
                i -= 1;
            } else {
                self.tiles[d] = self.tiles[n0 + k + j - 1];
                j -= 1;
            }
        }
        self.tiles.truncate(n0 + k);
    }

    pub(super) fn set_segments_line(
        &mut self,
        line: LineId,
        segs: &[Segment],
    ) -> Result<(), TransportError> {
        let l = self.slot(line).ok_or(TransportError::NoLine)?;
        let rec = self.lines[l as usize];
        if !segs.is_empty() && !check_segments(rec.len, segs) {
            return Err(TransportError::BadSegments);
        }
        let k = count_tiles(segs);
        let old_k = {
            let mut n = 0u32;
            walk_tiles(self.seg_slice(l).iter().map(|r| &r.seg), &mut |_, _| {
                n += 1;
                true
            });
            n
        };
        let tiles_after = self.tiles.len() as u64 - u64::from(old_k) + u64::from(k);
        let segs_after = u64::from(self.seg_live) - u64::from(rec.seg_count) + segs.len() as u64;
        if k > MAX_LINE_TILES
            || tiles_after > u64::from(self.tile_cap)
            || segs_after > u64::from(self.seg_cap)
        {
            return Err(TransportError::Full);
        }
        self.clear_geometry(l);
        self.push_segments(l, segs);
        self.index_line(l, k);
        self.touch(l);
        Ok(())
    }

    /// Decode: the line's segments, already checked, without the caps (decode grows to fit; the
    /// caller's `set_caps` settles them) and without the index (`rebuild_index` follows).
    pub(super) fn decode_segments(&mut self, l: u32, segs: &[Segment]) {
        self.push_segments(l, segs);
    }

    /// Rebuilds the tile index from every line's segments (decode; the test
    /// `index_rebuild_equals_incremental` proves it reaches what incremental maintenance reaches).
    /// Within the reserved room: the entries of a live store never exceed it.
    pub fn rebuild_index(&mut self) {
        self.tiles.clear();
        let tiles = &mut self.tiles;
        for &(id, l) in &self.index {
            let rec = &self.lines[l as usize];
            if rec.seg_count == 0 {
                continue;
            }
            let s = rec.seg_start as usize;
            walk_tiles(
                self.segs[s..s + rec.seg_count as usize]
                    .iter()
                    .map(|r| &r.seg),
                &mut |t, o| {
                    tiles.push(TileEntry {
                        y: t.y,
                        x: t.x,
                        line: id.0,
                        offset: o,
                    });
                    true
                },
            );
        }
        self.tiles.sort_unstable();
    }

    /// The tile index as `(tile, line, offset)` in index order (tests and tools).
    pub fn tile_index_into(&self, out: &mut Vec<(TilePos, LineId, u32)>) {
        out.clear();
        out.extend(
            self.tiles
                .iter()
                .map(|e| (TilePos::new(e.x, e.y), LineId(e.line), e.offset)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is a quarter of the unit circle without a transcendental: symmetric about the
    /// diagonal, exact at both ends, monotone, and every point within the rounding bound of
    /// radius 1 (`|c^2 + s^2 - 2^32| <= c + s`, and inside `[(2^16 - 2)^2, (2^16 + 2)^2]`).
    #[test]
    fn quarter_table_is_a_unit_quarter_circle() {
        let t = QUARTER_TABLE;
        assert_eq!(t[0], (65536, 0));
        assert_eq!(t[16], (0, 65536));
        for k in 0..17 {
            let (c, s) = t[k];
            assert_eq!((c, s), (t[16 - k].1, t[16 - k].0), "symmetry at {k}");
            let r2 = c * c + s * s;
            assert!(
                (r2 - (1 << 32)).abs() <= c + s,
                "rounding bound at {k}: {r2}"
            );
            assert!(
                (65534 * 65534..=65538 * 65538).contains(&r2),
                "radius at {k}: {r2}"
            );
            if k > 0 {
                assert!(c < t[k - 1].0 && s > t[k - 1].1, "monotone at {k}");
            }
        }
    }

    /// The interpolated unit vector at every 1/65,536 turn stays inside `[(2^16 - 82)^2,
    /// (2^16 + 2)^2]` (linear interpolation cuts a chord inside the arc, at most
    /// `1 - cos(pi / 64) = 0.0012`, 79 units, plus the floor) and is monotone within each quadrant.
    #[test]
    fn unit_interpolates_inside_the_circle() {
        let mut prev = unit(0);
        for a in 1..(4 * QUARTER) {
            let (c, s) = unit(a);
            let r2 = c * c + s * s;
            assert!(
                ((65536 - 82) * (65536 - 82)..=65538 * 65538).contains(&r2),
                "radius at {a}: {r2}"
            );
            if a % QUARTER != 0 {
                let q = a / QUARTER;
                let (dc, ds) = (c - prev.0, s - prev.1);
                let ok = match q {
                    0 => dc <= 0 && ds >= 0,
                    1 => dc <= 0 && ds <= 0,
                    2 => dc >= 0 && ds <= 0,
                    _ => dc >= 0 && ds >= 0,
                };
                assert!(ok, "monotone at {a}");
            }
            prev = (c, s);
        }
    }
}
