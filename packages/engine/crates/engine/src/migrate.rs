//! The upgrade path of 0005 ("Upgrades"), 0006 ("What a tick-rate change does") and 0007 §9
//! (worldgen stamping), for the half of it that runs before any ABI or storage code touches it
//! (docs/plan/24b-upgrade-and-migration.md, steps 1-3): [`OldStore`]/[`OldValue`] (Planning
//! decisions 1), [`Rescale`]/[`RescaleTicks`] (Planning decisions 2), and [`Migrating`] (Planning
//! decisions 4) plus the [`migrate`] driver that ties them to the engine's own game-type-free
//! carry-over (Planning decisions 3). `persist::identity::{Comparison, MismatchReason}` is the
//! sibling half of the same decision: it says *whether* a load needs this module at all; nothing
//! here reads it.
//!
//! **Seam for steps 4-5** (docs/plan/24b-upgrade-and-migration.md's own instruction; recorded
//! again, verbatim-in-spirit, in this milestone's Deviations): [`OldStore::decode`] takes a
//! `&mut ByteReader` already positioned right after a decoded snapshot's own `SimRng` field (0005
//! Snapshot: "engine section ... player table onward" is exactly `Store::write_canonical`'s wire
//! shape, which this module parses independently, byte-for-byte, without ever building a real
//! `Store<OldG>`) -- `SnapshotReader`/`sim_upgrade_end` (step 4) hands over the identity/tick
//! fields it already parsed at the container level (`schema`, both tick rates, `tick`) plus the
//! reader positioned there; `SimRng` and `tick` themselves are carried by [`migrate`]'s own
//! caller-supplied parameters, never through `OldStore`, since neither is game-typed or
//! schema-dependent (Planning decisions 3). [`migrate`] returns the freshly built `Authority<G>`
//! plus a [`MigrationOutcome`] (dropped-registration counts; `sim_upgrade_end`'s own "dropped
//! record count" report, 0024 §3b, is a distinct, tail-replay concept and not this struct).
//! `rescale()` is always applied to engine-owned timers regardless of whether the game ever calls
//! it (Planning decisions 2's own warning is about the game's copy, tracked separately, below).

use std::cell::Cell;
use std::collections::VecDeque;

use crate::authority::Authority;
use crate::bytes::ByteReader;
use crate::codec::{Codec, CodecError, decode_canonical};
use crate::game::{EntityId, Game, PlayerId, SaveIncompatible, Unknown};
use crate::rng::SimRng;
use crate::time::{Tick, Ticks};
use crate::world::{ChunkCoord, ChunkDims, Footprint, SystemId, Tile, TilePos, TileRect, TraitSet};
use crate::world_access::{WorldRead, WorldWrite};

// ---------------------------------------------------------------------------------------------
// Rescale / RescaleTicks (Planning decisions 2)
// ---------------------------------------------------------------------------------------------

/// Rescales a stored duration or deadline from an old tick rate to the running build's own (0006
/// "What a tick-rate change does"; docs/decisions/0006-time-units.md "Conversion rule" generalised
/// from a millisecond denominator to an arbitrary old-Hz one -- same integer-only, round-to-
/// nearest-with-ties-up, non-zero-floor arithmetic, proved equivalent to 0006's own formula by
/// `rescale_matches_0006_rounding`). Built by [`OldStore::rescale`] from `(old_hz, new_hz,
/// snapshot_tick)`; `is_identity()` is `true` whenever the rates agree, in which case both
/// [`Rescale::ticks`] and [`Rescale::deadline`] are the identity function.
///
/// ```
/// use engine::migrate::Rescale;
/// use engine::time::{Tick, Ticks};
///
/// let r = Rescale::new(20, 30, Tick(1_000));
/// assert!(!r.is_identity());
/// assert_eq!(r.ticks(Ticks(40)), Ticks(60)); // 2s at 20Hz -> 2s at 30Hz
/// assert_eq!(r.deadline(Tick(1_040)), Tick(1_060)); // 40 ticks in the future -> 60
/// assert_eq!(r.deadline(Tick(960)), Tick(940)); // 40 ticks in the past -> 60 ticks back
///
/// let same = Rescale::new(20, 20, Tick(1_000));
/// assert!(same.is_identity());
/// assert_eq!(same.ticks(Ticks(7)), Ticks(7));
/// ```
#[derive(Clone, Copy, Debug)]
pub struct Rescale {
    old_hz: u32,
    new_hz: u32,
    snapshot_tick: Tick,
}

impl Rescale {
    pub fn new(old_hz: u32, new_hz: u32, snapshot_tick: Tick) -> Self {
        Rescale {
            old_hz,
            new_hz,
            snapshot_tick,
        }
    }

    /// `true` when the old and new tick rates agree: [`Rescale::ticks`]/[`Rescale::deadline`] are
    /// both the identity function.
    #[inline]
    pub fn is_identity(&self) -> bool {
        self.old_hz == self.new_hz
    }

    /// `d * new_hz / old_hz`, integer-only, round to nearest with ties up, never zero for a
    /// non-zero `d` (0006 Conversion rule, generalised from a fixed 1000ms denominator to
    /// `old_hz`: `round_half_up(num / den) == floor((2*num + den) / (2*den))` for any non-negative
    /// `num`/positive `den`, which reduces to exactly 0006's own `(ms*hz + 500) / 1000` when
    /// `den == 1000`).
    pub fn ticks(&self, d: Ticks) -> Ticks {
        if self.is_identity() {
            return d;
        }
        let num = d.0 as u64 * self.new_hz as u64;
        let den = self.old_hz as u64;
        let t = (2 * num + den) / (2 * den);
        Ticks(if t == 0 && d.0 != 0 { 1 } else { t as u32 })
    }

    /// Rescales the *distance* from the snapshot tick this `Rescale` was built at (the tick
    /// counter itself is never rescaled, 0006 point 3): `snapshot + ticks(t - snapshot)` for a
    /// future `t`, mirrored (and saturating at 0, `Tick` being unsigned) for a past one.
    pub fn deadline(&self, t: Tick) -> Tick {
        if self.is_identity() {
            return t;
        }
        if t.0 >= self.snapshot_tick.0 {
            let dist = Ticks(t.0 - self.snapshot_tick.0);
            self.snapshot_tick.add(self.ticks(dist))
        } else {
            let dist = Ticks(self.snapshot_tick.0 - t.0);
            let scaled = self.ticks(dist);
            Tick(self.snapshot_tick.0.saturating_sub(scaled.0))
        }
    }
}

/// Implemented by hand, one line per field (Planning decisions 2: "no derive" -- 0017 crate
/// policy already rejected a proc-macro for far less). `Tick` rescales as a deadline (relative to
/// the `Rescale`'s own snapshot tick); `Ticks` rescales as a plain duration.
///
/// ```
/// use engine::migrate::{Rescale, RescaleTicks};
/// use engine::time::{Tick, Ticks};
///
/// #[derive(Debug, PartialEq)]
/// struct Timer {
///     done_at: Tick,
///     remaining: Ticks,
/// }
/// impl RescaleTicks for Timer {
///     fn rescale(&mut self, r: &Rescale) {
///         self.done_at.rescale(r);
///         self.remaining.rescale(r);
///     }
/// }
///
/// let mut t = Timer { done_at: Tick(1_040), remaining: Ticks(40) };
/// t.rescale(&Rescale::new(20, 30, Tick(1_000)));
/// assert_eq!(t, Timer { done_at: Tick(1_060), remaining: Ticks(60) });
/// ```
pub trait RescaleTicks {
    fn rescale(&mut self, r: &Rescale);
}

impl RescaleTicks for Tick {
    fn rescale(&mut self, r: &Rescale) {
        *self = r.deadline(*self);
    }
}

impl RescaleTicks for Ticks {
    fn rescale(&mut self, r: &Rescale) {
        *self = r.ticks(*self);
    }
}

impl<T: RescaleTicks> RescaleTicks for Option<T> {
    fn rescale(&mut self, r: &Rescale) {
        if let Some(v) = self {
            v.rescale(r);
        }
    }
}

impl<T: RescaleTicks, const N: usize> RescaleTicks for [T; N] {
    fn rescale(&mut self, r: &Rescale) {
        for v in self.iter_mut() {
            v.rescale(r);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// OldStore / OldValue (Planning decisions 1)
// ---------------------------------------------------------------------------------------------

/// One drained old-schema, game-typed value: `key` is engine-decoded (ids are never game data),
/// `bytes` is still raw postcard the engine never decoded, because it cannot name the old type
/// (Planning decisions 1). [`OldValue::decode`] is the game's own `migrate` module's job: `T` is
/// a `Codec` copy of the old shape, kept there, never imported from the old game's own crate.
///
/// ```
/// use engine::migrate::OldValue;
///
/// #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
/// struct OldPlayer { deposits: u32 }
///
/// // An `OldValue` is normally handed out by `OldStore::drain_players`/`drain_entities`; built
/// // directly here only to demonstrate `decode`'s own contract.
/// let bytes = engine::codec::encode(&OldPlayer { deposits: 3 }, &mut [0u8; 16]).map(|_| ());
/// # let _ = bytes;
/// ```
pub struct OldValue<K> {
    pub key: K,
    bytes: Vec<u8>,
}

impl<K> OldValue<K> {
    fn new(key: K, bytes: Vec<u8>) -> Self {
        OldValue { key, bytes }
    }

    /// Decodes the raw postcard bytes through [`crate::codec::decode_canonical`] (untrusted bytes
    /// off disk, `.claude/rules/determinism.md`), never plain `decode`. `T: Codec` (not the
    /// `DeserializeOwned`-only bound the brief's own prose names): `decode_canonical` re-encodes
    /// to verify canonicality, which needs `Serialize` too (this milestone's Deviations).
    pub fn decode<T: Codec>(&self) -> Result<T, SaveIncompatible> {
        decode_canonical(&self.bytes).map_err(|_| SaveIncompatible)
    }
}

/// Reads a varint-length-prefixed blob without decoding it (mirrors `crate::persist::write_sized`/
/// `read_sized`'s wire shape, `crate::store`'s private twin of the same pair -- duplicated by
/// necessity: `OldStore` cannot decode into a `T` it has no way to name, Planning decisions 1).
fn read_sized_raw(reader: &mut ByteReader) -> Result<Vec<u8>, CodecError> {
    let len = reader.varint()? as usize;
    Ok(reader.bytes(len)?.to_vec())
}

/// The old-schema, byte-level view `Game::migrate` reads from (Planning decisions 1). Not generic
/// over any `Game`: every field the engine itself understands (ids, tiles, counters, timers) is
/// already decoded; every game-typed value stays undecoded bytes behind [`OldValue::decode`].
/// [`OldStore::carry_tiles`] is the one method that is generic (over the *new* `G`, inferred from
/// its `WorldWrite<G>` argument) since it is the one piece of "what only migrate carries"
/// (Planning decisions 3) the engine provides a default for.
///
/// ```no_run
/// use engine::game::{EntityId, Game, SaveIncompatible};
/// use engine::migrate::OldStore;
///
/// #[derive(serde::Serialize, serde::Deserialize)]
/// struct OldEntity { x: i32, y: i32 }
///
/// fn migrate_entities<G: Game>(
///     old: &mut OldStore,
///     w: &mut dyn engine::game::WorldWrite<G>,
///     to_new: impl Fn(OldEntity) -> G::Entity,
/// ) -> Result<(), SaveIncompatible> {
///     for old_entity in old.drain_entities() {
///         let key: EntityId = old_entity.key;
///         let decoded: OldEntity = old_entity.decode()?;
///         w.put_entity(key, to_new(decoded));
///     }
///     old.carry_tiles(w);
///     Ok(())
/// }
/// ```
pub struct OldStore {
    schema: u32,
    old_hz: u32,
    new_hz: u32,
    tick: Tick,
    /// Set the first time the *public* [`OldStore::rescale`] is called (Planning decisions 2's
    /// own warning tracks the game's own copy, not the engine's internal one -- see
    /// [`migrate`]'s own body, which reads the old/new Hz directly rather than through this
    /// method, so running the engine-owned carry never marks this observed).
    rescale_observed: Cell<bool>,
    global: Vec<u8>,
    player_bytes: VecDeque<(PlayerId, Vec<u8>)>,
    /// Engine-only (Planning decisions 3: "player table (ids, last processed seq)"): never
    /// drained by [`OldStore::drain_players`], applied by [`migrate`] itself after `Game::migrate`
    /// returns, onto whichever player slots it actually created.
    player_meta: Vec<(PlayerId, u32, bool)>,
    next_entity_id: u32,
    entity_bytes: VecDeque<(EntityId, Vec<u8>)>,
    tiles: VecDeque<(TilePos, Tile)>,
    /// Engine-only (Planning decisions 3): `(id, old deadline)` in `(Tick, EntityId)` key order,
    /// exactly `TimerWheel::write_canonical`'s own iteration order.
    timers: Vec<(EntityId, Tick)>,
    /// Engine-only: the wake queue's `next` list, insertion order.
    wake_next: Vec<EntityId>,
    /// Engine-only: one `Vec` per system (`SystemId::MAX` of them), each in insertion order.
    active: Vec<Vec<EntityId>>,
}

impl OldStore {
    /// Builds from a decoded snapshot's own store-section bytes: `Store::write_canonical`'s wire
    /// shape (0005 Snapshot's "engine section", player table onward -- `tick`/`SimRng` are not
    /// part of it, `crate::persist::snapshot`'s own module doc comment), read from `reader`
    /// starting exactly where that section starts. `schema`/`old_tick_rate_hz`/`tick` are the
    /// stored identity's own fields; `new_tick_rate_hz` is the running build's
    /// `G::TICK_RATE.hz_value()`; `chunk_bits` is the running build's `G::CHUNK_BITS` (0007 §3: a
    /// chunk-size mismatch is `SaveIncompatible { ChunkSize }` before this ever runs, so old and
    /// new chunk bits are already known equal, Scope). A decode failure here is always
    /// `SaveIncompatible` (the ABI layer, step 4, reports it as `IncompatReason::Decode`).
    pub fn decode(
        reader: &mut ByteReader,
        schema: u32,
        old_tick_rate_hz: u32,
        new_tick_rate_hz: u32,
        tick: Tick,
        chunk_bits: u32,
    ) -> Result<Self, SaveIncompatible> {
        Self::decode_inner(
            reader,
            schema,
            old_tick_rate_hz,
            new_tick_rate_hz,
            tick,
            chunk_bits,
        )
        .map_err(|_: CodecError| SaveIncompatible)
    }

    fn decode_inner(
        reader: &mut ByteReader,
        schema: u32,
        old_hz: u32,
        new_hz: u32,
        tick: Tick,
        chunk_bits: u32,
    ) -> Result<Self, CodecError> {
        // Player table (`Store::write_canonical`: who, last_seq, online, sized state).
        let player_count = reader.u32()?;
        let mut player_bytes = VecDeque::with_capacity(player_count as usize);
        let mut player_meta = Vec::with_capacity(player_count as usize);
        for _ in 0..player_count {
            let who = PlayerId(reader.u32()?);
            let last_seq = reader.u32()?;
            let online = reader.u8()? != 0;
            let bytes = read_sized_raw(reader)?;
            player_meta.push((who, last_seq, online));
            player_bytes.push_back((who, bytes));
        }

        let next_entity_id = reader.u32()?;
        let global = read_sized_raw(reader)?;

        // Terrain overlay (`TerrainStore::write_canonical`: chunk key, entry count, (index, tile)
        // pairs).
        let dims = ChunkDims::new(chunk_bits);
        let chunk_count = reader.u32()?;
        let mut tiles = VecDeque::new();
        for _ in 0..chunk_count {
            let key = reader.u64()?;
            let chunk = ChunkCoord::from_key(key);
            let entry_count = reader.u32()?;
            for _ in 0..entry_count {
                let index = reader.u16()?;
                let tile = Tile(reader.u32()?);
                tiles.push_back((dims.tile_at(chunk, index), tile));
            }
        }

        let entity_count = reader.u32()?;
        let mut entity_bytes = VecDeque::with_capacity(entity_count as usize);
        for _ in 0..entity_count {
            let id = EntityId(reader.u32()?);
            let bytes = read_sized_raw(reader)?;
            entity_bytes.push_back((id, bytes));
        }

        // Active lists (`ActiveLists::write_canonical`: `SystemId::MAX` lists, each item a tag
        // byte then, if `1`, an id -- a `0` tombstone should never appear in a snapshot (only
        // taken between ticks), but is tolerated (skipped) rather than rejected.
        let mut active: Vec<Vec<EntityId>> = Vec::with_capacity(SystemId::MAX);
        for _ in 0..SystemId::MAX {
            let count = reader.u32()?;
            let mut list = Vec::with_capacity(count as usize);
            for _ in 0..count {
                if reader.u8()? != 0 {
                    list.push(EntityId(reader.u32()?));
                }
            }
            active.push(list);
        }

        // Timer wheel (`TimerWheel::write_canonical`: count, then (tick, id) in key order).
        let timer_count = reader.u32()?;
        let mut timers = Vec::with_capacity(timer_count as usize);
        for _ in 0..timer_count {
            let due = Tick(reader.u32()?);
            let id = EntityId(reader.u32()?);
            timers.push((id, due));
        }

        // Wake queue's `next` list (`WakeQueue::write_canonical`: count, then ids in insertion
        // order; `now` is never encoded).
        let wake_count = reader.u32()?;
        let mut wake_next = Vec::with_capacity(wake_count as usize);
        for _ in 0..wake_count {
            wake_next.push(EntityId(reader.u32()?));
        }

        Ok(OldStore {
            schema,
            old_hz,
            new_hz,
            tick,
            rescale_observed: Cell::new(false),
            global,
            player_bytes,
            player_meta,
            next_entity_id,
            entity_bytes,
            tiles,
            timers,
            wake_next,
            active,
        })
    }

    pub fn schema(&self) -> u32 {
        self.schema
    }

    pub fn tick_rate_hz(&self) -> u32 {
        self.old_hz
    }

    pub fn tick(&self) -> Tick {
        self.tick
    }

    /// Builds a [`Rescale`] from `(old_hz, new_hz, tick)` and marks it observed (Planning
    /// decisions 2's own "did the game ever call this" warning, checked by [`migrate`] after
    /// `Game::migrate` returns).
    pub fn rescale(&self) -> Rescale {
        self.rescale_observed.set(true);
        Rescale::new(self.old_hz, self.new_hz, self.tick)
    }

    fn rescale_was_observed(&self) -> bool {
        self.rescale_observed.get()
    }

    /// The engine's own internal copy of [`OldStore::rescale`] (Planning decisions 3's
    /// unconditional engine-owned carry): deliberately bypasses the public method above so
    /// running it never counts as the game having called `old.rescale()`.
    fn engine_rescale(&self) -> Rescale {
        Rescale::new(self.old_hz, self.new_hz, self.tick)
    }

    /// The old `G::Global`'s raw bytes, decoded through `T`.
    pub fn global<T: Codec>(&self) -> Result<T, SaveIncompatible> {
        decode_canonical(&self.global).map_err(|_| SaveIncompatible)
    }

    /// Every old player, ascending `PlayerId` (key order, Planning decisions 1: "all iteration is
    /// in key order"). Drains: the engine frees each value's bytes as `migrate` consumes it (old
    /// and new stores must coexist inside one fixed arena, 0015).
    pub fn drain_players(&mut self) -> impl Iterator<Item = OldValue<PlayerId>> + '_ {
        self.player_bytes
            .drain(..)
            .map(|(who, bytes)| OldValue::new(who, bytes))
    }

    /// Every old entity, ascending `EntityId`.
    pub fn drain_entities(&mut self) -> impl Iterator<Item = OldValue<EntityId>> + '_ {
        self.entity_bytes
            .drain(..)
            .map(|(id, bytes)| OldValue::new(id, bytes))
    }

    /// Every old modified tile, in the terrain overlay's own canonical order (ascending chunk key,
    /// then ascending local index within a chunk -- `TerrainStore::write_canonical`'s own order,
    /// re-expressed as global `TilePos`).
    pub fn drain_tiles(&mut self) -> impl Iterator<Item = (TilePos, Tile)> + '_ {
        self.tiles.drain(..)
    }

    /// The one-line default for "what only migrate carries: ... tiles" (Planning decisions 3):
    /// drains every old tile and writes it into the new world, *unless* it now equals the new
    /// build's own pristine value at that position (0007 §9's canonical-overlay rule) -- in which
    /// case the entry is simply redundant and dropped, never written. Reading `w.tile(pos)` before
    /// this position has been touched by anything else answers with the new pristine value, so no
    /// separate worldgen call is needed here (Deviations).
    pub fn carry_tiles<G: Game>(&mut self, w: &mut dyn WorldWrite<G>) {
        for (pos, tile) in self.tiles.drain(..) {
            if w.tile(pos) != Ok(tile) {
                w.set_tile(pos, tile);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Migrating (Planning decisions 4)
// ---------------------------------------------------------------------------------------------

/// The `WorldWrite<G>` implementor `Game::migrate` writes through (Planning decisions 4):
/// `put_entity`/`spawn` on an id whose tile footprint already has a different occupant sets an
/// internal fault (checked by [`migrate`] after `Game::migrate` returns) rather than rejecting the
/// call outright -- `WorldWrite`'s methods return nothing to fail with, and inserting anyway keeps
/// the rest of the game's own `migrate` body running against ordinary, consistent state instead of
/// a silently-skipped half-write. State-budget checks never run here (0004: "never for
/// non-action writes", Planning decisions 4).
pub struct Migrating<'a, G: Game> {
    authority: &'a mut Authority<G>,
    fault: bool,
}

impl<'a, G: Game> Migrating<'a, G> {
    pub(crate) fn new(authority: &'a mut Authority<G>) -> Self {
        Migrating {
            authority,
            fault: false,
        }
    }

    pub(crate) fn has_fault(&self) -> bool {
        self.fault
    }

    fn footprint_occupied(&self, anchor: TilePos, footprint: Footprint) -> bool {
        for dy in 0..footprint.h as i32 {
            for dx in 0..footprint.w as i32 {
                let pos = TilePos::new(anchor.x + dx, anchor.y + dy);
                if self.authority.store().entity_at(pos).is_some() {
                    return true;
                }
            }
        }
        false
    }

    fn check_collision(&mut self, e: &G::Entity) {
        let anchor = G::anchor(e);
        let footprint = self.authority.store().registry().footprint(G::prototype(e));
        if self.footprint_occupied(anchor, footprint) {
            self.fault = true;
        }
    }
}

impl<G: Game> WorldRead<G> for Migrating<'_, G> {
    fn tick(&self) -> Tick {
        self.authority.tick()
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

impl<G: Game> WorldWrite<G> for Migrating<'_, G> {
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        self.authority.set_tile(p, t);
    }

    /// Always a fresh id (Planning decisions 4: "spawn allocates above the carried id counter"),
    /// so a collision here can only be against an already-migrated entity, never against itself.
    /// Never auto-wakes (`Authority::spawn_no_wake`'s own doc comment has the full reasoning: the
    /// engine restores the wake queue's `next` list itself, from the old snapshot's own
    /// membership, Planning decisions 3).
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        self.check_collision(&e);
        self.authority.spawn_no_wake(e)
    }

    /// "On an absent id inserts under that old id through the same insertion path as `spawn`
    /// (occupancy and footprint checks included)" (Planning decisions 4): a `put_entity` on an id
    /// that already exists is an ordinary update to an entity `migrate` itself already placed, and
    /// is not re-checked (matching every other `WorldWrite` implementor: production ticks never
    /// check occupancy on their own puts either). Never auto-wakes, same reasoning as `spawn`.
    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        if self.authority.entity(id) == Ok(None) {
            self.check_collision(&e);
        }
        self.authority.put_entity_no_wake(id, e);
    }

    fn despawn(&mut self, id: EntityId) {
        self.authority.despawn(id);
    }

    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.authority.put_player(who, p);
    }

    fn put_global(&mut self, g: G::Global) {
        self.authority.put_global(g);
    }

    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        // `Authority` also has an inherent `rng(&self) -> SimRng` (an owned-copy peek): the
        // fully-qualified call below is required so this reaches `WorldWrite::rng` instead.
        <Authority<G> as WorldWrite<G>>::rng(self.authority)
    }
}

// ---------------------------------------------------------------------------------------------
// The migration driver
// ---------------------------------------------------------------------------------------------

/// Dropped-registration counts from the engine's own carry-over (Planning decisions 3): a
/// registration for an entity `Game::migrate` did not re-create is dropped, not an error. Distinct
/// from `sim_upgrade_end`'s own tail-replay "dropped record" count (0024 §3b), which is step 4's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub dropped_timers: u32,
    pub dropped_wakes: u32,
    pub dropped_active: u32,
}

/// Runs `Game::migrate` over `old` through a fresh [`Migrating`], then the engine's own
/// game-type-free carry-over (Planning decisions 3): the id counter (raised, never lowered), every
/// player's `last_seq`/`online` (onto whichever slots `migrate` actually created), and the timer
/// wheel / wake queue / active lists, each entry kept only if its entity id exists in the migrated
/// store and, for a timer, passed through `old.rescale()` first (the engine's own internal copy,
/// never the public one -- see [`OldStore::rescale`]'s own doc comment). Returns the freshly built
/// `Authority<G>` on success; a declining `Game::migrate`, an unresolved [`Migrating`] fault, or a
/// bad decode all surface uniformly as `SaveIncompatible` (0005: every stored byte stays
/// untouched -- this function never touches storage itself, so that guarantee is its caller's,
/// simply by not persisting anything on `Err`).
///
/// `tick`/`rng` are the old snapshot's own container-level fields (0005 Snapshot), carried by the
/// caller since neither is game-typed (Planning decisions 3; see this module's own doc comment for
/// why `OldStore` does not carry them itself). `terrain` is a fresh, empty `TerrainStore` built
/// over the *new* build's own worldgen/params.
pub fn migrate<G: Game>(
    mut old: OldStore,
    terrain: crate::world::TerrainStore,
    tick: Tick,
    rng: SimRng,
) -> Result<(Authority<G>, MigrationOutcome), SaveIncompatible>
where
    G::Global: Default,
{
    let engine_rescale = old.engine_rescale();
    let carried_next_entity_id = old.next_entity_id;
    let carried_player_meta = std::mem::take(&mut old.player_meta);
    let carried_timers = std::mem::take(&mut old.timers);
    let carried_wake_next = std::mem::take(&mut old.wake_next);
    let carried_active = std::mem::take(&mut old.active);
    let from_schema = old.schema();

    let store = crate::store::Store::new(terrain, G::Global::default());
    let mut authority = Authority::from_snapshot(store, rng, tick);

    let mut migrating = Migrating::new(&mut authority);
    G::migrate(
        from_schema,
        &mut old,
        &mut migrating as &mut dyn WorldWrite<G>,
    )?;
    let faulted = migrating.has_fault();
    if faulted {
        return Err(SaveIncompatible);
    }

    if !engine_rescale.is_identity() && !old.rescale_was_observed() {
        crate::abi::panic::log(
            crate::abi::registry::LogLevel::Warn,
            "migrate: tick rate changed but no duration was rescaled",
        );
    }

    // Planning decisions 3: engine-owned carry, unconditional, filtered to ids the game actually
    // kept.
    authority
        .store_mut()
        .carry_next_entity_id(carried_next_entity_id);

    for (who, last_seq, online) in carried_player_meta {
        authority
            .store_mut()
            .carry_player_meta(who, last_seq, online);
    }

    let mut outcome = MigrationOutcome::default();
    for (id, at) in carried_timers {
        if authority.store().entity(id).is_some() {
            let deadline = engine_rescale.deadline(at);
            authority.store_mut().timer_wake_at(id, deadline);
        } else {
            outcome.dropped_timers += 1;
        }
    }
    for id in carried_wake_next {
        if authority.store().entity(id).is_some() {
            authority.store_mut().wake_push_next(id);
        } else {
            outcome.dropped_wakes += 1;
        }
    }
    for (sys_index, ids) in carried_active.into_iter().enumerate() {
        for id in ids {
            if authority.store().entity(id).is_some() {
                authority
                    .store_mut()
                    .active_activate(SystemId(sys_index as u8), id);
            } else {
                outcome.dropped_active += 1;
            }
        }
    }

    Ok((authority, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rescale_identity_is_noop() {
        let r = Rescale::new(20, 20, Tick(500));
        assert!(r.is_identity());
        assert_eq!(r.ticks(Ticks(0)), Ticks(0));
        assert_eq!(r.ticks(Ticks(37)), Ticks(37));
        assert_eq!(r.deadline(Tick(0)), Tick(0));
        assert_eq!(r.deadline(Tick(1_000)), Tick(1_000));
        assert_eq!(r.deadline(Tick(100)), Tick(100));
    }

    /// Reference rounding, derived independently from 0006's own written rule ("round to nearest,
    /// ties up, never zero for a non-zero duration") rather than by calling `Rescale` -- a test
    /// that computes its expectation from the thing under test cannot fail (this session's own
    /// M24 gate finding). Implemented with `f64`, deliberately not reusing `Rescale`'s integer
    /// formula.
    fn expected_ticks(d: u32, old_hz: u32, new_hz: u32) -> u32 {
        if old_hz == new_hz {
            return d;
        }
        let exact = d as f64 * new_hz as f64 / old_hz as f64;
        let mut rounded = (exact + 0.5).floor() as u32; // ties up
        if rounded == 0 && d != 0 {
            rounded = 1;
        }
        rounded
    }

    #[test]
    fn rescale_matches_0006_rounding() {
        for (old_hz, new_hz) in [(20u32, 30u32), (30, 20), (20, 60)] {
            for d in 0..=200u32 {
                let r = Rescale::new(old_hz, new_hz, Tick(0));
                assert_eq!(
                    r.ticks(Ticks(d)).0,
                    expected_ticks(d, old_hz, new_hz),
                    "old_hz={old_hz} new_hz={new_hz} d={d}"
                );
            }
        }
        // The non-zero floor: a duration of 1 tick at 60Hz rescaled down to 20Hz is 0.33 ticks,
        // which must still floor-then-bump to 1, never 0.
        let r = Rescale::new(60, 20, Tick(0));
        assert_eq!(r.ticks(Ticks(1)), Ticks(1));
        assert_eq!(expected_ticks(1, 60, 20), 1);

        // `deadline`, future and past, with saturation at 0 for a past tick that would otherwise
        // rescale to before the epoch.
        let r = Rescale::new(20, 30, Tick(1_000));
        assert_eq!(
            r.deadline(Tick(1_040)),
            Tick(1_000 + expected_ticks(40, 20, 30))
        );
        assert_eq!(
            r.deadline(Tick(960)),
            Tick(1_000 - expected_ticks(40, 20, 30))
        );
        let near_zero = Rescale::new(20, 30, Tick(5));
        assert_eq!(
            near_zero.deadline(Tick(0)),
            Tick(0),
            "saturates at 0, never wraps"
        );
    }

    // -- migrate_default_is_save_incompatible: a minimal local `Game` that never overrides
    // `migrate`, proving the trait's own default (`Err(SaveIncompatible)`, game.rs) really is
    // reachable through this module's own driver. Mirrors the crate's own inline test-`Game`
    // pattern (e.g. `authority.rs`'s `TGame`).
    mod default_declines {
        use super::*;
        use crate::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown};
        use crate::world::{
            CacheCapacity, ChunkDims, PristineSource, PrototypeId, Registry, TerrainStore, Tile,
        };
        use crate::worldgen::Worldgen;

        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct DEntity;
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct DPlayer;
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct DGlobal;
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
        )]
        struct DReject;
        impl From<Unknown> for DReject {
            fn from(_: Unknown) -> Self {
                DReject
            }
        }
        struct DGen;
        impl Worldgen for DGen {
            type Params = ();
            const WORLDGEN_VERSION: u32 = 0;
            fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
                out.fill(Tile::VOID);
            }
        }
        struct ZeroSource;
        impl PristineSource for ZeroSource {
            fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
                out.fill(Tile::VOID);
            }
        }
        struct DGame;
        impl Game for DGame {
            const SCHEMA_VERSION: u32 = 2;
            type Worldgen = DGen;
            type Action = ();
            type Reject = DReject;
            type Entity = DEntity;
            type Player = DPlayer;
            type Global = DGlobal;
            type Presence = ();
            type Ui = ();
            type Client = ();
            fn register(_r: &mut Registry) {}
            fn prototype(_e: &DEntity) -> PrototypeId {
                PrototypeId(0)
            }
            fn anchor(_e: &DEntity) -> TilePos {
                TilePos::new(0, 0)
            }
            fn genesis(_w: &mut dyn WorldWrite<Self>) {}
            fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
            fn apply(
                _w: &mut dyn WorldWrite<Self>,
                _who: PlayerId,
                _a: &(),
            ) -> Result<(), DReject> {
                Ok(())
            }
            fn tick(_cx: &mut TickCx<'_, Self>) {}
            // `migrate` deliberately not overridden: the trait default is what this test proves.
        }

        fn empty_old(schema: u32) -> OldStore {
            OldStore {
                schema,
                old_hz: 20,
                new_hz: 20,
                tick: Tick(0),
                rescale_observed: Cell::new(false),
                global: Vec::new(),
                player_bytes: VecDeque::new(),
                player_meta: Vec::new(),
                next_entity_id: 1,
                entity_bytes: VecDeque::new(),
                tiles: VecDeque::new(),
                timers: Vec::new(),
                wake_next: Vec::new(),
                active: (0..SystemId::MAX).map(|_| Vec::new()).collect(),
            }
        }

        // `OldStore::global::<DGlobal>()` inside the trait default is never reached (the default
        // `migrate` returns `Err` before touching `old` at all), so an empty `global` blob above
        // is fine.

        #[test]
        fn migrate_default_is_save_incompatible() {
            let dims = ChunkDims::new(4);
            let terrain = TerrainStore::new(dims, Box::new(ZeroSource), CacheCapacity::Chunks(8));
            let result =
                super::super::migrate::<DGame>(empty_old(1), terrain, Tick(0), SimRng::new(0));
            assert!(matches!(result, Err(SaveIncompatible)));
        }
    }

    // -- Fix round 1 (orchestrator ruling): decision 5 makes a SCHEMA_VERSION mismatch
    // `NeedsMigrate` in *either* direction; `Game::migrate` decides, and a game may choose to
    // accept an older build's save written by a newer one (this is the
    // `no_migrate_hook_save_incompatible_files_untouched` fixture scenario's own mirror image:
    // there, no hook exists at all and the whole thing is `SaveIncompatible`; here, one does, and
    // it succeeds). This game's own `SCHEMA_VERSION` is 1 (older than the incoming save's 2) and
    // its `migrate` explicitly accepts `from_schema == 2`, bringing the newer shape's data down
    // into its own, simpler one.
    mod accepts_newer_schema {
        use super::*;
        use crate::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown};
        use crate::world::{
            CacheCapacity, ChunkDims, PristineSource, PrototypeId, Registry, TerrainStore, Tile,
        };
        use crate::worldgen::Worldgen;

        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct NEntity;
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct NPlayer;
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize,
        )]
        struct NGlobal {
            rolls: u32,
        }
        #[derive(
            Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
        )]
        struct NReject;
        impl From<Unknown> for NReject {
            fn from(_: Unknown) -> Self {
                NReject
            }
        }
        struct NGen;
        impl Worldgen for NGen {
            type Params = ();
            const WORLDGEN_VERSION: u32 = 0;
            fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
                out.fill(Tile::VOID);
            }
        }
        struct ZeroSource;
        impl PristineSource for ZeroSource {
            fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
                out.fill(Tile::VOID);
            }
        }

        /// The *newer* schema's own `Global` shape (schema 2): an extra field this older build's
        /// `migrate` simply discards on the way down. A private copy, like every other game's own
        /// `mod old` (Planning decisions 1) -- this is just the mirror case, an old*er* type this
        /// game happens to be newer than.
        #[derive(serde::Serialize, serde::Deserialize)]
        struct NewerGlobal {
            rolls: u32,
            extra_field_this_build_does_not_know_about: u32,
        }

        struct NGame;
        impl Game for NGame {
            const SCHEMA_VERSION: u32 = 1; // older than the incoming save's schema (2)
            type Worldgen = NGen;
            type Action = ();
            type Reject = NReject;
            type Entity = NEntity;
            type Player = NPlayer;
            type Global = NGlobal;
            type Presence = ();
            type Ui = ();
            type Client = ();
            fn register(_r: &mut Registry) {}
            fn prototype(_e: &NEntity) -> PrototypeId {
                PrototypeId(0)
            }
            fn anchor(_e: &NEntity) -> TilePos {
                TilePos::new(0, 0)
            }
            fn genesis(_w: &mut dyn WorldWrite<Self>) {}
            fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
            fn apply(
                _w: &mut dyn WorldWrite<Self>,
                _who: PlayerId,
                _a: &(),
            ) -> Result<(), NReject> {
                Ok(())
            }
            fn tick(_cx: &mut TickCx<'_, Self>) {}
            fn migrate(
                from_schema: u32,
                old: &mut OldStore,
                w: &mut dyn WorldWrite<Self>,
            ) -> Result<(), SaveIncompatible> {
                if from_schema != 2 {
                    return Err(SaveIncompatible);
                }
                let newer: NewerGlobal = old.global()?;
                w.put_global(NGlobal { rolls: newer.rolls });
                Ok(())
            }
        }

        #[test]
        fn migrate_accepts_a_newer_stored_schema_when_the_game_chooses_to() {
            use crate::codec::encode;
            use crate::persist::{Comparison, Identity, MismatchReason};
            use crate::worldgen::WorldgenStamp;

            // The identity-level routing decision first: a stored schema newer than the running
            // build's is `NeedsMigrate`, not `Incompatible` (fix round 1) -- `NGame::migrate` is
            // exactly the seam that then decides.
            let stamp = WorldgenStamp {
                version: 0,
                fingerprint: 0,
            };
            let stored = Identity {
                build_hash: [2; 16],
                engine_version: "0.1.0".to_string(),
                game_version: "0.1.0".to_string(),
                schema_version: 2,
                tick_rate_hz: 20,
                worldgen: stamp,
            };
            let running = Identity {
                build_hash: [1; 16],
                engine_version: "0.1.0".to_string(),
                game_version: "0.1.0".to_string(),
                schema_version: 1,
                tick_rate_hz: 20,
                worldgen: stamp,
            };
            assert_eq!(
                stored.compare(&running),
                Comparison::NeedsMigrate(MismatchReason::Schema)
            );

            let mut global_bytes = [0u8; 32];
            let n = encode(
                &NewerGlobal {
                    rolls: 7,
                    extra_field_this_build_does_not_know_about: 99,
                },
                &mut global_bytes,
            )
            .expect("encodes");
            let old = OldStore {
                schema: 2,
                old_hz: 20,
                new_hz: 20,
                tick: Tick(0),
                rescale_observed: Cell::new(false),
                global: global_bytes[..n].to_vec(),
                player_bytes: VecDeque::new(),
                player_meta: Vec::new(),
                next_entity_id: 1,
                entity_bytes: VecDeque::new(),
                tiles: VecDeque::new(),
                timers: Vec::new(),
                wake_next: Vec::new(),
                active: (0..SystemId::MAX).map(|_| Vec::new()).collect(),
            };
            let dims = ChunkDims::new(4);
            let terrain = TerrainStore::new(dims, Box::new(ZeroSource), CacheCapacity::Chunks(8));
            let (authority, _outcome) =
                super::super::migrate::<NGame>(old, terrain, Tick(0), SimRng::new(0))
                    .expect("an older build may choose to accept a newer schema's save");
            assert_eq!(authority.store().global().rolls, 7);
        }
    }
}
