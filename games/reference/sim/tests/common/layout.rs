//! Text-map layouts for belt scenarios (M56): one two-character token per tile, tokens separated by
//! single spaces, rows top to bottom. The world's convention (`content.rs`/`lib.rs` `Dir`, the
//! topology's `step`): `x` grows east, `y` grows south, so the first row is the northmost and a
//! `North` belt moves items towards the row above it.
//!
//! Tokens: `..` empty; the first character the kind (`b` belt, `s` spawner, `d` despawner, `S` a
//! splitter's anchor, `u` underground entrance, `x` underground exit), the second its facing (`^`
//! north, `>` east, `v` south, `<` west); `--` a splitter's other tile (east of a north/south
//! splitter's anchor, south of an east/west one: the footprint's min corner is the anchor,
//! `content::belt_footprint`). [`Layout::parse`] gives the placements in row-major order (one per
//! entity, `--` none), and [`Layout::hash`] is FNV-1a 64 over them, each `x i32 | y i32 | dir u8 |
//! kind u8` little-endian (`dir` and `kind` the `Dir`/`BeltKind` variant indexes), the same bytes
//! `tests/helpers/layout.ts` hashes: the two parsers are pinned to the same hash per layout
//! (`LAYOUT_HASHES`, here and in the `unit` test), so they cannot drift. The layouts themselves are
//! the `const`s below, mirrored as text in `layout.ts` (a change moves both pins in one commit).
//!
//! [`RefScenario::lay`] places a layout at an origin in one tick (`dispatch_batch`, every placement
//! must apply), then configures its spawners, both lanes at saturation, in a second tick.

use engine::game::PlayerId;
use engine::world::TilePos;
use reference_sim::{BeltKind, Dir, RefAction, TileXY};

use super::RefScenario;

/// `content::SPAWN_RATES`' saturation rate (7.5 items a second per lane).
pub const SATURATE: u8 = 3;

/// The 4x4 balancer (M56; the survey's map): flow north, four spawners on the bottom row, splitters
/// `a` (anchor (0, 5)) and `b` (2, 5), the crossing (stage 2 pairs a's right output with b's left
/// and b's right with a's left): a's left output curves east at (0, 3) into an east entrance at
/// (1, 3) paired with the exit at (4, 3) (gap 2, under b's two outputs on the surface) and curves
/// north at (5, 3) into splitter `d`'s right half; a's right output goes under the east entrance by
/// a north pair (1, 4) -> (1, 2) (gap 1: the perpendicular entrance between is transparent) into
/// splitter `c`'s left half; b's left output runs north into c's right half and b's right output
/// curves east at (3, 2) and north at (4, 2) into d's left half; four despawners on the top row.
pub const BALANCER: &str = "\
.. d^ d^ .. d^ d^
.. S^ -- .. S^ --
.. x^ b^ b> b^ b^
b> u> b^ b^ x> b^
b^ u^ b^ b^ .. ..
S^ -- S^ -- .. ..
s^ s^ s^ s^ .. ..";

/// [`BALANCER`] with the despawner over d's right half (column 5) a plain belt: that output fills
/// and blocks (question 11 on four inputs).
pub const BALANCER_BLOCKED: &str = "\
.. d^ d^ .. d^ b^
.. S^ -- .. S^ --
.. x^ b^ b> b^ b^
b> u> b^ b^ x> b^
b^ u^ b^ b^ .. ..
S^ -- S^ -- .. ..
s^ s^ s^ s^ .. ..";

/// A plain ring (M56): a 7 x 5 loop of belts running clockwise (east along the top row), every
/// corner a curve turning right (lane 1, the right, is the inner 106 lane), no spawner: items come
/// from the test hook. Per lane a `Next` cycle of eight lines: four runs (5, 3, 5 and 3 tiles) and
/// four curves.
pub const RING: &str = "\
b> b> b> b> b> b> bv
b^ .. .. .. .. .. bv
b^ .. .. .. .. .. bv
b^ .. .. .. .. .. bv
b^ b< b< b< b< b< b<";

/// [`RING`] one row lower, fed: a spawner north of the top run (4, 0) side-loads its outer lane
/// (lane 0, the north lane of an east belt) and one inside the ring (3, 4) side-loads the bottom
/// run's inner lane (lane 1, the north lane of a west belt).
pub const RING_FED: &str = "\
.. .. .. .. sv .. ..
b> b> b> b> b> b> bv
b^ .. .. .. .. .. bv
b^ .. .. .. .. .. bv
b^ .. .. sv .. .. bv
b^ b< b< b< b< b< b<";

/// [`RING_FED`] through a splitter (0079 §11): an east splitter anchored at (2, 1) (its left half
/// on the ring's top run, its right half (2, 2) inside) whose right output feeds a one-tile dead end
/// at (3, 2), which fills; every lap then passes the splitter's input `Fork`.
pub const RING_SPLITTER: &str = "\
.. .. .. .. sv .. ..
b> b> S> b> b> b> bv
b^ .. -- b> .. .. bv
b^ .. .. .. .. .. bv
b^ .. .. sv .. .. bv
b^ b< b< b< b< b< b<";

/// A side-load chain (M56, 0079 §16): eight feeders, each a spawner one tile from the main line,
/// side-loading onto a 24-tile east main line ending in a despawner.
pub const SIDELOAD_CHAIN: &str = "\
.. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv ..
s> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> d>";

/// One placement: a tile relative to the layout's top-left, a facing and a kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub dir: Dir,
    pub kind: BeltKind,
}

/// A parsed layout: its placements in row-major order and its size in tiles.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Layout {
    pub placements: Vec<Placement>,
    pub width: i32,
    pub height: i32,
}

const fn dir_index(d: Dir) -> u8 {
    match d {
        Dir::East => 0,
        Dir::South => 1,
        Dir::West => 2,
        Dir::North => 3,
    }
}

const fn kind_index(k: BeltKind) -> u8 {
    match k {
        BeltKind::Belt => 0,
        BeltKind::Spawner => 1,
        BeltKind::Despawner => 2,
        BeltKind::Splitter => 3,
        BeltKind::UndergroundIn => 4,
        BeltKind::UndergroundOut => 5,
    }
}

impl Layout {
    /// Parses `text` (module doc). Panics on empty text, an unknown token, a ragged row, or a `--`
    /// that is not exactly a splitter's other tile (and a splitter without its `--`).
    pub fn parse(text: &str) -> Layout {
        let mut placements = Vec::new();
        let mut others = Vec::new();
        let mut width = None;
        // One trailing newline and `\r\n` endings are accepted (`lines`), empty text is not: the
        // same rule as `layout.ts`'s `parseLayout`.
        let rows: Vec<&str> = text.lines().collect();
        assert!(!rows.is_empty(), "an empty layout");
        for (y, row) in rows.iter().enumerate() {
            let tokens: Vec<&str> = row.split(' ').collect();
            match width {
                None => width = Some(tokens.len()),
                Some(w) => assert_eq!(w, tokens.len(), "row {y}: {row:?} is ragged"),
            }
            for (x, t) in tokens.iter().enumerate() {
                let (x, y) = (x as i32, y as i32);
                let b = t.as_bytes();
                assert_eq!(b.len(), 2, "({x}, {y}): token {t:?}");
                if *t == ".." {
                    continue;
                }
                if *t == "--" {
                    others.push((x, y));
                    continue;
                }
                let kind = match b[0] {
                    b'b' => BeltKind::Belt,
                    b's' => BeltKind::Spawner,
                    b'd' => BeltKind::Despawner,
                    b'S' => BeltKind::Splitter,
                    b'u' => BeltKind::UndergroundIn,
                    b'x' => BeltKind::UndergroundOut,
                    _ => panic!("({x}, {y}): unknown kind in {t:?}"),
                };
                let dir = match b[1] {
                    b'^' => Dir::North,
                    b'>' => Dir::East,
                    b'v' => Dir::South,
                    b'<' => Dir::West,
                    _ => panic!("({x}, {y}): unknown facing in {t:?}"),
                };
                placements.push(Placement { x, y, dir, kind });
            }
        }
        let mut want: Vec<(i32, i32)> = placements
            .iter()
            .filter(|p| p.kind == BeltKind::Splitter)
            .map(|p| match p.dir {
                Dir::North | Dir::South => (p.x + 1, p.y),
                Dir::East | Dir::West => (p.x, p.y + 1),
            })
            .collect();
        want.sort_by_key(|&(x, y)| (y, x));
        assert_eq!(
            others, want,
            "`--` tiles are exactly the splitters' other tiles"
        );
        Layout {
            placements,
            width: width.unwrap_or(0) as i32,
            height: rows.len() as i32,
        }
    }

    /// FNV-1a 64 over the placements (module doc), what `layout.ts`'s `layoutHash` computes.
    pub fn hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |b: u8| {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        };
        for p in &self.placements {
            for b in p.x.to_le_bytes().into_iter().chain(p.y.to_le_bytes()) {
                eat(b);
            }
            eat(dir_index(p.dir));
            eat(kind_index(p.kind));
        }
        h
    }

    /// The tiles of `kind`'s placements at `origin`, in row-major order.
    pub fn tiles_of(&self, origin: TilePos, kind: BeltKind) -> Vec<TilePos> {
        self.placements
            .iter()
            .filter(|p| p.kind == kind)
            .map(|p| TilePos::new(origin.x + p.x, origin.y + p.y))
            .collect()
    }
}

impl RefScenario {
    /// Places `layout` with its top-left at `origin` in one tick (`dispatch_batch`; every placement
    /// must apply), then, in the next tick, configures spawner `i` (row-major) to make `feed[i]` on
    /// both lanes at saturation (`feed` holds one item per spawner). Returns the spawners' tiles.
    pub fn lay(
        &mut self,
        who: PlayerId,
        layout: &Layout,
        origin: TilePos,
        feed: &[u8],
    ) -> Vec<TilePos> {
        let actions: Vec<RefAction> = layout
            .placements
            .iter()
            .map(|p| RefAction::PlaceBelt {
                at: TileXY {
                    x: origin.x + p.x,
                    y: origin.y + p.y,
                },
                dir: p.dir,
                kind: p.kind,
            })
            .collect();
        for (p, r) in layout
            .placements
            .iter()
            .zip(self.dispatch_batch(who, &actions))
        {
            r.unwrap_or_else(|e| panic!("lay {p:?} at {origin:?}: {e:?}"));
        }
        let spawners = layout.tiles_of(origin, BeltKind::Spawner);
        assert_eq!(spawners.len(), feed.len(), "one item per spawner");
        let config: Vec<RefAction> = spawners
            .iter()
            .zip(feed)
            .flat_map(|(&at, &item)| {
                (0..2).map(move |lane| RefAction::SetSpawner {
                    at: TileXY::from_tile(at),
                    lane,
                    item,
                    rate: SATURATE,
                })
            })
            .collect();
        if !config.is_empty() {
            for r in self.dispatch_batch(who, &config) {
                r.expect("configure a spawner");
            }
        }
        spawners
    }
}
