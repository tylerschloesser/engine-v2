//! Belt scenarios (M56): reference layouts built from text maps (`common/layout.rs`), run on the
//! host and measured with the item ledger (`common/census.rs`): a 4x4 balancer (splitters, belts and
//! one underground crossing), the same balancer with one output blocked (question 11 on four
//! inputs), edits during its flow, a ring fed until full, a ring through a splitter (0079 §11's
//! spread), a side-load chain (0079 §16's blocked side-loads) and its `slow_` timing. Every
//! scenario asserts conservation exactly (made = live + sunk + destroyed); items come from spawners,
//! so these run in the fast suite, except `hooks::ring_lap_time` (the test hook's inserts, the
//! `test-hooks` leg). `LAYOUT_HASHES` pins each layout's placements with `layout.ts`'s parser.

mod common;

use common::RefScenario;
use common::census::{Bed, ring, ring_coords, short_gaps};
use common::layout::{
    BALANCER, BALANCER_BLOCKED, Layout, RING, RING_FED, RING_SPLITTER, SIDELOAD_CHAIN,
};
use engine::game::PlayerId;
use engine::transport::{LineId, Output};
use engine::world::TilePos;
use reference_sim::content::ItemId;
use reference_sim::rules::belts::topology::{hidden_lanes, lanes_at, splitter_lanes};
use reference_sim::{BeltKind, Dir};

const P1: PlayerId = PlayerId(1);
/// Every layout's top-left (inside `world()`'s cleared area).
const O: TilePos = TilePos::new(50, 50);

/// The engine's item for each `ItemId` (`ItemId as u16 + 1`).
const STONE: u16 = ItemId::Stone as u16 + 1;
const IRON: u16 = ItemId::Iron as u16 + 1;
const WOOD: u16 = ItemId::Wood as u16 + 1;
const COAL: u16 = ItemId::Coal as u16 + 1;
/// The balancer's four spawners, west to east: iron, coal (into splitter `a`), wood, stone (`b`).
const FEED: [u8; 4] = [
    ItemId::Iron as u8,
    ItemId::Coal as u8,
    ItemId::Wood as u8,
    ItemId::Stone as u8,
];

/// Each layout's FNV-1a 64 over its placements (`Layout::hash`), the same table as
/// `tests/unit/layout.test.ts`'s `LAYOUT_HASHES`: a change to a layout or to either parser moves
/// both pins in one commit.
const LAYOUT_HASHES: [(&str, &str, usize, u64); 6] = [
    ("balancer", BALANCER, 27, 0x1296_36a9_3550_5c45),
    (
        "balancer-blocked",
        BALANCER_BLOCKED,
        27,
        0x028d_5510_6c9b_a967,
    ),
    ("ring", RING, 20, 0x0b03_a1f0_4b1a_fa2f),
    ("ring-fed", RING_FED, 22, 0x9306_dc06_600e_c9d0),
    ("ring-splitter", RING_SPLITTER, 23, 0x645b_e270_10f5_50c8),
    ("sideload-chain", SIDELOAD_CHAIN, 33, 0xeeab_0d8d_66c4_8a95),
];

fn world() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 40, 20);
    s
}

fn at(x: i32, y: i32) -> TilePos {
    TilePos::new(O.x + x, O.y + y)
}

fn lanes(b: &Bed, t: TilePos) -> [LineId; 2] {
    lanes_at(b.tr(), t)
        .unwrap_or_else(|| panic!("{t:?} is mapped"))
        .lane
}

fn sunk(b: &Bed, t: TilePos) -> [u64; 2] {
    let l = lanes(b, t);
    [b.tr().sunk(l[0]).unwrap(), b.tr().sunk(l[1]).unwrap()]
}

fn count(b: &Bed, l: LineId) -> u32 {
    b.tr().count(l).expect("line")
}

fn positions(b: &Bed, l: LineId) -> Vec<u32> {
    let mut v = Vec::new();
    b.tr().items_in(l, &mut |_, p| v.push(p)).expect("line");
    v
}

/// A bed with `text` laid at [`O`] and its spawners fed `feed`.
fn bed(text: &str, feed: &[u8]) -> (Bed, Layout) {
    let l = Layout::parse(text);
    let mut s = world();
    s.lay(P1, &l, O, feed);
    s.assert_topology();
    (Bed::new(s), l)
}

/// Each despawner's two lanes tracked by kind, despawners in row-major order.
fn track_outputs(b: &mut Bed, l: &Layout) -> Vec<TilePos> {
    let outs = l.tiles_of(O, BeltKind::Despawner);
    for &d in &outs {
        b.track_sink(d, 0);
        b.track_sink(d, 1);
    }
    outs
}

/// Output `k`'s sinks by kind, both lanes together: `[stone, iron, wood, coal]`.
fn kinds(b: &Bed, k: usize) -> [u64; 4] {
    let both = |item| b.sinks[2 * k].kind(item) + b.sinks[2 * k + 1].kind(item);
    [both(STONE), both(IRON), both(WOOD), both(COAL)]
}

/// The two parsers agree on every layout (the Rust half of `LAYOUT_HASHES`; the `unit` test
/// `layout_hashes_match_rust` is the other): placements per layout and the hash, pinned. Fails if a
/// layout, the token grammar, the row-major order or the hash's encoding changes.
#[test]
fn layout_hashes_pinned() {
    let got: Vec<(&str, usize, u64)> = LAYOUT_HASHES
        .iter()
        .map(|&(name, text, _, _)| {
            let l = Layout::parse(text);
            (name, l.placements.len(), l.hash())
        })
        .collect();
    let want: Vec<(&str, usize, u64)> = LAYOUT_HASHES
        .iter()
        .map(|&(name, _, n, h)| (name, n, h))
        .collect();
    assert_eq!(got, want, "placements and hash per layout");
}

/// The 4x4 balancer ([`BALANCER`]) with four saturated spawners (iron, coal, wood, stone; both lanes)
/// and four despawners, 1,000 ticks, conservation exact after every tick. Every input runs at its
/// full rate (2,998 made: 8 lanes x 0.3748 a tick) and every output lane sinks at the same rate once
/// flowing: 187 or 188 a lane in the steady window 500-1,000 (500 x 0.3748 = 187.4). The totals
/// differ by the trip only: c's outputs (x 1, 2) are fed by the short paths (first sink at tick 75),
/// d's (x 4, 5) through the crossing's curves and the east underground (first sinks at 81 and 84),
/// so after 1,000 ticks they have sunk 347, 347, 337 and 336 a lane, the difference held in transit.
/// By kind the outputs are not mixed evenly (the forks alternate only while both sides have room):
/// pinned. With all eight input lanes saturated, any one-to-one wiring would sink the same 187-188
/// a lane: [`balancer_4x4_spreads_one_input`] and [`balancer_4x4_sub_saturation`] show the
/// balancing. The line ids by role are pinned too (the netcode cells' constants). Fails if a link of
/// the layout is lost (an input or output at a lower rate), the fork or side order changes, the id
/// allocation changes, or an item is lost or made.
#[test]
fn balancer_4x4_balances() {
    let (mut b, l) = bed(BALANCER, &FEED);
    // The line ids of the one-tick build by role, the same constants as the netcode cells'
    // `OUTPUTS`, `EXITS` and `HIDDEN` (`belt-scenarios.test.ts`): an id-allocation change moves
    // both pins in one commit.
    let ids = |v: Vec<LineId>| -> Vec<u32> {
        let mut v: Vec<u32> = v.into_iter().map(|l| l.0).collect();
        v.sort_unstable();
        v
    };
    let outputs = ids(l
        .tiles_of(O, BeltKind::Splitter)
        .into_iter()
        .flat_map(|t| [t, TilePos::new(t.x + 1, t.y)])
        .flat_map(|h| splitter_lanes(b.tr(), h).expect("a half").output)
        .collect());
    let exits = ids(l
        .tiles_of(O, BeltKind::UndergroundOut)
        .into_iter()
        .flat_map(|t| lanes(&b, t))
        .collect());
    let hidden = ids(l
        .tiles_of(O, BeltKind::UndergroundIn)
        .into_iter()
        .flat_map(|t| hidden_lanes(b.tr(), t).expect("paired"))
        .collect());
    assert_eq!(
        (b.tr().lines_len(), outputs, exits, hidden),
        (
            76,
            vec![7, 8, 11, 12, 19, 20, 23, 24, 55, 56, 59, 60, 63, 64, 67, 68],
            vec![25, 26, 39, 40],
            vec![41, 42, 51, 52]
        ),
        "lines, and the ids of the splitter outputs, exits and hidden lines"
    );
    let outs = track_outputs(&mut b, &l);
    let mut first = [0u32; 4];
    let mut mid = Vec::new();
    for t in 1..=1_000 {
        b.step(1);
        b.check();
        for (k, &d) in outs.iter().enumerate() {
            if first[k] == 0 && sunk(&b, d) != [0, 0] {
                first[k] = t;
            }
        }
        if t == 500 {
            mid = outs.iter().map(|&d| sunk(&b, d)).collect();
        }
    }
    let end: Vec<[u64; 2]> = outs.iter().map(|&d| sunk(&b, d)).collect();
    let window: Vec<[u64; 2]> = end
        .iter()
        .zip(&mid)
        .map(|(e, m)| [e[0] - m[0], e[1] - m[1]])
        .collect();
    assert_eq!(first, [75, 75, 81, 84], "the tick each output first sinks");
    assert_eq!(
        end,
        [[347, 347], [347, 347], [337, 337], [336, 336]],
        "sunk per output and lane after 1,000 ticks"
    );
    assert_eq!(
        window,
        [[187, 187], [187, 187], [188, 188], [187, 187]],
        "sunk per output and lane, ticks 500-1,000"
    );
    // [stone, iron, wood, coal] per output, both lanes.
    let k: Vec<[u64; 4]> = (0..4).map(|k| kinds(&b, k)).collect();
    assert_eq!(
        k,
        [
            [346, 312, 0, 36],
            [0, 346, 348, 0],
            [344, 2, 328, 0],
            [2, 34, 16, 620]
        ],
        "sunk by kind per output"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 2_998,
            live: 264,
            sunk: 2_734,
            destroyed: 0
        }
    );
    b.s.assert_topology();
}

/// Question 11 on four inputs ([`BALANCER_BLOCKED`]: d's right output, column 5, ends in a plain
/// belt that fills): the three open outputs carry 3 x 2 lanes at saturation and the four saturated
/// inputs share them by item kind (an input is a kind), counted at the despawners by the FIFO diff
/// over the window 500-1,000 (steady from tick 250: the blocked belt and d's right output line full
/// since then, the last coal sunk before it). Iron, wood and stone take a third each (374, 374, 376
/// of 1,124) and coal **none**: d's right output blocked, d's two inputs share its left output and
/// the left one (b1, from b's right output) wins every slot (M54's starvation), so a0 (a's left
/// output) backs up; then a's two inputs share a's right output and again the left one (iron) wins,
/// so coal (a's right input) starves through two splitters. Pinned exactly, restated to Tyler
/// (question 11). Fails if the forks' side order or the input fairness changes, or a link is lost.
#[test]
fn balancer_4x4_one_output_blocked() {
    let (mut b, l) = bed(BALANCER_BLOCKED, &FEED);
    track_outputs(&mut b, &l);
    let open = |b: &Bed| -> Vec<[u64; 4]> { (0..3).map(|k| kinds(b, k)).collect() };
    b.step_checked(250);
    let at_250 = open(&b);
    let blocked = lanes(&b, at(5, 0));
    let half = splitter_lanes(b.tr(), at(5, 1)).expect("d's right half");
    let full = |b: &Bed| {
        (
            [count(b, blocked[0]), count(b, blocked[1])],
            [count(b, half.output[0]), count(b, half.output[1])],
        )
    };
    assert_eq!(full(&b), ([4, 4], [2, 2]), "the blocked output full at 250");
    b.step_checked(250);
    let at_500 = open(&b);
    b.step_checked(500);
    let at_1000 = open(&b);
    assert_eq!(full(&b), ([4, 4], [2, 2]), "and at 1,000");
    // [stone, iron, wood, coal] per open output (c left, c right, d left), both lanes.
    let window: Vec<[u64; 4]> = at_1000
        .iter()
        .zip(&at_500)
        .map(|(e, m)| [0, 1, 2, 3].map(|i| e[i] - m[i]))
        .collect();
    assert_eq!(
        window,
        [[186, 188, 0, 0], [0, 186, 188, 0], [188, 0, 188, 0]],
        "sunk by kind per open output, ticks 500-1,000"
    );
    let share = [0, 1, 2, 3].map(|i| window.iter().map(|w| w[i]).sum::<u64>());
    assert_eq!(
        share,
        [374, 374, 376, 0],
        "each input's share (stone, iron, wood, coal) of 1,124"
    );
    assert_eq!(
        (at_250[0][3], at_1000[0][3]),
        (36, 36),
        "coal's last sink before tick 250"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 2_332,
            live: 266,
            sunk: 2_066,
            destroyed: 0
        }
    );
    b.s.assert_topology();
}

/// The balancer's edits (for [`edit_during_flow`] and its twin): after 500 ticks of flow, splitter
/// c picked up and re-placed 50 ticks later, the east entrance turned four times (south, west,
/// north, east again: unpaired, its hidden lines destroyed, then paired again) and the belt at
/// (2, 3) turned four times, 20 ticks apart, then 200 ticks. `assert_topology` and conservation
/// after every tick; returns the destroyed count after each edit.
fn run_edits(b: &mut Bed) -> Vec<u64> {
    let mut destroyed = Vec::new();
    let mut edit =
        |b: &mut Bed, f: &dyn Fn(&mut RefScenario) -> Result<(), reference_sim::RefReject>| {
            b.act(|s| f(s)).expect("the edit applies");
            b.s.assert_topology();
            destroyed.push(b.check().destroyed);
        };
    b.step_checked(500);
    let c = at(1, 1);
    edit(b, &|s| s.pick_up_belt(P1, c));
    b.step_checked(50);
    edit(b, &|s| s.place_belt(P1, c, Dir::North, BeltKind::Splitter));
    b.step_checked(100);
    for _ in 0..4 {
        edit(b, &|s| s.rotate_belt(P1, at(1, 3)));
        b.step_checked(20);
    }
    for _ in 0..4 {
        edit(b, &|s| s.rotate_belt(P1, at(2, 3)));
        b.step_checked(20);
    }
    b.step_checked(200);
    destroyed
}

/// Edits during flow on the balancer ([`run_edits`]): every edit keeps the topology canonical
/// (`assert_topology` after each) and conservation exact after every tick with the destroyed items
/// counted: 16 on splitter c's eight lines, the entrance's turns 44, 1, 16 and 5 (its own items and
/// its hidden lines' when the pair breaks), the belt's none (M59: its four turns keep the 8, 9, 9 and
/// 10 items on its two lanes; before M59 they destroyed 8, 7, 0 and 7). Those 22 items no longer
/// destroyed move the ledger at tick 1,023 from made 2,880 / sunk 2,513 / destroyed 104 to 2,868 /
/// 2,523 / 82 (live 263 either way): 10 more sunk on the two outputs the belt feeds (303 + 302 and
/// 304 + 303 become 306 + 305 twice) and 12 fewer made (the kept items hold the feed back where the
/// destroyed ones left room). The layout is whole again at
/// the end (tick 1,023) and its outputs sink again. The host's hash is the same across
/// `save_and_load` and the restored ledger still balances (the lines, `sunk` and hidden lines come
/// back), and the snapshot restored as a host restores it (with the world's caps, through
/// `engine::testing::replay`: `RefScenario::replay_restored`) runs 200 more ticks to the same hash as
/// the uninterrupted world, whose ledger still balances then. Fails if an edit destroys items
/// uncounted (conservation), leaves a stale line, or a restore loses a schedule's credit, a toggle,
/// a hidden line or an item.
#[test]
fn edit_during_flow() {
    let (mut b, l) = bed(BALANCER, &FEED);
    let destroyed = run_edits(&mut b);
    assert_eq!(
        destroyed,
        [16, 16, 60, 61, 77, 82, 82, 82, 82, 82],
        "destroyed after each edit"
    );
    let outs = l.tiles_of(O, BeltKind::Despawner);
    let end: Vec<[u64; 2]> = outs.iter().map(|&d| sunk(&b, d)).collect();
    assert_eq!(
        end,
        [[306, 305], [306, 305], [325, 326], [325, 325]],
        "sunk per output at tick 1,023"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 2_868,
            live: 263,
            sunk: 2_523,
            destroyed: 82
        }
    );
    let restored = b.s.replay_restored(200);
    b.step_checked(200);
    assert_eq!(
        restored,
        b.s.hash(),
        "200 ticks on: the restored world and the uninterrupted one"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 3_468,
            live: 263,
            sunk: 3_123,
            destroyed: 82
        },
        "the uninterrupted ledger at tick 1,223"
    );
    let h = b.s.hash();
    b.save_and_load();
    assert_eq!(b.s.hash(), h, "the hash across save_and_load");
    b.check();
}

/// Each lane's ring (`ring`) from the lines `start` (a ring tile's two lanes).
fn ring_lanes(b: &Bed, start: [LineId; 2]) -> [Vec<LineId>; 2] {
    start.map(|l| ring(b.tr(), l).expect("a ring"))
}

/// Steps one tick and returns, per lane, how many items moved exactly 24 along the ring and how
/// many did not.
fn step_ring(b: &mut Bed, rings: &[Vec<LineId>; 2]) -> [(u32, u32); 2] {
    let before = rings.clone().map(|r| ring_coords(b.tr(), &r));
    b.step(1);
    b.check();
    let mut out = [(0, 0); 2];
    for k in 0..2 {
        let (prev, total) = &before[k];
        let (now, _) = ring_coords(b.tr(), &rings[k]);
        for &(c, _) in &now {
            let from = (c + 24) % total;
            if prev.iter().any(|&(p, _)| p == from) {
                out[k].0 += 1;
            } else {
                out[k].1 += 1;
            }
        }
    }
    out
}

/// Steps `n` ticks on the ring and sums [`step_ring`]'s counts per lane.
fn ring_moves(b: &mut Bed, rings: &[Vec<LineId>; 2], n: u32) -> [(u32, u32); 2] {
    let mut moved = [(0, 0); 2];
    for _ in 0..n {
        let m = step_ring(b, rings);
        for k in 0..2 {
            moved[k].0 += m[k].0;
            moved[k].1 += m[k].1;
        }
    }
    moved
}

/// The fed ring ([`RING_FED`]): two saturated spawners side-load the ring's outer lane (from the
/// north) and its inner lane (from inside) until it is full: after 1,000 ticks the outer lane (8
/// lines, 5,276 positions) holds 82 items and the inner (4,520) 70, the feeders hold 4 a lane and
/// make nothing more (168 made, constant over the next 200 ticks: they are blocked). The full ring
/// is not still: it rotates rigidly at belt speed (0079 §11's cut rule), every item moving exactly
/// 24 along the ring every tick (82 x 200 and 70 x 200 moves, none other). Then the edits: the top
/// run's first tile turned south (the ring cut; M59: its 8 items kept, 4 a lane, where they were
/// destroyed before), picked up 20 ticks later (the 9 then on it destroyed, 5 and 4; 7 before M59,
/// 15 in all) and re-placed facing east 20 ticks after that; the feeders refill the ring (9 more
/// made, 15 before M59) to the same 82 and 70, rotating again. Conservation after every tick with the destroys,
/// `assert_topology` after each edit, no pair closer than `SPACING` on the ring's lines or across
/// their hand-offs in any of the 1,000 ticks after the re-placement (the overfull fallback never
/// squashes a pair) and no cut fallback. Fails if a full ring holds or slips, a feeder overfills
/// it, or an edit destroys items uncounted.
#[test]
fn ring_saturated_holds() {
    let (mut b, l) = bed(RING_FED, &[ItemId::Iron as u8, ItemId::Coal as u8]);
    let top = at(1, 1);
    let rings = ring_lanes(&b, lanes(&b, top));
    assert_eq!(rings.clone().map(|r| r.len()), [8, 8], "lines per lane");
    b.step_checked(1_000);
    let full = |b: &Bed, rings: &[Vec<LineId>; 2]| {
        rings.clone().map(|r| {
            let (v, total) = ring_coords(b.tr(), &r);
            (v.len(), total)
        })
    };
    let feeders = |b: &Bed| -> Vec<[u32; 2]> {
        l.tiles_of(O, BeltKind::Spawner)
            .iter()
            .map(|&t| {
                let f = lanes(b, t);
                [count(b, f[0]), count(b, f[1])]
            })
            .collect()
    };
    assert_eq!(
        full(&b, &rings),
        [(82, 5_276), (70, 4_520)],
        "items, length"
    );
    assert_eq!(feeders(&b), [[4, 4], [4, 4]], "the feeders hold");
    assert_eq!(b.check().made, 168);
    let moved = ring_moves(&mut b, &rings, 200);
    assert_eq!(moved, [(82 * 200, 0), (70 * 200, 0)], "every item moves 24");
    assert_eq!(b.check().made, 168, "the feeders made nothing more");
    let edit = at(1, 1);
    let mut destroyed = Vec::new();
    b.act(|s| s.rotate_belt(P1, edit)).expect("rotate");
    b.s.assert_topology();
    destroyed.push(b.check().destroyed);
    b.step_checked(20);
    b.act(|s| s.pick_up_belt(P1, edit)).expect("pick up");
    b.s.assert_topology();
    destroyed.push(b.check().destroyed);
    b.step_checked(20);
    b.act(|s| s.place_belt(P1, edit, Dir::East, BeltKind::Belt))
        .expect("place");
    b.s.assert_topology();
    destroyed.push(b.check().destroyed);
    assert_eq!(destroyed, [0, 9, 9], "destroyed after each edit");
    let rings = ring_lanes(&b, lanes(&b, top));
    let mut short = Vec::new();
    for _ in 0..1_000 {
        b.step(1);
        b.check();
        short.extend(short_gaps(b.tr(), &rings.concat()));
    }
    assert_eq!(short, [], "no squashed pair on the ring");
    assert_eq!(full(&b, &rings), [(82, 5_276), (70, 4_520)], "refilled");
    let moved = ring_moves(&mut b, &rings, 200);
    assert_eq!(moved, [(82 * 200, 0), (70 * 200, 0)], "rotating again");
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 177,
            live: 168,
            sunk: 0,
            destroyed: 9
        }
    );
    assert_eq!(b.s.transport_store().cut_fallbacks(), 0, "no cut fallback");
}

/// Items landing on the target of `ring`'s cut (the lowest `LineId` of the cycle advances first,
/// 0079 §11) over `n` ticks: an item at most `SPEED` behind the target's back after a tick landed
/// that tick (the target is downstream of the cut, so nothing waits there). Returns (cut, target,
/// landings).
fn cut_crossings(b: &mut Bed, ring: &[LineId], n: u32) -> (LineId, LineId, u32) {
    let cut = *ring.iter().min().expect("a ring");
    let k = ring.iter().position(|&l| l == cut).expect("on it");
    let target = ring[(k + 1) % ring.len()];
    let len = b.tr().len(target).expect("line");
    let mut landed = 0;
    for _ in 0..n {
        b.step(1);
        b.check();
        b.tr()
            .items_in(target, &mut |_, p| landed += u32::from(p + 24 >= len))
            .expect("line");
    }
    (cut, target, landed)
}

/// 0079 §11's known limitation, measured ([`RING_SPLITTER`]): the fed ring of
/// [`ring_saturated_holds`] with its top run through the left half of an east splitter, whose right
/// half's output fills a one-tile dead end (2 + 4 items a lane) and then takes nothing (each input
/// fork's toggle stays on the blocked side). Every lap now passes a `Fork`, so the cycle is not a
/// simple `Next` cycle: the cut line (the cycle's lowest id, 3 and 4) bounds its front against its
/// target's unmoved tail and a packed block spreads by `speed` there. Over the 1,000 ticks after
/// the first 1,000, 273 items a lane cross the cut (0.273 a tick: `speed / (SPACING + speed)` =
/// 24 / 88 = 0.2727), against the plain fed ring's 374 and 372 (its 82 and 70 items rotating at
/// belt speed: 0.373 and 0.372, a saturated lane's 0.375 less the ring's odd length); the ring
/// then holds 61 and 63 items, not 82 and 70. Recorded in 0079 §11 as measured; the dry pass over
/// fork and merge cycles is M56b's decision. Conservation after every tick in both. Fails if the
/// cut rule changes on either kind of cycle (the figure moves to 0.375, or the plain ring's drops).
#[test]
fn ring_with_splitter_spreads() {
    let feed = [ItemId::Iron as u8, ItemId::Coal as u8];
    let (mut plain, _) = bed(RING_FED, &feed);
    let rings = ring_lanes(&plain, lanes(&plain, at(1, 1)));
    plain.step_checked(1_000);
    let crossed = rings.clone().map(|r| cut_crossings(&mut plain, &r, 1_000));
    assert_eq!(
        crossed,
        [(LineId(3), LineId(11), 374), (LineId(4), LineId(12), 372)],
        "the plain ring: (cut, target, crossings in 1,000 ticks) per lane"
    );
    let (mut b, _) = bed(RING_SPLITTER, &feed);
    let rings = ring_lanes(&b, lanes(&b, at(1, 1)));
    assert_eq!(rings.clone().map(|r| r.len()), [11, 11], "lines per lane");
    b.step_checked(1_000);
    let made = b.check().made;
    let crossed = rings.clone().map(|r| cut_crossings(&mut b, &r, 1_000));
    assert_eq!(
        crossed,
        [(LineId(3), LineId(21), 273), (LineId(4), LineId(22), 273)],
        "through a splitter: (cut, target, crossings in 1,000 ticks) per lane"
    );
    assert_eq!(
        rings.clone().map(|r| ring_coords(b.tr(), &r).0.len()),
        [61, 63],
        "items on the ring"
    );
    let right = splitter_lanes(b.tr(), at(2, 2)).expect("the right half");
    let left = splitter_lanes(b.tr(), at(2, 1)).expect("the left half");
    let dead = lanes(&b, at(3, 2));
    assert_eq!(
        (
            [count(&b, right.output[0]), count(&b, right.output[1])],
            [count(&b, dead[0]), count(&b, dead[1])],
            [b.tr().toggle(left.input[0]), b.tr().toggle(left.input[1])],
        ),
        ([2, 2], [4, 4], [Ok(true), Ok(true)]),
        "the dead end full, the forks' toggles on its side"
    );
    assert_eq!((made, b.check().made), (152, 152), "the feeders blocked");
    assert_eq!(b.check().live, 152);
    assert_eq!(b.s.transport_store().cut_fallbacks(), 0);
}

/// The side-load chain bed after 1,000 ticks (conservation checked every tick): the eight feeders'
/// lanes (row-major, the top row) and the main line's lanes. The main spawner (row-major last)
/// makes iron, the feeders coal.
fn chain_bed() -> (Bed, Vec<[LineId; 2]>, [LineId; 2]) {
    let l = Layout::parse(SIDELOAD_CHAIN);
    let n = l.tiles_of(O, BeltKind::Spawner).len();
    let feed: Vec<u8> = (0..n)
        .map(|k| {
            if k == 8 {
                ItemId::Iron as u8
            } else {
                ItemId::Coal as u8
            }
        })
        .collect();
    let mut s = world();
    let spawners = s.lay(P1, &l, O, &feed);
    s.assert_topology();
    let mut b = Bed::new(s);
    b.step_checked(1_000);
    // Row-major: the eight feeders (row 0) first, the main line's spawner (row 1) last.
    let feeders: Vec<[LineId; 2]> = spawners[..8].iter().map(|&t| lanes(&b, t)).collect();
    let main = lanes(&b, at(1, 1));
    (b, feeders, main)
}

/// 0079 §16's case on a reference chain ([`SIDELOAD_CHAIN`]): a 24-tile east main line (the run of
/// 23 belts and the despawner, one line a lane, 6,144 positions, `Sink`) saturated by its own
/// spawner (iron, both lanes), and eight spawners (coal) side-loading its north lane (lane 0) from
/// one tile north, every third tile (each feeder's lanes `Merge` at +64 and +192 of its tile). While
/// the main line fills the feeders insert, then they block: after 1,000 ticks the main line has
/// sunk 357 (lane 0, the side-loaded items included) and 275 (lane 1, its spawner alone), holds 96
/// a lane (packed: 6,144 / 64), and over the next 200 ticks the feeders hold their four items a
/// lane at rest (0, 64, 128, 192: the front item waits at its merge) and make nothing (150 made, the
/// main spawner's 75 a lane, all sunk). Conservation after every tick. Fails if a feeder pushes
/// into a packed lane, the side-load lands on the wrong lane, or an item is lost.
#[test]
fn sideload_chain() {
    let (mut b, feeders, main) = chain_bed();
    let pos = |b: &Bed| -> Vec<[Vec<u32>; 2]> {
        feeders
            .iter()
            .map(|f| [positions(b, f[0]), positions(b, f[1])])
            .collect()
    };
    let sunk_main = |b: &Bed| [b.tr().sunk(main[0]).unwrap(), b.tr().sunk(main[1]).unwrap()];
    assert_eq!(b.tr().len(main[0]), Ok(6_144));
    assert_eq!(b.tr().out(main[0]), Ok(Output::Sink));
    let lands: Vec<[Output; 2]> = feeders
        .iter()
        .map(|f| [b.tr().out(f[0]).unwrap(), b.tr().out(f[1]).unwrap()])
        .collect();
    let want: Vec<[Output; 2]> = (0..8u32)
        .map(|k| {
            // Feeder k sits over tile x = 2 + 3k, (22 - 3k) tiles behind the line's front tile
            // (the despawner, x = 24).
            let off = (22 - 3 * k) * 256;
            [64, 192].map(|d| Output::Merge {
                line: main[0],
                at: off + d,
            })
        })
        .collect();
    assert_eq!(lands, want, "each feeder lands on the main line's lane 0");
    assert_eq!(sunk_main(&b), [357, 275], "sunk by tick 1,000");
    assert_eq!([count(&b, main[0]), count(&b, main[1])], [96, 96], "packed");
    let before = pos(&b);
    let rest = vec![0, 64, 128, 192];
    assert_eq!(
        before,
        vec![[rest.clone(), rest.clone()]; 8],
        "every feeder full at rest"
    );
    let c0 = b.check();
    b.step_checked(200);
    let c1 = b.check();
    assert_eq!(pos(&b), before, "no feeder item moved in 200 ticks");
    assert_eq!(
        (c1.made - c0.made, c1.live, sunk_main(&b)),
        (150, 264, [432, 350]),
        "made in the window, live, sunk by tick 1,200"
    );
}

/// The blocked side-loads' cost (0079 §16, for the per-merge cursor decision): the side-load chain
/// at tick 1,000 (eight merges blocked on a packed 96-item lane) timed over 200 whole host ticks
/// (`Sim::step`: the game's idle tick and `advance`), the median printed beside the same main line
/// without its feeders. A wall-clock figure (the workspace dev profile: opt-level 1, debug
/// assertions on): the assertion is a ceiling, the documented budget of 50 us a tick (measured 0.7
/// us, 0.2 us without the feeders, on the Mac, 2026-10-12; 0079 §16's trigger is a cost seen
/// against `tick.beltsLargeMs`), the one bound in this file.
#[test]
fn slow_sideload_chain_cost() {
    let time = |b: &mut Bed| {
        let mut times = Vec::new();
        for _ in 0..200 {
            // Timed for a human and the ceiling; never reaches state.
            #[allow(clippy::disallowed_types)]
            let start = std::time::Instant::now();
            b.s.step_ticks(1);
            times.push(start.elapsed());
        }
        times.sort_unstable();
        times[100].as_secs_f64() * 1e6
    };
    let (mut b, _, _) = chain_bed();
    let chain = time(&mut b);
    let bare = Layout::parse(SIDELOAD_CHAIN.lines().nth(1).expect("the main row"));
    let mut s = world();
    s.lay(P1, &bare, TilePos::new(O.x, O.y + 1), &[ItemId::Iron as u8]);
    let mut b = Bed::new(s);
    b.step(1_000);
    let alone = time(&mut b);
    println!(
        "side-load chain: tick median {chain:.1} us with 8 blocked side-loads, {alone:.1} us without"
    );
    assert!(chain < 50.0, "{chain:.1} us a tick, over the 50 us budget");
}

/// Scenarios that place items with the test hook (`RefAction::TestInsertItem`): built only with
/// the `test-hooks` feature, run by the `rust` suite's slow-tier `test-hooks` leg.
#[cfg(feature = "test-hooks")]
mod hooks {
    use super::*;
    use reference_sim::{RefAction, TileXY};

    /// The plain ring ([`RING`]): one item per lane by the test hook at the top run's second tile;
    /// every tick each item moves exactly 24 along its lane's `Next` cycle (eight lines: four runs
    /// and four curves, the outer lane 5,276 positions, the inner 4,520), and its laps take
    /// `floor` or `ceil` of the lane's length / 24 ticks (219 or 220 outer, 188 or 189 inner),
    /// pinned over four laps each (1,100 ticks). Conservation after every tick (two made, two live). Fails if a
    /// curve's length, a hand-off's landing or the cut rule moves an item by other than 24.
    #[test]
    fn ring_lap_time() {
        let (mut b, _) = bed(RING, &[]);
        let start = lanes(&b, at(1, 0));
        let rings = ring_lanes(&b, start);
        for (lane, item) in [(0u8, 1u16), (1, 2)] {
            b.act(|s| {
                s.dispatch(
                    P1,
                    RefAction::TestInsertItem {
                        at: TileXY::from_tile(at(2, 0)),
                        lane,
                        pos: 0,
                        item,
                    },
                )
            })
            .expect("the hook applies");
            b.inserted += 1;
        }
        assert_eq!(b.check().live, 2, "both items landed");
        let mut laps: [Vec<u32>; 2] = [Vec::new(), Vec::new()];
        let mut prev = rings.clone().map(|r| ring_coords(b.tr(), &r));
        let totals = prev.clone().map(|(_, t)| t);
        assert_eq!(totals, [5_276, 4_520], "lane lengths");
        for t in 1..=1_100 {
            b.step(1);
            b.check();
            let now = rings.clone().map(|r| ring_coords(b.tr(), &r));
            for k in 0..2 {
                let (p, n) = (prev[k].0[0].0, now[k].0[0].0);
                assert_eq!(
                    n,
                    (p + totals[k] - 24) % totals[k],
                    "tick {t} lane {k}: moved 24"
                );
                if n > p {
                    laps[k].push(t);
                }
            }
            prev = now;
        }
        // The tick each item passes its starting coordinate's wrap point (the cut of its ring
        // coordinate, not the engine's cut), then lap by lap.
        assert_eq!(
            laps,
            [
                vec![197, 417, 637, 857, 1_076],
                vec![167, 355, 543, 732, 920]
            ],
            "wraps per lane"
        );
        let gaps = laps
            .clone()
            .map(|l| l.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>());
        assert_eq!(
            gaps,
            [vec![220, 220, 220, 219], vec![188, 188, 189, 188]],
            "lap times: floor or ceil of 5,276 / 24 = 219.8 and 4,520 / 24 = 188.3"
        );
    }
}

/// The balancer fed `feed` (spawner lanes set to rate index `rate` after the build), tracked: the
/// window 500-1,000's sinks per output lane and by kind (`[stone, iron, wood, coal]`, both lanes).
fn balancer_window(feed: [u8; 4], rate: u8) -> (Bed, Vec<[u64; 2]>, Vec<[u64; 4]>) {
    use reference_sim::{RefAction, TileXY};
    let (mut b, l) = bed(BALANCER, &feed);
    if rate != common::layout::SATURATE {
        let acts: Vec<RefAction> = l
            .tiles_of(O, BeltKind::Spawner)
            .iter()
            .zip(feed)
            .flat_map(|(&t, item)| {
                (0..2).map(move |lane| RefAction::SetSpawner {
                    at: TileXY::from_tile(t),
                    lane,
                    item,
                    rate,
                })
            })
            .collect();
        for r in b.act(|s| s.dispatch_batch(P1, &acts)) {
            r.expect("set the rate");
        }
    }
    let outs = track_outputs(&mut b, &l);
    let read = |b: &Bed| -> (Vec<[u64; 2]>, Vec<[u64; 4]>) {
        (
            outs.iter().map(|&d| sunk(b, d)).collect(),
            (0..4).map(|k| kinds(b, k)).collect(),
        )
    };
    b.step_checked(500);
    let (s0, k0) = read(&b);
    b.step_checked(500);
    let (s1, k1) = read(&b);
    let lanes = s1
        .iter()
        .zip(&s0)
        .map(|(e, m)| [e[0] - m[0], e[1] - m[1]])
        .collect();
    let kinds = k1
        .iter()
        .zip(&k0)
        .map(|(e, m)| [0, 1, 2, 3].map(|i| e[i] - m[i]))
        .collect();
    (b, lanes, kinds)
}

/// The balancer balances one input ([`BALANCER`] with only coal, a's right input, at saturation;
/// the other three spawners off): over the window 500-1,000 the 374 coal items (187 a lane) leave
/// by all four outputs, 47, 46, 47 and 47 a lane: a quarter of 187.4 each (46.85). a's fork sends
/// every other item to a0 (towards d's right half) and a1 (c's left half), each preferring its left
/// output first, so the window's remainder falls on the outputs reached by left-first turns and the
/// one short output is c's right, the second choice of a second choice. Four straight belts would
/// sink all 374 at one output. Fails if a fork stops alternating, a splitter's sides swap or the
/// crossing loses a link (an output then sinks 0 or 94 a lane).
#[test]
fn balancer_4x4_spreads_one_input() {
    let off = reference_sim::content::SPAWN_OFF;
    let (b, lanes, kinds) = balancer_window(
        [off, ItemId::Coal as u8, off, off],
        common::layout::SATURATE,
    );
    assert_eq!(
        lanes,
        [[47, 47], [46, 46], [47, 47], [47, 47]],
        "sunk per output lane, ticks 500-1,000"
    );
    assert_eq!(
        kinds,
        [[0, 0, 0, 94], [0, 0, 0, 92], [0, 0, 0, 94], [0, 0, 0, 94]],
        "coal only"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 750,
            live: 74,
            sunk: 676,
            destroyed: 0
        }
    );
}

/// All four inputs below saturation (rate index 2: one item per 5 ticks a lane, 0.2 a tick): every
/// output lane sinks exactly 100 in the window 500-1,000 (the inputs' 4 x 2 x 100 split evenly), but
/// by kind each input reaches two outputs, half each, not all four: at equal rates and phase (the
/// spawners configured in the same tick) the forks' toggles lock to the inputs' interleaving (stone at outputs 0 and 2, iron at 1 and 2, wood at 1
/// and 3, coal at 0 and 3). Recorded with question 11 (the balancer balances throughput, not each input's
/// spread). Fails if a fork, a side or the crossing changes.
#[test]
fn balancer_4x4_sub_saturation() {
    let (b, lanes, kinds) = balancer_window(FEED, 2);
    assert_eq!(
        lanes,
        [[100, 100]; 4],
        "sunk per output lane, ticks 500-1,000"
    );
    assert_eq!(
        kinds,
        [
            [100, 0, 0, 100],
            [0, 100, 100, 0],
            [100, 100, 0, 0],
            [0, 0, 100, 100]
        ],
        "[stone, iron, wood, coal] per output"
    );
    assert_eq!(
        b.check(),
        common::census::Census {
            made: 1_600,
            live: 142,
            sunk: 1_458,
            destroyed: 0
        }
    );
}

/// The parsers' shared edges (`layout_parse_edges` in `tests/unit/layout.test.ts`): empty text is
/// refused, one trailing newline and `\r\n` endings parse as the plain text does, to the same hash
/// as TypeScript's. Fails if either side's line rule changes.
#[test]
fn layout_parse_edges() {
    assert!(
        std::panic::catch_unwind(|| Layout::parse("")).is_err(),
        "empty text refused"
    );
    let plain = Layout::parse("b> bv\nb^ b<").hash();
    assert_eq!(
        Layout::parse("b> bv\r\nb^ b<\n").hash(),
        plain,
        "CRLF and a trailing newline"
    );
    assert_eq!(plain, 0x7ec6_d535_6160_4295, "the same hash as TypeScript");
}
