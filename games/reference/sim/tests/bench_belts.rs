//! The bench page's belt field (M57, `?bench=belts`; `reference_sim::bench`'s module doc), behind the
//! `bench` feature this crate's self dev-dependency turns on for its tests. The genesis builder
//! writes exactly `common::layout::bench_field()` (whose hash `layout.ts`'s parser pins too), tick 1
//! maps it, and the spawners fill it to exactly the phone pair's item cap (0079 §21) without ever
//! needing more: no schedule pauses. `bench_belts_field_hash` is the native half of the field's cross-runtime hash; the `.wasm`
//! half is `bench-build`'s belt cell (`packages/engine/tests/wasm/bench-build.test.ts`).

mod common;

use common::layout::{Layout, bench_field};
use engine::game::EntityId;
use engine::sim::{Sim, WorldParams};
use engine::transport::{LineId, TransportRead};
use reference_sim::bench::{FEED, SATURATE};
use reference_sim::rules::belts::topology::{belts_unmapped, spawners_unscheduled};
use reference_sim::{BeltKind, RefEntity, RefGame, RefParams, SpawnCfg};

/// The phone pair (0079 §21): what `benchHost` declares for `?bench=belts`.
const PHONE_LINES: u32 = 12_288;
const PHONE_ITEMS: u32 = 98_304;

fn params(scale: u32) -> WorldParams<RefGame> {
    WorldParams {
        seed: 7,
        worldgen: RefParams {
            bench: scale,
            bench_regime: 1,
            ..RefParams::default()
        },
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
        max_lines: PHONE_LINES,
        max_items: PHONE_ITEMS,
    }
}

fn step(sim: &mut Sim<RefGame>, n: u32) {
    let mut out = Vec::new();
    for _ in 0..n {
        sim.step(&[], &mut out);
    }
}

/// Live lines, scheduled lines, and scheduled lines the item cap paused.
fn lines(sim: &Sim<RefGame>) -> (u32, u32, u32) {
    let tr = sim.authority().store().transport();
    let (mut live, mut sched, mut paused) = (0, 0, 0);
    for id in 1..tr.next_id() {
        if tr.len(LineId(id)).is_err() {
            continue;
        }
        live += 1;
        if let Ok(Some((_, p))) = tr.schedule(LineId(id)) {
            sched += 1;
            paused += u32::from(p);
        }
    }
    (live, sched, paused)
}

/// The Rust half of the field's layout pin (`tests/unit/layout.test.ts`'s `bench-field` row is the
/// other): 12,264 placements (48 runs of 256 tiles, less 4 gap tiles on each of the 6 special runs;
/// a splitter is one placement over two tiles), 144 rows.
#[test]
fn bench_field_layout_pinned() {
    let l = Layout::parse(&bench_field());
    assert_eq!(
        (l.placements.len(), l.width, l.height, l.hash()),
        (12_264, 256, 144, 0x634d_e43a_7434_8615),
        "placements, width, height, hash"
    );
}

/// Genesis writes the layout, entity for entity in row-major order, each spawner configured at
/// saturation with `FEED[run % 4]` on both lanes, and logs none of it (ADR 0046); another scale
/// writes `48 / scale` runs.
#[test]
fn bench_belts_builder_writes_the_layout() {
    let sim = Sim::<RefGame>::genesis(params(1));
    let layout = Layout::parse(&bench_field());
    let store = sim.authority().store();
    let mut got = Vec::new();
    let mut spawn = Vec::new();
    for (id, e) in store.entities() {
        let RefEntity::Belt(b) = e else {
            panic!("{id:?}: the field holds belts only")
        };
        got.push((id, b.origin.x, b.origin.y, b.dir, b.kind));
        if b.kind == BeltKind::Spawner {
            spawn.push(b.spawn);
        }
    }
    got.sort_by_key(|g| g.0);
    let want: Vec<_> = layout
        .placements
        .iter()
        .enumerate()
        .map(|(i, p)| (EntityId(i as u32 + 1), p.x, p.y, p.dir, p.kind))
        .collect();
    assert_eq!(
        got, want,
        "the builder writes the layout, row-major, ids from 1"
    );
    let feed: Vec<_> = (0..48)
        .map(|k| {
            [Some(SpawnCfg {
                item: FEED[k % 4],
                rate: SATURATE,
            }); 2]
        })
        .collect();
    assert_eq!(spawn, feed, "every spawner at saturation, both lanes");
    assert!(
        sim.authority().changes().is_empty(),
        "genesis is not logged"
    );
    assert_eq!(
        Sim::<RefGame>::genesis(params(4))
            .authority()
            .store()
            .entity_count(),
        12 * 256 - 2 * 4,
        "scale 4: 12 runs, two of them special"
    );
}

/// Tick 1 maps the whole field (no belt left unmapped, every spawner lane scheduled); pinned exact
/// with the hash at tick 200 (the `.wasm` leg's). M61 moved the hash from `ee989193ed484d9e`: each
/// splitter input's fork record now carries its partner (and the turn bit), the items unchanged.
#[test]
fn bench_belts_field_hash() {
    let mut sim = Sim::<RefGame>::genesis(params(1));
    let (unmapped, unscheduled) = (belts_unmapped(), spawners_unscheduled());
    step(&mut sim, 1);
    assert_eq!(
        (
            lines(&sim),
            belts_unmapped() - unmapped,
            spawners_unscheduled() - unscheduled
        ),
        ((348, 96, 0), 0, 0),
        "tick 1: (lines, scheduled, paused), belts unmapped, spawner lanes unscheduled"
    );
    step(&mut sim, 199);
    let tr = sim.authority().store().transport();
    assert_eq!(
        (
            sim.tick().0,
            tr.items_len(),
            format!("{:016x}", sim.state_hash())
        ),
        (200, 7_104, "2da20837c13a48b6".to_string()),
        "tick, items, state hash (bench-build's belt cell reads the same in Node)"
    );
    let again = {
        let mut b = Sim::<RefGame>::genesis(params(1));
        step(&mut b, 200);
        b.state_hash()
    };
    assert_eq!(again, sim.state_hash(), "one marker, one world");
}

/// The cap (0079 §21): the spawners fill the field in about 2,800 ticks (256 tiles at 1.875 a
/// second); from tick 3,000 to 4,000 the item count moves between 98,208 and the cap, 98,304, which
/// it touches on 124 ticks, and every lane still inserts at the full rate (96 lanes x 0.375 = 36 a
/// tick): the field fits the cap exactly and no schedule is ever paused by it (a field one item
/// larger would pause one: the schedule keeps its credit and inserts when a despawner frees a slot).
#[test]
fn bench_belts_field_fills_to_the_cap() {
    let mut sim = Sim::<RefGame>::genesis(params(1));
    step(&mut sim, 3_000);
    let inserts0 = sim
        .authority()
        .store()
        .transport()
        .scheduled_inserts_total();
    let (mut at_cap, mut paused_ticks, mut min, mut max) = (0u32, 0u32, u32::MAX, 0u32);
    for _ in 0..1_000 {
        step(&mut sim, 1);
        let n = sim.authority().store().transport().items_len();
        min = min.min(n);
        max = max.max(n);
        at_cap += u32::from(n == PHONE_ITEMS);
        paused_ticks += u32::from(lines(&sim).2 > 0);
    }
    let inserts = sim
        .authority()
        .store()
        .transport()
        .scheduled_inserts_total()
        - inserts0;
    assert_eq!(
        (min, max, at_cap, paused_ticks, inserts),
        (98_208, PHONE_ITEMS, 124, 0, 36_000),
        "items min, max, ticks at the cap, ticks with a paused schedule, inserts over 1,000 ticks"
    );
}
