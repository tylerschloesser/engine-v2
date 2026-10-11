//! The one interface the three candidates of 0077 §1 implement, and the driver that runs a
//! [`BenchWorld`] on any of them (spawners, inserter-like calls, then `advance`), so every candidate
//! sees the identical call sequence.
//!
//! The per-tick rule (0076 §2, `/Users/tyler/repos/belts/docs/12-belt-physics-measurements.md` §3c,
//! `docs/dev/sim.md` "Per tick"), every line in update order, items front to back, `leader` the new
//! position of the item ahead (in this line's coordinates; for the front item: `-SPACING` at a
//! `DeadEnd`, the plain target's rearmost item `tail - target.len` at a `Next`, none at a `Sink` or
//! an empty target):
//!
//! - `bound = leader + SPACING`; an item already inside the bound does not move, else
//!   `p = max(pos - speed, bound)` (so `advance = min(speed, gap_after_leader_move - SPACING)`).
//! - `p >= 0`: the item moves to `p`. `p < 0`: it crosses the front: a `Sink` deletes and counts it,
//!   a `Next` lands it at `target.len + p` (the squash is already in `p`; `<= target.len - 1`).
//!   Its `p` is the next item's leader, so several items cross in one tick when `speed >= SPACING`.
//! - `insert_back` lands at `max(len - speed, tail + SPACING)`, refused past `len - 1`.
//! - `insert_at(pos)`: `SPACING` clear on both sides on this line, `pos <= len - 1`.
//!   `remove_at(pos)`: the nearest item within `SPACING / 2`, the front one on a tie.
#![allow(dead_code)]

use super::world::{BenchWorld, Item, KINDS, LineIdx, LineSpec, Out};
use engine::bytes::ByteSink;
use engine::rng::SimRng;

pub const SP: i32 = 64;
/// "No leader": far enough below any position that `NONE + SP - speed` cannot overflow.
pub const NONE: i32 = i32::MIN / 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    NoRoom,
    Full,
}

pub trait Repr: Clone {
    const NAME: &'static str;
    /// Allocates every arena the candidate will ever use (capacity: `ceil(len / 64)` items per line).
    fn build(lines: &[LineSpec]) -> Self;
    fn advance(&mut self, order: &[LineIdx]);
    fn insert_back(&mut self, line: LineIdx, item: Item) -> Result<(), Refused>;
    fn insert_at(&mut self, line: LineIdx, pos: u32, item: Item) -> Result<(), Refused>;
    fn remove_at(&mut self, line: LineIdx, pos: u32) -> Option<Item>;
    /// Every line in index order, the candidate's own representation (deterministic bytes).
    fn encode(&self, sink: &mut dyn ByteSink);
    /// The line's items front to back with computed positions (tests only: allocates into `out`).
    fn items(&self, line: LineIdx, out: &mut Vec<(Item, u32)>);
    /// Items deleted by `Sink` outputs so far.
    fn sunk(&self) -> u64;
}

/// Leader position for a line's front item, from its output (see the module doc).
#[inline]
pub fn front_leader(out: Out, target_tail: Option<(i32, i32)>) -> i32 {
    match out {
        Out::DeadEnd => -SP,
        Out::Sink => NONE,
        Out::Next(_) => match target_tail {
            Some((tail, len)) => tail - len,
            None => NONE,
        },
    }
}

/// Spawner and inserter state for one run of a [`BenchWorld`]. Allocates only in [`Driver::new`].
#[derive(Clone)]
pub struct Driver {
    acc: Vec<u16>,
    next: Vec<Item>,
    rng: SimRng,
    pub spawned: u64,
    pub calls: u64,
    pub inserted: u64,
    pub removed: u64,
}

impl Driver {
    pub fn new(world: &BenchWorld) -> Self {
        Driver {
            acc: vec![0; world.spawners.len()],
            next: world.spawners.iter().map(|s| s.first).collect(),
            rng: SimRng::seed_seq(world.seed, 0x1A5E),
            spawned: 0,
            calls: 0,
            inserted: 0,
            removed: 0,
        }
    }

    /// The game's part of a tick (0076 §2: `G::tick` runs before the advance): spawners, then the
    /// inserter-like calls. A refused call still counts and draws the same random numbers.
    pub fn game_phase<R: Repr>(&mut self, world: &BenchWorld, r: &mut R) {
        for (i, s) in world.spawners.iter().enumerate() {
            self.acc[i] += s.rate256;
            if self.acc[i] < 256 {
                continue;
            }
            if r.insert_back(s.line, self.next[i]).is_ok() {
                self.acc[i] -= 256;
                self.spawned += 1;
                if s.cycle {
                    self.next[i] = self.next[i] % KINDS + 1;
                }
            } else {
                self.acc[i] = 256;
            }
        }
        let n = world.lines.len() as u32;
        for _ in 0..world.inserter_calls {
            let line = self.rng.below(n);
            let pos = self.rng.below(world.lines[line as usize].len);
            let op = self.rng.below(2);
            let item = self.rng.below(u32::from(KINDS)) as Item + 1;
            self.calls += 1;
            if op == 0 {
                if r.insert_at(line, pos, item).is_ok() {
                    self.inserted += 1;
                }
            } else if r.remove_at(line, pos).is_some() {
                self.removed += 1;
            }
        }
    }

    pub fn tick<R: Repr>(&mut self, world: &BenchWorld, r: &mut R) {
        self.game_phase(world, r);
        r.advance(&world.order);
    }
}
