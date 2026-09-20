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
        }
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

    pub fn add_prototype(&mut self, traits: TraitSet, footprint: Footprint) -> PrototypeId {
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

    #[inline]
    pub fn prototype_traits(&self, id: PrototypeId) -> TraitSet {
        self.prototypes[id.0 as usize].0
    }

    #[inline]
    pub fn footprint(&self, id: PrototypeId) -> Footprint {
        self.prototypes[id.0 as usize].1
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
    fn registry_prototype_table() {
        let mut reg = Registry::new();
        let id = reg.add_prototype(NOT_BUILDABLE, Footprint { w: 2, h: 3 });
        assert_eq!(reg.prototype_traits(id), NOT_BUILDABLE);
        assert_eq!(reg.footprint(id), Footprint { w: 2, h: 3 });
        let id2 = reg.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        assert_ne!(id, id2);
    }
}
