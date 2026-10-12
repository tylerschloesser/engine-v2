//! M47 (docs/decisions/0078 A3): forecasts and corrections. The host tracker's events, classifier,
//! builder and spawner schedule on a bare `Transport`; section 13's bytes; and end to end through
//! `testkit::Loopback` (real frames) the replica following the host: the five follower cases, the
//! arrival, and the arbiter `forecast_client_matches_host` on six hand worlds, the replica's items
//! equal to the host's on every held line every tick. The game is local: its `tick` runs a
//! per-thread list of rules (transport writes and a spawner that follows the declared schedule).

use std::cell::RefCell;

use engine::bytes::{ByteReader, ByteSink, SliceSink};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::host::hashes::HashMode;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::transport::{
    Geometry, Item, LineId, MSG_RUN_LIST, MSG_STATE, Output, SPACING, Schedule, Segment, Transport,
    TransportRead, TransportWrite,
};
use engine::wire::forecast::{self as wf, Arrival, Record, Run, Spawner, State};
use engine::wire::{CameraReport, FrameReader, SectionId, WireError};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    WorldPos,
};
use engine::worldgen::Worldgen;

// -- A test game whose tick runs rules ---------------------------------------------------------

type Rule = Box<dyn FnMut(u32, &mut dyn TransportWrite)>;

thread_local! {
    static RULES: RefCell<Vec<Rule>> = RefCell::new(Vec::new());
    /// Ids the rules created, in order.
    static IDS: RefCell<Vec<LineId>> = const { RefCell::new(Vec::new()) };
}

fn rule(f: impl FnMut(u32, &mut dyn TransportWrite) + 'static) {
    RULES.with(|r| r.borrow_mut().push(Box::new(f)));
}

/// A rule run once, at tick `at`.
fn once(at: u32, f: impl FnOnce(&mut dyn TransportWrite) + 'static) {
    let mut f = Some(f);
    rule(move |now, t| {
        if now == at
            && let Some(f) = f.take()
        {
            f(t);
        }
    });
}

fn id(k: usize) -> LineId {
    IDS.with(|i| i.borrow()[k])
}

fn reset() {
    RULES.with(|r| r.borrow_mut().clear());
    IDS.with(|i| i.borrow_mut().clear());
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct FcEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct FcPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct FcGlobal;
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum FcAction {
    Noop,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
enum FcReject {
    Unknown,
}
impl From<Unknown> for FcReject {
    fn from(_: Unknown) -> Self {
        FcReject::Unknown
    }
}
struct FcGen;
impl Worldgen for FcGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}
struct Flat;
impl PristineSource for Flat {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

struct FcGame;
impl Game for FcGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = FcGen;
    type Action = FcAction;
    type Reject = FcReject;
    type Entity = FcEntity;
    type Player = FcPlayer;
    type Global = FcGlobal;
    type Presence = ();
    type Ui = ();
    type Client = ();
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &FcEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &FcEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, FcPlayer);
        }
    }
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &FcAction) -> Result<(), FcReject> {
        Ok(())
    }
    fn tick(cx: &mut TickCx<'_, Self>) {
        let now = cx.tick().0;
        let mut rules = RULES.with(|r| std::mem::take(&mut *r.borrow_mut()));
        let t = cx.transport_mut().expect("tick: transport_mut is Ok");
        for r in rules.iter_mut() {
            r(now, t);
        }
        RULES.with(|r| {
            let mut r = r.borrow_mut();
            let added = std::mem::take(&mut *r);
            *r = rules;
            r.extend(added);
        });
    }
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &FcAction,
    ) -> Result<(), FcReject> {
        Ok(())
    }
}

fn params() -> WorldParams<FcGame> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 1024,
        max_modified_tiles: 1024,
        max_action_growth: 4096,
        max_lines: 256,
        max_items: 8192,
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(FcGame::CHUNK_BITS)
}

const TILE: i32 = 256;
const SP: u32 = SPACING;
/// Tiles at least this far east are never held by the client (its camera is at the origin).
const FAR: i32 = 4000;

/// A straight east-going path along tile row `row` from tile `x0` for `tiles` tiles.
fn east(x0: i32, row: i32, tiles: u32) -> Segment {
    Segment {
        len: tiles * 256,
        geometry: Geometry::Straight {
            from: WorldPos {
                x: x0 * TILE + 128,
                y: row * TILE + 128,
            },
            to: WorldPos {
                x: (x0 + tiles as i32) * TILE + 128,
                y: row * TILE + 128,
            },
        },
    }
}

/// Creates a line of `tiles` tiles at `(x0, row)` and records its id.
fn line(t: &mut dyn TransportWrite, x0: i32, row: i32, tiles: u32, speed: u16) -> LineId {
    let l = t.create(tiles * 256, speed).unwrap();
    t.set_segments(l, &[east(x0, row, tiles)]).unwrap();
    IDS.with(|i| i.borrow_mut().push(l));
    l
}

/// A spawner on line `k` following `Schedule`'s rule, declared on its first tick.
fn spawner(k: usize, period: u32, kinds: u16, first: u16) {
    let mut s: Option<Schedule> = None;
    rule(move |_now, t| {
        if IDS.with(|i| i.borrow().len()) <= k {
            return;
        }
        let l = id(k);
        if t.len(l).is_err() {
            return;
        }
        match s.as_mut() {
            None => {
                let sch = Schedule {
                    period,
                    acc: 0,
                    kinds,
                    next: Item(first),
                };
                t.set_spawner(l, Some(sch));
                s = Some(sch);
            }
            Some(sch) => {
                sch.acc += 256;
                if sch.acc >= sch.period {
                    if t.insert_back(l, sch.next).is_ok() {
                        sch.acc -= sch.period;
                        sch.next = sch.cycle(sch.next);
                    } else {
                        sch.acc -= 256;
                    }
                }
            }
        }
    });
}

fn camera() -> CameraReport {
    CameraReport {
        center_x: 16,
        center_y: 16,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

fn loopback() -> Loopback<FcGame> {
    loopback_with(params().max_items)
}

fn loopback_with(max_items: u32) -> Loopback<FcGame> {
    let mut lb = Loopback::<FcGame>::new(WorldParams {
        max_items,
        ..params()
    });
    lb.host.set_hash_mode(HashMode::All);
    lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(0, camera());
    lb
}

/// Section 13's records of the frame `build_frame` last made for client 0 (bundles unwrapped).
#[derive(Default, Clone, Copy, Debug)]
struct Tally {
    states: u32,
    run_lists: u32,
    arrivals: u32,
    puts: u32,
}

fn tally(lb: &Loopback<FcGame>) -> Tally {
    tally_of(lb, 0)
}

fn tally_of(lb: &Loopback<FcGame>, i: usize) -> Tally {
    let mut t = Tally::default();
    let bytes = lb.last_built_frame(i);
    if bytes.is_empty() {
        return t;
    }
    let mut r = FrameReader::new(bytes).unwrap();
    while let Some((sid, body)) = r.next_section().unwrap() {
        match sid {
            SectionId::Forecasts => wf::read(&mut ByteReader::new(body), |rec| match rec {
                Record::State(_) => t.states += 1,
                Record::RunList(_) => t.run_lists += 1,
                Record::Arrival(_) => t.arrivals += 1,
            })
            .unwrap(),
            SectionId::LineStructs => {
                engine::wire::lines::read(&mut ByteReader::new(body), |rec| {
                    if matches!(rec, engine::wire::lines::Record::Put(_)) {
                        t.puts += 1;
                    }
                })
                .unwrap();
            }
            _ => {}
        }
    }
    t
}

type Items = Vec<(Item, u32)>;

fn host_items(lb: &Loopback<FcGame>, l: LineId) -> Items {
    let mut v = Vec::new();
    lb.host
        .sim()
        .unwrap()
        .authority()
        .store()
        .transport()
        .items_in(l, &mut |i, p| v.push((i, p)))
        .unwrap();
    v
}

fn client_items_of(lb: &Loopback<FcGame>, i: usize, l: LineId) -> Items {
    let mut v = Vec::new();
    lb.client(i)
        .replica()
        .transport()
        .items_in(l, &mut |i, p| v.push((i, p)))
        .unwrap();
    v
}

fn held_lines(lb: &Loopback<FcGame>) -> Vec<LineId> {
    held_lines_of(lb, 0)
}

fn held_lines_of(lb: &Loopback<FcGame>, i: usize) -> Vec<LineId> {
    let mut v = Vec::new();
    lb.client(i).replica().structures(|p| v.push(p.id));
    v
}

/// What one run of the arbiter saw.
#[derive(Default, Debug)]
struct Seen {
    /// (line, tick) comparisons and the items in them.
    compared: u64,
    items: u64,
    max_held: usize,
    totals: Tally,
    /// Run lists for lines the client held before their frame (replica-counted).
    late_run_lists: u32,
    lists_seen: u64,
    /// (line, tick) pairs skipped because the client holds the line's items as unknown.
    unknown: u64,
}

/// One tick and the arbiter's check: every line the client holds has the host's items, in order,
/// at the same positions.
fn step_and_check(lb: &mut Loopback<FcGame>, label: &str, seen: &mut Seen) {
    step_and_check_n(lb, 1, label, seen);
}

/// [`step_and_check`] for clients `0..n` (the tally is client 0's).
fn step_and_check_n(lb: &mut Loopback<FcGame>, n: usize, label: &str, seen: &mut Seen) {
    let overflows: Vec<u64> = (0..n)
        .map(|i| lb.host.debug_overflows(lb.conn(i)))
        .collect();
    lb.step();
    let host_tick = lb.host.sim().unwrap().tick().0 - 1;
    let mut lagging = vec![false; n];
    for i in 0..n {
        if lb.host.debug_overflows(lb.conn(i)) > overflows[i] {
            // The frame overflowed and was not sent: the client is a tick behind until the next
            // frame (whose `Gone`s cover what this one lost); nothing to compare now.
            lagging[i] = true;
            continue;
        }
        if lb.host.debug_holding_frames(lb.conn(i)) {
            // Pacing holds this tick's frame for a bundle: the client catches up when it comes.
            lagging[i] = true;
            continue;
        }
        if lb.last_build_frame_len(i) == 0 {
            // No frame for this tick: nothing changed for the client. It steps this tick when
            // its next frame comes, by the same call (`ClientCore::on_frame` catches up first);
            // the arbiter takes that step now to compare this tick.
            lb.client_mut(i).forecast_catch_up(host_tick);
        }
        assert_eq!(
            lb.client(i).replica().forecast_tick(),
            Some(host_tick),
            "{label}: client {i}: the replica's forecast tick"
        );
    }
    let t = tally(lb);
    seen.totals.states += t.states;
    seen.totals.run_lists += t.run_lists;
    seen.totals.arrivals += t.arrivals;
    seen.totals.puts += t.puts;
    // Run lists for lines the client held before their frame, whatever else the frame carries
    // (M47 review, finding 8): the replica's corrections that were not states.
    let fc = lb.client(0).replica().forecast_counters();
    let lists = fc.corrections - fc.state_messages_applied;
    seen.late_run_lists += (lists - seen.lists_seen) as u32;
    seen.lists_seen = lists;
    for (i, &lag) in lagging.iter().enumerate() {
        if lag {
            continue;
        }
        let held = held_lines_of(lb, i);
        seen.max_held = seen.max_held.max(held.len());
        for l in held {
            if lb.client(i).replica().forecast_unknown(l) {
                // Its list did not fit a frame: no items held, none compared (M47 review, 1).
                seen.unknown += 1;
                continue;
            }
            let (h, c) = (host_items(lb, l), client_items_of(lb, i, l));
            assert_eq!(
                c, h,
                "{label}: client {i}: tick {host_tick}: line {l:?}: client vs host"
            );
            seen.compared += 1;
            seen.items += h.len() as u64;
        }
    }
}

fn run(lb: &mut Loopback<FcGame>, ticks: u32, label: &str) -> Seen {
    let mut seen = Seen::default();
    for _ in 0..ticks {
        step_and_check(lb, label, &mut seen);
    }
    seen
}

fn host_counters(lb: &Loopback<FcGame>) -> engine::transport::HostCounters {
    lb.host
        .sim()
        .unwrap()
        .authority()
        .store()
        .transport()
        .forecast_host_counters()
}

// -- The hand worlds ---------------------------------------------------------------------------

/// A packed chain into a toggled sink: back `B` (a saturated, cycling spawner) feeds `M` feeds `F`,
/// whose output toggles `Sink`/`DeadEnd` every 40 ticks from tick 60, and in a burst at ticks
/// 200-240 every 2 or 3 ticks (so a state for `F` meets items landing on it the same tick).
fn world_packed_chain() {
    once(1, |t| {
        let b = line(t, 0, 4, 8, 24);
        let m = line(t, 8, 4, 8, 24);
        let f = line(t, 16, 4, 8, 24);
        t.set_out(b, Output::Next(m)).unwrap();
        t.set_out(m, Output::Next(f)).unwrap();
        t.set_out(f, Output::Sink).unwrap();
    });
    spawner(0, 256, 6, 1);
    rule(|now, t| {
        let burst = (200..240).contains(&now) && (now % 5 == 0 || now % 5 == 2);
        if burst || (now >= 60 && (now - 60).is_multiple_of(40)) {
            let f = id(2);
            let out = if t.out(f) == Ok(Output::Sink) {
                Output::DeadEnd
            } else {
                Output::Sink
            };
            t.set_out(f, out).unwrap();
        }
    });
}

/// A spawner-fed lane: one item per 2.5 ticks onto a dead end (it fills, the spawner backs up);
/// at tick 150 the lane drains into a sink, at 220 it dead-ends again. Beside it, a lane fed by a
/// spawner the game never declares (each insert an arrival) into a sink toggled at 100 and 180.
fn world_spawner_lane() {
    once(1, |t| {
        line(t, 0, 8, 12, 24);
        let u = line(t, 0, 9, 12, 24);
        t.set_out(u, Output::Sink).unwrap();
    });
    spawner(0, 640, 0, 3);
    rule(|now, t| {
        if now >= 2 && now.is_multiple_of(3) {
            let _ = t.insert_back(id(1), Item(1 + (now % 4) as u16));
        }
        if now == 100 {
            t.set_out(id(1), Output::DeadEnd).unwrap();
        }
        if now == 180 {
            t.set_out(id(1), Output::Sink).unwrap();
        }
    });
    once(150, |t| t.set_out(id(0), Output::Sink).unwrap());
    once(220, |t| t.set_out(id(0), Output::DeadEnd).unwrap());
}

/// A fork within the horizon: `S` (spawner) feeds `F`, which forks onto `A` (a sink) and `B` (a dead
/// end that fills, after which every item goes to `A`); at tick 200 `B` drains too.
fn world_fork() {
    once(1, |t| {
        let s = line(t, 0, 12, 6, 24);
        let f = line(t, 6, 12, 4, 24);
        let a = line(t, 10, 12, 6, 24);
        let b = line(t, 10, 13, 6, 24);
        t.set_out(s, Output::Next(f)).unwrap();
        t.set_out(f, Output::Fork { a, b }).unwrap();
        t.set_out(a, Output::Sink).unwrap();
    });
    spawner(0, 256, 3, 1);
    once(200, |t| t.set_out(id(3), Output::Sink).unwrap());
}

/// Merges and hand-offs from lines the client does not hold: `M` (held) drains into a sink; `U`
/// (far away, a spawner) side-loads into `M`'s middle; `V` (far away, a spawner) hands off onto `H`
/// (held), which dead-ends until tick 120 and then feeds `M`'s back.
fn world_unheld_feeders() {
    once(1, |t| {
        let m = line(t, 0, 16, 16, 24);
        let u = line(t, FAR, 16, 6, 24);
        let v = line(t, FAR, 18, 6, 24);
        let h = line(t, 16, 16, 8, 24);
        t.set_out(m, Output::Sink).unwrap();
        t.set_out(
            u,
            Output::Merge {
                line: m,
                at: 8 * 256,
            },
        )
        .unwrap();
        t.set_out(v, Output::Next(h)).unwrap();
    });
    spawner(1, 768, 0, 2);
    spawner(2, 512, 2, 4);
    once(120, |t| t.set_out(id(3), Output::Next(id(0))).unwrap());
}

/// A state meets a lander (0078 A3 rules 1-2): `B`'s three packed items cross onto `F` at ticks
/// 1, 3 and 6; `F` closes at tick 6, the tick the last one crosses. `F`'s state covers its `T - 1`
/// items only; the lander keeps the stop `B`'s list gave it (none) until its due tick, when it
/// reaches the chain behind them (tick 86).
fn world_state_meets_lander() {
    once(1, |t| {
        let b = line(t, 0, 14, 8, 24);
        let f = line(t, 8, 14, 8, 24);
        t.set_out(b, Output::Next(f)).unwrap();
        t.set_out(f, Output::Sink).unwrap();
        for k in 0..3 {
            t.insert_at(b, SP * k, Item(1 + k as u16)).unwrap();
        }
    });
    once(6, |t| t.set_out(id(1), Output::DeadEnd).unwrap());
}

/// Mixed speeds (M47 review, finding 6): `A` at speed 72 feeds `B` at speed 24 into a sink, a
/// declared spawner on `A`. `A`'s front is held back by `B`'s moving tail most ticks, which the
/// model (no stop: the walk ends at the sink) does not predict: a run list per such tick, a
/// measured limit (0078's amendment), exact all the same.
fn world_mixed_speeds() {
    once(1, |t| {
        let a = line(t, 0, 26, 8, 72);
        let b = line(t, 8, 26, 8, 24);
        t.set_out(a, Output::Next(b)).unwrap();
        t.set_out(b, Output::Sink).unwrap();
    });
    spawner(0, 256, 2, 1);
}

/// Inserter-like edits: a lane fed by a spawner drains into a sink; every 7 ticks an item is
/// inserted at a moving position, every 11 ticks one is removed.
fn world_inserter() {
    once(1, |t| {
        let l = line(t, 0, 20, 16, 24);
        t.set_out(l, Output::Sink).unwrap();
    });
    spawner(0, 512, 0, 1);
    rule(|now, t| {
        if now <= 5 {
            return;
        }
        let l = id(0);
        if now.is_multiple_of(7) {
            let pos = (now * 997) % (16 * 256 - 1);
            let _ = t.insert_at(l, pos, Item(5));
        }
        if now.is_multiple_of(11) {
            let pos = (now * 613) % (16 * 256 - 1);
            let _ = t.remove_at(l, pos);
        }
    });
}

/// Surgery mid-flow: `A` (a spawner) feeds `B` feeds a sink; `B` is split in half at tick 80 (both
/// halves re-registered), joined back at 140, extended at the front at 180, rescaled at 230.
fn world_surgery() {
    once(1, |t| {
        let a = line(t, 0, 24, 8, 24);
        let b = line(t, 8, 24, 8, 24);
        t.set_out(a, Output::Next(b)).unwrap();
        t.set_out(b, Output::Sink).unwrap();
    });
    spawner(0, 384, 2, 1);
    once(80, |t| {
        let b = id(1);
        let back = t.split(b, 4 * 256).unwrap();
        t.set_segments(b, &[east(8, 24, 4)]).unwrap();
        t.set_segments(back, &[east(12, 24, 4)]).unwrap();
        IDS.with(|i| i.borrow_mut().push(back));
    });
    once(140, |t| {
        let (b, back) = (id(1), id(2));
        t.join(b, back).unwrap();
        t.set_segments(b, &[east(8, 24, 8)]).unwrap();
    });
    once(180, |t| {
        let b = id(1);
        t.extend_front(b, 2 * 256).unwrap();
        t.set_segments(b, &[east(8, 24, 10)]).unwrap();
    });
    once(230, |t| {
        let b = id(1);
        t.rescale(b, 9 * 256).unwrap();
        t.set_segments(b, &[east(8, 24, 9)]).unwrap();
    });
}

/// 0078 A3 (the arbiter): on each hand world (the brief's six and the lander case), for 300 ticks,
/// the replica's items (kind and position, front to back) equal the host's on every line it
/// holds, every tick; the packed chain sends no run list after the first frame (its jams are state
/// messages).
#[test]
fn forecast_client_matches_host() {
    type World = fn();
    let worlds: [(&str, World); 8] = [
        ("mixed speeds", world_mixed_speeds),
        ("packed chain", world_packed_chain),
        ("state meets lander", world_state_meets_lander),
        ("spawner lane", world_spawner_lane),
        ("fork", world_fork),
        ("unheld feeders", world_unheld_feeders),
        ("inserter", world_inserter),
        ("surgery", world_surgery),
    ];
    for (label, build) in worlds {
        reset();
        build();
        let mut lb = loopback();
        let seen = run(&mut lb, 300, label);
        let c = host_counters(&lb);
        println!("{label}: {seen:?} {c:?}");
        assert_eq!(
            held_lines(&lb),
            lines_in_view(&lb, 0),
            "{label}: the client holds every line in its view"
        );
        assert!(
            seen.max_held >= 1 && seen.items > 500,
            "{label}: compared too little: {seen:?}"
        );
        assert_eq!(
            c.spawner_mismatches, 0,
            "{label}: the declared schedules hold"
        );
        match label {
            "packed chain" => {
                assert!(seen.totals.states > 0, "{label}: the toggles correct");
                assert_eq!(
                    seen.late_run_lists, 0,
                    "{label}: no run list after the first frame"
                );
            }
            "unheld feeders" => {
                assert!(seen.totals.arrivals > 0, "{label}: arrivals from V");
                assert!(seen.max_held < 4, "{label}: U and V are not held");
            }
            "fork" => assert!(seen.totals.arrivals > 0, "{label}: fork crossings arrive"),
            "spawner lane" => {
                assert!(
                    seen.totals.arrivals > 50,
                    "{label}: undeclared inserts arrive"
                );
                assert_eq!(
                    seen.late_run_lists, 0,
                    "{label}: no list is resent for them"
                );
            }
            _ => {}
        }
    }
}

/// A long chain across two views: ten lines of 6 tiles, 40 tiles apart along one row (where a line
/// is drawn does not change how it moves), a spawner at the back, the front's sink toggled; one
/// client near the front, one near the back, each holding a different part. Per connection, a
/// hand-off from a line it does not hold arrives; one between two lines it holds it follows. Both
/// replicas equal the host every tick.
#[test]
fn forecast_two_views_match_host() {
    reset();
    once(1, |t| {
        let ls: Vec<LineId> = (0..10).map(|k| line(t, 40 * k, 4, 6, 24)).collect();
        for k in 1..10 {
            t.set_out(ls[k], Output::Next(ls[k - 1])).unwrap();
        }
        t.set_out(ls[0], Output::Sink).unwrap();
    });
    spawner(9, 256, 5, 1);
    rule(|now, t| {
        if now >= 700 && (now - 700).is_multiple_of(60) {
            let out = if ((now - 700) / 60).is_multiple_of(2) {
                Output::DeadEnd
            } else {
                Output::Sink
            };
            t.set_out(id(0), out).unwrap();
        }
    });
    let mut lb = loopback();
    lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(
        1,
        CameraReport {
            center_x: 330,
            center_y: 4,
            half_w: 16,
            half_h: 16,
            vel_x: 0,
            vel_y: 0,
        },
    );
    let mut seen = Seen::default();
    let mut arrivals = [0u32; 2];
    for _ in 0..900 {
        step_and_check_n(&mut lb, 2, "two views", &mut seen);
        for (i, a) in arrivals.iter_mut().enumerate() {
            *a += tally_of(&lb, i).arrivals;
        }
    }
    for i in 0..2 {
        assert_eq!(
            held_lines_of(&lb, i),
            lines_in_view(&lb, i),
            "client {i} holds every line in its view"
        );
    }
    let (a, b) = (held_lines_of(&lb, 0), held_lines_of(&lb, 1));
    println!("two views: {seen:?} held {a:?} / {b:?}, arrivals {arrivals:?}");
    assert!(!a.is_empty() && !b.is_empty() && a != b, "{a:?} / {b:?}");
    assert!(
        arrivals[0] > 20,
        "the front view's lines are fed from lines it does not hold"
    );
    assert!(seen.items > 20_000, "{seen:?}");
}

/// Sixty lanes in view draining into sinks: twenty fed by declared spawners (no records), forty
/// fed by a game that declares nothing and inserts on all forty at once every 37 ticks until tick
/// 300 (forty arrivals in one frame, more than a small buffer holds: a lost frame names forty
/// lines, not sixty).
fn world_lanes() {
    once(1, |t| {
        for k in 0..60 {
            let l = line(t, 0, 2 + k, 6, 24);
            t.set_out(l, Output::Sink).unwrap();
        }
    });
    for k in 40..60 {
        spawner(k, 256 + 16 * k as u32, 3, 1);
    }
    rule(|now, t| {
        if !(40..300).contains(&now) || !now.is_multiple_of(37) {
            return;
        }
        for k in 0..40 {
            let _ = t.insert_back(id(k), Item(1 + (k % 5) as u16));
        }
    });
}

/// The lines whose chunk set meets a chunk client `i` holds (what it should hold).
fn lines_in_view(lb: &Loopback<FcGame>, i: usize) -> Vec<LineId> {
    let held = lb.host.debug_held(lb.conn(i));
    let t = lb.host.sim().unwrap().authority().store().transport();
    let mut ids = Vec::new();
    t.line_ids(&mut |l| ids.push(l));
    ids.retain(|&l| {
        let mut meets = false;
        let _ = t.chunks_of(l, dims(), &mut |c| meets |= held.contains(&c));
        meets && t.has_segments(l)
    });
    ids
}

/// The `Gone` records of the frame last built for client 0.
fn gones(lb: &Loopback<FcGame>) -> usize {
    let bytes = lb.last_built_frame(0);
    let mut n = 0;
    if bytes.is_empty() {
        return 0;
    }
    let mut r = FrameReader::new(bytes).unwrap();
    while let Some((sid, body)) = r.next_section().unwrap() {
        if sid == SectionId::LineStructs {
            engine::wire::lines::read(&mut ByteReader::new(body), |rec| {
                n += usize::from(matches!(rec, engine::wire::lines::Record::Gone(_)))
            })
            .unwrap();
        }
    }
    n
}

/// The put budget and an overflowing frame (0079 §17 (c), 0078 §7, M47 review finding 2): with a
/// frame buffer too small for the world's structures and lists, puts and their lists spill over
/// frames, a held line whose correction does not fit is dropped and put again, and a frame that
/// overflows loses its records: the next drops only the lines those records named (and their
/// hand-off targets), never every held line. After the last overflow the client holds every line
/// in its view again within `k` frames, `k` = the lines in view + 2 (each frame admits at least
/// one put, its list or an `unknown` one). Every tick the replica equals the host on every line it
/// holds.
#[test]
fn forecast_matches_host_under_budget() {
    let mut overflowed_somewhere = false;
    for buf in [1_400usize, 600, 400, 300, 260] {
        for (label, build) in [
            ("packed chain", world_packed_chain as fn()),
            ("inserter", world_inserter),
            ("lanes", world_lanes),
        ] {
            reset();
            build();
            let mut lb = loopback();
            lb.set_frame_buf_len(buf);
            let mut seen = Seen::default();
            let (mut last_overflow, mut overflows) = (0u32, 0u64);
            let mut partial_drops = 0u32;
            let mut converged_at: Option<u32> = None;
            for tick in 0..400u32 {
                let held_before = held_lines(&lb).len();
                step_and_check(&mut lb, label, &mut seen);
                let o = lb.host.debug_overflows(lb.conn(0));
                if overflows > 0
                    && converged_at.is_none()
                    && held_lines(&lb) == lines_in_view(&lb, 0)
                {
                    converged_at = Some(tick);
                }
                if o > overflows {
                    overflows = o;
                    last_overflow = tick;
                    converged_at = None;
                } else if last_overflow + 1 == tick && overflows > 0 {
                    // The frame after a loss: its gones name only the lost records' lines.
                    let g = gones(&lb);
                    assert!(g <= held_before, "{label} at {buf} B: {g} gones");
                    // Only a frame that sent at least one `Gone` counts (review 2, finding 6).
                    if g > 0 && g < held_before {
                        partial_drops += 1;
                    }
                }
            }
            let view = lines_in_view(&lb, 0);
            let held = held_lines(&lb);
            println!(
                "{label} at {buf} B: {seen:?}, overflows {overflows} (last at {last_overflow}, \
                 view held again at {converged_at:?}), partial drops {partial_drops}, view {} held {}",
                view.len(),
                held.len()
            );
            assert!(
                seen.compared + seen.unknown >= 390,
                "{label} at {buf} B: {seen:?}"
            );
            if overflows > 0 {
                overflowed_somewhere = true;
                // `k`: the view's puts (structure, and list or an `unknown` one) over the put
                // budget, halved after the overflow, plus two frames (the loss's `Gone`s and the
                // recovery of the halving).
                let t = lb.host.sim().unwrap().authority().store().transport();
                let full = buf / 4;
                let bytes: usize = view
                    .iter()
                    .map(|&l| {
                        let mut put = engine::bytes::CountSink::default();
                        engine::wire::lines::write_put(&mut put, &t.structure(l).unwrap());
                        let list = t.run_list_bytes(l);
                        put.0 + if put.0 + list > full { 7 } else { list }
                    })
                    .sum();
                let k = bytes.div_ceil((full / 2).max(1)) as u32 + 2;
                let back = converged_at.expect("held its view again after the last overflow");
                let took = back - last_overflow;
                println!("{label} at {buf} B: back after {took} ticks, k = {k}");
                assert!(
                    took <= k,
                    "{label} at {buf} B: held its view {took} ticks after (k = {k})"
                );
                assert!(
                    k <= 2 * took + 4,
                    "{label} at {buf} B: k = {k} is not a tight bound"
                );
                if label == "lanes" {
                    assert_eq!(
                        partial_drops as u64, overflows,
                        "{label} at {buf} B: every loss dropped only the lines it named"
                    );
                }
            }
            assert_eq!(
                held, view,
                "{label} at {buf} B: the client holds its view again"
            );
        }
    }
    assert!(
        overflowed_somewhere,
        "no buffer overflowed: the lost path never ran"
    );
}

/// M47 review, finding 1: a line whose run list is larger than a frame's put budget (1,600 tiles,
/// 6,400 items of alternating kinds: 6,400 runs, about 77 KB, against 16 KiB of puts in a 64 KiB
/// frame) is put with an `unknown` list: no frame overflows, frames keep flowing, the structure is
/// held and the chunk hashes agree, the client holds no items for it. Once the game takes most of
/// its items away, the full list fits and arrives, and the client's items equal the host's.
#[test]
fn forecast_list_larger_than_a_frame_is_unknown() {
    reset();
    once(1, |t| {
        let l = line(t, 0, 4, 1_600, 24);
        for k in 0..6_400u32 {
            t.insert_at(l, SP * k, Item(1 + (k % 2) as u16)).unwrap();
        }
    });
    once(40, |t| {
        for _ in 0..5_500 {
            t.take_front(id(0)).unwrap();
        }
    });
    let mut lb = loopback();
    let mut seen = Seen::default();
    for tick in 0..39u32 {
        step_and_check(&mut lb, "unknown list", &mut seen);
        assert_eq!(
            lb.host.debug_overflows(lb.conn(0)),
            0,
            "tick {tick}: no overflow"
        );
        let (host, client) = (
            lb.host.sim().unwrap().tick().0,
            lb.client(0).last_summary().tick.0,
        );
        assert!(host - client <= 11, "tick {tick}: frames flow");
    }
    let l = id(0);
    assert_eq!(held_lines(&lb), vec![l], "the structure is held");
    assert!(lb.client(0).replica().forecast_unknown(l));
    assert_eq!(client_items_of(&lb, 0, l), Vec::new(), "no items for it");
    assert_eq!(lb.client(0).replica().forecast_counters().lists_unknown, 1);
    assert_eq!(lb.client(0).desyncs().count(), 0, "chunk hashes agree");
    for _ in 0..10 {
        step_and_check(&mut lb, "unknown list", &mut seen);
    }
    assert_eq!(lb.host.debug_overflows(lb.conn(0)), 0);
    assert!(
        !lb.client(0).replica().forecast_unknown(l),
        "the full list came"
    );
    assert_eq!(host_items(&lb, l).len(), 900);
    assert_eq!(client_items_of(&lb, 0, l), host_items(&lb, l));
    assert_eq!(lb.client(0).desyncs().count(), 0);
}

/// M47 review 2, finding 4: hand-offs around a line whose items the client does not know. `A`
/// (a declared spawner) feeds `U` (2,000 tiles, 6,400 alternating items: its list is larger than a
/// frame) which feeds `X` into a sink. The client lands nothing on `U` (`A`'s crossers vanish there,
/// as into a line not held) and gets each item leaving `U` as an arrival on `X`: `A` and `X` equal
/// the host every tick, `U` holds nothing, no item twice.
#[test]
fn forecast_hand_offs_around_an_unknown_line() {
    reset();
    once(1, |t| {
        let a = line(t, 0, 6, 8, 24);
        let u = line(t, 8, 6, 2_000, 24);
        let x = line(t, 0, 7, 8, 24);
        t.set_out(a, Output::Next(u)).unwrap();
        t.set_out(u, Output::Next(x)).unwrap();
        t.set_out(x, Output::Sink).unwrap();
        for k in 0..6_400u32 {
            t.insert_at(u, 10 + SP * k, Item(1 + (k % 2) as u16))
                .unwrap();
        }
    });
    spawner(0, 256, 0, 3);
    let mut lb = loopback();
    let seen = run(&mut lb, 200, "around unknown");
    let (u, x) = (id(1), id(2));
    assert!(lb.client(0).replica().forecast_unknown(u));
    assert_eq!(client_items_of(&lb, 0, u), Vec::new(), "U holds nothing");
    assert!(seen.unknown >= 190, "{seen:?}");
    assert!(
        seen.totals.arrivals > 50,
        "items leaving U arrive on X: {seen:?}"
    );
    assert!(!host_items(&lb, x).is_empty());
}

/// M47 review, finding 4: an update of held lines past the put budget (sixty lanes carrying items,
/// all re-sped in one tick, under a 2 KiB frame: 512 B of puts) sends the lines that do not fit
/// `Gone`, puts them again on later frames with their lists, and the client's items equal the
/// host's every tick; in the end every lane is held at its new speed.
#[test]
fn host_held_update_over_budget_goes_gone_then_put() {
    reset();
    once(1, |t| {
        for k in 0..60 {
            let l = line(t, 0, 2 + k, 6, 24);
            t.set_out(l, Output::Sink).unwrap();
        }
    });
    for k in 0..60 {
        spawner(k, 256 + 16 * k as u32, 3, 1);
    }
    once(120, |t| {
        for k in 0..60 {
            t.set_speed(id(k), 12).unwrap();
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(2_048);
    let mut seen = Seen::default();
    for _ in 0..120 {
        step_and_check(&mut lb, "re-sped", &mut seen);
    }
    assert_eq!(held_lines(&lb).len(), 60);
    let (mut gone, mut put) = (0, 0);
    for _ in 0..80 {
        step_and_check(&mut lb, "re-sped", &mut seen);
        gone += gones(&lb);
        put += tally(&lb).puts;
    }
    println!("re-sped: {gone} gones, {put} puts, {seen:?}");
    assert!(gone > 0, "updates past the budget went `Gone`");
    assert_eq!(
        put as usize, 60,
        "each lane put once, its own update or its re-put"
    );
    assert_eq!(held_lines(&lb).len(), 60, "every lane is held again");
    for k in 0..60 {
        assert_eq!(
            lb.client(0).replica().transport().speed(id(k)),
            Ok(12),
            "lane {k} re-sped"
        );
    }
    assert_eq!(seen.unknown, 0);
}

thread_local! {
    /// The tick a test's rule acts at, chosen while the test runs.
    static ACT_AT: core::cell::Cell<u32> = const { core::cell::Cell::new(u32::MAX) };
}

/// A frame with nothing to say but hashes: no section other than `Hashes` (M49: what a line holder
/// gets on a tick it would once have been silent).
fn quiet_frame(bytes: &[u8]) -> bool {
    let mut r = FrameReader::new(bytes).unwrap();
    while let Some((sid, _)) = r.next_section().unwrap() {
        if sid != SectionId::Hashes {
            return false;
        }
    }
    true
}

/// M49: the hashes-only variant of `forecast_quiet_gap_then_structure_change`. A connection
/// holding a line is never silenced (0078 A12 revised), so ticks with nothing to say bring frames
/// with no section but the hashes: after a stretch of them, a frame that changes a structure (the
/// sink closes) finds every tick stepped, and the replica equals the host on every tick.
#[test]
fn forecast_hashes_only_frames_then_structure_change() {
    reset();
    ACT_AT.with(|c| c.set(u32::MAX));
    once(1, |t| {
        let b = line(t, 0, 4, 8, 24);
        let m = line(t, 8, 4, 8, 24);
        let f = line(t, 16, 4, 8, 24);
        t.set_out(b, Output::Next(m)).unwrap();
        t.set_out(m, Output::Next(f)).unwrap();
        t.set_out(f, Output::Sink).unwrap();
        // Packed from the start, so items leave through the sink in every quiet tick.
        for l in [b, m, f] {
            for k in 0..30 {
                t.insert_at(l, 10 + SP * k, Item(1 + (k % 3) as u16))
                    .unwrap();
            }
        }
    });
    rule(|now, t| {
        if ACT_AT.with(|c| c.get()) == now {
            t.set_out(id(2), Output::DeadEnd).unwrap();
        }
    });
    let mut lb = loopback();
    let (mut quiet, mut compared, mut gap_before) = (0u32, 0u32, None);
    for _ in 0..200 {
        lb.step();
        let host_tick = lb.host.sim().unwrap().tick().0 - 1;
        assert_ne!(
            lb.last_build_frame_len(0),
            0,
            "tick {host_tick}: a line holder is silenced"
        );
        if quiet_frame(lb.last_built_frame(0)) {
            quiet += 1;
            if quiet >= 4 && ACT_AT.with(|c| c.get()) == u32::MAX && host_tick > 20 {
                ACT_AT.with(|c| c.set(host_tick + 1));
                gap_before = Some(quiet);
            }
        } else {
            quiet = 0;
        }
        assert_eq!(lb.client(0).replica().forecast_tick(), Some(host_tick));
        for l in held_lines(&lb) {
            assert_eq!(
                client_items_of(&lb, 0, l),
                host_items(&lb, l),
                "tick {host_tick}: line {l:?}"
            );
            compared += 1;
        }
    }
    let at = ACT_AT.with(|c| c.get());
    assert!(
        at != u32::MAX && gap_before.is_some(),
        "a quiet gap came before the close"
    );
    println!("closed at {at} after {gap_before:?} quiet ticks; {compared} compared");
    assert!(compared > 20);
}

/// M47 review 2, finding 1: a client steps only inside a frame. After ticks it got no frame for
/// (free flow into a sink, nothing to say), a frame that changes a structure (the sink closes) must
/// find those ticks stepped under the old structure (`Follower::frame`'s catch-up). M49: a line
/// holder now gets a frame every tick, so the gap is made by losing four of them on the way
/// (`Loopback::drop_frames`; each carries no section but hashes, which the client survives); the
/// structure changes on the tick after. The replica is compared on every tick a frame came for.
#[test]
fn forecast_quiet_gap_then_structure_change() {
    reset();
    ACT_AT.with(|c| c.set(u32::MAX));
    once(1, |t| {
        let b = line(t, 0, 4, 8, 24);
        let m = line(t, 8, 4, 8, 24);
        let f = line(t, 16, 4, 8, 24);
        t.set_out(b, Output::Next(m)).unwrap();
        t.set_out(m, Output::Next(f)).unwrap();
        t.set_out(f, Output::Sink).unwrap();
        // Packed from the start, so items leave through the sink in every quiet tick.
        for l in [b, m, f] {
            for k in 0..30 {
                t.insert_at(l, 10 + SP * k, Item(1 + (k % 3) as u16))
                    .unwrap();
            }
        }
    });
    rule(|now, t| {
        if ACT_AT.with(|c| c.get()) == now {
            t.set_out(id(2), Output::DeadEnd).unwrap();
        }
    });
    let mut lb = loopback();
    const GAP_AT: u32 = 30;
    let (mut compared, mut dropped, mut lag_before) = (0u32, 0u32, None);
    for _ in 0..200 {
        let next = lb.host.sim().unwrap().tick().0;
        if next == GAP_AT {
            lb.drop_frames(0, 4);
            ACT_AT.with(|c| c.set(GAP_AT + 4));
        }
        if next == GAP_AT + 4 {
            // Before the structure frame: the follower still at the tick before the gap.
            lag_before = lb.client(0).replica().forecast_tick();
        }
        lb.step();
        let host_tick = lb.host.sim().unwrap().tick().0 - 1;
        if (GAP_AT..GAP_AT + 4).contains(&host_tick) {
            assert!(
                quiet_frame(lb.last_built_frame(0)),
                "tick {host_tick}: a dropped frame said something"
            );
            dropped += 1;
            continue;
        }
        if host_tick == GAP_AT + 4 {
            // The frame after the gap carries the structure change (the sink closed: a put).
            let bytes = lb.last_built_frame(0);
            assert!(
                !quiet_frame(bytes),
                "tick {host_tick}: the structure frame is quiet"
            );
            let mut r = FrameReader::new(bytes).unwrap();
            let mut structs = false;
            while let Some((sid, _)) = r.next_section().unwrap() {
                structs |= sid == SectionId::LineStructs;
            }
            assert!(
                structs,
                "tick {host_tick}: the structure frame carries `LineStructs`"
            );
        }
        assert_eq!(lb.client(0).replica().forecast_tick(), Some(host_tick));
        for l in held_lines(&lb) {
            assert_eq!(
                client_items_of(&lb, 0, l),
                host_items(&lb, l),
                "tick {host_tick}: line {l:?}"
            );
            compared += 1;
        }
    }
    assert_eq!(dropped, 4, "the gap's frames were lost");
    assert_eq!(
        lag_before,
        Some(GAP_AT - 1),
        "the structure frame found the follower four ticks behind"
    );
    assert_eq!(compared, 585, "line-ticks compared");
}

/// M47 review 2, finding 3, and review 3: a lost frame carrying a change to `A` only, on a packed
/// chain `A -> B -> C` into a sink. The client steps the lost tick with `A`'s old output, so `A`'s
/// landers on `B` are wrong; the next frame drops `A` and the targets of its hand-offs. Modes:
/// - `Close`: `A` closes (`DeadEnd`);
/// - `CloseThenGone`: as `Close`, and `B` stops being held in the next frame (its path cleared);
/// - `Destroy`: `A` is destroyed (review 3, finding 1: `destroy_line` logs `A`'s old target);
/// - `TwoLosses`: as `Close`, and the frame after it is lost too (two in a row).
///
/// Each mode runs at three offsets (one of them has a hand-off from `A` to `B` at the lost tick).
/// Every compared tick is exact, and the client holds its view again.
#[test]
fn forecast_lost_state_on_a_chain() {
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Mode {
        Close,
        CloseThenGone,
        Destroy,
        TwoLosses,
    }
    for mode in [
        Mode::Close,
        Mode::CloseThenGone,
        Mode::Destroy,
        Mode::TwoLosses,
    ] {
        for offset in 0..3 {
            reset();
            ACT_AT.with(|c| c.set(u32::MAX));
            once(1, |t| {
                let a = line(t, 0, 4, 6, 24);
                let b = line(t, 6, 4, 6, 24);
                let c = line(t, 12, 4, 6, 24);
                t.set_out(a, Output::Next(b)).unwrap();
                t.set_out(b, Output::Next(c)).unwrap();
                t.set_out(c, Output::Sink).unwrap();
                for l in [a, b, c] {
                    for k in 0..20 {
                        t.insert_at(l, 10 + SP * k, Item(1 + (k % 3) as u16))
                            .unwrap();
                    }
                }
            });
            rule(move |now, t| {
                let at = ACT_AT.with(|c| c.get());
                if now == at {
                    if mode == Mode::Destroy {
                        t.destroy(id(0), &mut |_| {}).unwrap();
                    } else {
                        // A state for `A` alone: it closes (the client, missing it, still hands
                        // `A`'s front items on to `B`).
                        t.set_out(id(0), Output::DeadEnd).unwrap();
                    }
                }
                if mode == Mode::CloseThenGone && at != u32::MAX && now == at + 1 {
                    t.set_segments(id(1), &[]).unwrap();
                }
            });
            let mut lb = loopback();
            let mut seen = Seen::default();
            for _ in 0..30 + offset {
                step_and_check(&mut lb, "lost state", &mut seen);
            }
            let at = lb.host.sim().unwrap().tick().0;
            ACT_AT.with(|c| c.set(at));
            lb.set_frame_buf_len(24);
            let before = lb.host.debug_overflows(lb.conn(0));
            let losses = if mode == Mode::TwoLosses { 2 } else { 1 };
            for _ in 0..losses {
                step_and_check(&mut lb, "lost state", &mut seen);
            }
            assert_eq!(
                lb.host.debug_overflows(lb.conn(0)) - before,
                losses,
                "{mode:?} {offset}: the frames were lost"
            );
            lb.set_frame_buf_len(64 * 1024);
            for _ in 0..60 {
                step_and_check(&mut lb, "lost state", &mut seen);
            }
            assert_eq!(held_lines(&lb), lines_in_view(&lb, 0), "{mode:?} {offset}");
            assert!(seen.compared > 100, "{mode:?} {offset}: {seen:?}");
        }
    }
}

/// M47 review 2, finding 2: a frame that both overflows and sends held lines `Gone` for the
/// budget. Forty lanes get an undeclared insert each at once every 37 ticks (forty arrivals: more
/// than a 470 B frame holds), and twenty short lines get an inserter's item the same tick (twenty
/// lists of about 100 B against 117 B of puts: most go `Gone`). The next frame drops the lines
/// the lost plan had ops for as well; the client is exact and holds its view again.
#[test]
fn forecast_lost_frame_with_budget_gones() {
    reset();
    once(1, |t| {
        for k in 0..40 {
            let l = line(t, 0, 2 + k, 6, 24);
            t.set_out(l, Output::Sink).unwrap();
        }
        for k in 0..20 {
            line(t, 10, 2 + k, 2, 24);
        }
    });
    rule(|now, t| {
        if !(40..300).contains(&now) || !now.is_multiple_of(37) {
            return;
        }
        for k in 0..40 {
            let _ = t.insert_back(id(k), Item(1));
        }
        for k in 40..60 {
            let n = t.count(id(k)).unwrap();
            let _ = t.insert_at(id(k), 400 - 64 * (n % 6), Item(1 + (n % 2) as u16));
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(470);
    let mut seen = Seen::default();
    let mut gone_lines = 0;
    for _ in 0..400 {
        step_and_check(&mut lb, "lost with gones", &mut seen);
        gone_lines += gones(&lb);
    }
    let together = lb.host.debug_lost_with_budget_gones(lb.conn(0));
    println!("lost with gones: {seen:?}, {gone_lines} gones, {together} lost frames with them");
    assert!(lb.host.debug_overflows(lb.conn(0)) > 0, "frames were lost");
    assert!(
        together > 0,
        "a budget `Gone` and an overflow fell in one frame"
    );
    assert!(gone_lines > 0);
    assert_eq!(held_lines(&lb), lines_in_view(&lb, 0));
}

/// M47 review 2, finding 5: after an overflow the put budget halves, and the first put of a frame
/// carries a list only within it. A line created in a lost frame whose put and list (about 215 B)
/// lie between the halved (150 B) and the full (300 B) bound of a 1,200 B frame is not sent on the
/// next frame and not made `unknown`; it goes, with its full list, once the budget recovers.
#[test]
fn forecast_list_waits_for_the_budget_after_an_overflow() {
    reset();
    ACT_AT.with(|c| c.set(u32::MAX));
    once(1, |t| {
        // Something to say every tick (an undeclared insert: an arrival), so frames are built.
        let l = line(t, 0, 4, 6, 24);
        t.set_out(l, Output::Sink).unwrap();
    });
    rule(|now, t| {
        if now > 1 {
            let _ = t.insert_back(id(0), Item(1));
        }
        if now == ACT_AT.with(|c| c.get()) {
            let l = line(t, 0, 6, 4, 24);
            for k in 0..15u32 {
                t.insert_at(l, 10 + SP * k, Item(1 + (k % 2) as u16))
                    .unwrap();
            }
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(1_200);
    let mut seen = Seen::default();
    for _ in 0..20 {
        step_and_check(&mut lb, "wait", &mut seen);
    }
    let at = lb.host.sim().unwrap().tick().0;
    ACT_AT.with(|c| c.set(at));
    lb.set_frame_buf_len(24);
    let before = lb.host.debug_overflows(lb.conn(0));
    step_and_check(&mut lb, "wait", &mut seen);
    assert!(
        lb.host.debug_overflows(lb.conn(0)) > before,
        "the frame was lost"
    );
    lb.set_frame_buf_len(1_200);
    step_and_check(&mut lb, "wait", &mut seen);
    let l = id(1);
    let t = lb.host.sim().unwrap().authority().store().transport();
    let mut put = engine::bytes::CountSink::default();
    engine::wire::lines::write_put(&mut put, &t.structure(l).unwrap());
    let size = put.0 + t.run_list_bytes(l);
    assert!((150..=300).contains(&size), "put and list: {size} B");
    assert!(
        !held_lines(&lb).contains(&l),
        "pending on the frame after the overflow"
    );
    assert_eq!(lb.client(0).replica().forecast_counters().lists_unknown, 0);
    step_and_check(&mut lb, "wait", &mut seen);
    assert!(
        held_lines(&lb).contains(&l),
        "sent once the budget recovered"
    );
    assert!(!lb.client(0).replica().forecast_unknown(l));
    assert_eq!(client_items_of(&lb, 0, l), host_items(&lb, l));

    // Review 3, finding 2: a correction too. A held line `C` (halted, packed at its front) gets an
    // undeclared insert on the tick after an overflow: its list is that frame's first, between the
    // halved and the full bound, so `C` goes `Gone` and is put again with it once the budget
    // recovers; it is never `unknown`.
    reset();
    ACT_AT.with(|c| c.set(u32::MAX));
    once(1, |t| {
        let l = line(t, 0, 4, 6, 24);
        t.set_out(l, Output::Sink).unwrap();
        let c = line(t, 0, 6, 4, 24);
        for k in 0..15u32 {
            t.insert_at(c, 10 + SP * k, Item(1 + (k % 2) as u16))
                .unwrap();
        }
    });
    rule(|now, t| {
        if now > 1 {
            let _ = t.insert_back(id(0), Item(1));
        }
        let at = ACT_AT.with(|c| c.get());
        if at != u32::MAX && now == at + 1 {
            t.insert_at(id(1), 1_000, Item(2)).unwrap();
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(1_200);
    let mut seen = Seen::default();
    for _ in 0..60 {
        step_and_check(&mut lb, "wait correction", &mut seen);
    }
    let c = id(1);
    assert!(held_lines(&lb).contains(&c), "held before the overflow");
    let at = lb.host.sim().unwrap().tick().0;
    ACT_AT.with(|cell| cell.set(at));
    lb.set_frame_buf_len(24);
    let before = lb.host.debug_overflows(lb.conn(0));
    step_and_check(&mut lb, "wait correction", &mut seen);
    assert!(
        lb.host.debug_overflows(lb.conn(0)) > before,
        "the frame was lost"
    );
    lb.set_frame_buf_len(1_200);
    let corrections_before = lb.client(0).replica().forecast_counters();
    step_and_check(&mut lb, "wait correction", &mut seen);
    let t = lb.host.sim().unwrap().authority().store().transport();
    let mut put = engine::bytes::CountSink::default();
    engine::wire::lines::write_put(&mut put, &t.structure(c).unwrap());
    let size = put.0 + t.run_list_bytes(c);
    assert!((150..=300).contains(&size), "put and list: {size} B");
    assert!(
        !held_lines(&lb).contains(&c),
        "the correction did not ride the frame after the overflow: {corrections_before:?}"
    );
    step_and_check(&mut lb, "wait correction", &mut seen);
    assert!(
        held_lines(&lb).contains(&c),
        "put again once the budget recovered"
    );
    assert!(!lb.client(0).replica().forecast_unknown(c));
    assert_eq!(client_items_of(&lb, 0, c), host_items(&lb, c));
    assert_eq!(lb.client(0).replica().forecast_counters().lists_unknown, 0);
}

/// M47 review 3, finding 3: a line's `unknown` is judged on its structure plus its list in every
/// path, so it never flips. `U` (halted, 23 items: a 280 B list, a 31 B put) sits in the band
/// between the empty frame's bound less its structure and the bound itself (300 B of a 1,200 B
/// frame) for 20 ticks, with an undeclared insert or removal every tick (a correction) and a speed
/// change every other tick (an update put carrying the list). The client's `unknown` for `U`
/// changes at most once.
#[test]
fn forecast_unknown_never_flips_in_the_band() {
    reset();
    ACT_AT.with(|c| c.set(u32::MAX));
    once(1, |t| {
        let u = line(t, 0, 4, 12, 24);
        t.set_out(u, Output::DeadEnd).unwrap();
        for j in 0..23u32 {
            t.insert_at(u, 10 + SP * j, Item(1 + (j % 2) as u16))
                .unwrap();
        }
    });
    rule(|now, t| {
        let at = ACT_AT.with(|c| c.get());
        if at == u32::MAX || now < at {
            return;
        }
        if (now - at).is_multiple_of(2) {
            t.insert_at(id(0), 3_000, Item(2)).unwrap();
            let speed = if (now - at).is_multiple_of(4) { 12 } else { 24 };
            t.set_speed(id(0), speed).unwrap();
        } else {
            t.remove_at(id(0), 3_000).unwrap();
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(1_200);
    let mut seen = Seen::default();
    for _ in 0..80 {
        step_and_check(&mut lb, "band", &mut seen);
    }
    let u = id(0);
    ACT_AT.with(|c| c.set(lb.host.sim().unwrap().tick().0 + 1));
    let (mut last, mut flips) = (None, 0);
    for _ in 0..20 {
        step_and_check(&mut lb, "band", &mut seen);
        let t = lb.host.sim().unwrap().authority().store().transport();
        let mut put = engine::bytes::CountSink::default();
        engine::wire::lines::write_put(&mut put, &t.structure(u).unwrap());
        let list = t.run_list_bytes(u);
        assert!(
            list <= 300 && put.0 + list > 300,
            "in the band: {} + {list} B",
            put.0
        );
        assert!(held_lines(&lb).contains(&u));
        let unknown = lb.client(0).replica().forecast_unknown(u);
        if last.is_some_and(|l| l != unknown) {
            flips += 1;
        }
        last = Some(unknown);
    }
    println!("band: {flips} flips, unknown at the end: {last:?}");
    assert!(flips <= 1, "{flips} flips");
}

/// M47 review 3: `pos_at` follows `Next` only into lines the step would land on. `A -> U`, `U`
/// held `unknown` (a 30-item list over a 1,200 B frame's 300 B bound): `A`'s front item is on `A`
/// now and, once its path crosses into `U`, nowhere (`None`), as the step vanishes it there; `B ->
/// K`, `K` known, the same item continues onto `K`.
#[test]
fn forecast_pos_at_stops_at_an_unknown_line() {
    reset();
    once(1, |t| {
        let a = line(t, 0, 4, 2, 24);
        let u = line(t, 2, 4, 12, 24);
        t.set_out(a, Output::Next(u)).unwrap();
        t.set_out(u, Output::DeadEnd).unwrap();
        for j in 0..30u32 {
            t.insert_at(u, 1_000 + SP * j, Item(1 + (j % 2) as u16))
                .unwrap();
        }
        let b = line(t, 0, 6, 2, 24);
        let k = line(t, 2, 6, 12, 24);
        t.set_out(b, Output::Next(k)).unwrap();
        t.set_out(k, Output::DeadEnd).unwrap();
    });
    rule(|now, t| {
        if now == 20 {
            t.insert_back(id(0), Item(1)).unwrap();
            t.insert_back(id(2), Item(1)).unwrap();
        }
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(1_200);
    let mut seen = Seen::default();
    for _ in 0..22 {
        step_and_check(&mut lb, "pos_at", &mut seen);
    }
    let (a, u, b, k) = (id(0), id(1), id(2), id(3));
    let r = lb.client(0).replica();
    assert!(r.forecast_unknown(u) && !r.forecast_unknown(k));
    let now = f64::from(r.forecast_tick().unwrap());
    // Two tiles at 24 a tick: on `A` now, past its front within 30 ticks.
    assert_eq!(r.pos_at(a, 0, now).map(|(l, _)| l), Some(a));
    assert_eq!(r.pos_at(a, 0, now + 30.0), None, "vanishes at `U`");
    assert_eq!(r.pos_at(b, 0, now).map(|(l, _)| l), Some(b));
    assert_eq!(r.pos_at(b, 0, now + 30.0).map(|(l, _)| l), Some(k));
}

// -- The follower cases ------------------------------------------------------------------------

/// M41's five follower cases on the replica through real frames (0078 A3): a halt (a sink closes
/// under a packed lane), a resume (it reopens), a halt downstream (the line ahead closes: the
/// state's `front_stop` lies on the next line), a toggled sink (closed and reopened twice), and a
/// spawner pause (the item cap refuses an insert the replay would make; the next success resumes
/// it). Each: the replica equals the host on every held line every tick, and the expected
/// message kinds arrive.
#[test]
fn replica_follows_state_message() {
    // Halt and resume: one packed lane into a sink, closed at 40, reopened at 90.
    reset();
    once(1, |t| {
        let l = line(t, 0, 4, 12, 24);
        t.set_out(l, Output::Sink).unwrap();
    });
    spawner(0, 256, 0, 1);
    once(40, |t| t.set_out(id(0), Output::DeadEnd).unwrap());
    once(90, |t| t.set_out(id(0), Output::Sink).unwrap());
    let mut lb = loopback();
    let seen = run(&mut lb, 140, "halt/resume");
    assert!(seen.totals.states >= 2, "halt and resume: {seen:?}");
    assert_eq!(seen.late_run_lists, 0, "halt/resume: {seen:?}");

    // Halt downstream: `A` feeds `B`; `B` closes at 30: `A`'s items stop on `B` (negative stops).
    reset();
    once(1, |t| {
        let a = line(t, 0, 6, 8, 24);
        let b = line(t, 8, 6, 2, 24);
        t.set_out(a, Output::Next(b)).unwrap();
        t.set_out(b, Output::Sink).unwrap();
    });
    spawner(0, 256, 0, 2);
    once(30, |t| t.set_out(id(1), Output::DeadEnd).unwrap());
    let mut lb = loopback();
    let seen = run(&mut lb, 120, "halt downstream");
    assert!(seen.totals.states >= 2, "halt downstream: {seen:?}");
    assert_eq!(seen.late_run_lists, 0, "halt downstream: {seen:?}");

    // A toggled sink: closed at 20 and 80, reopened at 50 and 110.
    reset();
    once(1, |t| {
        let l = line(t, 0, 8, 10, 24);
        t.set_out(l, Output::Sink).unwrap();
    });
    spawner(0, 256, 4, 1);
    rule(|now, t| {
        if [20, 80].contains(&now) {
            t.set_out(id(0), Output::DeadEnd).unwrap();
        }
        if [50, 110].contains(&now) {
            t.set_out(id(0), Output::Sink).unwrap();
        }
    });
    let mut lb = loopback();
    let seen = run(&mut lb, 160, "toggled sink");
    assert!(seen.totals.states >= 4, "toggled sink: {seen:?}");
    assert_eq!(seen.late_run_lists, 0, "toggled sink: {seen:?}");

    // A state meets a lander (the arbiter's seventh world): the lander's due tick corrects it.
    reset();
    world_state_meets_lander();
    let mut lb = loopback();
    let seen = run(&mut lb, 120, "state meets lander");
    let c = host_counters(&lb);
    assert!(c.dues >= 1, "the lander's due tick: {c:?}");
    assert_eq!(seen.late_run_lists, 0, "state meets lander: {seen:?}");

    // A spawner pause: a world whose item cap is reached from tick 10 (a far line soaks up every
    // free item before the spawner's turn), freed at 80: the cap's refusal pauses the replay, the
    // next insert resumes it.
    reset();
    once(1, |t| {
        let l = line(t, 0, 10, 12, 24);
        t.set_out(l, Output::Sink).unwrap();
        line(t, FAR, 10, 80, 24);
    });
    rule(|now, t| {
        if now < 2 {
            return;
        }
        let soak = id(1);
        if (10..80).contains(&now) {
            loop {
                let pos = t.count(soak).unwrap() * SP;
                if pos >= 80 * 256 || t.insert_at(soak, pos, Item(9)).is_err() {
                    break;
                }
            }
        }
        if now == 80 {
            while t.take_front(soak).unwrap().is_some() {}
        }
    });
    spawner(0, 512, 0, 1);
    let mut lb = loopback_with(300);
    run(&mut lb, 140, "spawner pause");
    let c = host_counters(&lb);
    assert!(c.pauses >= 1 && c.resumes >= 1, "spawner pause: {c:?}");
    assert_eq!(c.spawner_mismatches, 0, "spawner pause: {c:?}");
    let fc = lb.client(0).replica().forecast_counters();
    assert!(fc.state_messages_applied >= 2, "spawner pause: {fc:?}");
}

/// 0078 A3 rule 6 (as built: the arrival carries the model's stop): an item handed onto a held line
/// from a line the client does not hold arrives with its stop; the line jams, so later arrivals
/// carry stops, and the replica keeps equal.
#[test]
fn replica_arrival_gets_stop() {
    reset();
    once(1, |t| {
        let u = line(t, FAR, 4, 6, 24);
        let h = line(t, 0, 4, 12, 24);
        t.set_out(u, Output::Next(h)).unwrap();
        // Items the host lists for `U` with the cheap forecast's stops (into `H`'s dead end).
        for k in 0..12 {
            t.insert_at(u, 600 + SP * k, Item(7)).unwrap();
        }
    });
    spawner(0, 512, 0, 7);
    let mut lb = loopback();
    let mut seen = Seen::default();
    let mut with_stop = 0;
    for _ in 0..150 {
        step_and_check(&mut lb, "arrival", &mut seen);
        let bytes = lb.last_built_frame(0).to_vec();
        if bytes.is_empty() {
            continue;
        }
        let mut r = FrameReader::new(&bytes).unwrap();
        while let Some((sid, body)) = r.next_section().unwrap() {
            if sid == SectionId::Forecasts {
                wf::read(&mut ByteReader::new(body), |rec| {
                    if let Record::Arrival(a) = rec {
                        assert_eq!(a.line, id(1));
                        if a.stop.is_some() {
                            with_stop += 1;
                        }
                    }
                })
                .unwrap();
            }
        }
    }
    assert!(seen.totals.arrivals >= 20, "arrivals: {seen:?}");
    assert!(
        with_stop >= 5,
        "arrivals into the jam carry a stop: {with_stop}"
    );
    assert_eq!(held_lines(&lb), vec![id(1)], "only H is held");
}

// -- The tracker on a bare store ---------------------------------------------------------------

fn msgs(t: &Transport) -> Vec<(LineId, u8)> {
    t.forecast_messages()
        .iter()
        .map(|m| (m.line, m.kind))
        .collect()
}

/// Packs `n` items onto `l` from position `from`, `SPACING` apart (an inserter's `insert_at`).
fn pack(t: &mut Transport, l: LineId, from: u32, n: u32, item: u16) {
    for k in 0..n {
        t.insert_at(l, from + SP * k, Item(item)).unwrap();
    }
}

/// The event kinds (0078 A3): a creation, an edit and an unpredicted insert invalidate (run
/// list); a free-flowing tick marks nothing; a closed output is a state message (structure); the
/// halt it causes upstream is detected at the front and corrected by a state; a release likewise;
/// a lander whose stop is not the chain fires its due tick.
#[test]
fn forecast_tracker_marks_events() {
    let mut t = Transport::new(16, 512);
    let a = t.create(16 * 256, 24).unwrap();
    let b = t.create(4 * 256, 24).unwrap();
    t.set_out(a, Output::Next(b)).unwrap();
    t.set_out(b, Output::Sink).unwrap();
    pack(&mut t, a, 2048, 20, 1);
    t.advance();
    assert_eq!(
        msgs(&t),
        [(a, MSG_RUN_LIST), (b, MSG_RUN_LIST)],
        "created and edited: run lists"
    );
    for _ in 0..5 {
        t.advance();
        assert_eq!(msgs(&t), [], "free flow into a sink marks nothing");
    }
    // Close the sink: `b` gets a state (a structure change of motion); `a`'s front halts when it
    // reaches `b`'s tail, which the front check finds.
    t.set_out(b, Output::DeadEnd).unwrap();
    t.advance();
    assert_eq!(msgs(&t), [(b, MSG_STATE)], "a closed output is a state");
    let before = t.forecast_host_counters();
    let mut kinds = Vec::new();
    for _ in 0..250 {
        t.advance();
        kinds.extend(msgs(&t));
    }
    let c = t.forecast_host_counters();
    assert!(c.halts > before.halts, "a halt: {c:?}");
    assert!(
        kinds.contains(&(a, MSG_STATE)),
        "corrected by a state: {kinds:?}"
    );
    assert!(
        !kinds.iter().any(|&(_, k)| k == MSG_RUN_LIST),
        "no run list for a forming jam: {kinds:?}"
    );
    // Reopen: a state for `b`; `a`'s jam releases (moves although a stop said not).
    let before = t.forecast_host_counters();
    t.set_out(b, Output::Sink).unwrap();
    t.advance();
    let got = msgs(&t);
    assert!(got.contains(&(b, MSG_STATE)), "{got:?}");
    assert!(!got.iter().any(|&(_, k)| k == MSG_RUN_LIST), "{got:?}");
    for _ in 0..20 {
        t.advance();
    }
    assert!(t.forecast_host_counters().releases > before.releases);
    // An inserter's edit and an insert no schedule predicted: run lists.
    t.insert_at(a, 16 * 256 - 1, Item(4)).unwrap();
    t.advance();
    assert_eq!(msgs(&t), [(a, MSG_RUN_LIST)]);
    // An insert no declared spawner made is an arrival (its line is not resent).
    t.insert_back(b, Item(4)).unwrap();
    t.advance();
    assert!(!msgs(&t).contains(&(b, MSG_RUN_LIST)), "{:?}", msgs(&t));
    assert!(
        t.forecast_crossings()
            .iter()
            .any(|c| c.route() == engine::transport::ROUTE_INSERT && LineId(c.to) == b),
        "logged for its arrival"
    );
}

/// 0078 A3's classifier: a jam forming on a packed line is a `State` (the client re-stops its
/// `T - 1` list and lands where the advance did), never a `RunList`; an item's new stop that lies
/// ahead of where it is (here: the line ahead's tail moved back by an edit) is a `RunList`.
#[test]
fn forecast_classifier_state_vs_runlist() {
    let mut t = Transport::new(16, 512);
    let l = t.create(16 * 256, 24).unwrap();
    t.set_out(l, Output::Sink).unwrap();
    pack(&mut t, l, 100, 30, 2);
    t.advance();
    for _ in 0..3 {
        t.advance();
    }
    assert_eq!(msgs(&t), []);
    // Close it: the packed block halts at 0 front-first; every tick the model holds.
    t.set_out(l, Output::DeadEnd).unwrap();
    let mut kinds = Vec::new();
    for _ in 0..100 {
        t.advance();
        kinds.extend(msgs(&t));
    }
    assert_eq!(kinds, [(l, MSG_STATE)], "one state, at the close");
    let mut written = engine::bytes::CountSink::default();
    t.write_run_list(l, &mut written);
    assert!(
        t.run_list_bytes(l) >= written.0,
        "the put budget never prices a run list below its bytes"
    );
    assert_eq!(t.forecast_front_stop(l), Some(Some(0)));
    // A second line packed behind a jam, then the jam's tail edited away: its stop lies ahead.
    let m = t.create(4 * 256, 24).unwrap();
    t.set_out(m, Output::Next(l)).unwrap();
    pack(&mut t, m, 0, 8, 3);
    for _ in 0..3 {
        t.advance();
    }
    let tail = {
        let mut last = 0;
        t.items_in(l, &mut |_, p| last = p).unwrap();
        last
    };
    t.remove_at(l, tail).unwrap();
    t.advance();
    let got = msgs(&t);
    assert!(got.contains(&(l, MSG_RUN_LIST)), "the edited line: {got:?}");
}

/// M47 review, finding 10: a full segment pool while the end of a tick rebuilds a line's model
/// (its message already decided) leaves the line marked for the next tick's run list, so the debug
/// check of every model (`check_model`) holds and the client is told the whole list next tick.
#[test]
fn forecast_full_pool_in_the_message_loop_resends_next_tick() {
    let mut t = Transport::new(16, 512);
    let l = t.create(16 * 256, 24).unwrap();
    t.set_out(l, Output::Sink).unwrap();
    pack(&mut t, l, 1000, 10, 1);
    for _ in 0..3 {
        t.advance();
    }
    t.set_out(l, Output::DeadEnd).unwrap();
    t.debug_fail_segment_allocs(1);
    t.advance();
    assert_eq!(
        msgs(&t),
        [(l, MSG_STATE)],
        "the close, decided before the pool refused"
    );
    t.advance();
    assert_eq!(msgs(&t), [(l, MSG_RUN_LIST)], "resent the next tick");
    t.advance();
    assert_eq!(msgs(&t), [], "the model holds again");
}

/// M47 review 2, finding 7: the put budget's price of a run list is never below the bytes written,
/// also when a full segment pool refused a lander (the model then holds fewer items than the
/// line, and the list has a run more). A packed chain whose landers keep needing segments, the pool
/// refusing every third allocation, every line checked every tick.
#[test]
fn forecast_run_list_price_never_below_its_bytes() {
    let mut t = Transport::new(16, 512);
    let ls: Vec<LineId> = (0..3).map(|_| t.create(8 * 256, 24).unwrap()).collect();
    t.set_out(ls[0], Output::Next(ls[1])).unwrap();
    t.set_out(ls[1], Output::Next(ls[2])).unwrap();
    for (k, &l) in ls.iter().enumerate() {
        pack(&mut t, l, 10 + 7 * k as u32, 25, 1 + k as u16);
    }
    let (mut under, mut short) = (0, 0);
    for tick in 0..400u32 {
        if tick % 37 == 5 {
            // Close and open the front: halts, releases and landers off the chain.
            let out = if t.out(ls[2]) == Ok(Output::Sink) {
                Output::DeadEnd
            } else {
                Output::Sink
            };
            t.set_out(ls[2], out).unwrap();
        }
        if tick % 5 == 0 {
            let _ = t.insert_back(ls[0], Item(4 + (tick % 2) as u16));
        }
        t.debug_fail_segment_allocs(u32::from(tick % 3 == 0));
        t.advance();
        for &l in &ls {
            let mut written = engine::bytes::CountSink::default();
            t.write_run_list(l, &mut written);
            if t.run_list_bytes(l) < written.0 {
                under += 1;
            }
            short += usize::from(t.debug_forecast_short(l));
        }
    }
    println!("price: {short} line-ticks with a refused lander");
    assert!(short > 0, "the pool refused a lander");
    assert_eq!(under, 0, "ticks a list was priced below its bytes");
}

/// The cheap forecast (0078 A3): stops `SPACING` behind every item ahead to a dead end, across at
/// most `MAX_DEPTH` lines; none past a sink or beyond the horizon unless the line there held.
#[test]
fn forecast_builder_depth_and_stops() {
    let mut t = Transport::new(32, 1024);
    // Ten lines of 1,024 in a chain, the last a dead end holding 3 items.
    let ls: Vec<LineId> = (0..10).map(|_| t.create(1024, 24).unwrap()).collect();
    for k in 0..9 {
        t.set_out(ls[k], Output::Next(ls[k + 1])).unwrap();
    }
    pack(&mut t, ls[9], 500, 3, 1);
    // From line k the dead end is 9 - k lines ahead: within 8 for k >= 1.
    for (k, &l) in ls.iter().enumerate().skip(1).take(8) {
        let ahead = 9 - k as i32;
        let want = -1024 * ahead + 3 * SP as i32;
        assert_eq!(t.forecast_front_stop(l), Some(Some(want)), "line {k}");
    }
    assert_eq!(
        t.forecast_front_stop(ls[0]),
        Some(None),
        "nine lines ahead: beyond the horizon, nothing held there"
    );
    assert_eq!(t.forecast_front_stop(ls[9]), Some(Some(0)), "its own front");
    // A sink at the end: no stop anywhere.
    t.set_out(ls[9], Output::Sink).unwrap();
    assert_eq!(t.forecast_front_stop(ls[5]), Some(None));
    // At the horizon a line whose front held this tick counts as a jam: a fresh chain whose last
    // line dead-ends full; line 8's front item waits behind it; from line 0, line 8 is at depth 8.
    let mut t = Transport::new(32, 1024);
    let ls: Vec<LineId> = (0..10).map(|_| t.create(1024, 24).unwrap()).collect();
    for k in 0..9 {
        t.set_out(ls[k], Output::Next(ls[k + 1])).unwrap();
    }
    pack(&mut t, ls[9], 0, 16, 1);
    pack(&mut t, ls[8], 10, 2, 1);
    t.advance();
    t.advance();
    let front = |t: &Transport, l| {
        let mut f = None;
        t.items_in(l, &mut |_, p| {
            f.get_or_insert(p);
        })
        .unwrap();
        f
    };
    assert_eq!(front(&t, ls[8]), Some(0), "line 8's front waits at 0");
    assert_eq!(
        t.forecast_front_stop(ls[0]),
        Some(Some(-1024 * 8 + 2 * SP as i32)),
        "behind line 8's held front, 8 lines ahead"
    );
    assert_eq!(
        t.forecast_front_stop(ls[1]),
        Some(Some(-1024 * 8 + 18 * SP as i32)),
        "line 1 sees the dead end itself"
    );
    // A merge whose front item waits is a dead end; one that flows is not.
    let s = t.create(1024, 24).unwrap();
    let main = t.create(4096, 24).unwrap();
    pack(&mut t, main, 1900, 4, 1);
    t.set_out(
        s,
        Output::Merge {
            line: main,
            at: 2000,
        },
    )
    .unwrap();
    t.insert_at(s, 10, Item(2)).unwrap();
    t.advance();
    assert_eq!(t.forecast_front_stop(s), Some(Some(0)), "blocked merge");
}

/// 0078 A3's spawner forecast: a declared schedule followed by the game's tick rule needs no
/// message after the line's first list, through a jam (refusals for room are predicted) and its
/// clearing; an insert the schedule did not predict is a counted mismatch and a run list.
#[test]
fn forecast_spawner_schedule_predicts_inserts() {
    reset();
    once(1, |t| {
        line(t, 0, 4, 10, 24);
    });
    spawner(0, 384, 6, 1);
    once(140, |t| t.set_out(id(0), Output::Sink).unwrap());
    let mut lb = loopback();
    let seen = run(&mut lb, 200, "spawner");
    let c = host_counters(&lb);
    assert_eq!(c.spawner_mismatches, 0);
    assert_eq!(seen.late_run_lists, 0, "{seen:?}");
    assert!(seen.items > 2000, "{seen:?}");
    let t = lb.host.sim().unwrap().authority().store().transport();
    let mut written = engine::bytes::CountSink::default();
    t.write_run_list(id(0), &mut written);
    assert!(
        t.run_list_bytes(id(0)) >= written.0,
        "never priced below its bytes, spawner included"
    );
    // A game inserting twice in one tick: a mismatch, the line's list resent.
    once(205, |t| {
        let _ = t.insert_back(id(0), Item(1));
    });
    let seen = run(&mut lb, 10, "spawner mismatch");
    let c = host_counters(&lb);
    assert!(c.spawner_mismatches >= 1, "{c:?}");
    assert!(seen.totals.run_lists >= 1, "{seen:?}");
}

// -- Section 13's bytes ------------------------------------------------------------------------

fn encode(f: impl Fn(&mut SliceSink)) -> Vec<u8> {
    let mut buf = vec![0u8; 4096];
    let mut sink = SliceSink::new(&mut buf);
    f(&mut sink);
    let n = sink.finish().unwrap();
    buf.truncate(n);
    buf
}

#[derive(Debug, PartialEq)]
enum Owned {
    State(State),
    Arrival(Arrival),
    RunList(LineId, Vec<Run>, Option<Spawner>),
    Unknown(LineId),
}

fn decode(bytes: &[u8]) -> Result<Vec<Owned>, WireError> {
    let mut got = Vec::new();
    wf::read(&mut ByteReader::new(bytes), |r| {
        got.push(match r {
            Record::State(s) => Owned::State(s),
            Record::Arrival(a) => Owned::Arrival(a),
            Record::RunList(l) if l.unknown => Owned::Unknown(l.line),
            Record::RunList(l) => Owned::RunList(l.line, l.runs.collect(), l.spawner),
        })
    })?;
    Ok(got)
}

fn sample() -> (Vec<Owned>, Vec<u8>) {
    let state = State {
        line: LineId(3),
        front_stop: Some(-128),
        paused: false,
        resumed: true,
    };
    let state2 = State {
        line: LineId(300),
        front_stop: None,
        paused: true,
        resumed: false,
    };
    let arr = Arrival {
        line: LineId(4),
        item: Item(9),
        pos: 4000,
        stop: Some(64),
    };
    let arr2 = Arrival {
        line: LineId(4),
        item: Item(9),
        pos: 4064,
        stop: None,
    };
    let runs = vec![
        Run {
            item: Item(1),
            count: 3,
            pos: 0,
            stop: Some(0),
        },
        Run {
            item: Item(2),
            count: 1,
            pos: 200,
            stop: None,
        },
    ];
    let sp = Spawner {
        period: 640,
        acc: 128,
        kinds: 6,
        next: Item(5),
        paused: true,
    };
    let bytes = encode(|s| {
        wf::write_state(s, &state);
        wf::write_state(s, &state2);
        wf::write_arrival(s, &arr);
        wf::write_arrival(s, &arr2);
        wf::write_run_list(s, LineId(2), &runs, Some(&sp));
        wf::write_run_list(s, LineId(70_000), &[], None);
        wf::write_run_list_unknown(s, LineId(70_001));
    });
    let owned = vec![
        Owned::State(state),
        Owned::State(state2),
        Owned::Arrival(arr),
        Owned::Arrival(arr2),
        Owned::RunList(LineId(2), runs, Some(sp)),
        Owned::RunList(LineId(70_000), vec![], None),
        Owned::Unknown(LineId(70_001)),
    ];
    (owned, bytes)
}

/// Every record kind and flag round-trips; the sizes are `wire/CLAUDE.md`'s.
#[test]
fn wire_forecast_round_trip() {
    let (owned, bytes) = sample();
    assert_eq!(decode(&bytes).unwrap(), owned);
    let one = |f: &dyn Fn(&mut SliceSink)| encode(f).len();
    assert_eq!(
        one(&|s| wf::write_state(
            s,
            &State {
                line: LineId(5),
                front_stop: None,
                paused: false,
                resumed: false
            }
        )),
        3,
        "a state without a stop"
    );
    assert_eq!(
        one(&|s| wf::write_state(
            s,
            &State {
                line: LineId(5),
                front_stop: Some(-64),
                paused: false,
                resumed: false
            }
        )),
        7,
        "a state with a stop"
    );
    assert_eq!(
        one(&|s| wf::write_arrival(
            s,
            &Arrival {
                line: LineId(5),
                item: Item(1),
                pos: 10,
                stop: None
            }
        )),
        9
    );
    assert_eq!(
        one(&|s| wf::write_run_list(
            s,
            LineId(5),
            &[Run {
                item: Item(1),
                count: 1,
                pos: 0,
                stop: None
            }],
            None
        )),
        4 + 12,
        "a one-run list"
    );
}

/// Every rejection `wire/forecast.rs` names, and every truncation of a valid section.
#[test]
fn wire_forecast_rejects_malformed() {
    let (owned, bytes) = sample();
    // The records' ends: a cut there is a valid shorter section; anywhere else it is malformed.
    let mut ends = Vec::new();
    for n in 1..=owned.len() {
        let end = (1..=bytes.len())
            .find(|&cut| decode(&bytes[..cut]).is_ok_and(|v| v.len() == n))
            .expect("every prefix of records decodes");
        ends.push(end);
    }
    for cut in 1..bytes.len() {
        let got = decode(&bytes[..cut]);
        if ends.contains(&cut) {
            assert!(got.is_ok(), "cut {cut} at a record's end");
        } else {
            assert_eq!(got, Err(WireError::Malformed), "cut {cut}");
        }
    }
    let bad = |f: &dyn Fn(&mut SliceSink)| decode(&encode(f));
    let st = |line: u32| State {
        line: LineId(line),
        front_stop: None,
        paused: false,
        resumed: false,
    };
    assert_eq!(
        bad(&|s| s.put_u8(7)),
        Err(WireError::Malformed),
        "unknown tag"
    );
    assert_eq!(
        bad(&|s| wf::write_state(s, &st(0))),
        Err(WireError::Malformed),
        "line 0"
    );
    assert_eq!(
        bad(&|s| {
            wf::write_state(s, &st(5));
            wf::write_state(s, &st(5));
        }),
        Err(WireError::Malformed),
        "lines not ascending"
    );
    assert_eq!(
        bad(&|s| {
            wf::write_run_list(s, LineId(1), &[], None);
            wf::write_state(s, &st(5));
        }),
        Err(WireError::Malformed),
        "kinds out of order"
    );
    assert_eq!(
        bad(&|s| {
            s.put_u8(0);
            s.put_varint(5);
            s.put_u8(0b110);
        }),
        Err(WireError::Malformed),
        "paused with resumed"
    );
    assert_eq!(
        bad(&|s| {
            s.put_u8(0);
            s.put_varint(5);
            s.put_u8(0b1000);
        }),
        Err(WireError::Malformed),
        "an undefined state flag"
    );
    let arr = |pos: u32, item: u16| Arrival {
        line: LineId(4),
        item: Item(item),
        pos,
        stop: None,
    };
    assert_eq!(
        bad(&|s| {
            wf::write_arrival(s, &arr(10, 1));
            wf::write_arrival(s, &arr(10, 1));
        }),
        Err(WireError::Malformed),
        "arrivals not ascending"
    );
    assert_eq!(
        bad(&|s| wf::write_arrival(s, &arr(10, 0))),
        Err(WireError::Malformed),
        "item 0"
    );
    let run = |pos: u32, count: u16| Run {
        item: Item(1),
        count,
        pos,
        stop: None,
    };
    assert_eq!(
        bad(&|s| wf::write_run_list(s, LineId(1), &[run(0, 0)], None)),
        Err(WireError::Malformed),
        "a run of 0"
    );
    assert_eq!(
        bad(&|s| wf::write_run_list(s, LineId(1), &[run(0, 2), run(64, 1)], None)),
        Err(WireError::Malformed),
        "positions not increasing (the second run starts at the first's last item)"
    );
    assert_eq!(
        decode(&encode(|s| wf::write_run_list(
            s,
            LineId(1),
            &[run(0, 2), run(65, 1)],
            None
        )))
        .map(|v| v.len()),
        Ok(1),
        "a squashed pair is increasing"
    );
    assert_eq!(
        bad(&|s| wf::write_run_list(
            s,
            LineId(1),
            &[],
            Some(&Spawner {
                period: 0,
                acc: 0,
                kinds: 0,
                next: Item(1),
                paused: false
            })
        )),
        Err(WireError::Malformed),
        "a spawner period of 0"
    );
    // M47 review, finding 11: every undefined flag bit and a spawner's next item 0.
    let arrival_flags = |f: u8| {
        decode(&encode(|s| {
            s.put_u8(1);
            s.put_varint(4);
            s.put_u16(1);
            s.put_u32(10);
            s.put_u8(f);
            if f & 1 != 0 {
                s.put_i32(0);
            }
        }))
    };
    assert!(arrival_flags(1).is_ok());
    for f in [2u8, 0x81] {
        assert_eq!(
            arrival_flags(f),
            Err(WireError::Malformed),
            "arrival flags {f:#x}"
        );
    }
    let list_flags = |f: u8| {
        decode(&encode(|s| {
            s.put_u8(2);
            s.put_varint(4);
            s.put_u8(f);
            s.put_varint(0);
        }))
    };
    assert!(list_flags(0).is_ok());
    for f in [3u8, 4, 0x80] {
        assert_eq!(
            list_flags(f),
            Err(WireError::Malformed),
            "list flags {f:#x}"
        );
    }
    let spawner = |next: u16, flags: u8| {
        decode(&encode(|s| {
            s.put_u8(2);
            s.put_varint(4);
            s.put_u8(1);
            s.put_varint(0);
            s.put_varint(512);
            s.put_varint(0);
            s.put_u16(0);
            s.put_u16(next);
            s.put_u8(flags);
        }))
    };
    assert!(spawner(1, 1).is_ok());
    assert_eq!(
        spawner(0, 0),
        Err(WireError::Malformed),
        "a spawner's next item 0"
    );
    assert_eq!(
        spawner(1, 2),
        Err(WireError::Malformed),
        "spawner flags 0x2"
    );
}

/// A straight west-going path along tile row `row` from tile `x0` for `tiles` tiles: its front
/// point (position 0, the anchor) is at `x0`.
fn west(x0: i32, row: i32, tiles: u32) -> Segment {
    Segment {
        len: tiles * 256,
        geometry: Geometry::Straight {
            from: WorldPos {
                x: x0 * TILE + 128,
                y: row * TILE + 128,
            },
            to: WorldPos {
                x: (x0 - tiles as i32) * TILE + 128,
                y: row * TILE + 128,
            },
        },
    }
}

/// `(line, puts, run lists)` of the frame `build_frame` last made for client 0, added into `acc`.
fn count_by_line(lb: &Loopback<FcGame>, acc: &mut Vec<(LineId, u32, u32)>) {
    let bytes = lb.last_built_frame(0);
    if bytes.is_empty() {
        return;
    }
    let mut bump = |l: LineId, put: u32, list: u32| match acc.iter_mut().find(|e| e.0 == l) {
        Some(e) => {
            e.1 += put;
            e.2 += list;
        }
        None => acc.push((l, put, list)),
    };
    let mut r = FrameReader::new(bytes).unwrap();
    while let Some((sid, body)) = r.next_section().unwrap() {
        match sid {
            SectionId::LineStructs => {
                engine::wire::lines::read(&mut ByteReader::new(body), |rec| {
                    if let engine::wire::lines::Record::Put(p) = rec {
                        bump(p.id, 1, 0);
                    }
                })
                .unwrap();
            }
            SectionId::Forecasts => wf::read(&mut ByteReader::new(body), |rec| {
                if let Record::RunList(rl) = rec {
                    bump(rl.line, 0, 1);
                }
            })
            .unwrap(),
            _ => {}
        }
    }
}

/// M48c (0078 A10): a snapshot re-puts only what the client lacks. Six lines run west from tiles
/// 200-205 (anchored in chunk (6, 0), which the first view does not hold) to tile 8, so the client
/// holds each through the chunks it does hold, items flowing (a declared spawner each, into a
/// sink); a seventh lies wholly inside chunk (6, 0). The camera then pans over the anchors: the
/// chunk enters by snapshot (its anchored lines force it), and the six held lines are not put again
/// and their lists not resent, the seventh is put once with its list. Hash-all all along (the
/// chunk hash covers the anchored structures, which the replica kept across the snapshot), no
/// desync; the replica's items equal the host's on every held line every tick.
#[test]
fn host_snapshot_does_not_reput_held_lines() {
    const N: usize = 6;
    reset();
    once(1, |t| {
        for k in 0..N as i32 {
            let l = t.create(192 * 256, 24).unwrap();
            t.set_segments(l, &[west(200 + k, 4 + k, 192)]).unwrap();
            t.set_out(l, Output::Sink).unwrap();
            IDS.with(|i| i.borrow_mut().push(l));
        }
        let inside = t.create(8 * 256, 24).unwrap();
        t.set_segments(inside, &[west(212, 20, 8)]).unwrap();
        t.set_out(inside, Output::Sink).unwrap();
        IDS.with(|i| i.borrow_mut().push(inside));
    });
    for k in 0..=N {
        spawner(k, 384 + 64 * k as u32, (k % 3) as u16, 1);
    }
    let anchor = ChunkCoord::new(6, 0);
    let mut lb = loopback();
    let mut seen = Seen::default();
    let mut counts = Vec::new();
    for _ in 0..60 {
        step_and_check(&mut lb, "before the pan", &mut seen);
        count_by_line(&lb, &mut counts);
    }
    assert!(
        !lb.host.debug_held(lb.conn(0)).contains(&anchor),
        "the anchor chunk is not held before the pan"
    );
    let held: Vec<LineId> = (0..N).map(id).collect();
    assert_eq!(
        held_lines(&lb),
        held,
        "the six crossing lines are held through the view, the seventh is not"
    );
    lb.set_camera(
        0,
        CameraReport {
            center_x: 208,
            ..camera()
        },
    );
    let mut snapshots = 0u32;
    for _ in 0..60 {
        step_and_check(&mut lb, "after the pan", &mut seen);
        count_by_line(&lb, &mut counts);
        let bytes = lb.last_built_frame(0);
        if !bytes.is_empty() {
            let mut r = FrameReader::new(bytes).unwrap();
            while let Some((sid, _)) = r.next_section().unwrap() {
                snapshots += u32::from(sid == SectionId::ChunkSnapshots);
            }
        }
    }
    assert_eq!(lb.client(0).desyncs().count(), 0, "hash-all saw no desync");
    assert_eq!(lb.host.desyncs().count(), 0);
    assert!(
        lb.host.debug_held(lb.conn(0)).contains(&anchor),
        "the anchor chunk entered"
    );
    assert_eq!(
        snapshots, 1,
        "frames with a snapshot: the anchor chunk entered by one"
    );
    let mut all = held.clone();
    all.push(id(N));
    assert_eq!(held_lines(&lb), all, "every line held at the end");
    counts.sort_unstable();
    let expected: Vec<(LineId, u32, u32)> = all.iter().map(|&l| (l, 1, 1)).collect();
    assert_eq!(
        counts, expected,
        "(line, puts, run lists): each line put once with its list"
    );
    assert_eq!(
        lb.client(0).replica().region_hash(),
        lb.host.region_hash(lb.conn(0)),
        "the region hashes cover the kept structures"
    );
    assert_eq!(seen.unknown, 0);
    if std::env::var_os("MEASURE").is_some() {
        println!("{seen:?}, {snapshots} frames with snapshots");
    }
    assert_eq!(
        (seen.compared, seen.items, seen.late_run_lists),
        (774, 17_024, 0),
        "(line-ticks, items) compared, lists to lines held before their frame"
    );
}

/// `(puts, run lists)` of line `k` (none before the rules create it) in the frame `build_frame`
/// last made for client 0.
fn counts_of(lb: &Loopback<FcGame>, k: usize) -> (u32, u32) {
    let Some(l) = IDS.with(|i| i.borrow().get(k).copied()) else {
        return (0, 0);
    };
    let mut acc = Vec::new();
    count_by_line(lb, &mut acc);
    acc.iter().find(|e| e.0 == l).map_or((0, 0), |e| (e.1, e.2))
}

/// The camera over the anchor chunk (6, 0) of the `west(200 + k, ..)` lines.
fn over_anchor() -> CameraReport {
    CameraReport {
        center_x: 208,
        ..camera()
    }
}

/// M48c fix round 1: a held line whose list the client holds `unknown` is put again, with its
/// (`unknown`) list, when its anchor chunk snapshots (`LineRoute::holds_current`'s list half). A
/// 4 KiB frame buffer (a 1 KiB put budget); 200 items of alternating kinds at rest at the dead end
/// (200 runs, about 2.4 KB) on a line running west from tile 200 (anchored in chunk (6, 0)) into
/// the view: held from the first frames, its list `unknown`; the camera then pans over the anchor.
#[test]
fn host_snapshot_reputs_an_unknown_held_line() {
    reset();
    once(1, |t| {
        let l = t.create(192 * 256, 24).unwrap();
        t.set_segments(l, &[west(200, 4, 192)]).unwrap();
        for k in 0..200u32 {
            t.insert_at(l, SP * k, Item(1 + (k % 2) as u16)).unwrap();
        }
        IDS.with(|i| i.borrow_mut().push(l));
    });
    let mut lb = loopback();
    lb.set_frame_buf_len(4096);
    let mut total = (0u32, 0u32);
    let add = |lb: &Loopback<FcGame>, total: &mut (u32, u32)| {
        let (p, r) = counts_of(lb, 0);
        total.0 += p;
        total.1 += r;
    };
    for _ in 0..40 {
        lb.step();
        add(&lb, &mut total);
    }
    let l = id(0);
    assert_eq!(held_lines(&lb), vec![l], "held through the view");
    assert!(
        lb.client(0).replica().forecast_unknown(l),
        "its list is unknown"
    );
    assert_eq!(total, (1, 1), "put once, with an unknown list");
    lb.set_camera(0, over_anchor());
    for _ in 0..40 {
        lb.step();
        add(&lb, &mut total);
    }
    assert!(
        lb.host
            .debug_held(lb.conn(0))
            .contains(&ChunkCoord::new(6, 0)),
        "the anchor chunk entered"
    );
    assert_eq!(
        total,
        (2, 2),
        "(puts, lists) of the unknown line: put again by its anchor's snapshot"
    );
    assert!(lb.client(0).replica().forecast_unknown(l));
    assert_eq!(lb.host.debug_overflows(lb.conn(0)), 0);
    assert_eq!(lb.client(0).desyncs().count(), 0, "hash-all saw no desync");
}

/// M48c fix round 1: a held line whose structure changes on the tick its anchor chunk snapshots
/// is held at an older `structure_version` than the host's, so the snapshot forces it (fresh, its
/// list riding) rather than sending a plain update (a speed change of a line at rest is no list).
/// The line runs west from tile 200 (anchor chunk (6, 0)) into the view, 40 items at rest at its
/// dead end; the speed changes on the tick the camera's move over the anchor arrives.
#[test]
fn host_snapshot_reputs_a_line_changed_that_tick() {
    use std::cell::Cell;
    use std::rc::Rc;
    reset();
    once(1, |t| {
        let l = t.create(192 * 256, 24).unwrap();
        t.set_segments(l, &[west(200, 4, 192)]).unwrap();
        for k in 0..40u32 {
            t.insert_at(l, SP * k, Item(1)).unwrap();
        }
        IDS.with(|i| i.borrow_mut().push(l));
    });
    let edit = Rc::new(Cell::new(false));
    let flag = edit.clone();
    rule(move |_, t| {
        if flag.replace(false) {
            t.set_speed(id(0), 32).unwrap();
        }
    });
    let mut lb = loopback();
    let mut seen = Seen::default();
    let mut total = (0u32, 0u32);
    for _ in 0..40 {
        step_and_check(&mut lb, "before", &mut seen);
        let (p, r) = counts_of(&lb, 0);
        total = (total.0 + p, total.1 + r);
    }
    assert_eq!(total, (1, 1), "held from the first frames, with its list");
    lb.set_camera(0, over_anchor());
    edit.set(true);
    step_and_check(&mut lb, "the pan", &mut seen);
    let (p, r) = counts_of(&lb, 0);
    assert!(
        lb.host
            .debug_held(lb.conn(0))
            .contains(&ChunkCoord::new(6, 0)),
        "the anchor chunk entered on the edit's tick"
    );
    assert_eq!(
        (p, r),
        (1, 1),
        "(puts, lists) in the snapshot frame: forced, fresh, its list riding"
    );
    for _ in 0..40 {
        step_and_check(&mut lb, "after", &mut seen);
        let (p, r) = counts_of(&lb, 0);
        total = (total.0 + p, total.1 + r);
    }
    assert_eq!(total, (1, 1), "nothing more after the snapshot");
    assert_eq!(lb.client(0).replica().transport().speed(id(0)), Ok(32));
    assert_eq!(lb.client(0).desyncs().count(), 0, "hash-all saw no desync");
}

/// M48c (0079 §17 (a), the resync departure): a snapshot answering the client's `ResyncChunk`
/// re-puts every line anchored in the chunk, so a structure corrupted at its current version is
/// repaired in one round. Three lines anchored in chunk (0, 0), fed by declared spawners; the
/// replica's copy of the first is corrupted (its speed flipped); hash-all reports the chunk once,
/// the answer re-puts all three with their lists, and the replica equals the host again, items
/// exact on every held line every tick afterwards, no second report.
#[test]
fn host_resync_answer_reputs_every_anchored_line() {
    reset();
    once(1, |t| {
        for k in 0..3 {
            let l = line(t, 2, 4 + 2 * k, 8, 24);
            t.set_out(l, Output::Sink).unwrap();
        }
    });
    for k in 0..3 {
        spawner(k, 384, 0, 1 + k as u16);
    }
    let mut lb = loopback();
    let mut seen = Seen::default();
    for _ in 0..30 {
        step_and_check(&mut lb, "before", &mut seen);
    }
    assert!(
        lb.client_mut(0).debug_corrupt_line(id(0)),
        "line 0 corrupted"
    );
    let mut counts = Vec::new();
    for _ in 0..20 {
        lb.step();
        count_by_line(&lb, &mut counts);
    }
    counts.sort_unstable();
    assert_eq!(lb.host.desyncs().count(), 1, "one report, answered once");
    assert_eq!(
        counts,
        (0..3).map(|k| (id(k), 1, 1)).collect::<Vec<_>>(),
        "(line, puts, lists): the answer re-put every anchored line"
    );
    assert_eq!(lb.host.debug_resync_notes(lb.conn(0)), 0, "the note went");
    let reports = lb.client(0).desyncs().count();
    for _ in 0..30 {
        step_and_check(&mut lb, "after", &mut seen);
    }
    assert_eq!(lb.client(0).desyncs().count(), reports, "no further report");
    assert_eq!(
        lb.client(0).replica().region_hash(),
        lb.host.region_hash(lb.conn(0)),
        "repaired"
    );
}

/// M48c fix round 1 (review): a resync note whose chunk leaves before the answering snapshot goes
/// out leaves with it, so stale notes cannot fill `LineRoute::resync`'s 256 slots and silence later
/// reports. The client's copy of a line anchored in chunk (0, 0) is corrupted; once it has
/// reported, every frame overflows (a 64 B buffer: the answer never goes) and the camera moves far
/// away; the report arrives (one note), and when the chunk leaves the note is gone.
#[test]
fn host_resync_note_leaves_with_its_chunk() {
    reset();
    once(1, |t| {
        let l = line(t, 2, 4, 8, 24);
        t.set_out(l, Output::Sink).unwrap();
    });
    spawner(0, 384, 0, 1);
    let mut lb = loopback();
    for _ in 0..30 {
        lb.step();
    }
    assert!(lb.client_mut(0).debug_corrupt_line(id(0)));
    let mut ticks = 0;
    while lb.client(0).desyncs().count() == 0 {
        lb.step();
        ticks += 1;
        assert!(ticks < 20, "the client never reported");
    }
    lb.set_frame_buf_len(64);
    lb.set_camera(
        0,
        CameraReport {
            center_x: FAR * 4,
            ..camera()
        },
    );
    lb.step();
    assert_eq!(lb.host.desyncs().count(), 1, "the report arrived");
    assert_eq!(
        lb.host.debug_resync_notes(lb.conn(0)),
        1,
        "noted, unanswered"
    );
    let anchor = ChunkCoord::new(0, 0);
    let mut ticks = 0;
    while lb.host.debug_held(lb.conn(0)).contains(&anchor) {
        lb.step();
        ticks += 1;
        assert!(ticks < 400, "the anchor chunk never left");
    }
    assert_eq!(
        lb.host.debug_resync_notes(lb.conn(0)),
        0,
        "the note left with its chunk"
    );
}
