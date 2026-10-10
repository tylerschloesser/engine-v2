//! `FrameView<'a, G>` and `Clocks` (docs/decisions/0003-game-facing-api.md: "`FrameView`:
//! `WorldRead` + clocks + presences"): the read-only per-frame view `ClientSide::extract`/`ui`
//! receive. M16b landed the minimal shape (`world`/`clocks`/`me`); this module (M17, 0018/0019)
//! grows it in place -- `entities()`, `visible()`, `zoom()`, `px_per_tile()`, `cursor_tile()`,
//! `window_origin()`, `time_ms()` -- rather than replacing it, per that milestone's own note.
//! M19/M30 add `presences()`; M26 adds `is_predicted(EntityId)`.

use std::collections::BTreeMap;

use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::predict::{NO_OVERLAY_ENTRY, Overlay, PendingQueue, Prediction, footprint_of};
use crate::presence::Presence as _;
use crate::time::{Tick, Ticks};
use crate::world::{Registry, Tile, TilePos, TileRect, WorldPos};
use crate::world_access::WorldRead;

use super::remote_presence::RemotePresences;

/// The authoritative and predicted tick a client observes (0003; 0006 "On the client" -- `client.
/// clock()` exposes the same pair to TypeScript). `predicted` differs from `authoritative` from
/// M26 on: `predicted = authoritative + lead` ([`docs/decisions/0012-prediction-and-
/// reconciliation.md`] "Two clocks"). `tick_fraction`/`ticks_per_second` are M17's own addition
/// (Seams: "progress into the current tick, for smooth progress drawables"), read from the client
/// worker's own clock block the same wake `frame()` runs (`game_instance.rs`); `tick_fraction` is
/// real from M26 on too (`ClientCore::tick_fraction`, `clock::HostClock`).
///
/// `lead` (M26 Seams, verbatim) is `predicted - authoritative`, carried as its own field rather
/// than derived, since [`Self::own_progress`]'s formula (Planning decisions "Own-timer completion
/// gap", verbatim) names it directly. `correction` (M26 Deviations: a seam beyond the brief's own
/// Seams list, the same "add what a formula genuinely needs" precedent `predicted_player` set in
/// this same file for M26 steps 1-3) is the currently-eased "Correction without snapping" scalar
/// (0012 Decision) [`Self::own_progress`] reads back out of `lead` (see that method's own doc
/// comment for why, not the literal "subtracts it from done_at" the brief's own prose suggests) --
/// ticks, signed, decaying to `0.0` over `ClientCore`'s own ease window. Neither field is
/// meaningful outside `own_progress`; every other reader of `Clocks` (a game's own `extract`/`ui`,
/// `client.clock()`) only ever reads `authoritative`/`predicted`/`tick_fraction`/`ticks_per_second`.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Clocks {
    pub authoritative: Tick,
    pub predicted: Tick,
    pub tick_fraction: f32,
    pub ticks_per_second: u32,
    pub lead: Ticks,
    pub correction: f32,
}

impl Clocks {
    /// A timer *not* owned by the local player (Planning decisions, verbatim: "for timers the
    /// player does not own"): no lead term, no correction -- rendered on the authoritative clock,
    /// like every other replicated, non-predicted quantity (0012 "Two clocks": "Everything not
    /// predicted renders against the authoritative clock"). Clamped `0.0..=1.0`; a non-positive
    /// duration (`done_at <= started_at`, a malformed or already-elapsed timer) reads `1.0` rather
    /// than dividing by a non-positive denominator.
    pub fn progress(&self, started_at: Tick, done_at: Tick) -> f32 {
        let auth = self.authoritative.0 as f32;
        let start = started_at.0 as f32;
        let done = done_at.0 as f32;
        let denom = done - start;
        if denom <= 0.0 {
            return 1.0;
        }
        ((auth - start) / denom).clamp(0.0, 1.0)
    }

    /// A timer the local player *owns* (Planning decisions "Own-timer completion gap", base
    /// formula): `(authoritative - (started_at - lead)) / (done_at - started_at + lead)`. The bar
    /// starts advancing at the tap (`started_at - lead` is in the past relative to `authoritative`
    /// from the very first frame) and reaches `1.0` exactly when the host's own completion tick can
    /// first have arrived, running `lead` ticks slower than a bare `progress` over the same
    /// nominal duration (Planning decisions: "running lead / duration slower").
    ///
    /// **Deviation from the brief's own one-line formula ("own_progress subtracts it from
    /// done_at"):** subtracting [`Self::correction`] from `done_at` alone, with `lead` left raw,
    /// does *not* give the no-jump property `own_timer_no_jump_at_ack` (Tests added) pins -- an ack
    /// that both sets `correction = k` and (via `LeadEstimator`) moves `lead` by that same `k` (the
    /// single-sample case: a fresh median jumps by exactly the one new sample) cancels `k` in the
    /// *denominator* (`(done_at - k) - started_at + (lead_old + k)` has no `k` left) but not in the
    /// *numerator* (`authoritative - (started_at - (lead_old + k))` still carries a bare `+k` no
    /// prior frame had), so the ratio still steps by `k` ticks' worth right at the ack -- the same
    /// order of jump the brief's own closing note calls "accepted" only for the CSS-restart case
    /// this method exists to avoid needing. Using an *eased effective lead*,
    /// `lead - correction`, everywhere `lead` appears (both terms, not just `done_at`) instead
    /// fixes that: at the instant of an ack, `correction` is freshly `k` and `lead` has just moved
    /// to `lead_old + k`, so `effective_lead = (lead_old + k) - k = lead_old` -- identical to what
    /// every term already used the frame before, so *nothing* about the ratio moves at that exact
    /// instant. As `correction` eases to `0.0` over the ease window, `effective_lead` eases from
    /// `lead_old` up to the corrected `lead_old + k`, and the bar gradually retargets onto the
    /// truer estimate -- "the ack causes exactly one k-tick correction ... eases to zero" (0012),
    /// read as *when the correction becomes fully visible*, not *when it is first applied*.
    pub fn own_progress(&self, started_at: Tick, done_at: Tick) -> f32 {
        let effective_lead = self.lead.0 as f32 - self.correction;
        let auth = self.authoritative.0 as f32;
        let start = started_at.0 as f32;
        let done = done_at.0 as f32;
        let denom = done - start + effective_lead;
        if denom <= 0.0 {
            return 1.0;
        }
        ((auth - (start - effective_lead)) / denom).clamp(0.0, 1.0)
    }
}

/// Every replica entity whose footprint (`G::prototype`'s own `Footprint`, anchored at `G::anchor`)
/// intersects `FrameView::visible()`, ascending `EntityId` (`BTreeMap`'s own iteration order --
/// makes DrawList hashes stable, M17 Seams). Built by
/// `FrameView::entities()`; a game never constructs this directly.
///
/// M26 (Scope: "`entities()` becomes
/// overlay-aware"): with no overlay attached (`FrameView::with_prediction` never called, every
/// pre-M26 caller), `Base` is the exact pre-M26 code path -- unchanged, so no existing DrawList
/// hash moves. With one attached, `Merged` walks a reused, sorted id list (overlay ids covering
/// `visible` merged with base ids intersecting it, `Overlay::render_entities_scratch`) and
/// resolves each id's value the same way `predict::merge_entities_in` does: an overlay override
/// replaces it (re-checked against `visible`, since an override may have moved the entity out of
/// frame), an overlay tombstone skips it, and everything else falls back to the base map.
pub enum EntityIter<'a, G: Game> {
    Base {
        inner: std::collections::btree_map::Iter<'a, EntityId, G::Entity>,
        registry: &'a Registry,
        visible: TileRect,
    },
    Merged {
        /// `(id, overlay_index)` pairs, ascending by id, one per candidate id -- `overlay_index`
        /// is [`crate::predict::NO_OVERLAY_ENTRY`] for a base-only id, else the index
        /// `Overlay::entity_value_at` reads directly (`merge_render_ids`'s own doc comment: no
        /// per-id `find_entity` scan).
        ids: std::cell::RefMut<'a, Vec<(EntityId, u32)>>,
        idx: usize,
        entities: &'a BTreeMap<EntityId, G::Entity>,
        overlay: &'a Overlay<G>,
        registry: &'a Registry,
        visible: TileRect,
    },
}

impl<'a, G: Game> Iterator for EntityIter<'a, G> {
    type Item = (EntityId, &'a G::Entity, TilePos);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            EntityIter::Base {
                inner,
                registry,
                visible,
            } => {
                for (&id, e) in inner.by_ref() {
                    let origin = G::anchor(e);
                    let footprint = registry.footprint(G::prototype(e));
                    let rect = TileRect::new(
                        origin,
                        TilePos::new(
                            origin.x + footprint.w as i32 - 1,
                            origin.y + footprint.h as i32 - 1,
                        ),
                    );
                    if rect.intersects(visible) {
                        return Some((id, e, origin));
                    }
                }
                None
            }
            EntityIter::Merged {
                ids,
                idx,
                entities,
                overlay,
                registry,
                visible,
            } => {
                while *idx < ids.len() {
                    let (id, ov_idx) = ids[*idx];
                    *idx += 1;
                    let resolved = if ov_idx == NO_OVERLAY_ENTRY {
                        entities.get(&id)
                    } else {
                        // `None` here is a tombstone, filtered out the same as an override that
                        // has moved out of `visible`.
                        overlay
                            .entity_value_at(ov_idx)
                            .filter(|&e| footprint_of::<G>(registry, e).intersects(visible))
                    };
                    if let Some(e) = resolved {
                        return Some((id, e, G::anchor(e)));
                    }
                }
                None
            }
        }
    }
}

/// Builds the sorted, collapsed `(id, overlay_index)` list [`EntityIter::Merged`] walks -- base
/// ids intersecting `visible`, paired with [`crate::predict::NO_OVERLAY_ENTRY`], merged with
/// *every* overlay entry (unfiltered, tombstones and out-of-view overrides included), collapsed
/// so each id keeps only its latest overlay index -- into `scratch`: reused, never reallocated
/// once warm (`.claude/rules/hot-paths.md`; `Overlay::render_entities_scratch`'s own doc comment).
///
/// **Post-`done` fix (frame-bench hang):** the original shape called `Overlay::find_entity` (an
/// O(overlay) reverse scan) once per candidate id from `EntityIter::Merged::next`, i.e.
/// O(visible base entities x overlay entries) per frame -- `bench.frame_worstcase`'s setup loop
/// (65,536 base entities, thousands of predicted `SpawnMany` entries pending) never finished a
/// frame that way. This version does the overlay lookup once per *overlay entry*, here, and
/// leaves `EntityIter::Merged::next` a single O(1) index read: O((base + overlay) log(base +
/// overlay)) per frame, no repeated scan.
///
/// Every overlay entry, not just ones whose own footprint covers `visible`, has to enter the
/// merge (unlike the base pass): a later entry for the same id -- a tombstone, or an override
/// that has since moved out of view -- must be able to suppress an *earlier* one (or a base
/// entry) for that id even though that later entry, on its own, would never intersect `visible`.
/// `EntityIter::Merged::next` re-applies the `visible` check to an override's own value at
/// resolve time, exactly as it did before.
fn merge_render_ids<G: Game>(
    entities: &BTreeMap<EntityId, G::Entity>,
    overlay: &Overlay<G>,
    registry: &Registry,
    visible: TileRect,
    scratch: &mut Vec<(EntityId, u32)>,
) {
    scratch.clear();
    for (&id, e) in entities.iter() {
        if footprint_of::<G>(registry, e).intersects(&visible) {
            scratch.push((id, NO_OVERLAY_ENTRY));
        }
    }
    for (idx, id) in overlay.entity_ids_raw().enumerate() {
        // `overlay.entities` is bounded (0012: single-digit per action, thousands total in the
        // worst case this fix targets) -- nowhere near `u32::MAX`.
        scratch.push((id, idx as u32));
    }
    scratch.sort_unstable_by_key(|&(id, _)| id);
    // Collapse each id's run to one entry: `NO_OVERLAY_ENTRY` unless a real overlay index is
    // present in the run, in which case the *largest* one -- overlay entries are pushed in
    // temporal order (`Overlay::push_entity`), so the largest index for an id is its latest
    // write, matching `find_entity`'s own "lookups scan backwards" semantics. In place, one pass,
    // no allocation: `w` never runs ahead of `i`.
    let mut w = 0;
    let mut i = 0;
    while i < scratch.len() {
        let id = scratch[i].0;
        let mut resolved = NO_OVERLAY_ENTRY;
        while i < scratch.len() && scratch[i].0 == id {
            let ov = scratch[i].1;
            if ov != NO_OVERLAY_ENTRY && (resolved == NO_OVERLAY_ENTRY || ov > resolved) {
                resolved = ov;
            }
            i += 1;
        }
        scratch[w] = (id, resolved);
        w += 1;
    }
    scratch.truncate(w);
}

/// The read-only view `ClientSide::extract`/`ui` receive (0003 "Contexts": the `View` role).
/// Borrows the replica for its own lifetime `'a` through `&dyn WorldRead<G>` (object-safe by
/// design, 0003: "`dyn` is deliberate ... trait-object upcasting") rather than owning a copy, so
/// one `FrameView` shape serves every `Game` with no generic read implementation per caller.
/// `entities`/`registry` are borrowed the same way, straight out of `client::Replica` (`pub(crate)`
/// accessors added this milestone) -- `WorldRead` itself stays object-safe, so entity iteration
/// cannot go through it (M17 Deviations).
pub struct FrameView<'a, G: Game> {
    world: &'a dyn WorldRead<G>,
    clocks: Clocks,
    me: PlayerId,
    entities: &'a BTreeMap<EntityId, G::Entity>,
    registry: &'a Registry,
    visible: TileRect,
    zoom: f32,
    px_per_tile: f32,
    cursor_tile: Option<TilePos>,
    window_origin: TilePos,
    time_ms: f64,
    own_presence: G::Presence,
    remote_presences: &'a RemotePresences<G>,
    /// M30: the render time (host ticks) [`Self::presences`] evaluates
    /// the interpolation buffer at; `None` (every caller that never calls
    /// [`Self::with_render_time`]) yields each remote's raw newest sample, as M19 did.
    render_t: Option<f64>,
    /// `None` until [`Self::with_prediction`] attaches one (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Scope), mirroring `world_access::View::with_overlay`'s
    /// own builder-step pattern: every existing caller (drawlist goldens, this file's own tests)
    /// keeps its exact prior behaviour and hashes.
    overlay: Option<&'a Overlay<G>>,
    pending: Option<&'a PendingQueue<G>>,
}

/// One remote player's presence, as `FrameView::presences()` hands it to a game's own callback
/// (M19 Provides, verbatim field list). `alpha` is always `1.0` until
/// M30 (Goal: "remote samples are exposed raw (snapped)").
pub struct RemotePresence<'a, G: Game> {
    pub who: PlayerId,
    pub pos: WorldPos,
    pub vel: [i32; 2],
    pub sample: &'a G::Presence,
    pub alpha: f32,
}

impl<'a, G: Game> FrameView<'a, G> {
    /// M19 steps 4-6, Deviations: `own_presence` crosses *by value*
    /// (`G::Presence: Copy`), not `&'a G::Presence` as the brief's own Provides literally spells
    /// it -- `game_instance.rs`'s fixed call order (M18: "build `FrameView` -> `ClientSide::frame`
    /// -> `extract`") builds this `FrameView` *before* `ClientSide::frame` runs, and `frame`
    /// receives `presence: &mut G::Presence` into the very same `ClientInstance` field a `&'a
    /// G::Presence` held here would alias -- copying the value out at construction (the field's
    /// value as of the *start* of this frame, i.e. last frame's final write) sidesteps that
    /// conflict entirely, the same one-frame staleness this file's `camera_view` fields (cached in
    /// `game_instance.rs`) already accept for `on_frame`'s own `FrameView`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &'a dyn WorldRead<G>,
        clocks: Clocks,
        me: PlayerId,
        entities: &'a BTreeMap<EntityId, G::Entity>,
        registry: &'a Registry,
        visible: TileRect,
        zoom: f32,
        px_per_tile: f32,
        cursor_tile: Option<TilePos>,
        window_origin: TilePos,
        time_ms: f64,
        own_presence: G::Presence,
        remote_presences: &'a RemotePresences<G>,
    ) -> Self {
        FrameView {
            world,
            clocks,
            me,
            entities,
            registry,
            visible,
            zoom,
            px_per_tile,
            cursor_tile,
            window_origin,
            time_ms,
            own_presence,
            remote_presences,
            render_t: None,
            overlay: None,
            pending: None,
        }
    }

    /// Attaches the client's prediction overlay and pending queue (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Scope): `entities()` becomes overlay-aware and
    /// `is_predicted`/`tile_is_predicted`/`predicted_tiles`/`pending` start answering for real.
    /// `game_instance.rs` calls this on every real client's own `FrameView`; every other caller
    /// (a fixture's own drawlist golden, this file's tests) that never calls it keeps the exact
    /// pre-M26 behaviour and hashes.
    pub fn with_prediction(
        mut self,
        overlay: &'a Overlay<G>,
        pending: &'a PendingQueue<G>,
    ) -> Self {
        self.overlay = Some(overlay);
        self.pending = Some(pending);
        self
    }

    /// This client's own persistent presence sample (Provides), as of the start of this frame --
    /// see [`Self::new`]'s own doc comment for why it crosses by value.
    pub fn own_presence(&self) -> G::Presence {
        self.own_presence
    }

    /// Every remote player's newest known presence sample, ascending `PlayerId` (Provides).
    ///
    /// With a render time attached ([`Self::with_render_time`]; always so in the client worker)
    /// `pos`, `vel` and `alpha` are interpolated (M30, 0012 "Remote
    /// motion") and a remote that has faded out entirely is skipped; `sample` stays the newest raw
    /// sample.
    pub fn presences(&self, f: &mut dyn FnMut(RemotePresence<'_, G>)) {
        for (who, entry) in self.remote_presences.iter() {
            let Some(render_t) = self.render_t else {
                f(RemotePresence {
                    who,
                    pos: entry.sample.pos(),
                    vel: entry.sample.vel(),
                    sample: &entry.sample,
                    alpha: 1.0,
                });
                continue;
            };
            if let Some(s) = self.remote_presences.sample(who, render_t) {
                f(RemotePresence {
                    who,
                    pos: s.pos,
                    vel: s.vel,
                    sample: &entry.sample,
                    alpha: s.alpha,
                });
            }
        }
    }

    /// The engine roster (0024 §8): every known player, online or not, with its online bit,
    /// ascending `PlayerId`. Reads the replica's `Store`; follows `Delta::Roster` and `Delta::Player`.
    pub fn roster(&self, f: &mut dyn FnMut(PlayerId, bool)) {
        self.world.roster(f);
    }

    /// Attaches the interpolation render time (host ticks) `presences()` samples at.
    pub fn with_render_time(mut self, render_t: f64) -> Self {
        self.render_t = Some(render_t);
        self
    }

    pub fn world(&self) -> &dyn WorldRead<G> {
        self.world
    }

    pub fn clocks(&self) -> Clocks {
        self.clocks
    }

    pub fn me(&self) -> PlayerId {
        self.me
    }

    /// Replica entities whose footprint intersects [`Self::visible`], ascending `EntityId` --
    /// overlay-aware once [`Self::with_prediction`] has attached one (`EntityIter`'s own doc
    /// comment): overlay values override by id, tombstones are skipped, provisional ids sort
    /// last (`EntityId`'s own `Ord`, 0022 §5).
    pub fn entities(&self) -> EntityIter<'a, G> {
        match self.overlay.filter(|o| !o.is_empty()) {
            None => EntityIter::Base {
                inner: self.entities.iter(),
                registry: self.registry,
                visible: self.visible,
            },
            Some(overlay) => {
                let mut scratch = overlay.render_entities_scratch();
                merge_render_ids::<G>(
                    self.entities,
                    overlay,
                    self.registry,
                    self.visible,
                    &mut scratch,
                );
                EntityIter::Merged {
                    ids: scratch,
                    idx: 0,
                    entities: self.entities,
                    overlay,
                    registry: self.registry,
                    visible: self.visible,
                }
            }
        }
    }

    /// True for a provisional id, or a real id the overlay currently overrides (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Planning decisions "`predicted` flag"): what
    /// `extract` asks to set [`super::drawlist::PREDICTED`] on a `Draw`. `false` with no overlay
    /// attached.
    pub fn is_predicted(&self, id: EntityId) -> bool {
        id.is_provisional()
            || self
                .overlay
                .is_some_and(|o| matches!(o.find_entity(id), Some(Some(_))))
    }

    /// True if the prediction overlay currently carries a put for `pos` (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Planning decisions "`predicted` flag": "the texel
    /// carries the predicted *value* only; a game styles a pending tile by drawing a `rect` or
    /// `ghost` from `predicted_tiles`" -- this is the query a game uses to decide *whether* to draw
    /// one). `false` with no overlay attached.
    pub fn tile_is_predicted(&self, pos: TilePos) -> bool {
        self.overlay.is_some_and(|o| o.find_tile(pos).is_some())
    }

    /// Every tile the prediction overlay currently carries an effective value for, deduplicated
    /// (`Overlay::effective_tiles`'s own doc comment): a game styles each with its own `rect`/
    /// `ghost` draw (Planning decisions "`predicted` flag"). No-op with no overlay attached.
    pub fn predicted_tiles(&self, f: &mut dyn FnMut(TilePos, Tile)) {
        if let Some(overlay) = self.overlay {
            overlay.effective_tiles(f);
        }
    }

    /// Every action still pending, oldest first (M26
    /// Provides): `seq` plus its most recently (re-)predicted status, for a game that wants to
    /// show "pending" independent of any single entity or tile (e.g. `NotPredictable`). No-op
    /// with no pending queue attached.
    pub fn pending(&self, f: &mut dyn FnMut(u32, &Prediction<G::Reject>)) {
        if let Some(pending) = self.pending {
            for p in pending.iter() {
                f(p.seq, &p.status);
            }
        }
    }

    /// The overlay-then-replica-merged player state, the same one-liner
    /// `Predicting::player`/`world_access::View::player` already use (docs/plan/
    /// 26-prediction-rendering-and-clocks.md Deviations: not in the brief's own Seams list by
    /// name -- added because `ClientSide::ui` has no other way to show "no visible change" for a
    /// player's own predicted inventory the way `entities()` now does for occupants; [`Self::
    /// world`] is deliberately left untouched, replica-only, for every other reader). Falls back
    /// to [`Self::world`]'s own `player` when no overlay is attached or it has no opinion.
    pub fn predicted_player(&self, who: PlayerId) -> Result<&'a G::Player, Unknown> {
        if let Some(p) = self.overlay.and_then(|o| o.find_player(who)) {
            return Ok(p);
        }
        self.world.player(who)
    }

    /// The visible rectangle plus a 2-tile margin (0018 §2's DrawList capacity assumes extract
    /// only ever considers roughly this much of the world).
    pub fn visible(&self) -> TileRect {
        self.visible
    }

    /// Tiles across the long axis (0018 §6): equals the camera block's own `tiles_across`.
    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    /// Device pixels per tile (steps 4-6 Deviations "`px_per_tile()` wired for real"):
    /// `camera/transform.ts`'s own `pxPerTile` formula (`max(viewportPxW, viewportPxH) /
    /// tilesAcross`), computed in `game_instance.rs` from `CameraBlock::viewport_px` (written by
    /// `frame-loop.ts` each rAF from `renderer.viewport`) and `CameraBlock::tiles_across`. `0.0`
    /// when `tiles_across <= 0` (untriggered production, or a native test built from `CameraBlock
    /// ::for_test`, which never sets `viewport_px`/`tiles_across`). `SCREEN_PX_STROKE` is still
    /// resolved in the vertex shader from its own uniform, not from this accessor (0018 Planning
    /// decisions) -- this accessor exists for a game's own `extract()` to make a screen-space
    /// decision (e.g. culling a drawable below one screen pixel), not for the renderer.
    /// Set by `frame-loop.ts` each rAF and by `engine/test`'s `stepFrame` (the canvas size, or
    /// `setViewport(client, w, h)`); `0.0` on any path that sets neither.
    pub fn px_per_tile(&self) -> f32 {
        self.px_per_tile
    }

    pub fn cursor_tile(&self) -> Option<TilePos> {
        self.cursor_tile
    }

    /// The tile every `Draw::pos` this frame is relative to (Planning decisions "Window origin").
    pub fn window_origin(&self) -> TilePos {
        self.window_origin
    }

    /// The client's own frame time in milliseconds (`CameraBlock::frame_time_ms`), for effects
    /// that progress independent of the tick clock.
    pub fn time_ms(&self) -> f64 {
        self.time_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{Footprint, PrototypeId, Tile, TraitSet};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
    struct FEntity {
        pos: TilePosSer,
    }

    /// `TilePos` has no `Serialize`/`Deserialize` (it is not itself replicated data); `FEntity`
    /// needs `Codec` (`Game::Entity`'s own bound), so this test module carries its own plain-data
    /// mirror rather than adding derives to the core coordinate type for one test.
    #[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
    struct TilePosSer {
        x: i32,
        y: i32,
    }

    impl From<TilePos> for TilePosSer {
        fn from(p: TilePos) -> Self {
            TilePosSer { x: p.x, y: p.y }
        }
    }
    impl From<TilePosSer> for TilePos {
        fn from(p: TilePosSer) -> Self {
            TilePos::new(p.x, p.y)
        }
    }

    struct FGen;
    impl Worldgen for FGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct FReject;
    impl From<Unknown> for FReject {
        fn from(_: Unknown) -> Self {
            FReject
        }
    }

    struct FGame;
    impl Game for FGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = FGen;
        type Action = ();
        type Reject = FReject;
        type Entity = FEntity;
        type Player = ();
        type Global = ();
        type Presence = ();
        type Ui = ();
        type Client = ();

        fn register(_r: &mut Registry) {}
        fn prototype(_e: &FEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(e: &FEntity) -> TilePos {
            e.pos.into()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), FReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct FWorld;
    impl WorldRead<FGame> for FWorld {
        fn tick(&self) -> Tick {
            Tick(0)
        }
        fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
            Err(Unknown)
        }
        fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
            Err(Unknown)
        }
        fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
            Ok(None)
        }
        fn entity(&self, _id: EntityId) -> Result<Option<&FEntity>, Unknown> {
            Ok(None)
        }
        fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
            Err(Unknown)
        }
        fn global(&self) -> &() {
            &()
        }
        fn entities_in(
            &self,
            _rect: crate::world::TileRect,
            _f: &mut dyn FnMut(EntityId, &FEntity),
        ) -> Result<(), Unknown> {
            Ok(())
        }
    }

    fn registry_1x1() -> Registry {
        let mut r = Registry::new();
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn view<'a>(
        world: &'a FWorld,
        entities: &'a BTreeMap<EntityId, FEntity>,
        registry: &'a Registry,
        visible: TileRect,
        zoom: f32,
        remote_presences: &'a RemotePresences<FGame>,
    ) -> FrameView<'a, FGame> {
        FrameView::new(
            world as &dyn WorldRead<FGame>,
            Clocks::default(),
            PlayerId(1),
            entities,
            registry,
            visible,
            zoom,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            (),
            remote_presences,
        )
    }

    #[test]
    fn frameview_entities_sorted_and_clipped() {
        let world = FWorld;
        let registry = registry_1x1();
        let mut entities = BTreeMap::new();
        // Deliberately inserted out of id order to prove the iterator sorts (BTreeMap already
        // does; this is what actually asserts it, not merely construction order).
        entities.insert(
            EntityId(3),
            FEntity {
                pos: TilePos::new(5, 5).into(),
            },
        ); // inside
        entities.insert(
            EntityId(1),
            FEntity {
                pos: TilePos::new(0, 0).into(),
            },
        ); // inside
        entities.insert(
            EntityId(2),
            FEntity {
                pos: TilePos::new(1000, 1000).into(),
            },
        ); // outside
        let visible = TileRect::new(TilePos::new(0, 0), TilePos::new(10, 10));
        let remote = RemotePresences::<FGame>::new();
        let fv = view(&world, &entities, &registry, visible, 20.0, &remote);

        let got: Vec<(EntityId, TilePos)> =
            fv.entities().map(|(id, _, origin)| (id, origin)).collect();
        assert_eq!(
            got,
            vec![
                (EntityId(1), TilePos::new(0, 0)),
                (EntityId(3), TilePos::new(5, 5)),
            ]
        );
    }

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct PPresence {
        x: i32,
    }
    impl crate::presence::Presence for PPresence {
        fn pos(&self) -> crate::world::WorldPos {
            crate::world::WorldPos { x: self.x, y: 0 }
        }
        fn vel(&self) -> [i32; 2] {
            [7, 0]
        }
    }
    struct PGame;
    impl Game for PGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = FGen;
        type Action = ();
        type Reject = FReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = PPresence;
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &()) -> PrototypeId {
            unimplemented!()
        }
        fn anchor(_e: &()) -> TilePos {
            unimplemented!()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), FReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    /// `own_presence()` returns the value `FrameView::new` was built with (Provides), by value
    /// (this file's own `Self::new` doc comment explains why not by reference).
    #[test]
    fn frameview_own_presence_returns_the_value_built_with() {
        let registry = Registry::new();
        let remote = RemotePresences::<PGame>::new();
        struct PWorld;
        impl WorldRead<PGame> for PWorld {
            fn tick(&self) -> Tick {
                Tick(0)
            }
            fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
                Err(Unknown)
            }
            fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
                Err(Unknown)
            }
            fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
                Ok(None)
            }
            fn entity(&self, _id: EntityId) -> Result<Option<&()>, Unknown> {
                Ok(None)
            }
            fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
                Err(Unknown)
            }
            fn global(&self) -> &() {
                &()
            }
            fn entities_in(
                &self,
                _rect: TileRect,
                _f: &mut dyn FnMut(EntityId, &()),
            ) -> Result<(), Unknown> {
                Ok(())
            }
        }
        let pworld = PWorld;
        let entities: BTreeMap<EntityId, ()> = BTreeMap::new();
        let fv = FrameView::<PGame>::new(
            &pworld as &dyn WorldRead<PGame>,
            Clocks::default(),
            PlayerId(1),
            &entities,
            &registry,
            TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            PPresence { x: 42 },
            &remote,
        );
        assert_eq!(fv.own_presence(), PPresence { x: 42 });
    }

    /// `presences()`: ascending `PlayerId`, `pos`/`vel` derived from each sample's own trait
    /// methods, `alpha` always `1.0` (Goal: "remote samples are exposed raw (snapped)" until M30).
    /// Inject-fail-revert: swap `RemotePresences::iter`'s `self.entries.iter()` for `self.entries
    /// .iter().rev()` -- the assertion on ascending order fails (`left: [3, 1], right: [1, 3]`);
    /// reverted.
    #[test]
    fn frameview_presences_ascending_with_derived_pos_and_vel() {
        let registry = Registry::new();
        let mut remote = RemotePresences::<PGame>::new();
        remote.apply_sample(PlayerId(3), PPresence { x: 30 }, Tick(1));
        remote.apply_sample(PlayerId(1), PPresence { x: 10 }, Tick(1));
        struct PWorld;
        impl WorldRead<PGame> for PWorld {
            fn tick(&self) -> Tick {
                Tick(0)
            }
            fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
                Err(Unknown)
            }
            fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
                Err(Unknown)
            }
            fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
                Ok(None)
            }
            fn entity(&self, _id: EntityId) -> Result<Option<&()>, Unknown> {
                Ok(None)
            }
            fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
                Err(Unknown)
            }
            fn global(&self) -> &() {
                &()
            }
            fn entities_in(
                &self,
                _rect: TileRect,
                _f: &mut dyn FnMut(EntityId, &()),
            ) -> Result<(), Unknown> {
                Ok(())
            }
        }
        let pworld = PWorld;
        let entities: BTreeMap<EntityId, ()> = BTreeMap::new();
        let fv = FrameView::<PGame>::new(
            &pworld as &dyn WorldRead<PGame>,
            Clocks::default(),
            PlayerId(2),
            &entities,
            &registry,
            TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            PPresence::default(),
            &remote,
        );
        let mut got: Vec<(PlayerId, i32, f32)> = Vec::new();
        fv.presences(&mut |p| got.push((p.who, p.pos.x, p.alpha)));
        assert_eq!(
            got,
            vec![(PlayerId(1), 10, 1.0), (PlayerId(3), 30, 1.0)],
            "ascending PlayerId, pos derived from Presence::pos()"
        );
    }

    /// `EntityIter::Merged` against a naive reference (the base map with the overlay's own
    /// entries applied in push order, then filtered by `visible`) over a seeded mix of overrides,
    /// tombstones, an override moving a visible entity out of view, one moving an out-of-view
    /// entity into view, a provisional spawn (in view and out of it), and repeated writes to one
    /// id -- the property `merge_render_ids`'s sorted-collapse (this file's own Post-`done` fix,
    /// "frame-bench hang") must preserve exactly, now that resolution is a direct index into the
    /// overlay rather than a per-id `find_entity` scan. Inject-fail-revert: in `merge_render_ids`'s
    /// collapse, change `ov > resolved` to `ov < resolved` (keeps the *earliest* overlay entry for
    /// an id instead of the latest) -- `EntityId(6)`'s repeated writes then resolve to its first,
    /// stale position `(1, 1)` instead of `(2, 2)`, and `EntityId(7)` resolves to its first (put)
    /// entry instead of its later tombstone, so it wrongly stays visible; this assertion fails on
    /// both (`left`/`right` mismatch on `EntityId(6)`'s origin and on `EntityId(7)`'s presence);
    /// reverted.
    #[test]
    fn frameview_merged_entities_match_naive_overlay_reference() {
        let world = FWorld;
        let registry = registry_1x1();
        let visible = TileRect::new(TilePos::new(0, 0), TilePos::new(9, 9));
        let mut entities = BTreeMap::new();

        // Base entities: some inside `visible`, some outside.
        for i in 0..12u32 {
            entities.insert(
                EntityId(i + 1),
                FEntity {
                    pos: TilePos::new((i % 5) as i32, (i % 5) as i32).into(),
                },
            );
        }
        for i in 12..16u32 {
            entities.insert(
                EntityId(i + 1),
                FEntity {
                    pos: TilePos::new(1000 + i as i32, 1000).into(),
                },
            );
        }

        let mut overlay = Overlay::<FGame>::new();
        // Plain override, still in view.
        overlay.push_entity(
            EntityId(2),
            Some(FEntity {
                pos: TilePos::new(6, 6).into(),
            }),
        );
        // Tombstone a base entity that would otherwise be visible.
        overlay.push_entity(EntityId(3), None);
        // Override moving a base entity that was in view OUT of view.
        overlay.push_entity(
            EntityId(4),
            Some(FEntity {
                pos: TilePos::new(2000, 2000).into(),
            }),
        );
        // Override moving a base entity that was OUT of view INTO view.
        overlay.push_entity(
            EntityId(13),
            Some(FEntity {
                pos: TilePos::new(7, 7).into(),
            }),
        );
        // Repeated writes to one id: an out-of-view write, then back in, then tombstoned for
        // real -- only "latest wins" (not "first wins" or "any wins") gets this right.
        overlay.push_entity(
            EntityId(5),
            Some(FEntity {
                pos: TilePos::new(3000, 3000).into(),
            }),
        );
        overlay.push_entity(
            EntityId(5),
            Some(FEntity {
                pos: TilePos::new(8, 8).into(),
            }),
        );
        overlay.push_entity(EntityId(5), None);
        // Repeated writes to an id the base map never held, both in view, at different positions
        // -- the discriminator for "latest wins" vs. "earliest wins": both orders leave the id
        // visible, but only the later write's position is correct.
        overlay.push_entity(
            EntityId(6),
            Some(FEntity {
                pos: TilePos::new(1, 1).into(),
            }),
        );
        overlay.push_entity(
            EntityId(6),
            Some(FEntity {
                pos: TilePos::new(2, 2).into(),
            }),
        );
        // An id the base map never held, put in view then tombstoned -- the discriminator for
        // "latest wins" vs. "any wins": only the latest entry (the tombstone) is correct.
        overlay.push_entity(
            EntityId(7),
            Some(FEntity {
                pos: TilePos::new(1, 2).into(),
            }),
        );
        overlay.push_entity(EntityId(7), None);
        // A provisional spawn, in view.
        let prov_in = EntityId::provisional(1, 0).unwrap();
        overlay.push_entity(
            prov_in,
            Some(FEntity {
                pos: TilePos::new(4, 4).into(),
            }),
        );
        // A provisional spawn, out of view.
        let prov_out = EntityId::provisional(1, 1).unwrap();
        overlay.push_entity(
            prov_out,
            Some(FEntity {
                pos: TilePos::new(4000, 4000).into(),
            }),
        );

        // Naive reference: the base map with every overlay entry applied in push order (`Some` =
        // put/override, `None` = despawn), then filtered by `visible` -- `EntityIter::Merged`'s
        // own contract, computed the slow, obviously-correct way.
        let mut reference = entities.clone();
        for (id, e) in overlay.entities() {
            match e {
                Some(e) => {
                    reference.insert(id, *e);
                }
                None => {
                    reference.remove(&id);
                }
            }
        }
        let mut expected: Vec<(EntityId, TilePos)> = reference
            .iter()
            .filter_map(|(&id, e)| {
                let origin = FGame::anchor(e);
                footprint_of::<FGame>(&registry, e)
                    .intersects(&visible)
                    .then_some((id, origin))
            })
            .collect();
        expected.sort_by_key(|&(id, _)| id);

        let remote = RemotePresences::<FGame>::new();
        let pending = PendingQueue::<FGame>::new();
        let fv = view(&world, &entities, &registry, visible, 20.0, &remote)
            .with_prediction(&overlay, &pending);

        let got: Vec<(EntityId, TilePos)> =
            fv.entities().map(|(id, _, origin)| (id, origin)).collect();
        assert_eq!(got, expected);
    }

    // `frameview_zoom_matches_camera_block` used to live here, built by hand through `view()`
    // above -- it proved `FrameView::zoom()` reads back whatever field it was constructed with,
    // never the real wiring (`game_instance.rs`'s `camera_view.zoom = camera.tiles_across`).
    // Fix round 1 (M17, coordinator review): moved to
    // `fixtures/drawables/tests/drawlist_golden.rs`, which can drive a real `GameInstance<
    // Drawables>` through the actual `Instance::frame` ABI method with a real `CameraBlock` --
    // `crates/engine` itself has no concrete `Game` whose `extract()` exposes `zoom()`/
    // `px_per_tile()` observably, only the local test-only `FGame`/`TestGame`/`MGame` fixtures
    // that don't route through a real camera at all.
}
