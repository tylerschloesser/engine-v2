//! `TileTexel`, `VisualTables` and the `ClientSide` trait (docs/decisions/0018-renderer.md §2,
//! §3; docs/plan/09-renderer-terrain.md Planning decisions "TileTexel::from_tables registration").
//!
//! The game calls `Registry::set_base_visual`/`set_resource_visual` inside `Game::register` (until
//! M12 lands `Game`, a fixture calls them directly, then [`install_visual_tables`]); the engine
//! keeps the resulting table in one instance-wide cell, written once, so `TileTexel::from_tables`
//! needs no table argument -- 0018 fixes that signature. Visual ids are one namespace of 1,024
//! shared with `tiles.json`; a real game registers at least its resource layer.

use core::cell::UnsafeCell;

use crate::world::{Registry, Tile};

/// GPU texel for one tile: `r` = base-layer visual id, `g` = resource-layer visual id (0 = none).
/// 4 bytes, `rg16uint` (0018 §3).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TileTexel {
    pub base: u16,
    pub resource: u16,
}

impl TileTexel {
    /// Table lookup through the instance-wide cell [`install_visual_tables`] writes. Before any
    /// install, the cell holds the identity table (0018 §2: "identity if none is registered").
    #[inline]
    pub fn from_tables(t: Tile) -> TileTexel {
        // SAFETY: see `install_visual_tables` -- a WASM instance is single-threaded (0015) and
        // this is written once, before any render frame reads it (nextest gives every native test
        // its own process, so this global is likewise never shared across tests).
        let tables = unsafe { &*VISUAL_TABLES.0.get() };
        tables.texel(t)
    }
}

/// `base`/`resource` visual-id tables: 256 entries each, one per `u8` tile layer id.
struct VisualTables {
    base: [u16; 256],
    resource: [u16; 256],
}

impl VisualTables {
    const fn identity() -> Self {
        let mut base = [0u16; 256];
        let mut resource = [0u16; 256];
        let mut i = 0usize;
        while i < 256 {
            base[i] = i as u16;
            resource[i] = i as u16;
            i += 1;
        }
        VisualTables { base, resource }
    }

    fn from_registry(r: &Registry) -> Self {
        let mut base = [0u16; 256];
        let mut resource = [0u16; 256];
        for i in 0..256usize {
            base[i] = r.base_visual(i as u8);
            resource[i] = r.resource_visual(i as u8);
        }
        VisualTables { base, resource }
    }

    #[inline]
    fn texel(&self, t: Tile) -> TileTexel {
        TileTexel {
            base: self.base[t.base() as usize],
            resource: self.resource[t.resource() as usize],
        }
    }
}

struct TablesCell(UnsafeCell<VisualTables>);
// SAFETY: see `TileTexel::from_tables` / `install_visual_tables`.
unsafe impl Sync for TablesCell {}

static VISUAL_TABLES: TablesCell = TablesCell(UnsafeCell::new(VisualTables::identity()));

/// Writes the instance-wide visual table from a filled-in `Registry` (`Game::register`'s tail,
/// until M12; a fixture calls it directly after its own registration). Called once, before the
/// first `frame`/`tile_visual` use -- never per frame (`.claude/rules/hot-paths.md` does not apply
/// to this one-time call).
pub fn install_visual_tables(registry: &Registry) {
    // SAFETY: see `TileTexel::from_tables`.
    unsafe {
        *VISUAL_TABLES.0.get() = VisualTables::from_registry(registry);
    }
}

/// The client-side rendering hooks a game may override (0018 §2, 0003's `ClientSide<G>`). `G` is
/// unbounded here: M09 runs before M12's `Game` trait, and `Uploader` (`client/upload.rs`) only
/// needs this one method, called generically as `C::tile_visual`. M12 adds the `G: Game` bound,
/// `Game::Client` and the remaining methods of 0018 §2 as empty-default shells for M16b-M18 to
/// fill, so fixtures written against this trait keep compiling unchanged.
pub trait ClientSide<G = ()> {
    /// Table lookup by default; a game overrides it to show `aux` instead (e.g. depletion).
    /// Called on chunk load/patch, never per frame (0018 §3).
    fn tile_visual(t: Tile) -> TileTexel {
        TileTexel::from_tables(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DefaultClient;
    impl ClientSide for DefaultClient {}

    struct DepletionClient;
    impl ClientSide for DepletionClient {
        fn tile_visual(t: Tile) -> TileTexel {
            // aux != 0 means "depleted": swap in a fixed aux-derived visual instead of the table.
            if t.aux() != 0 {
                TileTexel {
                    base: TileTexel::from_tables(t).base,
                    resource: 999,
                }
            } else {
                TileTexel::from_tables(t)
            }
        }
    }

    fn reset_identity() {
        install_visual_tables(&Registry::new());
    }

    #[test]
    fn texel_default_identity() {
        reset_identity();
        let t = Tile::new(5, 9, 0);
        let texel = TileTexel::from_tables(t);
        assert_eq!(
            texel,
            TileTexel {
                base: 5,
                resource: 9
            }
        );
        assert_eq!(DefaultClient::tile_visual(t), texel);
    }

    #[test]
    fn texel_registered_tables() {
        let mut reg = Registry::new();
        reg.set_base_visual(5, 500);
        reg.set_resource_visual(9, 900);
        install_visual_tables(&reg);
        let t = Tile::new(5, 9, 0);
        assert_eq!(
            TileTexel::from_tables(t),
            TileTexel {
                base: 500,
                resource: 900
            }
        );
        // Unregistered ids stay identity.
        assert_eq!(TileTexel::from_tables(Tile::new(6, 0, 0)).base, 6);
        reset_identity();
    }

    #[test]
    fn texel_override_shows_aux() {
        reset_identity();
        let plain = Tile::new(2, 3, 0);
        let depleted = Tile::new(2, 3, 1);
        assert_eq!(
            DepletionClient::tile_visual(plain),
            TileTexel {
                base: 2,
                resource: 3
            }
        );
        assert_eq!(
            DepletionClient::tile_visual(depleted),
            TileTexel {
                base: 2,
                resource: 999
            }
        );
        // The default impl is untouched by the override existing elsewhere.
        assert_eq!(
            DefaultClient::tile_visual(depleted),
            TileTexel {
                base: 2,
                resource: 3
            }
        );
    }
}
