//! Trait tables (docs/decisions/0007-world-model.md §6): the game declares bit constants
//! (`NOT_BUILDABLE`, `NOT_WALKABLE`, ...); the engine defines only the mechanism. `Registry` also
//! carries the prototype table as plain data (`TraitSet` + `Footprint` per `PrototypeId`) so
//! `Game::register` (M12) has its full target.

use super::tile::Tile;

/// A bitset of up to 64 game-declared trait bits.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TraitSet(pub u64);

impl TraitSet {
    pub const EMPTY: TraitSet = TraitSet(0);
    pub const ALL: TraitSet = TraitSet(u64::MAX);

    #[inline]
    pub const fn contains(self, other: TraitSet) -> bool {
        self.0 & other.0 == other.0
    }

    #[inline]
    pub const fn union(self, other: TraitSet) -> TraitSet {
        TraitSet(self.0 | other.0)
    }
}

impl core::ops::BitOr for TraitSet {
    type Output = TraitSet;
    #[inline]
    fn bitor(self, rhs: Self) -> Self {
        self.union(rhs)
    }
}

/// A handle into [`Registry`]'s prototype table.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct PrototypeId(pub u16);

/// A multi-tile entity's footprint, in tiles. The engine asserts `footprint <= chunk size` so an
/// entity overlaps at most 4 chunks (0007 §5); that assertion belongs to the entity placement code
/// (M12b), out of scope here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Footprint {
    pub w: u8,
    pub h: u8,
}

/// Base and resource trait tables (256 entries each, one per `u8` tile layer id) plus the
/// prototype table, registered once at init (`Game::register`, M12). `base_visuals`/
/// `resource_visuals` (docs/decisions/0018-renderer.md §2; docs/plan/09-renderer-terrain.md
/// Planning decisions "TileTexel::from_tables registration") are the same shape, one visual id per
/// tile layer id, identity by default so an unregistered game still renders something: visual ids
/// share one namespace of 1,024 with `tiles.json`.
pub struct Registry {
    base_traits: [TraitSet; 256],
    resource_traits: [TraitSet; 256],
    base_visuals: [u16; 256],
    resource_visuals: [u16; 256],
    prototypes: Vec<(TraitSet, Footprint)>,
    /// The game's configured chunk edge (0007 §3: 16, 32 or 64), set once by `Store::new` (M21,
    /// docs/plan/21-entities-and-timers.md) before `Game::register` runs, so [`Registry::
    /// add_prototype`] can assert "footprint <= chunk size" (0007 §5) at the point a game declares
    /// an oversized one. Defaults to 64 (the largest legal edge, 0007 §3) so a `Registry` built
    /// without ever calling [`Registry::set_chunk_edge`] (every pre-M21 test fixture, and any
    /// caller that only wants trait tables) stays exactly as permissive as before this milestone.
    chunk_edge: u32,
}

impl Registry {
    pub fn new() -> Self {
        let mut base_visuals = [0u16; 256];
        let mut resource_visuals = [0u16; 256];
        let mut i = 0usize;
        while i < 256 {
            base_visuals[i] = i as u16;
            resource_visuals[i] = i as u16;
            i += 1;
        }
        Registry {
            base_traits: [TraitSet::EMPTY; 256],
            resource_traits: [TraitSet::EMPTY; 256],
            base_visuals,
            resource_visuals,
            prototypes: Vec::new(),
            chunk_edge: 64,
        }
    }

    /// Sets the edge [`Registry::add_prototype`] checks every footprint against (0007 §5: "the
    /// engine asserts footprint <= chunk size, so an entity overlaps at most 4 chunks"). Called by
    /// `Store::new` (M21) before `Game::register` runs; `pub(crate)` since only the engine, which
    /// knows `G::CHUNK_BITS`, ever has a reason to call it.
    pub(crate) fn set_chunk_edge(&mut self, edge: u32) {
        self.chunk_edge = edge;
    }

    #[inline]
    pub fn set_base_traits(&mut self, base: u8, traits: TraitSet) {
        self.base_traits[base as usize] = traits;
    }

    #[inline]
    pub fn set_resource_traits(&mut self, resource: u8, traits: TraitSet) {
        self.resource_traits[resource as usize] = traits;
    }

    /// 0018 §2: the base-layer terrain id's art visual. Identity until a game overrides it.
    #[inline]
    pub fn set_base_visual(&mut self, base_id: u8, visual: u16) {
        self.base_visuals[base_id as usize] = visual;
    }

    /// 0018 §2: the resource-layer id's art visual. `resource_id = 0` (no resource) is identity
    /// (visual 0, "no resource") unless a game deliberately overrides it.
    #[inline]
    pub fn set_resource_visual(&mut self, resource_id: u8, visual: u16) {
        self.resource_visuals[resource_id as usize] = visual;
    }

    #[inline]
    pub fn base_visual(&self, base_id: u8) -> u16 {
        self.base_visuals[base_id as usize]
    }

    #[inline]
    pub fn resource_visual(&self, resource_id: u8) -> u16 {
        self.resource_visuals[resource_id as usize]
    }

    /// Registers a prototype's trait set and footprint (0007 §5-§6). Panics if `footprint` exceeds
    /// this game's configured chunk edge on either axis (`footprint_larger_than_chunk_panics_at_
    /// register`, docs/plan/21-entities-and-timers.md): an entity that could not fit in at most 4
    /// chunks would break every footprint-scoped read/write this milestone builds.
    pub fn add_prototype(&mut self, traits: TraitSet, footprint: Footprint) -> PrototypeId {
        assert!(
            footprint.w as u32 <= self.chunk_edge && footprint.h as u32 <= self.chunk_edge,
            "prototype footprint {}x{} exceeds the chunk edge ({}): 0007 §5 requires an entity to \
             overlap at most 4 chunks",
            footprint.w,
            footprint.h,
            self.chunk_edge
        );
        let id = self.prototypes.len() as u16;
        self.prototypes.push((traits, footprint));
        PrototypeId(id)
    }

    /// `base_traits[t.base] | resource_traits[t.resource]` (0007 §6). The occupant term of the
    /// full `traits_at` is M12/M21's (entities are out of scope here). `Tile::VOID` is
    /// special-cased to `TraitSet::ALL` (Planning decisions 7 of docs/plan/07-world-model-core.md).
    #[inline]
    pub fn tile_traits(&self, tile: Tile) -> TraitSet {
        if tile == Tile::VOID {
            return TraitSet::ALL;
        }
        self.base_traits[tile.base() as usize].union(self.resource_traits[tile.resource() as usize])
    }

    /// `TraitSet::EMPTY` for an id no `add_prototype` call ever returned (docs/plan/
    /// 21-entities-and-timers.md Deviations: total rather than panicking, since every pre-M21 test
    /// fixture across this crate uses `PrototypeId(0)` with nothing registered at all -- occupancy
    /// was Non-scope before this milestone, so an out-of-range id was never reachable in practice
    /// until `Store::apply` started consulting this table for every entity put).
    #[inline]
    pub fn prototype_traits(&self, id: PrototypeId) -> TraitSet {
        self.prototypes
            .get(id.0 as usize)
            .map_or(TraitSet::EMPTY, |(t, _)| *t)
    }

    /// `Footprint { w: 1, h: 1 }` for an id no `add_prototype` call ever returned (same reasoning as
    /// [`Registry::prototype_traits`]): a single-tile footprint is the natural default for "nothing
    /// declared", and keeps every unregistered `PrototypeId(0)` entity occupying exactly its own
    /// anchor tile rather than panicking.
    #[inline]
    pub fn footprint(&self, id: PrototypeId) -> Footprint {
        self.prototypes
            .get(id.0 as usize)
            .map_or(Footprint { w: 1, h: 1 }, |(_, f)| *f)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
    const NOT_WALKABLE: TraitSet = TraitSet(1 << 1);
    const COLLECTABLE: TraitSet = TraitSet(1 << 2);

    #[test]
    fn tile_void_traits_all() {
        let reg = Registry::new();
        assert_eq!(reg.tile_traits(Tile::VOID), TraitSet::ALL);
    }

    #[test]
    fn traits_union_of_tables() {
        let mut reg = Registry::new();
        reg.set_base_traits(1, NOT_BUILDABLE); // water
        reg.set_resource_traits(2, COLLECTABLE);
        let tile = Tile::new(1, 2, 0);
        let traits = reg.tile_traits(tile);
        assert!(traits.contains(NOT_BUILDABLE));
        assert!(traits.contains(COLLECTABLE));
        assert!(!traits.contains(NOT_WALKABLE));

        // A tile with base/resource ids that were never set gets TraitSet::EMPTY, not a panic.
        assert_eq!(reg.tile_traits(Tile::new(200, 200, 0)), TraitSet::EMPTY);
    }

    #[test]
    fn traitset_bitor_matches_union() {
        assert_eq!(
            NOT_BUILDABLE | NOT_WALKABLE,
            NOT_BUILDABLE.union(NOT_WALKABLE)
        );
    }

    #[test]
    fn visuals_default_identity_and_override() {
        let mut reg = Registry::new();
        assert_eq!(reg.base_visual(7), 7);
        assert_eq!(reg.resource_visual(0), 0);
        reg.set_base_visual(7, 200);
        reg.set_resource_visual(3, 201);
        assert_eq!(reg.base_visual(7), 200);
        assert_eq!(reg.resource_visual(3), 201);
        // Untouched entries stay identity.
        assert_eq!(reg.base_visual(8), 8);
    }

    #[test]
    #[should_panic(expected = "exceeds the chunk edge")]
    fn footprint_larger_than_chunk_panics_at_register() {
        let mut reg = Registry::new();
        reg.set_chunk_edge(16);
        reg.add_prototype(TraitSet::EMPTY, Footprint { w: 17, h: 1 });
    }

    #[test]
    fn footprint_exactly_the_chunk_edge_is_allowed() {
        let mut reg = Registry::new();
        reg.set_chunk_edge(16);
        let id = reg.add_prototype(TraitSet::EMPTY, Footprint { w: 16, h: 16 });
        assert_eq!(reg.footprint(id), Footprint { w: 16, h: 16 });
    }

    #[test]
    fn unregistered_prototype_is_total_not_panicking() {
        let reg = Registry::new();
        assert_eq!(reg.prototype_traits(PrototypeId(0)), TraitSet::EMPTY);
        assert_eq!(reg.footprint(PrototypeId(0)), Footprint { w: 1, h: 1 });
    }

    #[test]
    fn registry_prototype_table() {
        let mut reg = Registry::new();
        let id = reg.add_prototype(NOT_BUILDABLE, Footprint { w: 2, h: 3 });
        assert_eq!(reg.prototype_traits(id), NOT_BUILDABLE);
        assert_eq!(reg.footprint(id), Footprint { w: 2, h: 3 });
        let id2 = reg.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        assert_ne!(id, id2);
    }
}
