//! The wake queue (docs/decisions/0007-world-model.md §7: "wake-ups are queued and applied at one
//! fixed point in the tick"; docs/plan/21b-timers-wakeups-and-tickcx.md Scope "Wake queue"): two
//! lists, `now` (drained by `TickCx::next_woken` during `G::tick`) and `next` (every entity put
//! made through `Authority` outside `G::tick`, plus `TickCx::wake`, appends here, deduplicated, in
//! insertion order). The fixed point (`Authority::begin_tick`/`end_tick`) swaps `next` into `now`
//! at the start of a tick and drops whatever `now` is left holding at the end of it -- so `now` is
//! never observed non-empty outside one `G::tick` call, and only `next` needs to survive a
//! snapshot (`Store::encode`'s own "woken_next" field).

use std::collections::{BTreeSet, VecDeque};

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::game::EntityId;

/// One deduplicated, insertion-ordered list of entity ids.
#[derive(Default)]
struct WakeList {
    order: VecDeque<EntityId>,
    member: BTreeSet<EntityId>,
}

impl WakeList {
    /// Appends `id` unless it is already present. Returns whether it was newly inserted (the undo
    /// journal only needs to remember a push that actually changed anything).
    fn push(&mut self, id: EntityId) -> bool {
        if self.member.insert(id) {
            self.order.push_back(id);
            true
        } else {
            false
        }
    }

    fn pop_front(&mut self) -> Option<EntityId> {
        let id = self.order.pop_front()?;
        self.member.remove(&id);
        Some(id)
    }

    /// Removes `id` if present, wherever it sits in the list (the undo journal's own rollback:
    /// order among the *other* entries does not matter once one entry is undone). Returns whether
    /// it was present.
    fn remove(&mut self, id: EntityId) -> bool {
        if !self.member.remove(&id) {
            return false;
        }
        if let Some(pos) = self.order.iter().position(|&x| x == id) {
            self.order.remove(pos);
        }
        true
    }

    fn clear(&mut self) {
        self.order.clear();
        self.member.clear();
    }

    fn len(&self) -> usize {
        self.order.len()
    }

    fn iter(&self) -> impl Iterator<Item = EntityId> + '_ {
        self.order.iter().copied()
    }
}

/// `now`/`next` (docs/plan/21b-timers-wakeups-and-tickcx.md Scope). `now` is deliberately never
/// encoded: outside a `G::tick` call in progress it is always empty (`Authority::end_tick` clears
/// it).
#[derive(Default)]
pub(crate) struct WakeQueue {
    now: WakeList,
    next: WakeList,
}

impl WakeQueue {
    pub(crate) fn new() -> Self {
        WakeQueue::default()
    }

    /// `Authority::do_spawn`/`do_put_entity`'s auto-wake, and `TickCx::wake`. Returns whether `id`
    /// was newly inserted (for the undo journal).
    pub(crate) fn push_next(&mut self, id: EntityId) -> bool {
        self.next.push(id)
    }

    /// Undoes a [`WakeQueue::push_next`] that turns out to belong to a rolled-back `apply` (the
    /// undo journal, docs/plan/21b-timers-wakeups-and-tickcx.md Planning decisions).
    pub(crate) fn remove_next(&mut self, id: EntityId) -> bool {
        self.next.remove(id)
    }

    pub(crate) fn pop_now(&mut self) -> Option<EntityId> {
        self.now.pop_front()
    }

    /// The fixed point (`Authority::begin_tick`): `next` becomes `now`, `next` starts fresh so
    /// writes during `G::tick` queue for the *next* tick.
    pub(crate) fn swap(&mut self) {
        std::mem::swap(&mut self.now, &mut self.next);
        self.next.clear();
    }

    /// `Authority::end_tick`: whatever the game left in `now` undrained is dropped (0007 §7's own
    /// "applied at one fixed point" -- a wake not drained this tick is not carried to the next one;
    /// an entity that still needs it must be re-woken).
    pub(crate) fn clear_now(&mut self) {
        self.now.clear();
    }

    /// `Store::write_canonical`/`hash_state`: insertion order (docs/plan/
    /// 21b-timers-wakeups-and-tickcx.md Scope "woken_next (insertion order)").
    pub(crate) fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.next.len() as u32);
        for id in self.next.iter() {
            sink.put_u32(id.0);
        }
    }

    /// `Store::decode`: `now` is left empty (production never observes it non-empty outside a
    /// `G::tick` call, and a snapshot is only ever taken between ticks).
    pub(crate) fn decode(reader: &mut ByteReader) -> Result<Self, CodecError> {
        let mut next = WakeList::default();
        let count = reader.u32()?;
        for _ in 0..count {
            next.push(EntityId(reader.u32()?));
        }
        Ok(WakeQueue {
            now: WakeList::default(),
            next,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_and_order() {
        let mut q = WakeQueue::new();
        assert!(q.push_next(EntityId(1)));
        assert!(q.push_next(EntityId(2)));
        assert!(!q.push_next(EntityId(1)), "already queued: no duplicate");
        q.swap();
        assert_eq!(q.pop_now(), Some(EntityId(1)));
        assert_eq!(q.pop_now(), Some(EntityId(2)));
        assert_eq!(q.pop_now(), None);
    }

    #[test]
    fn undrained_is_dropped_at_end_of_tick() {
        let mut q = WakeQueue::new();
        q.push_next(EntityId(1));
        q.swap();
        q.clear_now();
        assert_eq!(q.pop_now(), None);
    }

    #[test]
    fn remove_next_undoes_a_push() {
        let mut q = WakeQueue::new();
        q.push_next(EntityId(1));
        q.push_next(EntityId(2));
        assert!(q.remove_next(EntityId(1)));
        assert!(!q.remove_next(EntityId(1)), "already removed");
        q.swap();
        assert_eq!(q.pop_now(), Some(EntityId(2)));
        assert_eq!(q.pop_now(), None);
    }

    #[test]
    fn roundtrip_encodes_only_next() {
        let mut q = WakeQueue::new();
        q.push_next(EntityId(3));
        q.push_next(EntityId(1));
        let mut buf = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        q.write_canonical(&mut V(&mut buf));
        let mut reader = ByteReader::new(&buf);
        let mut r = WakeQueue::decode(&mut reader).unwrap();
        r.swap();
        assert_eq!(r.pop_now(), Some(EntityId(3)));
        assert_eq!(r.pop_now(), Some(EntityId(1)));
    }
}
