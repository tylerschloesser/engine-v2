//! Throwaway spike: can ONE game-written `apply` run against the authoritative world and
//! against a partial client replica + prediction overlay? See ../RESULT.md.
//!
//! Core idea: replicated state is a `Store` whose ONLY mutator is `Store::apply(&Delta)`.
//! A write through `WorldWrite` IS a delta (whole-value "put"). The host applies it and records
//! it; the client replica applies the very same value; the overlay just remembers it.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::Debug;
use std::hash::{Hash, Hasher};

pub mod harness;

// ---------------------------------------------------------------------------------------------
// Plain types
// ---------------------------------------------------------------------------------------------

pub type Tick = u32;
pub const CHUNK: i32 = 32;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct PlayerId(pub u8);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct EntityId(pub u32);

impl EntityId {
    const PROVISIONAL_BIT: u32 = 1 << 31;
    /// Client-side id for the `n`th entity spawned by pending action `seq`. Stable across replays.
    pub fn provisional(seq: u32, n: u32) -> Self {
        EntityId(Self::PROVISIONAL_BIT | ((seq & 0x07FF_FFFF) << 4) | (n & 0xF))
    }
    pub fn is_provisional(self) -> bool {
        self.0 & Self::PROVISIONAL_BIT != 0
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

impl TilePos {
    pub const fn new(x: i32, y: i32) -> Self {
        TilePos { x, y }
    }
    pub fn chunk(self) -> ChunkCoord {
        ChunkCoord { x: self.x.div_euclid(CHUNK), y: self.y.div_euclid(CHUNK) }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ChunkCoord {
    pub x: i32,
    pub y: i32,
}

/// Opaque packed tile; the game declares the bit fields.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Tile(pub u32);

/// Engine defines the mechanism, the game defines the meanings.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TraitSet(pub u64);

impl TraitSet {
    pub fn contains(self, other: TraitSet) -> bool {
        self.0 & other.0 == other.0
    }
}
impl std::ops::BitOr for TraitSet {
    type Output = TraitSet;
    fn bitor(self, rhs: TraitSet) -> TraitSet {
        TraitSet(self.0 | rhs.0)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Footprint {
    pub origin: TilePos,
    pub w: u8,
    pub h: u8,
}

impl Footprint {
    pub fn tile(pos: TilePos) -> Self {
        Footprint { origin: pos, w: 1, h: 1 }
    }
    pub fn contains(self, p: TilePos) -> bool {
        p.x >= self.origin.x
            && p.y >= self.origin.y
            && p.x < self.origin.x + self.w as i32
            && p.y < self.origin.y + self.h as i32
    }
    pub fn tiles(self) -> impl Iterator<Item = TilePos> {
        let o = self.origin;
        (0..self.h as i32).flat_map(move |dy| (0..self.w as i32).map(move |dx| TilePos::new(o.x + dx, o.y + dy)))
    }
    /// Does any tile of the footprint lie in a chunk for which `f` is true?
    pub fn any_chunk(self, mut f: impl FnMut(ChunkCoord) -> bool) -> bool {
        let a = self.origin.chunk();
        let b = TilePos::new(self.origin.x + self.w as i32 - 1, self.origin.y + self.h as i32 - 1).chunk();
        for cy in a.y..=b.y {
            for cx in a.x..=b.x {
                if f(ChunkCoord { x: cx, y: cy }) {
                    return true;
                }
            }
        }
        false
    }
}

/// A read hit state the client does not hold. `?` turns it into the game's `Reject` via `From`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Unknown;

// ---------------------------------------------------------------------------------------------
// What the game author implements
// ---------------------------------------------------------------------------------------------

pub trait Game: Sized + 'static {
    type Config: Clone;
    type Action: Clone + Debug;
    type Reject: From<Unknown> + Clone + PartialEq + Debug;
    /// Whole-value replicated. Keep it plain data (no heap) so clone-modify-put never allocates.
    type Entity: Clone + PartialEq + Hash + Debug;
    /// Private per-player state, replicated only to that player.
    type Player: Clone + PartialEq + Hash + Debug;

    /// Worldgen: pure function of (config, position). Total on host AND client.
    fn pristine(cfg: &Self::Config, pos: TilePos) -> Tile;
    /// Trait table lookups.
    fn tile_traits(tile: Tile) -> TraitSet;
    fn entity_traits(e: &Self::Entity) -> TraitSet;
    fn footprint(e: &Self::Entity) -> Footprint;

    /// Engine-defined connection action (first join).
    fn join(w: &mut dyn WorldWrite<Self>, who: PlayerId);
    /// THE handler. Runs on host (live + replay) and on the client (prediction + re-prediction).
    /// Contract: validate first, write after; on `Err` nothing may have been written.
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, action: &Self::Action) -> Result<(), Self::Reject>;
    /// Tick rules. HOST ONLY. Gets the concrete authority (iteration helpers) but still writes
    /// through the same recording `WorldWrite` path.
    fn tick(w: &mut Authority<Self>);
}

/// Object-safe on purpose: handlers compile once and take `&mut dyn WorldWrite<G>`.
pub trait WorldRead<G: Game> {
    /// Host: the tick being simulated. Prediction: the tick this action was predicted to land on
    /// (frozen per pending action, so replays do not drift).
    fn tick(&self) -> Tick;
    fn tile(&self, pos: TilePos) -> Result<Tile, Unknown>;
    fn entity_at(&self, pos: TilePos) -> Result<Option<EntityId>, Unknown>;
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown>;
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown>;

    /// OR of the tile's traits and the occupant's traits.
    fn traits_at(&self, pos: TilePos) -> Result<TraitSet, Unknown> {
        let mut t = G::tile_traits(self.tile(pos)?);
        if let Some(id) = self.entity_at(pos)? {
            if let Some(e) = self.entity(id)? {
                t = t | G::entity_traits(e);
            }
        }
        Ok(t)
    }
}

/// Every method is a whole-value put, and therefore also a delta.
pub trait WorldWrite<G: Game>: WorldRead<G> {
    fn set_tile(&mut self, pos: TilePos, tile: Tile);
    fn spawn(&mut self, e: G::Entity) -> EntityId;
    fn put_entity(&mut self, id: EntityId, e: G::Entity);
    fn despawn(&mut self, id: EntityId);
    fn put_player(&mut self, who: PlayerId, p: G::Player);
}

// ---------------------------------------------------------------------------------------------
// Deltas and the store they mutate (shared by host and client)
// ---------------------------------------------------------------------------------------------

pub enum Delta<G: Game> {
    Tile { pos: TilePos, tile: Tile },
    EntityPut { id: EntityId, entity: G::Entity },
    EntityGone { id: EntityId },
    Player { who: PlayerId, state: G::Player },
}

impl<G: Game> Clone for Delta<G> {
    fn clone(&self) -> Self {
        match self {
            Delta::Tile { pos, tile } => Delta::Tile { pos: *pos, tile: *tile },
            Delta::EntityPut { id, entity } => Delta::EntityPut { id: *id, entity: entity.clone() },
            Delta::EntityGone { id } => Delta::EntityGone { id: *id },
            Delta::Player { who, state } => Delta::Player { who: *who, state: state.clone() },
        }
    }
}

/// Who gets a delta. Derived mechanically at write time.
#[derive(Clone, Copy, Debug)]
pub enum Scope {
    Area(Footprint),
    Player(PlayerId),
}

pub struct Store<G: Game> {
    pub cfg: G::Config,
    /// Sparse: only tiles that differ from pristine. (Real engine: per-chunk sorted vecs.)
    tiles: BTreeMap<TilePos, Tile>,
    entities: BTreeMap<EntityId, G::Entity>,
    /// Derived from entity footprints; never written by the game.
    occupancy: BTreeMap<TilePos, EntityId>,
    players: BTreeMap<PlayerId, G::Player>,
}

impl<G: Game> Store<G> {
    pub fn new(cfg: G::Config) -> Self {
        Store { cfg, tiles: BTreeMap::new(), entities: BTreeMap::new(), occupancy: BTreeMap::new(), players: BTreeMap::new() }
    }

    /// The only mutator of replicated state, on both sides of the wire.
    pub fn apply(&mut self, d: &Delta<G>) {
        match d {
            Delta::Tile { pos, tile } => {
                if *tile == G::pristine(&self.cfg, *pos) {
                    self.tiles.remove(pos); // canonical form: overlay holds only differences
                } else {
                    self.tiles.insert(*pos, *tile);
                }
            }
            Delta::EntityPut { id, entity } => {
                if let Some(old) = self.entities.get(id) {
                    for t in G::footprint(old).tiles() {
                        self.occupancy.remove(&t);
                    }
                }
                for t in G::footprint(entity).tiles() {
                    self.occupancy.insert(t, *id);
                }
                self.entities.insert(*id, entity.clone());
            }
            Delta::EntityGone { id } => {
                if let Some(old) = self.entities.remove(id) {
                    for t in G::footprint(&old).tiles() {
                        self.occupancy.remove(&t);
                    }
                }
            }
            Delta::Player { who, state } => {
                self.players.insert(*who, state.clone());
            }
        }
    }

    pub fn tile(&self, pos: TilePos) -> Tile {
        self.tiles.get(&pos).copied().unwrap_or_else(|| G::pristine(&self.cfg, pos))
    }

    fn hash_into(&self, h: &mut Fnv) {
        self.tiles.hash(h);
        self.entities.hash(h);
        self.players.hash(h);
    }
}

/// FNV-1a. (Spike only: std `Hash` feeds native-endian bytes; the real thing hashes canonical bytes.)
pub struct Fnv(pub u64);
impl Default for Fnv {
    fn default() -> Self {
        Fnv(0xcbf29ce484222325)
    }
}
impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= *b as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Host: authoritative world. Writes = apply delta + record delta.
// ---------------------------------------------------------------------------------------------

pub struct Authority<G: Game> {
    store: Store<G>,
    tick: Tick,
    next_entity: u32,
    changes: Vec<(Scope, Delta<G>)>,
    spawned: Vec<EntityId>,
}

impl<G: Game> Authority<G> {
    pub fn new(cfg: G::Config) -> Self {
        Authority { store: Store::new(cfg), tick: 0, next_entity: 1, changes: Vec::new(), spawned: Vec::new() }
    }

    fn write(&mut self, d: Delta<G>) {
        let scope = match &d {
            Delta::Tile { pos, .. } => Scope::Area(Footprint::tile(*pos)),
            Delta::EntityPut { entity, .. } => Scope::Area(G::footprint(entity)),
            Delta::EntityGone { id } => match self.store.entities.get(id) {
                Some(e) => Scope::Area(G::footprint(e)),
                None => return,
            },
            Delta::Player { who, .. } => Scope::Player(*who),
        };
        self.store.apply(&d);
        self.changes.push((scope, d));
    }

    // Iteration helpers for tick rules (host only; prediction never iterates).
    pub fn player_ids(&self) -> Vec<PlayerId> {
        self.store.players.keys().copied().collect()
    }
    pub fn entity_ids(&self) -> Vec<EntityId> {
        self.store.entities.keys().copied().collect()
    }

    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv::default();
        self.tick.hash(&mut h);
        self.next_entity.hash(&mut h);
        self.store.hash_into(&mut h);
        h.finish()
    }

    pub fn store(&self) -> &Store<G> {
        &self.store
    }

    /// One sim step: inputs in arrival order, then tick rules. Same code live and in replay.
    pub fn advance(&mut self, inputs: &[Input<G>], mut on_result: impl FnMut(&Input<G>, Tick, Result<(), G::Reject>, &[EntityId])) {
        self.tick += 1;
        for input in inputs {
            self.spawned.clear();
            let before = self.changes.len();
            let r = match input {
                Input::Join(who) => {
                    G::join(self, *who);
                    Ok(())
                }
                Input::Action { who, action, .. } => G::apply(self, *who, action),
            };
            // Mechanical check of the "validate, then write" contract.
            assert!(r.is_ok() || self.changes.len() == before, "handler wrote state and then rejected: {input:?}");
            let spawned = std::mem::take(&mut self.spawned);
            on_result(input, self.tick, r, &spawned);
            self.spawned = spawned;
        }
        G::tick(self);
    }
}

impl<G: Game> WorldRead<G> for Authority<G> {
    fn tick(&self) -> Tick {
        self.tick
    }
    fn tile(&self, pos: TilePos) -> Result<Tile, Unknown> {
        Ok(self.store.tile(pos))
    }
    fn entity_at(&self, pos: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(self.store.occupancy.get(&pos).copied())
    }
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        Ok(self.store.entities.get(&id))
    }
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.store.players.get(&who).ok_or(Unknown)
    }
}

impl<G: Game> WorldWrite<G> for Authority<G> {
    fn set_tile(&mut self, pos: TilePos, tile: Tile) {
        self.write(Delta::Tile { pos, tile });
    }
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        let id = EntityId(self.next_entity);
        self.next_entity += 1;
        self.spawned.push(id);
        self.write(Delta::EntityPut { id, entity: e });
        id
    }
    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        self.write(Delta::EntityPut { id, entity: e });
    }
    fn despawn(&mut self, id: EntityId) {
        self.write(Delta::EntityGone { id });
    }
    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.write(Delta::Player { who, state: p });
    }
}

// ---------------------------------------------------------------------------------------------
// Host shell: log, acks, subscription filtering. Subscriptions are host state, never sim state.
// ---------------------------------------------------------------------------------------------

pub enum Input<G: Game> {
    Join(PlayerId),
    Action { who: PlayerId, seq: u32, action: G::Action },
}
impl<G: Game> Clone for Input<G> {
    fn clone(&self) -> Self {
        match self {
            Input::Join(p) => Input::Join(*p),
            Input::Action { who, seq, action } => Input::Action { who: *who, seq: *seq, action: action.clone() },
        }
    }
}
impl<G: Game> Debug for Input<G> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Input::Join(p) => write!(f, "Join({p:?})"),
            Input::Action { who, seq, action } => write!(f, "Action({who:?}, #{seq}, {action:?})"),
        }
    }
}

pub struct Ack<G: Game> {
    pub seq: u32,
    pub tick: Tick,
    pub result: Result<(), G::Reject>,
    /// Real ids of entities the action spawned, in spawn order. Because the SAME handler ran
    /// the prediction, the nth provisional id maps to the nth real id. Derived, not authored.
    pub spawned: Vec<EntityId>,
}

pub struct Frame<G: Game> {
    pub tick: Tick,
    pub enter: Vec<ChunkCoord>,
    pub deltas: Vec<Delta<G>>,
    pub acks: Vec<Ack<G>>,
}

struct Conn<G: Game> {
    subs: BTreeSet<ChunkCoord>,
    entering: Vec<ChunkCoord>,
    acks: Vec<Ack<G>>,
}

pub struct Host<G: Game> {
    pub auth: Authority<G>,
    pub log: Vec<(Tick, Input<G>)>,
    inbox: Vec<Input<G>>,
    conns: BTreeMap<PlayerId, Conn<G>>,
}

impl<G: Game> Host<G> {
    pub fn new(cfg: G::Config) -> Self {
        Host { auth: Authority::new(cfg), log: Vec::new(), inbox: Vec::new(), conns: BTreeMap::new() }
    }

    pub fn connect(&mut self, who: PlayerId) {
        self.conns.insert(who, Conn { subs: BTreeSet::new(), entering: Vec::new(), acks: Vec::new() });
        self.inbox.push(Input::Join(who));
    }

    /// Stand-in for "server derives the chunk set from the camera message". Not logged.
    pub fn subscribe(&mut self, who: PlayerId, c: ChunkCoord) {
        let conn = self.conns.get_mut(&who).expect("connected");
        if !conn.subs.contains(&c) && !conn.entering.contains(&c) {
            conn.entering.push(c);
        }
    }

    pub fn receive(&mut self, who: PlayerId, seq: u32, action: G::Action) {
        self.inbox.push(Input::Action { who, seq, action });
    }

    pub fn step(&mut self) -> Vec<(PlayerId, Frame<G>)> {
        let inputs = std::mem::take(&mut self.inbox);
        let (log, conns) = (&mut self.log, &mut self.conns);
        self.auth.advance(&inputs, |input, tick, result, spawned| {
            log.push((tick, input.clone())); // (real engine: write-ahead, before apply)
            if let Input::Action { who, seq, .. } = input {
                if let Some(c) = conns.get_mut(who) {
                    c.acks.push(Ack { seq: *seq, tick, result, spawned: spawned.to_vec() });
                }
            }
        });

        let changes = std::mem::take(&mut self.auth.changes);
        let store = &self.auth.store;
        let mut out = Vec::new();
        for (who, conn) in self.conns.iter_mut() {
            let mut deltas = Vec::new();
            for (scope, d) in &changes {
                let relevant = match scope {
                    Scope::Area(fp) => fp.any_chunk(|c| conn.subs.contains(&c)),
                    Scope::Player(p) => p == who,
                };
                if relevant {
                    deltas.push(d.clone());
                }
            }
            // Chunk enter: a snapshot is just more puts, consistent as of the end of this tick.
            // Puts are idempotent, so an entity already known via another chunk is harmless.
            let enter = std::mem::take(&mut conn.entering);
            for c in &enter {
                for (pos, tile) in store.tiles.iter().filter(|(p, _)| p.chunk() == *c) {
                    deltas.push(Delta::Tile { pos: *pos, tile: *tile });
                }
                for (id, e) in store.entities.iter().filter(|(_, e)| G::footprint(e).any_chunk(|k| k == *c)) {
                    deltas.push(Delta::EntityPut { id: *id, entity: e.clone() });
                }
                conn.subs.insert(*c);
            }
            out.push((*who, Frame { tick: self.auth.tick, enter, deltas, acks: std::mem::take(&mut conn.acks) }));
        }
        out
    }

    /// Rebuild from genesis using only config + log.
    pub fn replay(cfg: G::Config, log: &[(Tick, Input<G>)], until: Tick) -> Authority<G> {
        let mut auth = Authority::new(cfg);
        let mut i = 0;
        while auth.tick < until {
            let t = auth.tick + 1;
            let start = i;
            while i < log.len() && log[i].0 == t {
                i += 1;
            }
            let inputs: Vec<Input<G>> = log[start..i].iter().map(|(_, inp)| inp.clone()).collect();
            auth.advance(&inputs, |_, _, _, _| {});
            auth.changes.clear();
        }
        auth
    }
}

// ---------------------------------------------------------------------------------------------
// Client: replica (mutated only by deltas) + overlay (mutated only by predicted handlers)
// ---------------------------------------------------------------------------------------------

pub struct Replica<G: Game> {
    store: Store<G>,
    subs: BTreeSet<ChunkCoord>,
    tick: Tick,
}

/// Reusable arena: three vecs that keep their capacity across `clear()`. Last write wins, lookups
/// scan backwards. Entries number in the single digits, so a linear scan beats any map.
pub struct Overlay<G: Game> {
    tiles: Vec<(TilePos, Tile)>,
    entities: Vec<(EntityId, Option<G::Entity>)>, // None = despawned
    players: Vec<(PlayerId, G::Player)>,
    saw_unknown: std::cell::Cell<bool>,
}

impl<G: Game> Overlay<G> {
    fn new() -> Self {
        Overlay {
            tiles: Vec::with_capacity(64),
            entities: Vec::with_capacity(32),
            players: Vec::with_capacity(16),
            saw_unknown: std::cell::Cell::new(false),
        }
    }
    fn clear(&mut self) {
        self.tiles.clear();
        self.entities.clear();
        self.players.clear();
    }
    fn mark(&self) -> (usize, usize, usize) {
        (self.tiles.len(), self.entities.len(), self.players.len())
    }
    fn rollback(&mut self, m: (usize, usize, usize)) {
        self.tiles.truncate(m.0);
        self.entities.truncate(m.1);
        self.players.truncate(m.2);
    }
    pub fn len(&self) -> usize {
        self.tiles.len() + self.entities.len() + self.players.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// Layered reads, shared by the read-only view and the predicting view.
fn unknown<G: Game, T>(o: &Overlay<G>) -> Result<T, Unknown> {
    o.saw_unknown.set(true);
    Err(Unknown)
}

fn read_tile<G: Game>(r: &Replica<G>, o: &Overlay<G>, pos: TilePos) -> Result<Tile, Unknown> {
    // Pristine terrain is total on the client, but the *overlay* of an unsubscribed chunk is not
    // held (someone may have mined it out), so the tile as a whole is unknown.
    if !r.subs.contains(&pos.chunk()) {
        return unknown(o);
    }
    if let Some((_, t)) = o.tiles.iter().rev().find(|(p, _)| *p == pos) {
        return Ok(*t);
    }
    Ok(r.store.tile(pos))
}

fn read_entity<'a, G: Game>(r: &'a Replica<G>, o: &'a Overlay<G>, id: EntityId) -> Result<Option<&'a G::Entity>, Unknown> {
    if let Some((_, e)) = o.entities.iter().rev().find(|(i, _)| *i == id) {
        return Ok(e.as_ref());
    }
    match r.store.entities.get(&id) {
        Some(e) => Ok(Some(e)),
        // Cannot tell "does not exist" from "exists outside my subscription".
        None => unknown(o),
    }
}

fn read_entity_at<G: Game>(r: &Replica<G>, o: &Overlay<G>, pos: TilePos) -> Result<Option<EntityId>, Unknown> {
    if !r.subs.contains(&pos.chunk()) {
        return unknown(o);
    }
    // Latest overlay state per id: does a predicted entity cover this tile?
    for (idx, (id, e)) in o.entities.iter().enumerate().rev() {
        let superseded = o.entities[idx + 1..].iter().any(|(i, _)| i == id);
        if superseded {
            continue;
        }
        if let Some(e) = e {
            if G::footprint(e).contains(pos) {
                return Ok(Some(*id));
            }
        }
    }
    match r.store.occupancy.get(&pos) {
        // The replica's occupant may have been moved/despawned in the overlay.
        Some(id) if o.entities.iter().any(|(i, _)| i == id) => Ok(None),
        other => Ok(other.copied()),
    }
}

fn read_player<'a, G: Game>(r: &'a Replica<G>, o: &'a Overlay<G>, who: PlayerId) -> Result<&'a G::Player, Unknown> {
    if let Some((_, p)) = o.players.iter().rev().find(|(w, _)| *w == who) {
        return Ok(p);
    }
    match r.store.players.get(&who) {
        Some(p) => Ok(p),
        None => unknown(o), // other players' private state is never replicated to us
    }
}

/// What the renderer / UI reads: replica with predictions layered on top.
pub struct View<'a, G: Game> {
    replica: &'a Replica<G>,
    overlay: &'a Overlay<G>,
}

impl<'a, G: Game> WorldRead<G> for View<'a, G> {
    /// The authoritative sim clock (latest frame). See `Client::predicted_tick` for the other one.
    fn tick(&self) -> Tick {
        self.replica.tick
    }
    fn tile(&self, pos: TilePos) -> Result<Tile, Unknown> {
        read_tile(self.replica, self.overlay, pos)
    }
    fn entity_at(&self, pos: TilePos) -> Result<Option<EntityId>, Unknown> {
        read_entity_at(self.replica, self.overlay, pos)
    }
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        read_entity(self.replica, self.overlay, id)
    }
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        read_player(self.replica, self.overlay, who)
    }
}

/// What a predicted handler runs against.
struct Predicting<'a, G: Game> {
    replica: &'a Replica<G>,
    overlay: &'a mut Overlay<G>,
    tick: Tick,
    seq: u32,
    spawned: u32,
}

impl<'a, G: Game> WorldRead<G> for Predicting<'a, G> {
    fn tick(&self) -> Tick {
        self.tick
    }
    fn tile(&self, pos: TilePos) -> Result<Tile, Unknown> {
        read_tile(self.replica, self.overlay, pos)
    }
    fn entity_at(&self, pos: TilePos) -> Result<Option<EntityId>, Unknown> {
        read_entity_at(self.replica, self.overlay, pos)
    }
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        read_entity(self.replica, self.overlay, id)
    }
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        read_player(self.replica, self.overlay, who)
    }
}

impl<'a, G: Game> WorldWrite<G> for Predicting<'a, G> {
    fn set_tile(&mut self, pos: TilePos, tile: Tile) {
        if !self.replica.subs.contains(&pos.chunk()) {
            self.overlay.saw_unknown.set(true); // blind write: backstop, handlers normally read first
        }
        self.overlay.tiles.push((pos, tile));
    }
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        let id = EntityId::provisional(self.seq, self.spawned);
        self.spawned += 1;
        self.put_entity(id, e);
        id
    }
    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        let subs = &self.replica.subs;
        if !G::footprint(&e).tiles().all(|t| subs.contains(&t.chunk())) {
            self.overlay.saw_unknown.set(true);
        }
        self.overlay.entities.push((id, Some(e)));
    }
    fn despawn(&mut self, id: EntityId) {
        self.overlay.entities.push((id, None));
    }
    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.overlay.players.push((who, p));
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum Prediction<R> {
    /// Handler succeeded on local knowledge; its writes are in the overlay.
    Applied,
    /// Handler touched state this client does not hold. Still sent; shown as "pending", no ghost.
    NotPredictable,
    /// Handler rejected on local knowledge. Still sent (the host decides); nothing shown.
    Rejected(R),
}

pub struct Pending<G: Game> {
    pub seq: u32,
    pub action: G::Action,
    /// Frozen at submit time so that re-prediction writes the same timer values every frame.
    pub predicted_tick: Tick,
    pub status: Prediction<G::Reject>,
}

pub enum ClientEvent<G: Game> {
    Confirmed { seq: u32, tick: Tick, remap: Vec<(EntityId, EntityId)> },
    Rejected { seq: u32, tick: Tick, reason: G::Reject },
}

pub struct Client<G: Game> {
    pub who: PlayerId,
    replica: Replica<G>,
    overlay: Overlay<G>,
    pending: VecDeque<Pending<G>>,
    next_seq: u32,
    /// Estimated ticks between "latest frame I hold" and "tick my action will be applied".
    pub lead: Tick,
    pub outbox: Vec<(u32, G::Action)>,
    pub events: Vec<ClientEvent<G>>,
}

impl<G: Game> Client<G> {
    pub fn new(cfg: G::Config, who: PlayerId, lead: Tick) -> Self {
        Client {
            who,
            replica: Replica { store: Store::new(cfg), subs: BTreeSet::new(), tick: 0 },
            overlay: Overlay::new(),
            pending: VecDeque::with_capacity(32),
            next_seq: 1,
            lead,
            outbox: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn view(&self) -> View<'_, G> {
        View { replica: &self.replica, overlay: &self.overlay }
    }
    /// The clock predicted own-player timers are written in and must be rendered in.
    pub fn predicted_tick(&self) -> Tick {
        self.replica.tick + self.lead
    }
    pub fn pending(&self) -> impl Iterator<Item = &Pending<G>> {
        self.pending.iter()
    }
    pub fn overlay_len(&self) -> usize {
        self.overlay.len()
    }
    pub fn authoritative(&self) -> &Store<G> {
        &self.replica.store
    }

    fn predict(replica: &Replica<G>, overlay: &mut Overlay<G>, who: PlayerId, p: &mut Pending<G>) {
        let mark = overlay.mark();
        overlay.saw_unknown.set(false);
        let mut w = Predicting { replica, overlay: &mut *overlay, tick: p.predicted_tick, seq: p.seq, spawned: 0 };
        let r = G::apply(&mut w, who, &p.action);
        p.status = if overlay.saw_unknown.get() {
            overlay.rollback(mark);
            Prediction::NotPredictable
        } else {
            match r {
                Ok(()) => Prediction::Applied,
                Err(e) => {
                    overlay.rollback(mark); // engine enforces atomicity on the client for free
                    Prediction::Rejected(e)
                }
            }
        };
    }

    /// Predict now, queue for sending. Returns (seq, how it was predicted).
    pub fn submit(&mut self, action: G::Action) -> (u32, Prediction<G::Reject>) {
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut p = Pending { seq, action: action.clone(), predicted_tick: self.predicted_tick(), status: Prediction::NotPredictable };
        Self::predict(&self.replica, &mut self.overlay, self.who, &mut p);
        let status = p.status.clone();
        self.pending.push_back(p);
        self.outbox.push((seq, action));
        (seq, status)
    }

    /// Factorio-style reset-and-replay, once per authoritative frame.
    pub fn on_frame(&mut self, f: &Frame<G>) {
        // 1. authoritative deltas -> replica (the only thing that ever mutates it)
        self.replica.tick = f.tick;
        for c in &f.enter {
            self.replica.subs.insert(*c);
        }
        for d in &f.deltas {
            self.replica.store.apply(d);
        }
        // 2. drop acked / rejected pending actions by sequence number
        for ack in &f.acks {
            while let Some(p) = self.pending.front() {
                if p.seq > ack.seq {
                    break;
                }
                let p = self.pending.pop_front().unwrap();
                if p.seq == ack.seq {
                    self.events.push(match &ack.result {
                        Ok(()) => ClientEvent::Confirmed {
                            seq: ack.seq,
                            tick: ack.tick,
                            remap: ack.spawned.iter().enumerate().map(|(n, real)| (EntityId::provisional(ack.seq, n as u32), *real)).collect(),
                        },
                        Err(e) => ClientEvent::Rejected { seq: ack.seq, tick: ack.tick, reason: e.clone() },
                    });
                }
            }
        }
        // 3. discard the overlay   4. re-apply what is still pending
        self.overlay.clear();
        for p in self.pending.iter_mut() {
            Self::predict(&self.replica, &mut self.overlay, self.who, p);
        }
    }
}
