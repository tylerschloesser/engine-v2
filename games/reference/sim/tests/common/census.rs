//! Item bookkeeping for belt scenarios (M56; the fixture's `tests/common/props.rs` ported to the
//! reference game): [`Bed`] steps a [`RefScenario`] one tick at a time and keeps, for every line ever
//! seen alive, its `sunk` count at the end of the last tick it was alive (`sunk` changes only inside
//! `advance`, and the topology destroys a line in `G::tick` before it, so a dead line's last value is
//! final). [`Bed::check`] asserts made = live + sunk + destroyed exactly, made being the engine's
//! scheduled inserts plus the test hook's accepted inserts and destroyed the topology's
//! `belts_destroyed_items()`. [`Bed::track_sinks`] counts what a despawner sinks by kind: the items
//! sunk in a tick are the front items of its line before the tick (a FIFO diff of the line's items
//! against its `sunk` delta; an item reaching a 256-position despawner line cannot leave it in the
//! same tick at speed 24). [`ring`] and [`ring_coords`] follow a lane around a `Next` cycle, as the
//! fixture's `ring_laps` does over its chains.
//!
//! Every step of a bed must go through it (`step`, `act`): an edit stepped on the scenario directly
//! would let a line die unobserved.

use std::collections::BTreeMap;

use engine::transport::{LineId, Output, TransportRead};
use engine::world::TilePos;
use reference_sim::rules::belts::topology::{belts_destroyed_items, lanes_at};

use super::RefScenario;

/// Every item the world made and where it is now.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Census {
    /// Scheduled inserts (the spawners) plus test-hook inserts.
    pub made: u64,
    pub live: u64,
    pub sunk: u64,
    pub destroyed: u64,
}

/// A despawner line's sinks by item kind (the engine's item, `ItemId as u16 + 1`).
#[derive(Clone, Debug, Default)]
pub struct SinkTally {
    pub line: LineId,
    pub by_kind: BTreeMap<u16, u64>,
    before: Vec<u16>,
    sunk_before: u64,
}

impl SinkTally {
    pub fn kind(&self, item: u16) -> u64 {
        self.by_kind.get(&item).copied().unwrap_or(0)
    }
}

/// A scenario stepped with its ledger (module doc).
pub struct Bed {
    pub s: RefScenario,
    sunk_seen: BTreeMap<u32, u64>,
    /// Test-hook inserts the test verified landed.
    pub inserted: u64,
    /// Scheduled inserts made before the last `save_and_load` (the engine's count restarts there).
    made_base: u64,
    /// The thread's destroyed counter when the bed was made (a second bed on the same thread).
    destroyed_base: u64,
    pub sinks: Vec<SinkTally>,
}

impl Bed {
    pub fn new(s: RefScenario) -> Bed {
        let mut b = Bed {
            s,
            sunk_seen: BTreeMap::new(),
            inserted: 0,
            made_base: 0,
            destroyed_base: belts_destroyed_items(),
            sinks: Vec::new(),
        };
        b.observe();
        b
    }

    pub fn tr(&self) -> &dyn TransportRead {
        self.s.read().transport()
    }

    /// Records every live line's `sunk`, and each tracked sink's delta by kind.
    fn observe(&mut self) {
        let store = self.s.transport_store();
        for id in 1..store.next_id() {
            if let Ok(n) = store.sunk(LineId(id)) {
                self.sunk_seen.insert(id, n);
            }
        }
        for t in &mut self.sinks {
            let now = store.sunk(t.line).expect("a tracked sink line lives");
            let d = (now - t.sunk_before) as usize;
            assert!(
                d <= t.before.len(),
                "sink {:?}: {d} sunk of {} held",
                t.line,
                t.before.len()
            );
            for &k in &t.before[..d] {
                *t.by_kind.entry(k).or_insert(0) += 1;
            }
            t.sunk_before = now;
            t.before.clear();
            store
                .items_in(t.line, &mut |i, _| t.before.push(i.0))
                .expect("line");
        }
    }

    /// Steps `n` ticks, observing after each.
    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            self.s.step_ticks(1);
            self.observe();
        }
    }

    /// [`Self::step`] with [`Self::check`] after every tick.
    pub fn step_checked(&mut self, n: u32) {
        for _ in 0..n {
            self.step(1);
            self.check();
        }
    }

    /// Runs `f` (which must step exactly one tick: one `dispatch`, `dispatch_batch` or edit) and
    /// observes.
    pub fn act<R>(&mut self, f: impl FnOnce(&mut RefScenario) -> R) -> R {
        let t = self.s.tick();
        let r = f(&mut self.s);
        assert_eq!(self.s.tick().0, t.0 + 1, "an act steps one tick");
        self.observe();
        r
    }

    /// Counts what the despawner on `at` sinks from now on, by kind (its lane `lane`'s line).
    pub fn track_sink(&mut self, at: TilePos, lane: usize) -> usize {
        let line = lanes_at(self.tr(), at).expect("a despawner").lane[lane];
        let store = self.s.transport_store();
        let mut before = Vec::new();
        store
            .items_in(line, &mut |i, _| before.push(i.0))
            .expect("line");
        self.sinks.push(SinkTally {
            line,
            by_kind: BTreeMap::new(),
            before,
            sunk_before: store.sunk(line).expect("line"),
        });
        self.sinks.len() - 1
    }

    /// Snapshots and restores the host (`RefScenario::save_and_load`): the engine's scheduled-insert
    /// count restarts, so the bed keeps what it had made; `sunk` and the lines are state and come
    /// back as they were.
    pub fn save_and_load(&mut self) {
        self.made_base += self.s.transport_store().scheduled_inserts_total();
        self.s.save_and_load();
    }

    pub fn census(&self) -> Census {
        let store = self.s.transport_store();
        Census {
            made: self.made_base + store.scheduled_inserts_total() + self.inserted,
            live: u64::from(store.items_len()),
            sunk: self.sunk_seen.values().sum(),
            destroyed: belts_destroyed_items() - self.destroyed_base,
        }
    }

    /// Asserts conservation (made = live + sunk + destroyed) and returns the census.
    pub fn check(&self) -> Census {
        let c = self.census();
        assert_eq!(
            c.made,
            c.live + c.sunk + c.destroyed,
            "tick {}: conservation {c:?}",
            self.s.tick().0
        );
        c
    }
}

/// The lines of the cycle through `start` along `Next` links and a `Fork`'s `a` (a splitter's left
/// half: the ring through a splitter), in flow order from `start`; `None` if the walk leaves by
/// anything else or does not come back.
pub fn ring(tr: &dyn TransportRead, start: LineId) -> Option<Vec<LineId>> {
    let mut v = vec![start];
    let mut at = start;
    loop {
        let n = match tr.out(at) {
            Ok(Output::Next(n) | Output::Fork { a: n, .. }) => n,
            _ => return None,
        };
        if n == start {
            return Some(v);
        }
        if v.contains(&n) || v.len() > 4_096 {
            return None;
        }
        v.push(n);
        at = n;
    }
}

/// Every item on `ring`'s lines by its ring coordinate: its position plus the lengths of the lines
/// ahead of its own in flow order (the fixture's `ring_laps` coordinate), as `(coord, item)` sorted
/// by coordinate; and the ring's total length.
pub fn ring_coords(tr: &dyn TransportRead, ring: &[LineId]) -> (Vec<(u32, u16)>, u32) {
    let lens: Vec<u32> = ring.iter().map(|&l| tr.len(l).expect("line")).collect();
    let total = lens.iter().sum();
    let mut v = Vec::new();
    for (k, &l) in ring.iter().enumerate() {
        let ahead: u32 = lens[k + 1..].iter().sum();
        tr.items_in(l, &mut |i, p| v.push((p + ahead, i.0)))
            .expect("line");
    }
    v.sort_unstable();
    (v, total)
}

/// Every pair closer than `SPACING` on one of `lines`, or across a `Next` hand-off from one of
/// them (`(line, target, gap)`, `target` the line itself for a pair on it): a squashed pair (0079
/// §12) the overfull fallback may leave.
pub fn short_gaps(tr: &dyn TransportRead, lines: &[LineId]) -> Vec<(LineId, LineId, u32)> {
    let pos = |l: LineId| {
        let mut p = Vec::new();
        tr.items_in(l, &mut |_, x| p.push(x)).expect("line");
        p
    };
    let mut v = Vec::new();
    for &l in lines {
        let p = pos(l);
        for k in 1..p.len() {
            if p[k] - p[k - 1] < engine::transport::SPACING {
                v.push((l, l, p[k] - p[k - 1]));
            }
        }
        if let (Ok(Output::Next(to)), Some(&front)) = (tr.out(l), p.first())
            && let Some(&tail) = pos(to).last()
        {
            let gap = front + tr.len(to).expect("line") - tail;
            if gap < engine::transport::SPACING {
                v.push((l, to, gap));
            }
        }
    }
    v
}
