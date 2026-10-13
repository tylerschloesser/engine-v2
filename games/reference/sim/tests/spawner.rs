//! Spawners and despawners (M53b; README "Belts", Spawner and despawner; 0079 §19 (e), §21): a
//! spawner lane's configuration becomes its line's engine schedule, set by the tick once per
//! configuration and never per insert; a despawner's lines end in `Sink` and count what they delete.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::{Item, LineId, Output, Schedule};
use engine::world::TilePos;
use reference_sim::content::{ItemId, SPAWN_OFF, SPAWN_RATES};
use reference_sim::rules::belts::topology::lanes_at;
use reference_sim::{BeltKind, Dir, RefReject};

const P1: PlayerId = PlayerId(1);
const IRON: u8 = ItemId::Iron as u8;
const COAL: u8 = ItemId::Coal as u8;

fn world() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 30, 20);
    s
}

fn put(s: &mut RefScenario, at: TilePos, dir: Dir, kind: BeltKind) {
    s.place_belt(P1, at, dir, kind)
        .unwrap_or_else(|r| panic!("place {at:?}: {r:?}"));
}

fn lanes(s: &RefScenario, at: TilePos) -> [LineId; 2] {
    lanes_at(s.read().transport(), at)
        .unwrap_or_else(|| panic!("{at:?} is mapped"))
        .lane
}

fn sched(s: &RefScenario, l: LineId) -> Option<Schedule> {
    s.transport_store()
        .schedule(l)
        .expect("line exists")
        .map(|(s, _)| s)
}

fn items(s: &RefScenario, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    s.read()
        .transport()
        .items_in(l, &mut |i, p| v.push((i.0, p)))
        .expect("line");
    v
}

/// A spawner at (50, 50) facing east and `n` plain belts in front of it, then a despawner when
/// `sink` (the run's front).
fn chain(s: &mut RefScenario, n: i32, sink: bool) -> (TilePos, TilePos) {
    let sp = TilePos::new(50, 50);
    put(s, sp, Dir::East, BeltKind::Spawner);
    for x in 1..=n {
        put(s, TilePos::new(50 + x, 50), Dir::East, BeltKind::Belt);
    }
    let end = TilePos::new(51 + n, 50);
    if sink {
        put(s, end, Dir::East, BeltKind::Despawner);
    }
    (sp, end)
}

/// `SetSpawner` gives the lane's line the schedule its item and rate ask (period from
/// `SPAWN_RATES`, `next` the engine item `ItemId + 1`, no cycling); a later `SetSpawner` on the other
/// lane re-sets both lanes (fix round 1: the unchanged lane restarts at `acc` 0, losing at most one
/// period of credit: here 84 of 683); `SPAWN_OFF` clears a lane; a rotation (re-created lines) sets
/// the configured lane again on the new lines. No `set_spawner` is refused. Fails if the topology
/// sets no schedule, keeps a cleared one or forgets a configuration when the lines are re-created.
#[test]
fn spawner_sets_the_engine_schedule() {
    let mut s = world();
    let (sp, _) = chain(&mut s, 3, false);
    let [l0, l1] = lanes(&s, sp);
    assert_eq!((sched(&s, l0), sched(&s, l1)), (None, None), "placed: none");

    s.set_spawner(P1, sp, 0, IRON, 3).expect("a spawner lane");
    let iron = |acc| Schedule {
        period: 683,
        acc,
        kinds: 0,
        next: Item(u16::from(IRON) + 1),
    };
    // Set in the tick with `acc: 0`; that tick's `advance` stepped it once.
    assert_eq!(sched(&s, l0), Some(iron(256)), "lane 0 scheduled");
    assert_eq!(sched(&s, l1), None, "lane 1 unset");
    s.assert_topology();

    s.step_ticks(10);
    assert_eq!(
        sched(&s, l0).map(|x| x.acc),
        Some(84),
        "lane 0's credit before"
    );
    s.set_spawner(P1, sp, 1, COAL, 0).expect("lane 1");
    let coal = Schedule {
        period: SPAWN_RATES[0],
        acc: 256,
        kinds: 0,
        next: Item(u16::from(COAL) + 1),
    };
    assert_eq!(
        (sched(&s, l0), sched(&s, l1)),
        (Some(iron(256)), Some(coal)),
        "both lanes re-set: lane 0 restarted (84 of credit lost, under one period)"
    );

    s.set_spawner(P1, sp, 0, SPAWN_OFF, 0)
        .expect("clear lane 0");
    assert_eq!(sched(&s, l0), None, "cleared");
    assert!(sched(&s, l1).is_some(), "lane 1 kept");
    s.assert_topology();

    s.rotate_belt(P1, sp).unwrap();
    let [n0, n1] = lanes(&s, sp);
    assert!(n0 != l0 && n1 != l1, "re-created");
    assert_eq!(sched(&s, n0), None, "lane 0 stays clear");
    assert_eq!(
        sched(&s, n1).map(|x| (x.period, x.next)),
        Some((SPAWN_RATES[0], Item(u16::from(COAL) + 1))),
        "the re-created lane 1 is scheduled again"
    );
    s.assert_topology();
    assert_eq!(
        reference_sim::rules::belts::topology::spawners_unscheduled(),
        0,
        "no set_spawner refused"
    );
}

/// Fix round 1 (review must-fix): two `SetSpawner`s on different lanes applied in one tick give one
/// wake; both lanes end scheduled. Fails if the tick sets only the lane of the last action.
#[test]
fn two_lanes_set_in_one_tick() {
    let mut s = world();
    let (sp, _) = chain(&mut s, 1, false);
    let at = reference_sim::TileXY::from_tile(sp);
    let r = s.dispatch_batch(
        P1,
        &[
            reference_sim::RefAction::SetSpawner {
                at,
                lane: 0,
                item: IRON,
                rate: 3,
            },
            reference_sim::RefAction::SetSpawner {
                at,
                lane: 1,
                item: COAL,
                rate: 2,
            },
        ],
    );
    assert_eq!(r, [Ok(()), Ok(())]);
    let [l0, l1] = lanes(&s, sp);
    assert_eq!(
        (
            sched(&s, l0).map(|x| (x.period, x.next)),
            sched(&s, l1).map(|x| (x.period, x.next))
        ),
        (
            Some((683, Item(u16::from(IRON) + 1))),
            Some((SPAWN_RATES[2], Item(u16::from(COAL) + 1)))
        ),
        "both lanes scheduled"
    );
    s.assert_topology();
}

/// Fix round 1: at a line cap of 2 a spawner placed beside a belt is left unmapped (a dropped pair);
/// it is configured meanwhile (no lines: nothing set). Picking the belt up frees the cap and that
/// wake re-maps the spawner beside it: its lines get the configured schedule in the same wake. A
/// second lane configured then is refused by the tracker's pool (half the cap: one lane) and counted
/// by `spawners_unscheduled`. Fails if only a spawner's own wake sets schedules, or if a refusal goes
/// uncounted.
#[test]
fn spawner_rescheduled_when_a_neighbour_remaps_it() {
    use reference_sim::rules::belts::topology::{belts_unmapped, spawners_unscheduled};
    let mut s = RefScenario::with_caps(2, 64);
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 30, 20);
    let sp = TilePos::new(50, 50);
    let above = TilePos::new(50, 49);
    put(&mut s, above, Dir::North, BeltKind::Belt);
    put(&mut s, sp, Dir::East, BeltKind::Spawner);
    assert!(
        lanes_at(s.read().transport(), sp).is_none(),
        "the cap dropped it"
    );
    assert!(belts_unmapped() > 0);
    s.set_spawner(P1, sp, 0, IRON, 3).unwrap();
    assert!(
        lanes_at(s.read().transport(), sp).is_none(),
        "still unmapped"
    );

    s.pick_up_belt(P1, above).unwrap();
    let [l0, l1] = lanes(&s, sp);
    assert_eq!(
        (sched(&s, l0).map(|x| (x.period, x.acc)), sched(&s, l1)),
        (Some((683, 256)), None),
        "re-mapped by the neighbour's wake, scheduled in it"
    );
    assert_eq!(spawners_unscheduled(), 0);
    s.set_spawner(P1, sp, 1, COAL, 3).unwrap();
    assert_eq!(sched(&s, l1), None, "the pool holds one lane");
    assert_eq!(spawners_unscheduled(), 1, "the refusal counted");
}

/// A spawner feeding three belts into a despawner: the despawner's run ends in `Sink`, its `sunk`
/// grows, and every inserted item is on a line or sunk (`scheduled_inserts_total` = items + sunk).
/// Pinned after 400 ticks at the saturation rate on both lanes (300 = 2 x 400 x 256 / 683 inserts;
/// 40 in flight on five tiles that hold at most 40 at spacing 64; fix round 1 moved 261 / 39 to
/// 260 / 40: lane 1's configuration a tick later restarts lane 0). Fails if the despawner dead-ends
/// (nothing sunk), joins the spawner, or the counts do not conserve.
#[test]
fn despawner_sinks_and_counts() {
    let mut s = world();
    let (sp, end) = chain(&mut s, 3, true);
    for lane in 0..2 {
        s.set_spawner(P1, sp, lane, IRON, 3).unwrap();
    }
    let run = lanes(&s, end);
    let tr = s.read().transport();
    assert_eq!(
        [tr.out(run[0]), tr.out(run[1])],
        [Ok(Output::Sink), Ok(Output::Sink)]
    );
    assert_eq!(
        lanes(&s, TilePos::new(51, 50)),
        run,
        "belts and despawner: one run"
    );
    assert_ne!(lanes(&s, sp), run, "the spawner is its own pair");
    s.assert_topology();

    s.step_ticks(400);
    let tr = s.read().transport();
    let sunk = tr.sunk(run[0]).unwrap() + tr.sunk(run[1]).unwrap();
    let mut on = 0u64;
    for l in lanes(&s, sp).into_iter().chain(run) {
        on += u64::from(tr.count(l).unwrap());
    }
    let inserted = s.transport_store().scheduled_inserts_total();
    assert_eq!(
        (inserted, sunk, on),
        (300, 260, 40),
        "inserted, sunk, on the lines"
    );
    assert_eq!(inserted, sunk + on, "conserved");
}

/// `SetSpawner`'s refusals, each with no write: no belt (an empty tile, a furnace), not a spawner (a
/// belt, a despawner), a lane past 1, an item no `ItemId` has, a rate past `SPAWN_RATES`; and a
/// configuration equal to the lane's is `Ok` with no write. Fails if a check is missing or a refusal
/// (or a no-op) writes.
#[test]
fn set_spawner_rules() {
    let mut s = world();
    let (sp, _) = chain(&mut s, 1, false);
    let belt = TilePos::new(51, 50);
    let desp = TilePos::new(50, 52);
    put(&mut s, desp, Dir::East, BeltKind::Despawner);
    s.give(P1, ItemId::Furnace, 1);
    s.place(P1, TilePos::new(56, 56)).expect("a furnace");
    let puts = s.entity_puts_logged();
    let cases = [
        (TilePos::new(45, 45), 0, IRON, 0, RefReject::NoBeltHere),
        (TilePos::new(57, 57), 0, IRON, 0, RefReject::NoBeltHere),
        (belt, 0, IRON, 0, RefReject::NotASpawner),
        (desp, 0, IRON, 0, RefReject::NotASpawner),
        (sp, 2, IRON, 0, RefReject::BadLane),
        (sp, 0, 6, 0, RefReject::BadItem),
        (sp, 0, IRON, 4, RefReject::BadRate),
    ];
    for (at, lane, item, rate, want) in cases {
        assert_eq!(
            s.set_spawner(P1, at, lane, item, rate),
            Err(want),
            "{at:?} lane {lane} item {item} rate {rate}"
        );
    }
    assert_eq!(s.entity_puts_logged(), puts, "a refusal writes nothing");
    s.set_spawner(P1, sp, 1, IRON, 2).unwrap();
    assert_eq!(s.entity_puts_logged(), puts + 1, "one put");
    let b = s.belt_at(sp).unwrap();
    assert_eq!(
        (b.spawn[0], b.spawn[1].map(|c| (c.item, c.rate))),
        (None, Some((IRON, 2)))
    );
    s.set_spawner(P1, sp, 1, IRON, 2).unwrap();
    s.set_spawner(P1, sp, 0, SPAWN_OFF, 3).unwrap();
    assert_eq!(s.entity_puts_logged(), puts + 1, "unchanged: no write");
}

/// 0079 §19 (e): over 600 ticks a configured spawner feeding a despawner inserts 450 items and the
/// world records no entity put and visits no entity (the schedule is the engine's state; nothing is
/// written per insert). Fails if the game inserts itself, or re-sets a schedule, from the tick.
#[test]
fn spawner_writes_nothing_per_insert() {
    let mut s = world();
    let (sp, _) = chain(&mut s, 4, true);
    for lane in 0..2 {
        s.set_spawner(P1, sp, lane, COAL, 3).unwrap();
    }
    let puts = s.entity_puts_logged();
    let writes = s.writes_logged();
    let before = s.transport_store().scheduled_inserts_total();
    let mut visited = 0;
    for _ in 0..600 {
        s.step_ticks(1);
        visited += s.visited_last_tick();
    }
    assert_eq!(
        s.transport_store().scheduled_inserts_total() - before,
        450,
        "inserts in 600 ticks"
    );
    assert_eq!(s.entity_puts_logged(), puts, "entity puts");
    assert_eq!(s.writes_logged(), writes, "writes");
    assert_eq!(visited, 0, "entities visited");
}

/// `fullGame()`'s spawner passage (M53b golden): a spawner at saturation on both lanes fills a
/// dead-ended two-belt run; once full the world stands still (the state hash 50 ticks apart equal,
/// so the golden does not depend on the drivers' waits); the spawner picked up takes its tile's
/// items; a despawner placed at the run's front drains the run, `sunk` equal to the count the run
/// held, and the world stands still again, and after the despawner's pick-up too. Fails if a blocked schedule keeps changing state, the
/// despawner does not join the run or loses an item.
#[test]
fn spawner_passage_drains() {
    let mut s = world();
    let (sp, end) = chain(&mut s, 2, false);
    s.set_spawner(P1, sp, 0, IRON, 3).unwrap();
    s.set_spawner(P1, sp, 1, COAL, 3).unwrap();
    s.step_ticks(100);
    let full = s.hash();
    s.step_ticks(50);
    assert_eq!(s.hash(), full, "a full run stands still");
    let run = lanes(&s, TilePos::new(51, 50));
    let held: Vec<_> = run.iter().map(|&l| items(&s, l).len()).collect();
    assert_eq!(held, [8, 8], "two tiles, four a lane each");
    s.pick_up_belt(P1, sp).unwrap();
    assert_eq!(
        s.read().transport().lines_len(),
        2,
        "the spawner's lines gone"
    );
    put(&mut s, end, Dir::East, BeltKind::Despawner);
    assert_eq!(lanes(&s, end), run, "the despawner fronts the run");
    s.step_ticks(60);
    let tr = s.read().transport();
    assert_eq!(
        (
            tr.sunk(run[0]),
            tr.sunk(run[1]),
            tr.count(run[0]),
            tr.count(run[1])
        ),
        (Ok(8), Ok(8), Ok(0), Ok(0)),
        "sunk equals the count"
    );
    let drained = s.hash();
    s.step_ticks(20);
    assert_eq!(s.hash(), drained, "a drained run stands still");
    s.assert_topology();
    // The passage's last action: the despawner picked up, the empty run dead-ends and stands still.
    s.pick_up_belt(P1, end).unwrap();
    let last = s.hash();
    s.step_ticks(20);
    assert_eq!(s.hash(), last, "the passage ends quiescent");
    s.assert_topology();
}
