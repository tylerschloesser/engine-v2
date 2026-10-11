//! Candidate A of 0077 §1: every item a node `(item, pos, next, prev)` in one global arena, a doubly
//! linked list per line front to back, absolute positions. Advance visits every item.
#![allow(dead_code)]

use super::repr::{Refused, Repr, SP, front_leader};
use super::world::{Item, LineIdx, LineSpec, Out, SPACING};
use engine::bytes::ByteSink;

const NIL: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct Node {
    item: Item,
    pos: u32,
    next: u32,
    prev: u32,
}

#[derive(Clone, Copy)]
struct Line {
    len: i32,
    speed: i32,
    out: Out,
    head: u32,
    tail: u32,
    count: u32,
}

#[derive(Clone)]
pub struct ReprA {
    lines: Vec<Line>,
    nodes: Vec<Node>,
    free: u32,
    sunk: u64,
}

impl ReprA {
    fn alloc(&mut self, item: Item, pos: u32) -> Result<u32, Refused> {
        let n = self.free;
        if n == NIL {
            return Err(Refused::Full);
        }
        self.free = self.nodes[n as usize].next;
        self.nodes[n as usize] = Node {
            item,
            pos,
            next: NIL,
            prev: NIL,
        };
        Ok(n)
    }

    fn release(&mut self, n: u32) {
        self.nodes[n as usize].next = self.free;
        self.free = n;
    }

    fn push_back(&mut self, l: LineIdx, n: u32, pos: u32) {
        let line = &mut self.lines[l as usize];
        let tail = line.tail;
        {
            let node = &mut self.nodes[n as usize];
            node.pos = pos;
            node.next = NIL;
            node.prev = tail;
        }
        if tail == NIL {
            line.head = n;
        } else {
            self.nodes[tail as usize].next = n;
        }
        line.tail = n;
        line.count += 1;
    }

    /// M41: a structure change (a sink closing or reopening), for the forecast spike's agreement
    /// check.
    pub fn set_out(&mut self, l: LineIdx, out: Out) {
        self.lines[l as usize].out = out;
    }

    fn tail_pos(&self, l: LineIdx) -> Option<i32> {
        let t = self.lines[l as usize].tail;
        (t != NIL).then(|| self.nodes[t as usize].pos as i32)
    }

    fn unlink(&mut self, l: LineIdx, n: u32) {
        let Node { next, prev, .. } = self.nodes[n as usize];
        let line = &mut self.lines[l as usize];
        if prev == NIL {
            line.head = next;
        } else {
            self.nodes[prev as usize].next = next;
        }
        if next == NIL {
            line.tail = prev;
        } else {
            self.nodes[next as usize].prev = prev;
        }
        line.count -= 1;
    }

    fn advance_line(&mut self, l: LineIdx) {
        let line = self.lines[l as usize];
        if line.head == NIL {
            return;
        }
        let target = match line.out {
            Out::Next(t) => self
                .tail_pos(t)
                .map(|tail| (tail, self.lines[t as usize].len)),
            _ => None,
        };
        let mut leader = front_leader(line.out, target);
        let mut n = line.head;
        while n != NIL {
            let node = &mut self.nodes[n as usize];
            let pos = node.pos as i32;
            let bound = leader + SP;
            let p = if pos < bound {
                pos
            } else {
                (pos - line.speed).max(bound)
            };
            leader = p;
            let next = node.next;
            if p >= 0 {
                node.pos = p as u32;
                n = next;
                continue;
            }
            // Crossing: `n` is the line's head.
            self.unlink(l, n);
            match line.out {
                Out::Sink => {
                    self.release(n);
                    self.sunk += 1;
                }
                Out::Next(t) => {
                    let tlen = self.lines[t as usize].len;
                    self.push_back(t, n, (tlen + p) as u32);
                }
                Out::DeadEnd => unreachable!("a dead end bounds p at 0"),
            }
            n = next;
        }
    }
}

impl Repr for ReprA {
    const NAME: &'static str = "A";

    fn build(specs: &[LineSpec]) -> Self {
        let cap: u32 = specs.iter().map(|s| s.len.div_ceil(SPACING)).sum();
        let mut nodes = Vec::with_capacity(cap as usize);
        for i in 0..cap {
            nodes.push(Node {
                item: 0,
                pos: 0,
                next: if i + 1 < cap { i + 1 } else { NIL },
                prev: NIL,
            });
        }
        let mut r = ReprA {
            lines: specs
                .iter()
                .map(|s| Line {
                    len: s.len as i32,
                    speed: i32::from(s.speed),
                    out: s.out,
                    head: NIL,
                    tail: NIL,
                    count: 0,
                })
                .collect(),
            nodes,
            free: if cap > 0 { 0 } else { NIL },
            sunk: 0,
        };
        for (l, s) in specs.iter().enumerate() {
            for &(item, pos) in &s.items_at_rest {
                let n = r.alloc(item, pos).expect("capacity");
                r.push_back(l as LineIdx, n, pos);
            }
        }
        r
    }

    fn advance(&mut self, order: &[LineIdx]) {
        for &l in order {
            self.advance_line(l);
        }
    }

    fn insert_back(&mut self, l: LineIdx, item: Item) -> Result<(), Refused> {
        let line = self.lines[l as usize];
        let land = match self.tail_pos(l) {
            None => line.len - line.speed,
            Some(t) => (line.len - line.speed).max(t + SP),
        };
        if land > line.len - 1 {
            return Err(Refused::NoRoom);
        }
        let n = self.alloc(item, land as u32)?;
        self.push_back(l, n, land as u32);
        Ok(())
    }

    fn insert_at(&mut self, l: LineIdx, pos: u32, item: Item) -> Result<(), Refused> {
        let line = self.lines[l as usize];
        let pos = pos as i32;
        if pos > line.len - 1 {
            return Err(Refused::NoRoom);
        }
        let mut pred = NIL;
        let mut n = line.head;
        while n != NIL && self.nodes[n as usize].pos as i32 <= pos {
            pred = n;
            n = self.nodes[n as usize].next;
        }
        if pred != NIL && pos - (self.nodes[pred as usize].pos as i32) < SP {
            return Err(Refused::NoRoom);
        }
        if n != NIL && (self.nodes[n as usize].pos as i32) - pos < SP {
            return Err(Refused::NoRoom);
        }
        let new = self.alloc(item, pos as u32)?;
        self.nodes[new as usize].prev = pred;
        self.nodes[new as usize].next = n;
        let line = &mut self.lines[l as usize];
        if pred == NIL {
            line.head = new;
        } else {
            self.nodes[pred as usize].next = new;
        }
        if n == NIL {
            line.tail = new;
        } else {
            self.nodes[n as usize].prev = new;
        }
        line.count += 1;
        Ok(())
    }

    fn remove_at(&mut self, l: LineIdx, pos: u32) -> Option<Item> {
        let pos = pos as i32;
        let mut n = self.lines[l as usize].head;
        while n != NIL {
            let node = self.nodes[n as usize];
            let p = node.pos as i32;
            if p > pos + SP / 2 {
                return None;
            }
            if (p - pos).abs() <= SP / 2 {
                self.unlink(l, n);
                self.release(n);
                return Some(node.item);
            }
            n = node.next;
        }
        None
    }

    fn encode(&self, sink: &mut dyn ByteSink) {
        for line in &self.lines {
            sink.put_varint(u64::from(line.count));
            let mut leader = -SP;
            let mut n = line.head;
            while n != NIL {
                let node = &self.nodes[n as usize];
                sink.put_u16(node.item);
                sink.put_varint((node.pos as i32 - leader - SP) as u64);
                leader = node.pos as i32;
                n = node.next;
            }
        }
    }

    fn items(&self, l: LineIdx, out: &mut Vec<(Item, u32)>) {
        out.clear();
        let mut n = self.lines[l as usize].head;
        while n != NIL {
            let node = &self.nodes[n as usize];
            out.push((node.item, node.pos));
            n = node.next;
        }
    }

    fn sunk(&self) -> u64 {
        self.sunk
    }
}
