//! The update order (0076 §2): reverse topological over the output links, so a line advances
//! after the lines it feeds and a hand-off lands on a line that has already moved this tick.
//! Strongly connected components come from Tarjan's algorithm (iterative, over scratch reserved
//! from `max_lines`), which emits them in exactly that order; roots are tried in ascending
//! `LineId`, so the order is a function of the graph alone. A cycle is cut at its lowest `LineId`:
//! that line advances first (its own output is the cut link: what it hands off lands on a line
//! that has not moved yet, and does not move again that tick, 0079), then the line feeding it, and
//! so on back around the cycle.
//!
//! Recomputed only when `create`/`destroy`/`set_out` set `graph_dirty` (never per tick). Links
//! (M44): a `Next` or a `Merge` is one, a `Fork` two (`a` then `b`), so a component may be more
//! than a simple cycle; `emit_component` orders it by a depth-first walk from its lowest id.

use super::Transport;
use super::line::NIL;

const UNVISITED: u32 = u32::MAX;
/// A call-stack entry is a line slot (low 30 bits) and the index of its next link to try.
const CHILD_SHIFT: u32 = 30;
const SLOT_MASK: u32 = (1 << CHILD_SHIFT) - 1;

/// Tarjan's working arrays, by line slot. Reserved once (`Transport::set_caps`); `recompute_order`
/// only resizes them within that capacity.
#[derive(Default)]
pub(super) struct Scratch {
    index: Vec<u32>,
    low: Vec<u32>,
    on_stack: Vec<bool>,
    stack: Vec<u32>,
    call: Vec<u32>,
}

impl Scratch {
    pub(super) fn capacity_bytes(&self) -> usize {
        4 * (self.index.capacity()
            + self.low.capacity()
            + self.stack.capacity()
            + self.call.capacity())
            + self.on_stack.capacity()
    }

    /// Reserved bytes per line slot: `index`, `low`, `stack`, `call` (`u32`) and `on_stack` (`bool`).
    pub(super) const BYTES_PER_LINE: usize = 4 * core::mem::size_of::<u32>() + 1;

    pub(super) fn reserve(&mut self, n: usize) {
        for v in [
            &mut self.index,
            &mut self.low,
            &mut self.stack,
            &mut self.call,
        ] {
            if v.capacity() < n {
                v.reserve_exact(n - v.len());
            }
        }
        if self.on_stack.capacity() < n {
            self.on_stack.reserve_exact(n - self.on_stack.len());
        }
    }
}

impl Transport {
    /// The `k`-th line slot `l` feeds (`k` 0: `Next`'s, `Merge`'s or `Fork`'s `a`; 1: `Fork`'s `b`).
    #[inline]
    fn succ(&self, l: u32, k: u32) -> Option<u32> {
        let rec = &self.lines[l as usize];
        let s = match k {
            0 => rec.next_slot,
            1 => rec.alt_slot,
            _ => NIL,
        };
        (s != NIL).then_some(s)
    }

    pub(super) fn recompute_order(&mut self) {
        let n = self.lines.len();
        debug_assert!(
            n <= SLOT_MASK as usize,
            "call entries pack the slot in 30 bits"
        );
        let mut sc = std::mem::take(&mut self.scratch);
        sc.index.clear();
        sc.index.resize(n, UNVISITED);
        sc.low.clear();
        sc.low.resize(n, 0);
        sc.on_stack.clear();
        sc.on_stack.resize(n, false);
        sc.stack.clear();
        sc.call.clear();
        self.order.clear();
        let mut counter = 0u32;
        for k in 0..self.index.len() {
            let root = self.index[k].1;
            if sc.index[root as usize] != UNVISITED {
                continue;
            }
            sc.call.push(root);
            'call: while let Some(&e) = sc.call.last() {
                let (v, mut k) = (e & SLOT_MASK, e >> CHILD_SHIFT);
                let vi = v as usize;
                if k == 0 {
                    sc.index[vi] = counter;
                    sc.low[vi] = counter;
                    counter += 1;
                    sc.stack.push(v);
                    sc.on_stack[vi] = true;
                } else {
                    // Back from child `k - 1`, now finished.
                    let w = self.succ(v, k - 1).expect("a resumed child exists");
                    sc.low[vi] = sc.low[vi].min(sc.low[w as usize]);
                }
                while let Some(w) = self.succ(v, k) {
                    k += 1;
                    if sc.index[w as usize] == UNVISITED {
                        *sc.call.last_mut().expect("v is on the call stack") = v | k << CHILD_SHIFT;
                        sc.call.push(w);
                        continue 'call;
                    }
                    if sc.on_stack[w as usize] {
                        sc.low[vi] = sc.low[vi].min(sc.index[w as usize]);
                    }
                }
                sc.call.pop();
                if sc.low[vi] == sc.index[vi] {
                    self.emit_component(&mut sc, v);
                }
            }
        }
        self.scratch = sc;
        self.graph_dirty = false;
        self.order_recomputes = self.order_recomputes.wrapping_add(1);
    }

    /// Pops the component rooted at `v` off Tarjan's stack and appends it to the order: a single
    /// line as is; a cycle (any strongly connected set, M44: forks give two links) from its lowest
    /// `LineId`, then the rest in depth-first post-order from it over the component's own links
    /// (`a` before `b`), so each line follows every line it feeds except along a cut link. The cut
    /// links (a hand-off onto a line that has not advanced yet) are the lowest id's own out-links
    /// and the back edges of the walk to a non-root ancestor still on its path; a link into the
    /// lowest id lands on a line that has already advanced. For a simple cycle that is the lowest
    /// id, then backwards against the links (its one cut link is the lowest id's output).
    fn emit_component(&mut self, sc: &mut Scratch, v: u32) {
        let start = sc
            .stack
            .iter()
            .rposition(|&x| x == v)
            .expect("v is on the stack");
        let size = sc.stack.len() - start;
        if size == 1 {
            sc.on_stack[v as usize] = false;
            sc.stack.truncate(start);
            self.order.push(v);
            return;
        }
        let mut lowest = v;
        for &x in &sc.stack[start..] {
            if self.lines[x as usize].id < self.lines[lowest as usize].id {
                lowest = x;
            }
        }
        sc.stack.truncate(start);
        // `on_stack` still marks the component's lines (no link leaves a component for a line
        // still on Tarjan's stack); the walk clears each as it enters it. It runs on top of the
        // outer call stack, whose lines are outside the component: together at most `n` entries.
        let from = self.order.len();
        self.order.push(lowest);
        sc.on_stack[lowest as usize] = false;
        let base = sc.call.len();
        sc.call.push(lowest);
        'walk: while sc.call.len() > base {
            let e = *sc.call.last().expect("above base");
            let (x, mut k) = (e & SLOT_MASK, e >> CHILD_SHIFT);
            while let Some(w) = self.succ(x, k) {
                k += 1;
                if sc.on_stack[w as usize] {
                    sc.on_stack[w as usize] = false;
                    *sc.call.last_mut().expect("above base") = x | k << CHILD_SHIFT;
                    sc.call.push(w);
                    continue 'walk;
                }
            }
            sc.call.pop();
            if x != lowest {
                self.order.push(x);
            }
        }
        debug_assert_eq!(
            self.order.len() - from,
            size,
            "the walk reached the component"
        );
    }
}
