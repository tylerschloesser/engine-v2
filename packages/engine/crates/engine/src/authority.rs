//! `Authority<G>` (docs/decisions/0003-game-facing-api.md "Contexts": "the host; reads never
//! `Unknown`" except a missing player; a write applies, records the delta, and derives its scope
//! from footprint or player"): wraps a `Store<G>` plus the host driver's own state, `SimRng` and
//! the current `Tick`, that M12's `Store` deliberately does not hold (docs/plan/
//! 12-store-and-game-trait.md Deviations). `TickCx` (0003: "`Authority` plus iteration over active
//! entities") is built here too, since it delegates every `WorldRead`/`WorldWrite` method straight
//! to one; docs/plan/21b-timers-wakeups-and-tickcx.md gives it its final shape (wake/timer/active-
//! list methods) and adds the undo-journal experiment at the bottom of this file.

use std::cell::RefCell;

use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::rng::SimRng;
use crate::store::Store;
use crate::time::{Tick, Ticks};
use crate::world::{ChunkCoord, SystemId, TerrainStore, Tile, TilePos, TileRect, TraitSet};
use crate::world_access::{WorldRead, WorldWrite, chunk_of};

/// The undo-journal experiment's adopt/not-adopt decision (docs/plan/
/// 21b-timers-wakeups-and-tickcx.md Planning decisions, ADR: see Deviations for the measured
/// numbers this constant follows). `false`: the pre-existing assert stays the only enforcement of
/// "validate first, write after" in every build, exactly as before this milestone.
pub(crate) const UNDO_JOURNAL_ADOPTED: bool = false;

/// Who a delta is scoped to (0011 "Scopes"), derived mechanically at write time -- never chosen by
/// the game.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Chunk(ChunkCoord),
    Player(PlayerId),
    Global,
}

/// Up to 8 scopes for one write. 0007 §5 bounds one footprint at 4 overlapped chunks; a moved
/// entity (M21, docs/plan/21-entities-and-timers.md Scope: "every chunk under the old and new
/// footprint, <= 4 each") can therefore touch up to 4 old-footprint chunks plus 4 new-footprint
/// ones, deduplicated -- 8 is the true worst case, not 4 (widened from M12b's original 4-slot
/// array, which only ever needed to hold a single-tile write's one chunk or a move's old/new
/// *anchor* pair, at most 2). A fixed inline array, never heap-allocated (Budgets: zero allocation
/// in `apply`/`tick` steady state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scopes {
    items: [Option<Scope>; 8],
}

impl Scopes {
    pub const fn none() -> Self {
        Scopes { items: [None; 8] }
    }

    pub const fn one(a: Scope) -> Self {
        Scopes {
            items: [Some(a), None, None, None, None, None, None, None],
        }
    }

    pub const fn two(a: Scope, b: Scope) -> Self {
        Scopes {
            items: [Some(a), Some(b), None, None, None, None, None, None],
        }
    }

    /// Builds from up to 8 chunk scopes, deduplicating (M21: old-footprint + new-footprint chunks,
    /// each side already capped at 4 by 0007 §5's own footprint bound). Extra items beyond 8 are
    /// dropped -- unreachable given that bound, so this is a defensive cap, not a real limit.
    pub(crate) fn from_chunks(chunks: impl Iterator<Item = ChunkCoord>) -> Self {
        let mut items: [Option<Scope>; 8] = [None; 8];
        let mut n = 0usize;
        'outer: for c in chunks {
            let s = Scope::Chunk(c);
            for existing in items.iter().take(n) {
                if *existing == Some(s) {
                    continue 'outer;
                }
            }
            if n < items.len() {
                items[n] = Some(s);
                n += 1;
            }
        }
        Scopes { items }
    }

    pub fn iter(&self) -> impl Iterator<Item = Scope> + '_ {
        self.items.iter().filter_map(|s| *s)
    }

    pub fn len(&self) -> usize {
        self.items.iter().filter(|s| s.is_some()).count()
    }

    pub fn is_empty(&self) -> bool {
        self.items[0].is_none()
    }
}

/// One `Authority`'s recorded writes since the last [`Authority::clear_changes`]: `(Scopes,
/// Delta<G>)` pairs, in write order. Reused across ticks (`Sim::step` clears it after handing the
/// frame to its caller), never reallocated in steady state once its capacity settles.
pub struct ChangeLog<G: Game> {
    changes: Vec<(Scopes, Delta<G>)>,
}

impl<G: Game> ChangeLog<G> {
    pub fn new() -> Self {
        ChangeLog {
            changes: Vec::new(),
        }
    }

    pub fn push(&mut self, scopes: Scopes, delta: Delta<G>) {
        self.changes.push((scopes, delta));
    }

    pub fn clear(&mut self) {
        self.changes.clear();
    }

    /// The undo journal's own rollback (docs/plan/21b-timers-wakeups-and-tickcx.md): drops every
    /// entry recorded since `len`, so a rolled-back `apply`'s writes never reach a client as
    /// deltas.
    pub(crate) fn truncate(&mut self, len: usize) {
        self.changes.truncate(len);
    }

    pub fn as_slice(&self) -> &[(Scopes, Delta<G>)] {
        &self.changes
    }

    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

impl<G: Game> Default for ChangeLog<G> {
    fn default() -> Self {
        Self::new()
    }
}

/// The host's authoritative world (0003 "Contexts"). A write is `Store::apply` plus pushing the
/// scoped `Delta` onto a reused [`ChangeLog`]; reads are total except a missing player.
pub struct Authority<G: Game> {
    store: Store<G>,
    rng: SimRng,
    tick: Tick,
    changes: ChangeLog<G>,
    /// Reused across `entities_in` calls (`.claude/rules/hot-paths.md`): a `RefCell` since
    /// `WorldRead::entities_in` takes `&self`.
    entities_in_scratch: RefCell<Vec<EntityId>>,
    /// The state budget (0007 §8), defaulted to the ADR's own baseline-phone figures so a test
    /// that never calls [`Authority::set_budget`] still behaves like production; `Sim::genesis`
    /// (M21) overrides all three from `WorldParams<G>` right after construction.
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
    /// 0023 "Honesty is audited, not trusted": bumped by the release-mode half of the growth
    /// audit (`crate::budget`) whenever an action added more than it declared -- debug/test
    /// builds panic instead (docs/plan/21-entities-and-timers.md Tests added: `under_declared_
    /// growth_counts_in_release`/`_panics_in_debug`).
    growth_violations: u64,
    /// Diagnostic counter (Budgets: "the tick time row"; docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Provides): every id `TickCx::next_woken`/`next_due`/`active_at` actually yields this tick.
    /// Reset by [`Authority::begin_tick`]. Proves tick cost is O(active entities): a world of
    /// sleeping machines with none due must read `0` here.
    entities_visited_per_tick: u64,
    /// 0023 "apply, measure, roll back" alternative (docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Planning decisions): bumped by the release-mode half of the undo-journal rollback, if
    /// adopted (below).
    apply_rollbacks: u64,
    /// The undo-journal experiment (Planning decisions "Host-side atomicity of `apply`"): records
    /// enough to undo one `apply` call's writes, discarded on `Ok`, replayed backwards on `Err`.
    journal: UndoJournal<G>,
}

impl<G: Game> Authority<G> {
    /// `terrain` is already constructed (M07/M08 own that); `global` is the value before
    /// `Game::genesis` runs (`Store::new`'s own doc comment: `G::Global` has no `Default` bound in
    /// the `Game` trait, so `Sim::genesis` -- the only production caller -- supplies one through a
    /// local `where G::Global: Default` bound instead; see docs/plan/
    /// 12b-world-access-and-sim-driver.md Deviations). `Game::register` runs once, inside
    /// `Store::new` (M21, docs/plan/21-entities-and-timers.md Deviations: moved from here into
    /// `Store` so `Store::apply` can consult footprints for `ChunkIndex` maintenance) -- `Authority`
    /// no longer holds its own `Registry` copy, reading `self.store.registry()` instead.
    pub fn new(terrain: TerrainStore, global: G::Global, seed: u64) -> Self {
        Authority {
            store: Store::new(terrain, global),
            rng: SimRng::new(seed),
            tick: Tick(0),
            changes: ChangeLog::new(),
            entities_in_scratch: RefCell::new(Vec::new()),
            max_entities: 262_144,
            max_modified_tiles: 1_048_576,
            max_action_growth: 4_096,
            growth_violations: 0,
            entities_visited_per_tick: 0,
            apply_rollbacks: 0,
            journal: UndoJournal::new(),
        }
    }

    /// Sets the state budget (M21, docs/plan/21-entities-and-timers.md): called once by
    /// `Sim::genesis` right after construction, from `WorldParams<G>` (0009's `WorldConfig.params`,
    /// already carried there since M13/M15 but unread until this milestone).
    pub(crate) fn set_budget(
        &mut self,
        max_entities: u32,
        max_modified_tiles: u32,
        max_action_growth: u32,
    ) {
        self.max_entities = max_entities;
        self.max_modified_tiles = max_modified_tiles;
        self.max_action_growth = max_action_growth;
    }

    pub fn max_entities(&self) -> u32 {
        self.max_entities
    }

    pub fn max_modified_tiles(&self) -> u32 {
        self.max_modified_tiles
    }

    pub fn max_action_growth(&self) -> u32 {
        self.max_action_growth
    }

    /// Cumulative count of under-declared actions the release-mode audit has caught (0023):
    /// `engine/test`'s own counter, and this milestone's `under_declared_growth_counts_in_release`.
    pub fn growth_violations(&self) -> u64 {
        self.growth_violations
    }

    pub(crate) fn record_growth_violation(&mut self) {
        self.growth_violations += 1;
    }

    /// docs/plan/21b-timers-wakeups-and-tickcx.md Provides.
    pub fn entities_visited_per_tick(&self) -> u64 {
        self.entities_visited_per_tick
    }

    fn bump_visited(&mut self) {
        self.entities_visited_per_tick += 1;
    }

    /// Undo-journal rollbacks so far (0023's "apply, measure, roll back" alternative, if adopted).
    pub fn apply_rollbacks(&self) -> u64 {
        self.apply_rollbacks
    }

    pub fn store(&self) -> &Store<G> {
        &self.store
    }

    /// Mutable store access (M21, testkit-only in practice): `testkit::fill_world`/`set_next_
    /// entity_id` need to reach `Store` directly to build a large world without hundreds of
    /// thousands of individual `Sim::step` calls.
    #[cfg(any(test, feature = "testing"))]
    pub fn store_mut(&mut self) -> &mut Store<G> {
        &mut self.store
    }

    pub fn changes(&self) -> &[(Scopes, Delta<G>)] {
        self.changes.as_slice()
    }

    pub fn clear_changes(&mut self) {
        self.changes.clear();
    }

    #[inline]
    pub fn tick(&self) -> Tick {
        self.tick
    }

    /// `Sim::step`, after `G::tick` runs for the current tick (Scope: "records ... then `G::tick`,
    /// then advances the tick"). `pub(crate)`: only the driver advances the clock.
    pub(crate) fn advance_tick(&mut self) {
        self.tick = self.tick.add(Ticks(1));
    }

    /// The fixed point at the start of `G::tick` (0007 §7; docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Scope "Wake queue"): swaps the wake queue's `next` into `now`, so this tick's `next_woken`
    /// serves exactly what was queued since the previous fixed point. Also compacts every active
    /// list's tombstones from the *previous* tick's `deactivate` calls (Scope "Active lists":
    /// "removals ... take effect at the next fixed point") -- so a caller inspecting
    /// `active_len`/`active_at` anywhere between the end of one `Sim::step` and the start of the
    /// next still sees the old, tombstoned shape, and only this tick's own compaction (run before
    /// this tick's `G::tick`, so this tick's rule already sees the closed-up list) changes it.
    /// Also resets the per-tick visited counter.
    pub(crate) fn begin_tick(&mut self) {
        self.store.wake_swap();
        self.store.active_compact_all();
        self.entities_visited_per_tick = 0;
    }

    /// The fixed point at the end of `G::tick`: whatever `now` still holds is dropped (0007 §7:
    /// "applied at one fixed point").
    pub(crate) fn end_tick(&mut self) {
        self.store.wake_clear_now();
    }

    /// The undo-journal experiment (`Sim::step`, around one `G::apply` call): starts recording.
    pub(crate) fn begin_apply_journal(&mut self) {
        self.journal.begin();
    }

    /// `apply` returned `Ok`, or returned `Err` with no write (the common, well-behaved case):
    /// discard whatever the journal recorded (Planning decisions: "discarded on `Ok`" -- also true
    /// of a clean rejection, which recorded nothing to discard in the first place).
    pub(crate) fn commit_apply_journal(&mut self) {
        self.journal.commit();
    }

    /// A rejecting `apply` that nonetheless wrote (violates "validate first, write after", 0003).
    /// Debug and test builds panic immediately, so authors learn the mistake right away (docs/plan/
    /// 21b-timers-wakeups-and-tickcx.md Planning decisions: "debug and test builds keep the
    /// panic"). Release builds roll back through the undo journal instead, counting it, **only if**
    /// [`UNDO_JOURNAL_ADOPTED`] -- Deviations records the measured numbers behind that constant;
    /// while it is `false` this is unconditional, exactly the assert this milestone found in place.
    pub(crate) fn handle_rejected_apply_write(&mut self, who: PlayerId, seq: u32, before: usize) {
        if UNDO_JOURNAL_ADOPTED && !cfg!(debug_assertions) {
            self.journal.rollback(&mut self.store);
            self.changes.truncate(before);
            self.apply_rollbacks += 1;
        } else {
            panic!("a rejecting apply recorded a write (0004 Consequences): who={who:?} seq={seq}");
        }
    }

    /// Test-only direct control of the undo journal (docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Tests added: `journal_rolls_back_store_indexes_wakes_counts`), bypassing the debug/release
    /// branch in [`Authority::handle_rejected_apply_write`] so the rollback mechanism itself can be
    /// exercised under `cfg(test)` independent of [`UNDO_JOURNAL_ADOPTED`].
    #[cfg(any(test, feature = "testing"))]
    pub fn rollback_apply_journal_for_test(&mut self, before: usize) {
        self.journal.rollback(&mut self.store);
        self.changes.truncate(before);
        self.apply_rollbacks += 1;
    }

    /// The host's per-player last-processed `seq` (0004), updated through `Store::apply` --
    /// `Store::apply` is the only mutator of replicated state (`crate::store`'s own doc comment)
    /// -- but outside [`Authority::write`]/the [`ChangeLog`]: 0004 delivers acks to a client over
    /// their own channel ("Acks ride on deltas", a separate `Ack<G>`, never a rebroadcast
    /// `Delta`), so this is never a scoped, client-visible change (docs/plan/
    /// 12b-world-access-and-sim-driver.md Deviations, which also has the added `Delta::Ack`
    /// variant this calls into `Store::apply` through).
    pub(crate) fn record_ack(&mut self, who: PlayerId, seq: u32) {
        self.store.apply(&Delta::Ack { who, seq });
    }

    fn write(&mut self, delta: Delta<G>, scopes: Scopes) {
        if self.journal.is_recording() {
            self.journal.capture_pre_image(&self.store, &delta);
        }
        self.store.apply(&delta);
        self.changes.push(scopes, delta);
    }

    /// [`WorldWrite::spawn`]'s real body (docs/plan/21b-timers-wakeups-and-tickcx.md Scope: "every
    /// `EntityPut` made through `Authority` outside `G::tick` ... pushes the id to `woken_next`");
    /// `wake` is `true` from `Authority`'s own `WorldWrite` impl (apply/on_player/genesis) and
    /// `false` from `TickCx`'s (Planning decisions: "puts made through `TickCx` do not auto-wake").
    fn do_spawn(&mut self, e: G::Entity, wake: bool) -> EntityId {
        let id = EntityId(self.store.next_entity_id());
        let scope = self.entity_scopes(id, Some(&e));
        self.write(Delta::EntityPut { id, entity: e }, scope);
        if wake {
            self.auto_wake(id);
        }
        id
    }

    fn do_put_entity(&mut self, id: EntityId, e: G::Entity, wake: bool) {
        let scope = self.entity_scopes(id, Some(&e));
        self.write(Delta::EntityPut { id, entity: e }, scope);
        if wake {
            self.auto_wake(id);
        }
    }

    fn do_despawn(&mut self, id: EntityId) {
        let scope = self.entity_scopes(id, None);
        self.write(Delta::EntityGone { id }, scope);
        // `Store::apply`'s own `EntityGone` arm already cancels the timer and deactivates every
        // active list for `id` (0007 §7: "despawn removes"/"despawn deactivates everywhere") --
        // nothing further to do here.
    }

    /// Pushes `id` to the wake queue's `next` list, deduplicated (docs/plan/
    /// 21b-timers-wakeups-and-tickcx.md Scope). Shared by every auto-wake put and `TickCx::wake`.
    fn auto_wake(&mut self, id: EntityId) {
        let pushed = self.store.wake_push_next(id);
        if pushed && self.journal.is_recording() {
            self.journal.record_woke(id);
        }
    }

    /// Every chunk under the entity's old footprint (if it already existed) and its new one (if
    /// this write gives it one), deduplicated (docs/plan/21-entities-and-timers.md Scope: "every
    /// chunk under the old and new footprint (Scopes, <= 4 each)"). Widened from M12b's own
    /// anchor-chunk-only derivation: `encode_chunk_snapshot`'s entity filter and M15's frame
    /// builder widen together with this (M14/M15 Deviations "Entities in a chunk snapshot"/
    /// "Anchor-only entity delivery, not footprint overlap").
    fn entity_scopes(&self, id: EntityId, new: Option<&G::Entity>) -> Scopes {
        let dims = self.store.terrain().dims();
        let registry = self.store.registry();
        let old_rect = self.store.entity(id).map(|e| {
            crate::store::footprint_rect(G::anchor(e), registry.footprint(G::prototype(e)))
        });
        let new_rect = new.map(|e| {
            crate::store::footprint_rect(G::anchor(e), registry.footprint(G::prototype(e)))
        });
        let old_chunks = old_rect.into_iter().flat_map(|r| r.chunks(&dims).iter());
        let new_chunks = new_rect.into_iter().flat_map(|r| r.chunks(&dims).iter());
        Scopes::from_chunks(old_chunks.chain(new_chunks))
    }
}

impl<G: Game> WorldRead<G> for Authority<G> {
    fn tick(&self) -> Tick {
        self.tick
    }

    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        Ok(self.store.terrain().tile(p))
    }

    /// OR of the tile's traits and the occupant's traits (0007 §6): real as of M21.
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        let tile_traits = self
            .store
            .registry()
            .tile_traits(self.store.terrain().tile(p));
        let occupant_traits = match self.store.entity_at(p).and_then(|id| self.store.entity(id)) {
            Some(e) => self.store.registry().prototype_traits(G::prototype(e)),
            None => TraitSet::EMPTY,
        };
        Ok(tile_traits.union(occupant_traits))
    }

    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(self.store.entity_at(p))
    }

    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        Ok(self.store.entity(id))
    }

    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.store.player(who)
    }

    fn global(&self) -> &G::Global {
        self.store.global()
    }

    /// The host is always total (Non-scope: nothing gates a chunk from the host's own reads).
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        let mut scratch = self.entities_in_scratch.borrow_mut();
        self.store.entities_in(rect, &mut scratch, f);
        Ok(())
    }
}

impl<G: Game> WorldWrite<G> for Authority<G> {
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        if !p.in_range() {
            // 0007 §2: "writes outside the coordinate range are debug-asserted and ignored."
            debug_assert!(false, "set_tile outside coordinate range: {p:?}");
            return;
        }
        let scope = Scopes::one(Scope::Chunk(chunk_of::<G>(p)));
        self.write(Delta::Tile { pos: p, tile: t }, scope);
    }

    fn spawn(&mut self, e: G::Entity) -> EntityId {
        self.do_spawn(e, true)
    }

    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        self.do_put_entity(id, e, true)
    }

    fn despawn(&mut self, id: EntityId) {
        self.do_despawn(id)
    }

    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.write(
            Delta::Player { who, state: p },
            Scopes::one(Scope::Player(who)),
        );
    }

    fn put_global(&mut self, g: G::Global) {
        self.write(Delta::Global { state: g }, Scopes::one(Scope::Global));
    }

    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        Ok(&mut self.rng)
    }
}

/// The write context `Game::tick` receives (0003: "HOST ONLY. `TickCx` is a `WorldWrite`: the
/// same recording write path"). Minimal here (Planning decisions "Exact `TickCx` shape"): index-
/// based player iteration only; M21b adds wake/timer/active-list methods. Delegates every
/// `WorldRead`/`WorldWrite` method to the `Authority` it wraps.
pub struct TickCx<'a, G: Game> {
    authority: &'a mut Authority<G>,
}

impl<'a, G: Game> TickCx<'a, G> {
    pub(crate) fn new(authority: &'a mut Authority<G>) -> Self {
        TickCx { authority }
    }

    /// The write context as a plain `&mut dyn WorldWrite<G>`, e.g. to share a rule helper with
    /// `apply` (0003).
    pub fn as_write(&mut self) -> &mut dyn WorldWrite<G> {
        &mut *self.authority
    }

    pub fn player_count(&self) -> usize {
        self.authority.store().player_count()
    }

    /// The `i`th player in ascending `PlayerId` order (0022 §1's `Ord`; `Store`'s player table is
    /// a `BTreeMap`, so this is its natural iteration order). Index-based so a rule can write
    /// while iterating (Planning decisions: no entity-wide iteration exists, and the player table
    /// has no wheel -- `tick` just scans it, "tens of rows").
    pub fn player_id_at(&self, i: usize) -> Option<PlayerId> {
        self.authority.store().player_id_at(i)
    }

    /// Pops the next id the wake queue's fixed point (`Authority::begin_tick`) queued for this
    /// tick, or `None` once drained (docs/plan/21b-timers-wakeups-and-tickcx.md Provides).
    pub fn next_woken(&mut self) -> Option<EntityId> {
        let id = self.authority.store.wake_pop_now();
        if id.is_some() {
            self.authority.bump_visited();
        }
        id
    }

    /// Pops the earliest entity whose timer is now due (`tick <= self.tick()`), in key order, or
    /// `None` if the wheel is empty or its earliest entry is not yet due.
    pub fn next_due(&mut self) -> Option<EntityId> {
        let now = self.authority.tick;
        let id = self.authority.store.timer_next_due(now);
        if id.is_some() {
            self.authority.bump_visited();
        }
        id
    }

    /// Queues `id` for the *next* tick's `next_woken` (Planning decisions: "`TickCx::wake(id)` does
    /// the same" as an auto-waking put) -- deduplicated, insertion order.
    pub fn wake(&mut self, id: EntityId) {
        self.authority.auto_wake(id);
    }

    /// Sets `id`'s one timer (0007 §7: at most one per entity), replacing any existing one.
    pub fn wake_at(&mut self, id: EntityId, at: Tick) {
        self.authority.store.timer_wake_at(id, at);
    }

    /// Removes `id`'s timer, if any.
    pub fn cancel_wake(&mut self, id: EntityId) {
        self.authority.store.timer_cancel(id);
    }

    pub fn activate(&mut self, sys: SystemId, id: EntityId) {
        self.authority.store.active_activate(sys, id);
    }

    pub fn deactivate(&mut self, sys: SystemId, id: EntityId) {
        self.authority.store.active_deactivate(sys, id);
    }

    pub fn active_len(&self, sys: SystemId) -> usize {
        self.authority.store.active_len(sys)
    }

    /// Reading a live slot counts as visiting that entity (`entities_visited_per_tick`); a
    /// tombstoned or out-of-range index (`None`) does not.
    pub fn active_at(&mut self, sys: SystemId, i: usize) -> Option<EntityId> {
        let id = self.authority.store.active_at(sys, i);
        if id.is_some() {
            self.authority.bump_visited();
        }
        id
    }
}

impl<G: Game> WorldRead<G> for TickCx<'_, G> {
    fn tick(&self) -> Tick {
        WorldRead::<G>::tick(self.authority)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        self.authority.tile(p)
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        self.authority.traits_at(p)
    }
    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        self.authority.entity_at(p)
    }
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        self.authority.entity(id)
    }
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.authority.player(who)
    }
    fn global(&self) -> &G::Global {
        self.authority.global()
    }
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        self.authority.entities_in(rect, f)
    }
}

impl<G: Game> WorldWrite<G> for TickCx<'_, G> {
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        self.authority.set_tile(p, t);
    }
    /// No auto-wake (Planning decisions: "puts made through `TickCx` do not auto-wake").
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        self.authority.do_spawn(e, false)
    }
    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        self.authority.do_put_entity(id, e, false);
    }
    fn despawn(&mut self, id: EntityId) {
        self.authority.do_despawn(id);
    }
    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.authority.put_player(who, p);
    }
    fn put_global(&mut self, g: G::Global) {
        self.authority.put_global(g);
    }
    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        self.authority.rng()
    }
}

/// One key's pre-image, or the wake-queue push, recorded by [`UndoJournal::capture_pre_image`]/
/// [`UndoJournal::record_woke`] (docs/plan/21b-timers-wakeups-and-tickcx.md Planning decisions).
enum UndoEntry<G: Game> {
    Tile {
        pos: TilePos,
        old: Tile,
    },
    Entity {
        id: EntityId,
        old: Option<G::Entity>,
    },
    Player {
        who: PlayerId,
        old: Option<G::Player>,
    },
    Global {
        old: G::Global,
    },
    /// Undoes an [`Authority::auto_wake`] push: removed from the wake queue's `next` on rollback.
    Woke {
        id: EntityId,
    },
}

/// The undo-journal experiment (docs/plan/21b-timers-wakeups-and-tickcx.md Planning decisions:
/// "Host-side atomicity of `apply` via an undo journal"). Records the previous value (or absence)
/// of each key touched by one `apply` call, on that key's *first* touch only (a later write to the
/// same key within the same call must not overwrite the true original pre-image); discarded on
/// `Ok`, replayed backwards on `Err`. `entries` is preallocated and only ever `clear`ed, never
/// shrunk, so steady state after warm-up allocates nothing (`tick_state_steady_no_alloc` covers the
/// whole tick path, not just this journal, but this is why it can).
struct UndoJournal<G: Game> {
    entries: Vec<UndoEntry<G>>,
    recording: bool,
}

impl<G: Game> UndoJournal<G> {
    fn new() -> Self {
        UndoJournal {
            entries: Vec::with_capacity(16),
            recording: false,
        }
    }

    fn is_recording(&self) -> bool {
        self.recording
    }

    /// Starts recording for one `apply` call.
    fn begin(&mut self) {
        self.entries.clear();
        self.recording = true;
    }

    /// `apply` returned `Ok` (or a clean `Err` that recorded nothing): discard.
    fn commit(&mut self) {
        self.entries.clear();
        self.recording = false;
    }

    /// Captures `delta`'s target key's value in `store` *before* `Authority::write` applies it, if
    /// this is that key's first touch this `apply` call. `Roster`/`Ack` are never reachable from
    /// inside `G::apply` (`WorldWrite` has no method that produces either -- both are host-internal,
    /// `crate::sim`/`Authority::record_ack`'s own doc comments), so the journal has nothing to do
    /// for them.
    fn capture_pre_image(&mut self, store: &Store<G>, delta: &Delta<G>) {
        match delta {
            Delta::Tile { pos, .. } => {
                let touched = self
                    .entries
                    .iter()
                    .any(|e| matches!(e, UndoEntry::Tile { pos: p, .. } if p == pos));
                if !touched {
                    self.entries.push(UndoEntry::Tile {
                        pos: *pos,
                        old: store.terrain().tile(*pos),
                    });
                }
            }
            Delta::EntityPut { id, .. } | Delta::EntityGone { id } => {
                let touched = self
                    .entries
                    .iter()
                    .any(|e| matches!(e, UndoEntry::Entity { id: i, .. } if i == id));
                if !touched {
                    self.entries.push(UndoEntry::Entity {
                        id: *id,
                        old: store.entity(*id).cloned(),
                    });
                }
            }
            Delta::Player { who, .. } => {
                let touched = self
                    .entries
                    .iter()
                    .any(|e| matches!(e, UndoEntry::Player { who: w, .. } if w == who));
                if !touched {
                    self.entries.push(UndoEntry::Player {
                        who: *who,
                        old: store.player(*who).ok().cloned(),
                    });
                }
            }
            Delta::Global { .. } => {
                let touched = self
                    .entries
                    .iter()
                    .any(|e| matches!(e, UndoEntry::Global { .. }));
                if !touched {
                    self.entries.push(UndoEntry::Global {
                        old: store.global().clone(),
                    });
                }
            }
            Delta::Roster { .. } | Delta::Ack { .. } => {}
        }
    }

    /// Records an [`Authority::auto_wake`] push that actually changed the queue (a deduplicated
    /// no-op push has nothing to undo).
    fn record_woke(&mut self, id: EntityId) {
        self.entries.push(UndoEntry::Woke { id });
    }

    /// Replays every recorded entry backwards against `store`, undoing exactly this `apply` call's
    /// writes and wake-queue push. `store.apply` on the inverse `Delta` also restores every side
    /// effect `Store::apply` itself derives (the `ChunkIndex`, `entity_count`/`modified_tile_count`,
    /// and -- since `Store::apply`'s own `EntityGone` arm cancels them -- the timer/active-list
    /// registrations of an entity a rolled-back spawn had woken): the journal only has to remember
    /// enough to reconstruct the *value*, never the derived bookkeeping.
    fn rollback(&mut self, store: &mut Store<G>) {
        for entry in self.entries.drain(..).rev() {
            match entry {
                UndoEntry::Tile { pos, old } => store.apply(&Delta::Tile { pos, tile: old }),
                UndoEntry::Entity { id, old } => match old {
                    Some(e) => store.apply(&Delta::EntityPut { id, entity: e }),
                    None => store.apply(&Delta::EntityGone { id }),
                },
                UndoEntry::Player { who, old } => {
                    if let Some(p) = old {
                        store.apply(&Delta::Player { who, state: p });
                    }
                    // `old == None`: the slot did not exist before this `apply`. `Delta` has no
                    // "unset a player" variant (0011 never needs one -- a player row is never
                    // removed) and no fixture or reference-game rule creates a player row from
                    // inside `G::apply` (only `on_player(Joined)` does, never inside `apply`), so
                    // this is unreached in practice; recorded rather than silently assumed away.
                }
                UndoEntry::Global { old } => store.apply(&Delta::Global { state: old }),
                UndoEntry::Woke { id } => {
                    store.wake_remove_next(id);
                }
            }
        }
        self.recording = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::PlayerEvent;
    use crate::world::{CacheCapacity, ChunkDims, PristineSource, PrototypeId, Registry};
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity {
        anchor: (i32, i32),
        /// Selects `PrototypeId(1)` (registered `NOT_BUILDABLE`) instead of the default
        /// `PrototypeId(0)` (empty traits) -- only `placement_is_one_trait_query` sets this.
        has_bit: bool,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer {
        score: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal {
        day: u32,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject
        }
    }
    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct TGame;
    impl Game for TGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = TGen;
        type Action = ();
        type Reject = TReject;
        type Entity = TEntity;
        type Player = TPlayer;
        type Global = TGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(r: &mut Registry) {
            // Water (base id 1) and the wide "machine" prototype (id 1) share NOT_BUILDABLE --
            // `placement_is_one_trait_query` proves `traits_at` answers from either source with
            // one query, naming neither.
            r.set_base_traits(1, NOT_BUILDABLE);
            r.add_prototype(
                crate::world::TraitSet::EMPTY,
                crate::world::Footprint { w: 1, h: 1 },
            ); // id 0
            r.add_prototype(NOT_BUILDABLE, crate::world::Footprint { w: 1, h: 1 }); // id 1
        }
        fn prototype(e: &TEntity) -> PrototypeId {
            if e.has_bit {
                PrototypeId(1)
            } else {
                PrototypeId(0)
            }
        }
        fn anchor(e: &TEntity) -> TilePos {
            TilePos::new(e.anchor.0, e.anchor.1)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut crate::game::TickCx<'_, Self>) {}
    }

    fn authority() -> Authority<TGame> {
        let terrain = TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(8),
        );
        Authority::new(terrain, TGlobal { day: 0 }, 42)
    }

    #[test]
    fn every_put_is_one_delta_with_scope() {
        let mut a = authority();

        a.set_tile(TilePos::new(1, 1), Tile::new(1, 0, 0));
        assert_eq!(a.changes().len(), 1);
        assert_eq!(a.changes()[0].0.len(), 1);
        assert!(matches!(
            a.changes()[0].0.iter().next(),
            Some(Scope::Chunk(_))
        ));

        let id = a.spawn(TEntity {
            anchor: (5, 5),
            has_bit: false,
        });
        assert_eq!(a.changes().len(), 2);
        assert_eq!(a.changes()[1].0.len(), 1);

        a.put_entity(
            id,
            TEntity {
                anchor: (100, 5),
                has_bit: false,
            },
        ); // moved chunk: two scopes
        assert_eq!(a.changes().len(), 3);
        assert_eq!(a.changes()[2].0.len(), 2);

        a.despawn(id);
        assert_eq!(a.changes().len(), 4);
        assert_eq!(a.changes()[3].0.len(), 1);

        a.put_player(PlayerId(1), TPlayer { score: 3 });
        assert_eq!(a.changes().len(), 5);
        assert_eq!(
            a.changes()[4].0.iter().next(),
            Some(Scope::Player(PlayerId(1)))
        );

        a.put_global(TGlobal { day: 9 });
        assert_eq!(a.changes().len(), 6);
        assert_eq!(a.changes()[5].0.iter().next(), Some(Scope::Global));

        a.clear_changes();
        assert!(a.changes().is_empty());
    }

    #[test]
    fn host_reads_are_total() {
        let mut a = authority();
        // Every tile read succeeds, written or not.
        assert!(a.tile(TilePos::new(123, 456)).is_ok());
        let id = a.spawn(TEntity {
            anchor: (0, 0),
            has_bit: false,
        });
        assert_eq!(
            a.entity(id),
            Ok(Some(&TEntity {
                anchor: (0, 0),
                has_bit: false
            }))
        );
        assert_eq!(a.entity(EntityId(9999)), Ok(None));
        assert_eq!(a.global(), &TGlobal { day: 0 });
    }

    #[test]
    fn missing_player_is_unknown() {
        let a = authority();
        assert_eq!(a.player(PlayerId(1)), Err(Unknown));
    }

    /// A pristine source of plain grass (base 0, no traits) -- unlike `ZeroSource` (`Tile::VOID`,
    /// which `Registry::tile_traits` special-cases to `TraitSet::ALL`), this lets an *unoccupied,
    /// unpainted* tile carry no bits at all, so `placement_is_one_trait_query` can tell "the bit
    /// came from the tile" apart from "the bit came from the occupant" apart from "neither".
    struct GrassSource;
    impl PristineSource for GrassSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::new(0, 0, 0));
        }
    }

    /// 0007 §6: "the same bit query names no tile type" -- a caller (`can_place`-style helper)
    /// asks `traits_at` once and gets `NOT_BUILDABLE` whether the bit came from the tile (water)
    /// or from an occupant's registered prototype, never needing to know which.
    #[test]
    fn placement_is_one_trait_query() {
        let terrain = TerrainStore::new(
            ChunkDims::new(4),
            Box::new(GrassSource),
            CacheCapacity::Chunks(8),
        );
        let mut a = Authority::<TGame>::new(terrain, TGlobal { day: 0 }, 1);

        // Water: a tile whose base carries NOT_BUILDABLE, no occupant.
        a.set_tile(TilePos::new(1, 1), Tile::new(1, 0, 0));
        assert!(
            a.traits_at(TilePos::new(1, 1))
                .unwrap()
                .contains(NOT_BUILDABLE)
        );

        // A machine: a plain tile (base 0, no bit) with an occupant whose prototype carries it.
        assert!(
            !a.traits_at(TilePos::new(5, 5))
                .unwrap()
                .contains(NOT_BUILDABLE)
        );
        a.spawn(TEntity {
            anchor: (5, 5),
            has_bit: true,
        });
        assert!(
            a.traits_at(TilePos::new(5, 5))
                .unwrap()
                .contains(NOT_BUILDABLE)
        );

        // Neither tile nor occupant: no bit.
        assert!(
            !a.traits_at(TilePos::new(9, 9))
                .unwrap()
                .contains(NOT_BUILDABLE)
        );
    }
}
