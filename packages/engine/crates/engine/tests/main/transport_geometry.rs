//! M43 (docs/decisions/0076-transport-lines-engine-game-split.md §4): registered line geometry,
//! `pos_to_world`, the derived chunk set, anchor and tile index. Positions are Q24.8 (`WorldPos`,
//! 256 per tile); expectations are literal (0069 §2) except the precision test, which compares
//! against an `i128` lerp written in the test.
//!
//! - `geometry_prefix_lookup`: three segments, every boundary, and `set_segments`' refusals.
//! - `geometry_arc_quarter_circle_endpoints`: the four cardinal starts exact, both sweep signs,
//!   12 §3d's curve radii (0.263 and 0.736 tiles over 106 and 295 positions) at about one
//!   position per 1/256 tile along the arc.
//! - `geometry_chunks_and_anchor_across_border`, `geometry_precision_at_2_pow_18`.
//! - `index_rebuild_equals_incremental`: 200 seeded random edits (segments and surgery); after
//!   each, the incremental index equals `rebuild_index`'s, and every tenth edit both equal a
//!   brute-force index sampled from `pos_to_world` at every position.

use engine::rng::SimRng;
use engine::transport::{
    Geometry, LineId, MAX_LEN, MAX_LINE_TILES, MAX_SEGMENTS, Output, Segment, Transport,
    TransportError, TransportRead, TransportWrite, walk_evals,
};
use engine::world::{ChunkCoord, ChunkDims, TilePos, WorldPos};

const T: i32 = 256;

fn wp(x: i32, y: i32) -> WorldPos {
    WorldPos { x, y }
}

fn straight(len: u32, from: WorldPos, to: WorldPos) -> Segment {
    Segment {
        len,
        geometry: Geometry::Straight { from, to },
    }
}

fn arc(len: u32, centre: WorldPos, radius_q8: u32, start_turn_q8: u16, sweep_q8: i16) -> Segment {
    Segment {
        len,
        geometry: Geometry::Arc {
            centre,
            radius_q8,
            start_turn_q8,
            sweep_q8,
        },
    }
}

fn at(t: &Transport, l: LineId, pos: u32) -> WorldPos {
    t.pos_to_world(l, pos)
        .unwrap()
        .expect("a position on the path")
}

fn chunks(t: &Transport, l: LineId, dims: ChunkDims) -> Vec<(i32, i32)> {
    let mut v = Vec::new();
    t.chunks_of(l, dims, &mut |c| v.push((c.x, c.y))).unwrap();
    v
}

fn lines_at(t: &Transport, tile: TilePos) -> Vec<(u32, u32)> {
    let mut v = Vec::new();
    t.lines_at(tile, &mut |l, o| v.push((l.0, o))).unwrap();
    v
}

/// A straight tile (256 positions) east from the origin, a quarter arc (106 positions, radius 67)
/// turning toward `+y`, then 300 positions south. `pos_to_world` binary-searches the prefix sums
/// (0, 256, 362): the first position of each segment is that segment's own offset 0.
#[test]
fn geometry_prefix_lookup() {
    let mut t = Transport::new(8, 64);
    let l = t.create(662, 24).unwrap();
    assert_eq!(t.pos_to_world(l, 0), Ok(None), "no segments yet");
    let segs = [
        straight(256, wp(0, 0), wp(T, 0)),
        arc(106, wp(T, 67), 67, 192, 64),
        straight(300, wp(T + 67, 67), wp(T + 67, 67 + 300)),
    ];
    t.set_segments(l, &segs).unwrap();
    assert_eq!(at(&t, l, 0), wp(0, 0));
    assert_eq!(at(&t, l, 1), wp(1, 0));
    assert_eq!(at(&t, l, 255), wp(255, 0));
    // The arc starts at a quarter turn of 3 (pointing `-y` from its centre): exactly (256, 0).
    assert_eq!(at(&t, l, 256), wp(T, 0));
    assert_eq!(at(&t, l, 362), wp(T + 67, 67));
    assert_eq!(at(&t, l, 661), wp(T + 67, 67 + 299));
    assert_eq!(t.pos_to_world(l, 662), Ok(None), "pos >= len");
    let mut got = Vec::new();
    t.segments(l, &mut |s| got.push(s)).unwrap();
    assert_eq!(got, segs.to_vec());

    // Refusals write nothing.
    let bad: [&[Segment]; 7] = [
        &[straight(661, wp(0, 0), wp(T, 0))],
        &[
            straight(0, wp(0, 0), wp(T, 0)),
            straight(662, wp(0, 0), wp(T, 0)),
        ],
        &[arc(662, wp(0, 0), 0, 0, 64)],
        &[arc(662, wp(0, 0), 67, 256, 64)],
        &[arc(662, wp(0, 0), 67, 0, 0)],
        &[arc(662, wp(0, 0), 67, 0, -257)],
        &[arc(662, wp(i32::MAX - 66, 0), 67, 0, 64)],
    ];
    for b in bad {
        assert_eq!(
            t.set_segments(l, b),
            Err(TransportError::BadSegments),
            "{b:?}"
        );
    }
    let many = [straight(1, wp(0, 0), wp(1, 0)); MAX_SEGMENTS + 1];
    let m = t.create(MAX_SEGMENTS as u32 + 1, 1).unwrap();
    assert_eq!(t.set_segments(m, &many), Err(TransportError::BadSegments));
    t.set_segments(m, &many[1..])
        .expect_err("16 of length 1 sum to 16, not 17");
    let mut got = Vec::new();
    t.segments(l, &mut |s| got.push(s)).unwrap();
    assert_eq!(got, segs.to_vec(), "unchanged by the refusals");
    // `&[]` clears; surgery that changes `len` clears too.
    t.set_segments(l, &[]).unwrap();
    assert_eq!(t.pos_to_world(l, 0), Ok(None));
    t.set_segments(l, &segs).unwrap();
    t.extend_back(l, 10).unwrap();
    assert_eq!(
        t.pos_to_world(l, 0),
        Ok(None),
        "extend_back cleared the segments"
    );
    assert_eq!(lines_at(&t, TilePos::new(0, 0)), vec![]);
    assert_eq!(
        t.set_segments(LineId(9), &segs),
        Err(TransportError::NoLine)
    );
}

/// A quarter arc from each cardinal start lands exactly on the circle's cardinal point at its
/// first position (the table's exact ends); its last position is within two 1/256 tile of the
/// next cardinal point (one position short of the end, plus the table's rounding); a negative
/// sweep runs the other way. 12 §3d's lanes (radius 67 over 106 positions, 188 over 295) move
/// about one 1/256 tile per position all along the arc.
#[test]
fn geometry_arc_quarter_circle_endpoints() {
    let c = wp(1000, -1000);
    let r = 188i32;
    let mut t = Transport::new(16, 64);
    let card = [wp(r, 0), wp(0, r), wp(-r, 0), wp(0, -r)];
    for (q, sweep) in [
        (0usize, 64i16),
        (1, 64),
        (2, 64),
        (3, 64),
        (1, -64),
        (0, -64),
    ] {
        let l = t.create(295, 8).unwrap();
        t.set_segments(l, &[arc(295, c, r as u32, 64 * q as u16, sweep)])
            .unwrap();
        let first = at(&t, l, 0);
        assert_eq!(first, wp(c.x + card[q].x, c.y + card[q].y), "start {q}");
        let next = if sweep > 0 { (q + 1) % 4 } else { (q + 3) % 4 };
        let last = at(&t, l, 294);
        let (ex, ey) = (c.x + card[next].x, c.y + card[next].y);
        assert!(
            (last.x - ex).abs() <= 2 && (last.y - ey).abs() <= 2,
            "start {q} sweep {sweep}: last {last:?}, end ({ex}, {ey})"
        );
    }
    // Arc length `radius x pi / 2` matches the line length: steps of about 1 position.
    for (len, radius) in [(106u32, 67u32), (295, 188)] {
        let l = t.create(len, 8).unwrap();
        t.set_segments(l, &[arc(len, wp(0, 0), radius, 0, 64)])
            .unwrap();
        let mut prev = at(&t, l, 0);
        for pos in 1..len {
            let p = at(&t, l, pos);
            let d2 = (p.x - prev.x).pow(2) + (p.y - prev.y).pow(2);
            assert!((0..=4).contains(&d2), "len {len} pos {pos}: step^2 {d2}");
            let r2 = i64::from(p.x).pow(2) + i64::from(p.y).pow(2);
            let (lo, hi) = (i64::from(radius) - 2, i64::from(radius) + 1);
            assert!(
                (lo * lo..=hi * hi).contains(&r2),
                "len {len} pos {pos}: off the circle"
            );
            prev = p;
        }
    }
}

/// Chunks (CHUNK_BITS 5: 32 tiles) of a line crossing the border between chunk 0 and 1 at tile
/// 32, sorted `(cy, cx)`; the anchor is the chunk of position 0 (the front), so the same path
/// registered the other way anchors in the other chunk. A segment ending exactly on a tile edge
/// does not claim the tile past it. The tile index records the first position in each tile.
#[test]
fn geometry_chunks_and_anchor_across_border() {
    let dims = ChunkDims::new(5);
    let mut t = Transport::new(64, 64);
    let east = t.create(4 * 256, 24).unwrap();
    t.set_segments(
        east,
        &[straight(1024, wp(30 * T, 5 * T), wp(34 * T, 5 * T))],
    )
    .unwrap();
    assert_eq!(chunks(&t, east, dims), vec![(0, 0), (1, 0)]);
    assert_eq!(t.anchor(east, dims), Ok(Some(ChunkCoord::new(0, 0))));
    let west = t.create(4 * 256, 24).unwrap();
    t.set_segments(
        west,
        &[straight(1024, wp(34 * T, 5 * T), wp(30 * T, 5 * T))],
    )
    .unwrap();
    assert_eq!(t.anchor(west, dims), Ok(Some(ChunkCoord::new(1, 0))));
    // Westward, position `o` is at `x = 34 x 256 - o`: tile 34 at 0 only, tile 33 from 1, ...,
    // tile 30 from 769 (the last position, 1023, is at `30 x 256 + 1`).
    assert_eq!(chunks(&t, west, dims), vec![(0, 0), (1, 0)]);
    assert_eq!(
        (30..=34)
            .map(|x| lines_at(&t, TilePos::new(x, 5)))
            .collect::<Vec<_>>(),
        vec![
            vec![(1, 0), (2, 769)],
            vec![(1, 256), (2, 513)],
            vec![(1, 512), (2, 257)],
            vec![(1, 768), (2, 1)],
            vec![(2, 0)],
        ]
    );
    assert_eq!(
        lines_at(&t, TilePos::new(29, 5)),
        vec![],
        "the westward path stops inside 30"
    );
    // Ending on a tile edge: tiles 28..=31 only, chunk 0 only.
    let edge = t.create(1024, 24).unwrap();
    t.set_segments(edge, &[straight(1024, wp(28 * T, 0), wp(32 * T, 0))])
        .unwrap();
    assert_eq!(chunks(&t, edge, dims), vec![(0, 0)]);
    // An L across four chunks with negative coordinates: north along x = -1 from y = 40 to
    // y = -8, then east along y = -8 from x = -1 to x = 40. Sorted `(cy, cx)`: row -1 first.
    let l = t.create(48 * 256 + 41 * 256, 24).unwrap();
    t.set_segments(
        l,
        &[
            straight(48 * 256, wp(-T, 40 * T), wp(-T, -8 * T)),
            straight(41 * 256, wp(-T, -8 * T), wp(40 * T, -8 * T)),
        ],
    )
    .unwrap();
    assert_eq!(
        chunks(&t, l, dims),
        vec![(-1, -1), (0, -1), (1, -1), (-1, 0), (-1, 1)]
    );
    assert_eq!(t.anchor(l, dims), Ok(Some(ChunkCoord::new(-1, 1))));
    // Northward `y = 40 x 256 - o` enters tile -8 at `o = 47 x 256 + 1`; the eastward segment
    // starts in the same tile, so the corner has one entry.
    assert_eq!(
        lines_at(&t, TilePos::new(-1, -8)),
        vec![(4, 47 * 256 + 1)],
        "the corner tile"
    );
    let bits4 = ChunkDims::new(4);
    assert_eq!(chunks(&t, east, bits4), vec![(1, 0), (2, 0)]);
    // An arc in a chunk corner: a quarter around tile (32, 32)'s corner spans four chunks.
    let a = t.create(402, 24).unwrap();
    t.set_segments(a, &[arc(402, wp(32 * T, 32 * T), 256, 0, 256)])
        .unwrap();
    assert_eq!(chunks(&t, a, dims), vec![(0, 0), (1, 0), (0, 1), (1, 1)]);
    assert_eq!(t.anchor(a, dims), Ok(Some(ChunkCoord::new(1, 1))));
}

/// `pos_to_world` far from the origin is exact integer arithmetic: a straight segment spanning
/// -2^18 to +2^18 tiles (Q24.8: +-2^26) in 1,024 positions matches an `i128` lerp at every
/// position (an `i32` intermediate overflows at `2^27 x 1,023`), and a one-tile segment at
/// (+2^18, -2^18) tiles maps every position to its 1/256 tile.
#[test]
fn geometry_precision_at_2_pow_18() {
    let far = 1i32 << 26;
    // 256 lines: a tile index of 2,048 entries for this path's 1,024.
    let mut t = Transport::new(256, 64);
    let l = t.create(1024, 24).unwrap();
    let (from, to) = (wp(-far, far), wp(far, -far));
    t.set_segments(l, &[straight(1024, from, to)]).unwrap();
    let lerp = |a: i32, b: i32, o: u32| -> i32 {
        let d = (i128::from(b) - i128::from(a)) * i128::from(o);
        (i128::from(a) + d.div_euclid(1024)) as i32
    };
    for pos in 0..1024 {
        let p = at(&t, l, pos);
        assert_eq!(
            p,
            wp(lerp(from.x, to.x, pos), lerp(from.y, to.y, pos)),
            "pos {pos}"
        );
    }
    assert_eq!(at(&t, l, 1023), wp(far - (1 << 17), -far + (1 << 17)));
    let m = t.create(256, 24).unwrap();
    t.set_segments(m, &[straight(256, wp(far, -far), wp(far + T, -far))])
        .unwrap();
    for pos in 0..256 {
        assert_eq!(at(&t, m, pos), wp(far + pos as i32, -far));
    }
    assert_eq!(
        lines_at(&t, TilePos::new(1 << 18, -(1 << 18))),
        vec![(2, 0)]
    );
}

/// The tile index sampled the slow way: every position's tile through `pos_to_world`, an entry
/// whenever the tile changes (sorted like the index).
fn brute_index(t: &Transport, lines: &[LineId]) -> Vec<(TilePos, LineId, u32)> {
    let mut v = Vec::new();
    for &l in lines {
        let Ok(len) = t.len(l) else { continue };
        let mut last = None;
        for pos in 0..len {
            let Some(p) = t.pos_to_world(l, pos).unwrap() else {
                break;
            };
            if last != Some(p.tile()) {
                v.push((p.tile(), l, pos));
                last = Some(p.tile());
            }
        }
    }
    v.sort_by_key(|&(tile, l, o)| (tile.y, tile.x, l, o));
    v
}

/// 200 seeded random edits over a few lines: `set_segments` (straight runs and arcs, random
/// directions, inside a 3 x 3 chunk area around the origin), `split`, `join`, `extend_*`,
/// `shrink_*`, `rescale`, `destroy`, `create`. After each the index maintained incrementally
/// equals what `rebuild_index` builds from scratch; every tenth edit both also equal the
/// brute-force index from `pos_to_world`.
#[test]
fn index_rebuild_equals_incremental() {
    let mut rng = SimRng::new(43);
    let mut t = Transport::new(256, 256);
    let mut lines: Vec<LineId> = Vec::new();
    for _ in 0..6 {
        lines.push(t.create(4 * 256, 8).unwrap());
    }
    let coord = |rng: &mut SimRng| rng.below(96 * 256) as i32 - 48 * 256;
    let geometry = |rng: &mut SimRng, len: u32| -> Vec<Segment> {
        // One to three segments summing to `len`.
        let n = 1 + rng.below(3).min(len - 1);
        let mut left = len;
        let mut segs = Vec::new();
        for k in 0..n {
            let sl = if k + 1 == n {
                left
            } else {
                1 + rng.below(left - (n - k - 1))
            };
            left -= sl;
            let start = wp(coord(rng), coord(rng));
            segs.push(if rng.below(3) == 0 {
                arc(
                    sl,
                    start,
                    1 + rng.below(4 * 256),
                    rng.below(256) as u16,
                    rng.below(512) as i16 - 256 + if rng.below(2) == 0 { 0 } else { 1 },
                )
            } else {
                let d = rng.below(sl * 2) as i32 + 1;
                let to = match rng.below(4) {
                    0 => wp(start.x + d, start.y),
                    1 => wp(start.x, start.y - d),
                    2 => wp(start.x - d, start.y + d / 2),
                    _ => wp(start.x + d / 3, start.y + d),
                };
                straight(sl, start, to)
            });
        }
        segs
    };
    let mut counts = [0u32; 9];
    let mut incremental = Vec::new();
    let mut rebuilt = Vec::new();
    let mut peak = 0;
    for edit in 0..200 {
        let k = rng.below(lines.len() as u32) as usize;
        let l = lines[k];
        let len = t.len(l).unwrap();
        let op = rng.below(9);
        let r = match op {
            0..=2 => {
                let segs = geometry(&mut rng, len);
                t.set_segments(l, &segs).map(|_| ())
            }
            3 => t.split(l, 9 + rng.below(len)).map(|b| lines.push(b)),
            4 => {
                let f = lines[rng.below(lines.len() as u32) as usize];
                if f != l && t.out(f) != Ok(Output::Next(l)) {
                    t.set_out(l, Output::Next(f)).unwrap();
                    t.join(f, l).map(|_| {
                        lines.retain(|&x| x != l);
                    })
                } else {
                    Err(TransportError::Unsupported)
                }
            }
            5 => {
                let by = rng.below(512);
                if rng.below(2) == 0 {
                    t.extend_front(l, by)
                } else {
                    t.shrink_back(l, by)
                }
            }
            6 => t.rescale(l, 64 + rng.below(2048)),
            7 if lines.len() > 3 => t.destroy(l, &mut |_| {}).map(|_| {
                lines.retain(|&x| x != l);
            }),
            _ => t.create(256 * (1 + rng.below(6)), 8).map(|n| lines.push(n)),
        };
        if r.is_ok() {
            counts[op as usize] += 1;
        }
        t.tile_index_into(&mut incremental);
        t.rebuild_index();
        t.tile_index_into(&mut rebuilt);
        assert_eq!(incremental, rebuilt, "edit {edit}: op {op} ({r:?})");
        peak = peak.max(rebuilt.len());
        if edit % 10 == 9 {
            assert_eq!(rebuilt, brute_index(&t, &lines), "edit {edit}: brute force");
        }
    }
    // The script did what it says: geometry was set and every surgery ran.
    assert!(counts[0] + counts[1] + counts[2] >= 40, "{counts:?}");
    assert!(counts[3..=8].iter().all(|&c| c >= 3), "{counts:?}");
    assert!(peak > 60, "the index never held more than {peak} entries");
    // Past `MAX_LINE_TILES` a path is refused (`Full`), nothing written.
    let long = t.create(MAX_LINE_TILES * 256 + 256, 8).unwrap();
    let too_far = MAX_LINE_TILES as i32 * T + T;
    assert_eq!(
        t.set_segments(
            long,
            &[straight(
                MAX_LINE_TILES * 256 + 256,
                wp(0, 0),
                wp(too_far, 0)
            )]
        ),
        Err(TransportError::Full)
    );
    t.tile_index_into(&mut incremental);
    assert_eq!(incremental, rebuilt);
}

/// M43 review (finding 3): a path past `MAX_LINE_TILES` is refused after walking at most that
/// many tiles, not the whole path. A straight segment `MAX_LEN` positions long across about 8.4
/// million tiles is refused `Full`, and the tile walk made at most 34 point evaluations per tile
/// up to the cap (one per binary-search step over a 2^31 segment, plus the first and the last):
/// read from `walk_evals`, a counter, not a timer.
#[test]
fn geometry_refused_path_walks_at_most_the_cap() {
    let mut t = Transport::new(4, 64);
    let l = t.create(MAX_LEN, 8).unwrap();
    let before = walk_evals();
    let far = 1i32 << 30;
    assert_eq!(
        t.set_segments(l, &[straight(MAX_LEN, wp(-far, 0), wp(far, 0))]),
        Err(TransportError::Full)
    );
    let evals = walk_evals() - before;
    assert!(
        evals <= 34 * u64::from(MAX_LINE_TILES + 2),
        "{evals} point evaluations for a refused path"
    );
    assert_eq!(t.segments(l, &mut |_| panic!("nothing registered")), Ok(()));
}

/// The cost of geometry upkeep at the recommended caps (M43 review, finding 2; a measurement, not
/// a gate, slow tier): the tile index filled to about 262k entries (32,767 lines of 8 tiles), then
/// one line's `extend_back` (which clears its geometry: a `retain` over the index) and
/// `set_segments` (the in-place merge), 20 times; prints the median. Run in release:
/// `cargo test --release -p engine --features testing --test main slow_geometry_upkeep_cost --
/// --nocapture`.
#[test]
fn slow_geometry_upkeep_cost() {
    let lines = engine::transport::DEFAULT_MAX_LINES;
    let mut t = Transport::new(lines, 0);
    let mut ids = Vec::new();
    for k in 0..lines - 1 {
        let l = t.create(8 * 256, 8).unwrap();
        // Rows of increasing `y`: each line's entries sort last, so filling is O(entries).
        let y = k as i32 * T;
        t.set_segments(l, &[straight(8 * 256, wp(0, y), wp(8 * T, y))])
            .unwrap();
        ids.push(l);
    }
    let mut index = Vec::new();
    t.tile_index_into(&mut index);
    assert!(index.len() > 262_000, "{} entries", index.len());
    let mid = ids[ids.len() / 2];
    let y = (ids.len() / 2) as i32 * T;
    let mut times = Vec::new();
    for _ in 0..20 {
        // Timed: the extension of one line and its re-registration (one belt tile, one lane).
        // A measurement printed for a human; it never reaches any state or assertion.
        #[allow(clippy::disallowed_types)]
        let start = std::time::Instant::now();
        t.extend_back(mid, 256).unwrap();
        t.set_segments(mid, &[straight(9 * 256, wp(0, y), wp(9 * T, y))])
            .unwrap();
        times.push(start.elapsed());
        t.shrink_back(mid, 256).unwrap();
        t.set_segments(mid, &[straight(8 * 256, wp(0, y), wp(8 * T, y))])
            .unwrap();
    }
    times.sort();
    println!(
        "geometry upkeep at {} index entries: extend_back + set_segments median {:?} (min {:?}, max {:?})",
        index.len(),
        times[10],
        times[0],
        times[19]
    );
}
