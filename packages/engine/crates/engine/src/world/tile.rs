//! `Tile`: the 4-byte packed tile (docs/decisions/0007-world-model.md §4).
//!
//! ```text
//! bits 0..8   base      terrain id (grass, water, ...)   engine-known layer
//! bits 8..16  resource  resource id, 0 = none             engine-known layer
//! bits 16..32 aux       game-defined (e.g. remaining amount)  opaque to the engine
//! ```
//! Little-endian bytes are therefore `[base, resource, aux_lo, aux_hi]`: array-of-structs, one
//! cache line per tile of every layer.

/// A packed 4-byte tile. `pub u32` so a game can read/write the raw bits when it needs to (aux is
/// entirely game-defined).
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Tile(pub u32);

impl Tile {
    /// `Tile(u32::MAX)`: out-of-range reads (0007 §2) and a placeholder no valid tile can equal
    /// (`base`/`resource`/`aux` all-ones). [`crate::world::Registry::tile_traits`] special-cases
    /// it to [`crate::world::TraitSet::ALL`].
    pub const VOID: Tile = Tile(u32::MAX);

    #[inline]
    pub const fn new(base: u8, resource: u8, aux: u16) -> Self {
        Tile((base as u32) | ((resource as u32) << 8) | ((aux as u32) << 16))
    }

    #[inline]
    pub const fn base(self) -> u8 {
        self.0 as u8
    }

    #[inline]
    pub const fn resource(self) -> u8 {
        (self.0 >> 8) as u8
    }

    #[inline]
    pub const fn aux(self) -> u16 {
        (self.0 >> 16) as u16
    }

    #[inline]
    pub const fn with_base(self, base: u8) -> Self {
        Tile((self.0 & !0x0000_00ff) | base as u32)
    }

    #[inline]
    pub const fn with_resource(self, resource: u8) -> Self {
        Tile((self.0 & !0x0000_ff00) | ((resource as u32) << 8))
    }

    #[inline]
    pub const fn with_aux(self, aux: u16) -> Self {
        Tile((self.0 & 0x0000_ffff) | ((aux as u32) << 16))
    }

    #[inline]
    pub const fn to_le_bytes(self) -> [u8; 4] {
        self.0.to_le_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_le_byte_order() {
        let t = Tile::new(0x11, 0x22, 0x4433);
        assert_eq!(t.to_le_bytes(), [0x11, 0x22, 0x33, 0x44]);
        assert_eq!(t.base(), 0x11);
        assert_eq!(t.resource(), 0x22);
        assert_eq!(t.aux(), 0x4433);
    }

    #[test]
    fn tile_with_helpers_touch_only_their_layer() {
        let t = Tile::new(1, 2, 3);
        assert_eq!(t.with_base(9), Tile::new(9, 2, 3));
        assert_eq!(t.with_resource(9), Tile::new(1, 9, 3));
        assert_eq!(t.with_aux(9999), Tile::new(1, 2, 9999));
    }

    #[test]
    fn void_is_all_ones() {
        assert_eq!(Tile::VOID, Tile(u32::MAX));
        assert_eq!(Tile::VOID.base(), 0xff);
        assert_eq!(Tile::VOID.resource(), 0xff);
        assert_eq!(Tile::VOID.aux(), 0xffff);
    }
}
