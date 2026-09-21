//! [`run_script`] (docs/plan/12b-world-access-and-sim-driver.md Provides): drives a [`Sim<G>`]
//! through a script of `(Tick, Record<G>)` entries and returns the final `state_hash()`.
//!
//! Contract: a script entry's `Tick` names the *ordinal* of the `Sim::step` call that delivers it
//! (the 1st call lands on `Tick(1)`, the 2nd on `Tick(2)`, ...) -- exactly `sim.tick()` after that
//! call returns, since each `step` advances the tick by exactly one (`Sim::step`'s own doc
//! comment: "then advances the tick"). Entries must be sorted ascending by `Tick`; several entries
//! sharing one `Tick` are delivered together, in one `step` call, in script order (0004: "within a
//! tick, actions apply in host arrival order"). Any gap between one entry's `Tick` and the next is
//! filled with idle `step(&[], ..)` calls, so a script can leave ticks empty on purpose (the same
//! shape `puts_idle_100` exercises directly, without this helper, by calling `step` in a bare
//! loop).

use crate::game::Game;
use crate::sim::{Outcome, Record, Sim};
use crate::time::Tick;

pub fn run_script<G: Game>(sim: &mut Sim<G>, script: &[(Tick, Record<G>)]) -> u64
where
    G::Action: Clone,
{
    let mut out: Vec<Outcome<G>> = Vec::new();
    let mut i = 0;
    while i < script.len() {
        let want = script[i].0;
        debug_assert!(
            want.0 >= 1,
            "run_script: a Tick(0) entry is genesis's, not step's"
        );
        while sim.tick().0 + 1 < want.0 {
            sim.step(&[], &mut out);
        }
        let mut batch: Vec<Record<G>> = Vec::new();
        while i < script.len() && script[i].0 == want {
            batch.push(script[i].1.clone());
            i += 1;
        }
        sim.step(&batch, &mut out);
    }
    sim.state_hash()
}
