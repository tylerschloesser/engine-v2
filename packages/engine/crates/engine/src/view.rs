//! View geometry shared by generation and subscriptions (docs/decisions/0008-chunk-generation.md
//! §5, `docs/plan/08b-gen-workers-and-queue.md` Seams): [`visible_rect`] turns a camera's centre
//! and half extent into a chunk rectangle; [`lookahead_chunks`] is the look-ahead function
//! generation and 0010's subscriptions share ("the chunks that 0010's look-ahead subscribes beyond
//! ring 1"); [`nearest_first`] orders a chunk rect nearest-first (offered to M13's `host::warm`).
//! Float use is confined to `visible_rect`; everything else here is integer-only
//! (`.claude/rules/determinism.md`: `floor`, comparisons and `as` casts only, no transcendentals).

use crate::world::{ChunkCoord, ChunkDims, ChunkRect, TILE_MAX, TILE_MIN, TilePos, TileRect};

#[inline]
fn clamp_tile_axis(v: f64) -> i32 {
    v.clamp(TILE_MIN as f64, TILE_MAX as f64) as i32
}

/// `center`/`half_extent_tiles` are world-tile-space floats, the camera block's own units (0019
/// §1: `centre` is `f64`, `half_extent_tiles` is `f32`). The rectangle `[center - half_extent,
/// center + half_extent]` is floored to tile boundaries, clamped into the valid tile range, then
/// converted to the chunk rect it lies in.
pub fn visible_rect(
    center: (f64, f64),
    half_extent_tiles: (f32, f32),
    dims: ChunkDims,
) -> ChunkRect {
    let min_x = (center.0 - half_extent_tiles.0 as f64).floor();
    let max_x = (center.0 + half_extent_tiles.0 as f64).floor();
    let min_y = (center.1 - half_extent_tiles.1 as f64).floor();
    let max_y = (center.1 + half_extent_tiles.1 as f64).floor();
    let min = TilePos::new(clamp_tile_axis(min_x), clamp_tile_axis(min_y));
    let max = TilePos::new(clamp_tile_axis(max_x), clamp_tile_axis(max_y));
    ChunkRect::new(dims.chunk_of(min), dims.chunk_of(max))
}

/// docs/plan/17-drawlist-and-sprites.md Seams: `FrameView::visible()` ("visible rectangle plus a
/// 2-tile margin"). Tile-space counterpart of [`visible_rect`] (chunk-space): floors `[center -
/// half_extent - margin, center + half_extent + margin]` to tile boundaries per axis, then clamps
/// into the valid tile range -- same float/clamp shape as `visible_rect`, one level finer.
pub fn visible_tile_rect(
    center: (f64, f64),
    half_extent_tiles: (f32, f32),
    margin: f64,
) -> TileRect {
    let min_x = (center.0 - half_extent_tiles.0 as f64 - margin).floor();
    let max_x = (center.0 + half_extent_tiles.0 as f64 + margin).floor();
    let min_y = (center.1 - half_extent_tiles.1 as f64 - margin).floor();
    let max_y = (center.1 + half_extent_tiles.1 as f64 + margin).floor();
    TileRect::new(
        TilePos::new(clamp_tile_axis(min_x), clamp_tile_axis(min_y)),
        TilePos::new(clamp_tile_axis(max_x), clamp_tile_axis(max_y)),
    )
}

/// Up to 2 extra chunks beyond `visible.expanded(1)`, in the direction of travel (0008 §5): one
/// per axis with nonzero velocity, at `visible`'s own mid row/column, just past the ring-1 edge on
/// that axis. `velocity` is Q24.8 tiles/second (the same units `GenQueue`'s `GenView::velocity`
/// carries); only its sign matters here. `dims` is accepted for symmetry with the rest of this
/// module's signatures and to leave room for a future chunk-size-aware shape; unused today
/// (`docs/plan/08b-gen-workers-and-queue.md` Deviations: 0008 §5 does not pin an exact algorithm
/// down beyond "at most 2 extra chunks", so this is this milestone's own reading, shared verbatim
/// by generation and M10's subscriptions).
pub fn lookahead_chunks(
    visible: ChunkRect,
    velocity: (i32, i32),
    _dims: ChunkDims,
    out: &mut [ChunkCoord; 2],
) -> usize {
    let ring1 = visible.expanded(1);
    let mid_x = (ring1.min.x + ring1.max.x) / 2;
    let mid_y = (ring1.min.y + ring1.max.y) / 2;
    let mut n = 0;
    if velocity.0 != 0 {
        let x = if velocity.0 > 0 {
            ring1.max.x + 1
        } else {
            ring1.min.x - 1
        };
        out[n] = ChunkCoord::new(x, mid_y);
        n += 1;
    }
    if velocity.1 != 0 {
        let y = if velocity.1 > 0 {
            ring1.max.y + 1
        } else {
            ring1.min.y - 1
        };
        out[n] = ChunkCoord::new(mid_x, y);
        n += 1;
    }
    n
}

#[inline]
fn chunk_point_dist_sq(c: ChunkCoord, center: TilePos) -> i64 {
    let dx = c.x as i64 - center.x as i64;
    let dy = c.y as i64 - center.y as i64;
    dx * dx + dy * dy
}

/// Fills `out` (row-major from `rect.iter()`, capped at `out.len()`) with every chunk of `rect`,
/// sorted nearest-first to `center`; returns the count written. In place, allocation-free
/// (`sort_unstable_by_key` on the `out` slice itself -- no scratch buffer).
///
/// `center` is in the same coordinate space as [`ChunkCoord`] (docs/plan/
/// 08b-gen-workers-and-queue.md Deviations: despite the [`TilePos`] type -- both are plain `i32`
/// pairs with no inherent scale -- a caller holding a genuine tile-space position converts with
/// `dims.chunk_of(..)` first and passes the result reinterpreted as a `TilePos`; M13's `host::warm`
/// already holds a `ChunkDims` to do this with).
pub fn nearest_first(rect: ChunkRect, center: TilePos, out: &mut [ChunkCoord]) -> usize {
    let mut n = 0;
    for chunk in rect.iter() {
        if n >= out.len() {
            break;
        }
        out[n] = chunk;
        n += 1;
    }
    out[..n].sort_unstable_by_key(|c| chunk_point_dist_sq(*c, center));
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_rect_negative_and_edge() {
        let dims = ChunkDims::new(5); // edge 32
        // Centred well inside chunk 0 (tiles [0, 31]), extent small enough that both boundary
        // tiles ([1, 31]) still fall inside it.
        let r = visible_rect((16.0, 16.0), (15.0, 15.0), dims);
        assert_eq!(
            r,
            ChunkRect::new(ChunkCoord::new(0, 0), ChunkCoord::new(0, 0))
        );

        // Negative centre, straddling a chunk boundary.
        let r = visible_rect((-1.0, -1.0), (2.0, 2.0), dims);
        assert_eq!(r.min, dims.chunk_of(TilePos::new(-3, -3)));
        assert_eq!(r.max, dims.chunk_of(TilePos::new(1, 1)));

        // Far out near the coordinate edge: clamps into range rather than overflowing.
        let r = visible_rect((TILE_MAX as f64 + 1000.0, 0.0), (4.0, 4.0), dims);
        assert_eq!(r.max.x, dims.chunk_of(TilePos::new(TILE_MAX, 0)).x);

        let r = visible_rect((TILE_MIN as f64 - 1000.0, 0.0), (4.0, 4.0), dims);
        assert_eq!(r.min.x, dims.chunk_of(TilePos::new(TILE_MIN, 0)).x);
    }

    #[test]
    fn lookahead_caps_extra_chunks() {
        let dims = ChunkDims::new(4);
        let visible = ChunkRect::new(ChunkCoord::new(0, 0), ChunkCoord::new(0, 0));
        let mut out = [ChunkCoord::default(); 2];

        // No velocity: nothing extra.
        assert_eq!(lookahead_chunks(visible, (0, 0), dims, &mut out), 0);

        // Pure +x: one chunk, just beyond ring1's +x edge.
        let n = lookahead_chunks(visible, (300, 0), dims, &mut out);
        assert_eq!(n, 1);
        let ring1 = visible.expanded(1);
        assert_eq!(out[0], ChunkCoord::new(ring1.max.x + 1, 0));

        // Diagonal: exactly 2, never more.
        let n = lookahead_chunks(visible, (300, -300), dims, &mut out);
        assert_eq!(n, 2);
        assert_eq!(out[0], ChunkCoord::new(ring1.max.x + 1, 0));
        assert_eq!(out[1], ChunkCoord::new(0, ring1.min.y - 1));
    }

    #[test]
    fn nearest_first_order() {
        let rect = ChunkRect::new(ChunkCoord::new(-2, -2), ChunkCoord::new(2, 2));
        let mut out = [ChunkCoord::default(); 25];
        let n = nearest_first(rect, TilePos::new(0, 0), &mut out);
        assert_eq!(n, 25);
        assert_eq!(out[0], ChunkCoord::new(0, 0));
        let mut last = 0i64;
        for &c in &out[..n] {
            let d = chunk_point_dist_sq(c, TilePos::new(0, 0));
            assert!(d >= last, "not sorted nearest-first: {out:?}");
            last = d;
        }

        // A buffer smaller than the rect: the first `out.len()` row-major chunks are the
        // candidates (a realistic caller sizes `out` to the whole rect it wants ordered), sorted
        // among themselves.
        let mut small = [ChunkCoord::default(); 3];
        let n = nearest_first(rect, TilePos::new(2, 2), &mut small);
        assert_eq!(n, 3);
        let mut last = 0i64;
        for &c in &small[..n] {
            let d = chunk_point_dist_sq(c, TilePos::new(2, 2));
            assert!(d >= last);
            last = d;
        }
    }
}
