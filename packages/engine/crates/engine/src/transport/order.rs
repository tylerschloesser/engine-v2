//! The update order (0076 §2): reverse topological over the output links, so a line advances
//! after the lines it feeds and a hand-off lands on a line that has already moved this tick.
//! Strongly connected components come from Tarjan's algorithm (iterative, over scratch reserved
//! from `max_lines`), which emits them in exactly that order; roots are tried in ascending
//! `LineId`, so the order is a function of the graph alone. A cycle is cut at its lowest `LineId`:
//! that line advances first (its own output is the cut link: what it hands off lands on a line
//! that has not moved yet, and does not move again that tick, 0079), then the line feeding it, and
//! so on back around the cycle.
//!
//! Recomputed only when `create`/`destroy`/`set_out` set `graph_dirty` (never per tick). In M42 a
//! line has at most one link (`Next`), so a component is a single line or a simple cycle; M44's
//! `Fork` (two links) generalises the within-component walk.

use super::Transport;
use super::line::NIL;

const UNVISITED: u32 = u32::MAX;

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
    /// The line slot `l` feeds, if any.
    #[inline]
    fn succ(&self, l: u32) -> Option<u32> {
        let s = self.lines[l as usize].next_slot;
        (s != NIL).then_some(s)
    }

    pub(super) fn recompute_order(&mut self) {
        let n = self.lines.len();
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
            while let Some(&v) = sc.call.last() {
                let vi = v as usize;
                if sc.index[vi] == UNVISITED {
                    sc.index[vi] = counter;
                    sc.low[vi] = counter;
                    counter += 1;
                    sc.stack.push(v);
                    sc.on_stack[vi] = true;
                    if let Some(w) = self.succ(v) {
                        if sc.index[w as usize] == UNVISITED {
                            sc.call.push(w);
                            continue;
                        }
                        if sc.on_stack[w as usize] {
                            sc.low[vi] = sc.low[vi].min(sc.index[w as usize]);
                        }
                    }
                } else {
                    // Back from the one child: `v`'s successor, already finished.
                    let w = self
                        .succ(v)
                        .expect("only a node with a successor is resumed");
                    sc.low[vi] = sc.low[vi].min(sc.low[w as usize]);
                }
                sc.call.pop();
                if sc.low[vi] == sc.index[vi] {
                    self.emit_component(&mut sc, v);
                }
            }
        }
        self.scratch = sc;
        self.graph_dirty = false;
    }

    /// Pops the component rooted at `v` off Tarjan's stack and appends it to the order: a single
    /// line as is; a cycle from its lowest `LineId` backwards against the links.
    fn emit_component(&mut self, sc: &mut Scratch, v: u32) {
        let start = sc
            .stack
            .iter()
            .rposition(|&x| x == v)
            .expect("v is on the stack");
        let size = sc.stack.len() - start;
        let mut lowest = v;
        for &x in &sc.stack[start..] {
            sc.on_stack[x as usize] = false;
            if self.lines[x as usize].id < self.lines[lowest as usize].id {
                lowest = x;
            }
        }
        sc.stack.truncate(start);
        if size == 1 {
            self.order.push(v);
            return;
        }
        // A simple cycle (one link per line): `lowest`, then the lines after it along the links,
        // written in reverse, so each line follows the one it feeds.
        self.order.push(lowest);
        let from = self.order.len();
        let mut x = self.succ(lowest).expect("a cycle member has a link");
        while x != lowest {
            self.order.push(x);
            x = self.succ(x).expect("a cycle member has a link");
        }
        debug_assert_eq!(self.order.len() - from + 1, size, "not a simple cycle");
        self.order[from..].reverse();
    }
}
