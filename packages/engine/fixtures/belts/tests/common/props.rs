//! Helpers for the seeded property tests (M44b `tests/props.rs`; M56 reuses them): a native
//! `Sim<Belts>` driven through the request pattern (`Action::Request(op)`, executed by the next
//! `Belts::tick`), the world's item ledger and the spacing scan. Included by path (`#[path]`), not
//! from `common/mod.rs`: the spike binaries that include `common` have their own global allocator
//! and cannot link `fx_belts`.
#![allow(dead_code)]

use std::collections::BTreeMap;

use engine::game::{PlayerEvent, PlayerId, WorldRead};
use engine::rng::SimRng;
use engine::sim::{Record, Sim, WorldParams};
use engine::transport::{Item, LineId, Output, SPACING};
use fx_belts::{Action, Belts, Dir, Op, Pos, Thing};

const WHO: PlayerId = PlayerId(1);

/// A native world driven one tick at a time by request batches.
pub struct World {
    pub sim: Sim<Belts>,
    seq: u32,
    /// Every line ever seen alive: its sunk count at the end of the last tick it was alive. Sunk
    /// counts change only inside `advance`, and a line dies (`Join`, `Destroy`) inside `G::tick`
    /// before it, so a dead line's last value is final.
    sunk_seen: BTreeMap<u32, u64>,
}

/// Every item the world has made and where each went (`spawned + inserted` in, the rest out).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Ledger {
    pub spawned: u64,
    pub inserted: u64,
    pub live: u64,
    pub sunk: u64,
    pub removed: u64,
    pub taken: u64,
    pub destroyed: u64,
}

impl Ledger {
    pub fn made(&self) -> u64 {
        self.spawned + self.inserted
    }

    pub fn accounted(&self) -> u64 {
        self.live + self.sunk + self.removed + self.taken + self.destroyed
    }
}

/// Two items closer than `SPACING`: on `line` (`target` none), or across `line`'s `Next` hand-off
/// to `target` (`back` is then `line`'s front, `front` the target's tail, path distance `gap`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Gap {
    pub line: LineId,
    pub target: Option<LineId>,
    pub gap: u32,
}

impl World {
    /// Genesis with `max_lines` and `max_items` (the M43b seed and entity caps).
    pub fn new(seed: u64, max_lines: u32, max_items: u32) -> Self {
        let sim = Sim::genesis(WorldParams {
            seed,
            worldgen: fx_belts::BeltsParams::default(),
            max_entities: 4096,
            max_modified_tiles: 4096,
            max_action_growth: 4096,
            max_lines,
            max_items,
        });
        World {
            sim,
            seq: 0,
            sunk_seen: BTreeMap::new(),
        }
    }

    /// One tick: the first also connects the player; every op is one request (all must apply:
    /// `Op::valid`). Then the sunk bookkeeping.
    pub fn step(&mut self, ops: &[Op]) {
        let mut batch: Vec<Record<Belts>> = Vec::new();
        if self.seq == 0 {
            for ev in [PlayerEvent::Joined, PlayerEvent::Connected] {
                batch.push(Record::Player { who: WHO, ev });
            }
        }
        for op in ops {
            self.seq += 1;
            batch.push(Record::Action {
                who: WHO,
                seq: self.seq,
                action: Action::Request(*op),
            });
        }
        if self.seq == 0 {
            self.seq = 1; // connected; the next batch skips the player records.
        }
        let mut out = Vec::new();
        self.sim.step(&batch, &mut out);
        assert!(
            out.iter().all(|o| o.result.is_ok()),
            "every request applies"
        );
        for i in 0..self.chains() {
            let l = self.line(i);
            if let Ok(s) = self.sim.authority().transport().sunk(l) {
                self.sunk_seen.insert(l.0, s);
            }
        }
    }

    pub fn tick(&self) -> u32 {
        self.sim.tick().0
    }

    pub fn chains(&self) -> u32 {
        self.sim.authority().global().chains
    }

    /// Chain `i`'s line id (`LineId::NONE` when refused or absent; possibly dead).
    pub fn line(&self, i: u32) -> LineId {
        self.sim.authority().global().line(i)
    }

    pub fn alive(&self, l: LineId) -> bool {
        l != LineId::NONE && self.sim.authority().transport().len(l).is_ok()
    }

    /// Chain indices whose line is alive, in table order.
    pub fn live_chains(&self) -> Vec<u32> {
        (0..self.chains())
            .filter(|&i| self.alive(self.line(i)))
            .collect()
    }

    /// The table index of `l` (its first slot).
    pub fn index_of(&self, l: LineId) -> Option<u32> {
        (0..self.chains()).find(|&i| self.line(i) == l)
    }

    pub fn len(&self, l: LineId) -> u32 {
        self.sim.authority().transport().len(l).expect("line")
    }

    pub fn speed(&self, l: LineId) -> u32 {
        u32::from(self.sim.authority().transport().speed(l).expect("line"))
    }

    pub fn out(&self, l: LineId) -> Output {
        self.sim.authority().transport().out(l).expect("line")
    }

    pub fn items(&self, l: LineId) -> Vec<(u16, u32)> {
        let mut v = Vec::new();
        self.sim
            .authority()
            .transport()
            .items_in(l, &mut |item: Item, pos| v.push((item.0, pos)))
            .expect("line");
        v
    }

    pub fn positions(&self, l: LineId) -> Vec<u32> {
        self.items(l).iter().map(|&(_, p)| p).collect()
    }

    pub fn sunk(&self, l: LineId) -> u64 {
        self.sim.authority().transport().sunk(l).expect("line")
    }

    pub fn toggle(&self, l: LineId) -> bool {
        self.sim.authority().transport().toggle(l).expect("line")
    }

    /// Items accepted onto `l` by its spawner(s).
    pub fn spawned_on(&self, l: LineId) -> u64 {
        let mut n = 0;
        for (_, e) in self.sim.authority().store().entities() {
            if let Thing::Spawner(s) = e
                && s.line == l.0
            {
                n += u64::from(s.spawned);
            }
        }
        n
    }

    /// The whole world's ledger: live and sunk over every line alive now, plus the final sunk
    /// counts of the lines that died; the spawners, the tally and the destroyed counter.
    pub fn ledger(&self) -> Ledger {
        let mut g = Ledger::default();
        let tr = self.sim.authority().transport();
        for (&id, &s) in &self.sunk_seen {
            g.sunk += tr.sunk(LineId(id)).unwrap_or(s);
        }
        for i in self.live_chains() {
            g.live += u64::from(tr.count(self.line(i)).expect("line"));
        }
        for (_, e) in self.sim.authority().store().entities() {
            match e {
                Thing::Spawner(s) | Thing::Cycling(s) => g.spawned += u64::from(s.spawned),
                Thing::Tally(t) => {
                    g.inserted += u64::from(t.inserted);
                    g.removed += u64::from(t.removed);
                    g.taken += u64::from(t.taken);
                }
                Thing::Destroyed(n) => g.destroyed += u64::from(*n),
                Thing::Request(_) | Thing::Jam(_) | Thing::Inserter(_) => {}
            }
        }
        g
    }

    /// Every pair closer than `SPACING` on a live line or across a live `Next` hand-off.
    pub fn short_gaps(&self) -> Vec<Gap> {
        let mut v = Vec::new();
        for i in self.live_chains() {
            let l = self.line(i);
            let p = self.positions(l);
            for k in 1..p.len() {
                if p[k] - p[k - 1] < SPACING {
                    v.push(Gap {
                        line: l,
                        target: None,
                        gap: p[k] - p[k - 1],
                    });
                }
            }
            if let (Output::Next(to), Some(&front)) = (self.out(l), p.first())
                && let Some(&tail) = self.positions(to).last()
            {
                let gap = front + self.len(to) - tail;
                if gap < SPACING {
                    v.push(Gap {
                        line: l,
                        target: Some(to),
                        gap,
                    });
                }
            }
        }
        v
    }
}

/// A `DeadEnd` chain of `tiles x 256` at `speed` with items `(item, pos)` at rest (at most 8).
pub fn chain(tiles: u16, speed: u16, rest: &[(u16, u32)]) -> Op {
    let mut items_at_rest = [(0, 0); 8];
    items_at_rest[..rest.len()].copy_from_slice(rest);
    Op::Chain {
        from: Pos { x: 0, y: 0 },
        dir: Dir::East,
        tiles,
        speed,
        items_at_rest,
    }
}

/// A uniform pick from a non-empty slice.
pub fn pick<T: Copy>(rng: &mut SimRng, v: &[T]) -> T {
    v[rng.below(v.len() as u32) as usize]
}

/// A uniform value in `[lo, hi]`.
pub fn between(rng: &mut SimRng, lo: u32, hi: u32) -> u32 {
    lo + rng.below(hi - lo + 1)
}
