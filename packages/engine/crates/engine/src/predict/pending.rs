//! `Prediction`, `Pending<G>` and `PendingQueue<G>` (docs/decisions/0012-prediction-and-
//! reconciliation.md Decision: "queued as pending with its `seq`"; docs/plan/
//! 25-prediction-core.md Seams). Ported from the spike's own `Prediction<R>`/`Pending<G>`/
//! `Client`'s `pending: VecDeque<Pending<G>>`.

use std::collections::VecDeque;

use crate::game::Game;
use crate::time::Tick;

/// One predicted action's own outcome (0012 Decision, verbatim): `Applied`'s writes are already in
/// the overlay; `NotPredictable` covers both a declined read (`Unknown`) and `G::predict(a) ==
/// false`; `Rejected` is a *hint* only (0012 "A local `Rejected` is likewise a hint, never a
/// verdict") -- never surfaced to the UI on its own (docs/plan/25-prediction-core.md Planning
/// decisions).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Prediction<R> {
    Applied,
    NotPredictable,
    Rejected(R),
}

/// One action still awaiting its host ack, tracked purely for prediction (this is *not* the outbox
/// -- `client::core::ClientCore`'s existing `outbox: Vec<(u32, Vec<u8>)>` still owns sending the
/// encoded bytes exactly once; M28b's resend seam is the first thing that reads this queue for
/// retransmission, docs/plan/25-prediction-core.md Non-scope).
pub struct Pending<G: Game> {
    pub seq: u32,
    pub action: G::Action,
    /// Frozen at submit time (0012 "Frozen predicted tick"): every replay re-predicts against this
    /// same tick, never a freshly read one.
    pub predicted_tick: Tick,
    /// Re-evaluated on every replay (docs/plan/25-prediction-core.md Planning decisions: "Statuses
    /// are re-evaluated on every replay").
    pub status: Prediction<G::Reject>,
    /// The authoritative tick this client held at the moment this action was dispatched -- M26's
    /// `on_ack_sample` hook pairs this with the tick the ack itself lands on, to estimate lead
    /// (docs/plan/25-prediction-core.md Provides).
    pub auth_tick_at_dispatch: Tick,
}

/// The client's own pending queue (0012 Decision): every action dispatched but not yet acked,
/// oldest first. Capacity is a convention shared with `client::core::OUTBOX_CAPACITY` (docs/plan/
/// 25-prediction-core.md Planning decisions: "Queue full stays M16's behaviour ... prediction adds
/// no second limit") -- `ClientCore::on_action` refuses a further dispatch once *this* queue
/// itself reaches `OUTBOX_CAPACITY`, so nothing here needs to enforce a second cap of its own.
///
/// **Post-`done` fix (docs/plan/26-prediction-rendering-and-clocks.md, "PendingQueue never drains
/// under bench.frame_worstcase"):** `on_action`'s guard used to check `outbox.len()`, the
/// transient *send* buffer `poll_uplink` clears on every flush regardless of whether anything has
/// been acked -- so this queue had no real cap at all in practice, and grew one entry per
/// dispatch for as long as acks kept not arriving (`pending=510` against 510 dispatches, measured
/// live). The guard now reads `pending.len()` directly.
pub struct PendingQueue<G: Game> {
    entries: VecDeque<Pending<G>>,
}

impl<G: Game> PendingQueue<G> {
    pub fn new() -> Self {
        PendingQueue {
            entries: VecDeque::new(),
        }
    }

    pub fn push(&mut self, p: Pending<G>) {
        self.entries.push_back(p);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Pending<G>> {
        self.entries.iter()
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Pending<G>> {
        self.entries.iter_mut()
    }

    /// Pops the oldest entry if its `seq <= ack_seq`, or `None` (0012 step 2: "pop pending actions
    /// with `seq <= ack_seq`" -- the game's own `Confirmed`/`Rejected` notification already travels
    /// through the existing `ActionResults`/`drain_results` path, M16; this only retires the
    /// pending queue's own bookkeeping copy, one entry per call so the caller can sample each ack
    /// individually, docs/plan/25-prediction-core.md Provides "`on_ack_sample`"). Every pending
    /// `seq` is monotonic (`ClientCore::on_action`'s own `next_seq`-free ordering: the ring
    /// producer assigns `seq`, 0003), so the front of the queue is always the oldest.
    pub fn pop_acked_through(&mut self, ack_seq: u32) -> Option<Pending<G>> {
        match self.entries.front() {
            Some(p) if p.seq <= ack_seq => self.entries.pop_front(),
            _ => None,
        }
    }

    /// M28b's resend seam (docs/plan/25-prediction-core.md Provides, verbatim): every action still
    /// pending after `seq`, oldest first. Since [`Self::pop_acked_through`] already drops every
    /// acked entry each frame, every entry this queue holds is by definition unacked -- `seq` lets
    /// the caller resend only what a reconnect's own last-known-ack has not already covered.
    pub fn unacked_after(&self, seq: u32) -> impl Iterator<Item = (u32, &G::Action)> {
        self.entries
            .iter()
            .filter(move |p| p.seq > seq)
            .map(|p| (p.seq, &p.action))
    }
}

impl<G: Game> Default for PendingQueue<G> {
    fn default() -> Self {
        Self::new()
    }
}
