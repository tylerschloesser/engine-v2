//! M53 (docs/decisions/0079 §21): the spawner schedule is line state and `advance` performs its
//! insert, on a bare `Transport` (the host's tracker is on in every reserved store). The loopback
//! cases (`schedule_is_state`'s state hash, `schedule_inserts_at_the_predicted_ticks`,
//! `schedule_survives_restore`) are in `forecasts.rs`, beside the arbiter they reuse.
//!
//! - `schedule_credit_never_bursts`: a stalled schedule holds its credit, unchanged, and inserts
//!   once when room returns, then at its own cadence.
//! - `schedule_paused_by_cap`: the item cap pauses it (a `State` with `paused`), the next success
//!   resumes it (`resumed`).
//! - `schedule_follows_surgery`: `join` moves `back`'s to the merged line, `split` to the back
//!   piece, `destroy` drops it, two meeting at a `join` is `Unsupported`.
//! - `insert_back_on_a_scheduled_line_is_refused`: `Err(Scheduled)` (a debug build panics), and
//!   `set_spawner`'s own refusals.

use engine::bytes::SliceSink;
use engine::transport::{
    Item, LineId, MSG_STATE, Output, Schedule, Transport, TransportError, TransportRead,
    TransportWrite,
};

const TILE: u32 = 256;

fn encode(t: &Transport) -> Vec<u8> {
    let mut buf = vec![0u8; 1 << 16];
    let mut sink = SliceSink::new(&mut buf);
    t.write_canonical(&mut sink);
    let n = sink.finish().expect("fits");
    buf.truncate(n);
    buf
}

fn items(t: &Transport, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    t.items_in(l, &mut |item, pos| v.push((item.0, pos)))
        .expect("the line exists");
    v
}

fn sched(period: u32, next: u16) -> Schedule {
    Schedule {
        period,
        acc: 0,
        kinds: 0,
        next: Item(next),
    }
}

/// 7.5 items a second at 20 Hz (`5,120 / 7.5`, rounded): the reference game's rate.
const PERIOD: u32 = 683;

/// The README's spawner line (0079 §21: "waiting while full, never a burst"). One 4-tile dead end
/// at speed 24 fed at `PERIOD`: it fills (16 items, the 17th would land past `len - 1`) and the
/// schedule stalls. Over 100 stalled ticks the credit never moves (an attempt is due every tick,
/// refused for room, `acc -= 256` after `acc += 256`) and nothing is inserted. At tick 300 the line
/// sinks: the back item leaves the back tile at tick 301's advance, so tick 302's step inserts
/// exactly once (at 1,000, moved to 976), and the next inserts come at the schedule's own cadence
/// from the credit left (`acc - 427` after that success), never one a tick.
#[test]
fn schedule_credit_never_bursts() {
    let mut t = Transport::new(4, 64);
    let l = t.create(4 * TILE, 24).unwrap();
    t.set_spawner(l, Some(sched(PERIOD, 1))).unwrap();
    for _ in 0..200 {
        t.advance();
    }
    assert_eq!(t.count(l), Ok(16), "the dead end filled");
    let (stalled, paused) = t.schedule(l).unwrap().expect("scheduled");
    assert!(!paused, "a room refusal never pauses");
    let n0 = t.scheduled_inserts_total();
    assert_eq!(n0, 16);
    assert_eq!(
        stalled.acc, STALLED_ACC,
        "an attempt is due every stalled tick (acc + 256 >= 683): {stalled:?}"
    );
    for k in 0..100 {
        t.advance();
        let (s, _) = t.schedule(l).unwrap().unwrap();
        assert_eq!(s, stalled, "stalled tick {k}: the credit held, unchanged");
        assert_eq!(
            t.scheduled_inserts_total(),
            n0,
            "stalled tick {k}: no insert"
        );
    }
    t.set_out(l, Output::Sink).unwrap();
    // Ticks 301.. : the tick of every insert, and the items each tick inserted.
    let mut at = Vec::new();
    for tick in 301..=320u32 {
        let before = t.scheduled_inserts_total();
        t.advance();
        let d = t.scheduled_inserts_total() - before;
        assert!(d <= 1, "tick {tick}: {d} inserts");
        if d == 1 {
            at.push(tick);
        }
        if tick == 302 {
            assert_eq!(items(&t, l).last(), Some(&(1, 976)), "tick 302's insert");
        }
    }
    assert_eq!(
        at, INSERT_TICKS_AFTER_STALL,
        "one insert when room returns, then the cadence ({stalled:?})"
    );
}

/// The credit the stalled schedule holds (`>= 683 - 256`: due every tick).
const STALLED_ACC: u32 = 592;

/// The inserts of `schedule_credit_never_bursts` after the stall: tick 302 when room returns
/// (`592 + 256 - 683` = 165 left), then every 2 or 3 ticks from that credit (305 at 933, 307 at
/// 762, ...: 683 / 256 = 2.67 ticks an item), never one a tick.
const INSERT_TICKS_AFTER_STALL: [u32; 7] = [302, 305, 307, 310, 313, 315, 318];

/// The item cap pauses a schedule (0078 A3 rule 4's `paused`, now state): caps 6 items; line `C`
/// holds four items put by `insert_at`, line `A` (16 tiles, a dead end) is scheduled every tick.
/// `A` inserts at ticks 1 and 3 (4,072 then `max(4,072, 4,024 + 64)`; tick 2's lands past 4,095),
/// so the store holds 6 items and tick 4's step is refused `Full`: that tick's message
/// for `A` is a `State` with `paused` and the schedule reads paused, its credit held (`acc` 0:
/// `+ 256 - 256`, no burst once it resumes). Nothing is said for `A` while it stays paused. At tick
/// 40 one item is removed from `C` before the advance (`C`'s own list is resent): that tick's step
/// inserts on `A`, which resumes (a `State` with `resumed`, unpaused), and tick 41's meets the cap
/// again and pauses (a `State` with `paused`). Every message for `A` is one of those three states; the tracker
/// counts two pauses, one resume and no mismatch.
#[test]
fn schedule_paused_by_cap() {
    let mut t = Transport::new(4, 6);
    let c = t.create(8 * TILE, 24).unwrap();
    for k in 0..4u32 {
        t.insert_at(c, 100 + 300 * k, Item(9)).unwrap();
    }
    let a = t.create(16 * TILE, 24).unwrap();
    t.set_spawner(a, Some(sched(256, 1))).unwrap();
    // `(tick, paused, resumed)` of every message for `A` after its first tick (whose run list
    // carries the new schedule).
    let mut said = Vec::new();
    for tick in 1..=60u32 {
        if tick == 40 {
            assert_eq!(t.remove_at(c, 100), Ok(Some(Item(9))));
        }
        t.advance();
        let (s, paused) = t.schedule(a).unwrap().unwrap();
        if let Some(m) = t.forecast_message(a).copied()
            && tick > 1
        {
            assert_eq!(m.kind, MSG_STATE, "tick {tick}: a state");
            assert_eq!(paused, m.paused, "tick {tick}: the schedule reads as said");
            said.push((tick, m.paused, m.resumed));
        }
        if paused {
            assert_eq!(s.acc, 0, "tick {tick}: the credit held while paused");
        }
    }
    assert_eq!(t.items_len(), 6, "the cap binds again");
    assert_eq!(
        said,
        [(4, true, false), (40, false, true), (41, true, false)],
        "paused at the cap; resumed by the step after the removal; paused again"
    );
    let hc = t.forecast_host_counters();
    assert_eq!((hc.pauses, hc.resumes, hc.spawner_mismatches), (2, 1, 0));
}

/// Surgery follows the line's back (0079 §21). `join(F, B)`: `B`'s schedule (state, credit and
/// next item as they stand) moves to `F`, and the next insert lands at the joined line's back. A
/// `join` whose front is scheduled is `Unsupported` and the store unchanged, whether the back is
/// scheduled too (two would meet) or not (M53 fix round 1: the front's schedule would sit
/// mid-line, `B.len` upstream of the joined line's back). `split(L, 1,024)`: the schedule moves to the new back
/// piece, which takes the inserts from then on (`L` keeps its own items only). `destroy` drops it:
/// no insert after, and the reused slot's new line has none.
#[test]
fn schedule_follows_surgery() {
    let mut t = Transport::new(16, 256);
    // join
    let f = t.create(4 * TILE, 24).unwrap();
    let b = t.create(4 * TILE, 24).unwrap();
    t.set_out(b, Output::Next(f)).unwrap();
    let s_b = Schedule {
        period: 300,
        acc: 0,
        kinds: 3,
        next: Item(1),
    };
    t.set_spawner(b, Some(s_b)).unwrap();
    for _ in 0..5 {
        t.advance();
    }
    let before = t.schedule(b).unwrap().expect("scheduled");
    let n_b = t.scheduled_inserts_total();
    assert!(n_b > 0);
    t.join(f, b).unwrap();
    assert_eq!(t.schedule(f), Ok(Some(before)), "join: to the merged line");
    assert!(t.schedule(b).is_err(), "the back line is gone");
    let mut landed = false;
    for _ in 0..4 {
        let n = t.scheduled_inserts_total();
        t.advance();
        if t.scheduled_inserts_total() > n {
            // `max(2,048 - 24, tail + 64)` = 2,032 (the tail is the back line's last item, now at
            // 1,968 on the joined line), then moved 24: in the former back line's part.
            assert_eq!(
                items(&t, f).last().map(|&(_, p)| p),
                Some(2_008),
                "lands at the joined line's back"
            );
            landed = true;
            break;
        }
    }
    assert!(landed, "the merged line inserts");

    // two schedules meeting
    let f2 = t.create(4 * TILE, 24).unwrap();
    let b2 = t.create(4 * TILE, 24).unwrap();
    t.set_out(b2, Output::Next(f2)).unwrap();
    t.set_spawner(f2, Some(sched(256, 4))).unwrap();
    t.set_spawner(b2, Some(sched(256, 5))).unwrap();
    let bytes = encode(&t);
    assert_eq!(t.join(f2, b2), Err(TransportError::Unsupported));
    assert_eq!(encode(&t), bytes, "a refused join changed nothing");

    // only the front scheduled
    let f3 = t.create(4 * TILE, 24).unwrap();
    let b3 = t.create(4 * TILE, 24).unwrap();
    t.set_out(b3, Output::Next(f3)).unwrap();
    t.set_spawner(f3, Some(sched(256, 7))).unwrap();
    let bytes = encode(&t);
    assert_eq!(
        t.join(f3, b3),
        Err(TransportError::Unsupported),
        "a scheduled front would sit mid-line"
    );
    assert_eq!(encode(&t), bytes, "a refused join changed nothing");

    // split
    let l = t.create(8 * TILE, 24).unwrap();
    t.set_spawner(l, Some(sched(256, 6))).unwrap();
    for _ in 0..3 {
        t.advance();
    }
    let s_l = t.schedule(l).unwrap();
    let back = t.split(l, 4 * TILE).unwrap();
    assert_eq!(t.schedule(l), Ok(None), "split: the front piece has none");
    assert_eq!(t.schedule(back), Ok(s_l), "split: to the back piece");
    let (front_n, back_n) = (t.count(l).unwrap(), t.count(back).unwrap());
    for _ in 0..10 {
        t.advance();
    }
    assert!(
        t.count(back).unwrap() > back_n,
        "the back piece takes the inserts"
    );
    assert!(
        t.count(l).unwrap() <= front_n + (t.count(back).unwrap() - back_n),
        "nothing is inserted on the front piece itself"
    );
    assert!(
        items(&t, l).iter().all(|&(_, p)| p < 4 * TILE - 24),
        "no insert at the front piece's back"
    );

    // destroy
    let total = t.scheduled_inserts_total();
    let per_tick = |t: &mut Transport| {
        let n = t.scheduled_inserts_total();
        t.advance();
        t.scheduled_inserts_total() - n
    };
    // `back`, `f`, `f2`, `b2`, `f3` are scheduled: destroyed, nothing inserts after.
    for id in [back, f, f2, b2, f3, b3] {
        t.destroy(id, &mut |_| {}).unwrap();
    }
    assert!(t.scheduled_inserts_total() >= total);
    for _ in 0..10 {
        assert_eq!(
            per_tick(&mut t),
            0,
            "a destroyed line's schedule went with it"
        );
    }
    let reused = t.create(4 * TILE, 24).unwrap();
    assert_eq!(
        t.schedule(reused),
        Ok(None),
        "a reused slot carries no schedule"
    );
}

/// 0079 §21: the engine owns a scheduled line's inserts. A game's `insert_back` there is
/// `Err(Scheduled)` in a release build and a panic naming the line in a debug build (a game bug);
/// cleared with `set_spawner(line, None)`, the line takes `insert_back` again. `set_spawner`
/// refuses a period below 256 (`BadPeriod`: one insert a tick is the most), `Item(0)` (`BadItem`)
/// and a missing line (`NoLine`), changing nothing.
#[test]
fn insert_back_on_a_scheduled_line_is_refused() {
    let mut t = Transport::new(4, 64);
    let l = t.create(4 * TILE, 24).unwrap();
    let bytes = encode(&t);
    assert_eq!(
        t.set_spawner(l, Some(sched(255, 1))),
        Err(TransportError::BadPeriod)
    );
    assert_eq!(
        t.set_spawner(l, Some(sched(256, 0))),
        Err(TransportError::BadItem)
    );
    assert_eq!(
        t.set_spawner(LineId(9), Some(sched(256, 1))),
        Err(TransportError::NoLine)
    );
    assert_eq!(encode(&t), bytes, "a refused set_spawner changed nothing");
    t.set_spawner(l, Some(sched(256, 1))).unwrap();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.insert_back(l, Item(2))));
    if cfg!(debug_assertions) {
        let e = r.expect_err("a debug build panics");
        let msg = e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(
            msg.contains("insert_back on LineId(1), whose schedule is state"),
            "{msg}"
        );
    } else {
        assert_eq!(r.unwrap(), Err(TransportError::Scheduled));
    }
    assert_eq!(t.count(l), Ok(0), "nothing landed");
    t.set_spawner(l, None).unwrap();
    assert_eq!(t.insert_back(l, Item(2)), Ok(()), "unscheduled again");
}

/// M53 fix round 1: the step walks the scheduled slots only (`advance` keeps them in an id-sorted
/// list reserved at the caps), not every line. 1,000 lines, one scheduled: 10 ticks visit 10 slots
/// (a walk of the line index visited 10,000). The list follows surgery: a `split` lists the back
/// piece instead (one visit a tick), a `destroy` of it lists nothing (none).
#[test]
fn schedule_step_visits_only_scheduled_lines() {
    let mut t = Transport::new(1_024, 4_096);
    let ls: Vec<LineId> = (0..1_000)
        .map(|_| t.create(4 * TILE, 24).unwrap())
        .collect();
    t.set_spawner(ls[500], Some(sched(256, 1))).unwrap();
    let v0 = t.schedule_visits();
    for _ in 0..10 {
        t.advance();
    }
    assert_eq!(t.schedule_visits() - v0, 10, "one slot a tick");
    assert!(t.scheduled_inserts_total() > 0);
    let back = t.split(ls[500], 2 * TILE).unwrap();
    let v1 = t.schedule_visits();
    t.advance();
    assert_eq!(t.schedule_visits() - v1, 1, "the back piece, listed");
    t.destroy(back, &mut |_| {}).unwrap();
    let v2 = t.schedule_visits();
    t.advance();
    assert_eq!(t.schedule_visits(), v2, "nothing listed after the destroy");
}

/// M53 fix round 1: `set_spawner`'s room is the forecast tracker's pool, half the line cap (2 at
/// caps of 4 lines): a third new schedule is `Full` and changes nothing, a replaced one fits, and
/// one fits again after a clear. Clearing (`None`) a line that holds no schedule leaves a
/// `declare_spawner` declaration there: the game's own inserts on it stay predicted (no
/// `ROUTE_INSERT` crossing after the declaration armed) and never mismatch.
#[test]
fn set_spawner_room_and_clearing() {
    use engine::transport::ROUTE_INSERT;
    let mut t = Transport::new(4, 64);
    let ls: Vec<LineId> = (0..3).map(|_| t.create(4 * TILE, 24).unwrap()).collect();
    t.set_spawner(ls[0], Some(sched(256, 1))).unwrap();
    t.set_spawner(ls[1], Some(sched(256, 1))).unwrap();
    let bytes = encode(&t);
    assert_eq!(
        t.set_spawner(ls[2], Some(sched(256, 1))),
        Err(TransportError::Full),
        "past half the line cap"
    );
    assert_eq!(encode(&t), bytes, "a refused set_spawner changed nothing");
    t.set_spawner(ls[0], Some(sched(300, 2))).unwrap();
    t.set_spawner(ls[0], None).unwrap();
    t.set_spawner(ls[2], Some(sched(256, 1))).unwrap();

    // A join at a full pool (fix round 2): a fourth line feeds `ls[0]` and holds a schedule
    // beside `ls[2]`'s (the pool's two entries); the join moves it to `ls[0]`, whose tracker entry
    // is taken after the back line's is freed, so nothing is dropped and the merged line's inserts are
    // predicted (never `ROUTE_INSERT` crossings after the tick the schedule moved).
    t.set_spawner(ls[1], None).unwrap();
    let back = t.create(4 * TILE, 24).unwrap();
    t.set_out(back, Output::Next(ls[0])).unwrap();
    t.set_spawner(back, Some(sched(256, 3))).unwrap();
    t.set_out(ls[0], Output::Sink).unwrap();
    for _ in 0..3 {
        t.advance();
    }
    t.join(ls[0], back).unwrap();
    let mut merged_arrivals = 0;
    for tick in 0..40 {
        t.advance();
        if tick > 0 {
            merged_arrivals += t
                .forecast_crossings()
                .iter()
                .filter(|c| c.route() == ROUTE_INSERT && c.to == ls[0].0)
                .count();
        }
    }
    let hc = t.forecast_host_counters();
    assert_eq!(hc.spawner_declarations_dropped, 0, "dropped at a full pool");
    assert_eq!(
        merged_arrivals, 0,
        "the merged line's inserts are predicted"
    );
    assert_eq!(hc.spawner_mismatches, 0);

    let mut u = Transport::new(4, 64);
    let a = u.create(4 * TILE, 24).unwrap();
    u.set_out(a, Output::Sink).unwrap();
    u.declare_spawner(a, Some(sched(256, 1)));
    assert_eq!(u.set_spawner(a, None), Ok(()), "nothing to clear");
    let mut arrivals = 0;
    for tick in 1..=40u32 {
        let _ = u.insert_back(a, Item(1));
        u.advance();
        if tick > 1 {
            arrivals += u
                .forecast_crossings()
                .iter()
                .filter(|c| c.route() == ROUTE_INSERT)
                .count();
        }
    }
    assert!(u.count(a).unwrap() > 0);
    assert_eq!(
        arrivals, 0,
        "the declaration stayed: its inserts are predicted"
    );
    assert_eq!(u.forecast_host_counters().spawner_mismatches, 0);
}
