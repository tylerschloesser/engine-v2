//! The fixture's client (M49): `extract` draws every visible item through the engine's
//! `transport::draw::draw_items` with [`FixtureStyle`] and nothing else (no entity, no tile art).
//! The DrawList golden (`tests/drawlist_belts.rs`), the `gc-belts` page and the netcode motion test
//! read what it draws.

use std::cell::Cell;

use engine::client::drawlist::{SpriteId, rgba};
use engine::client::{ClientSide, DrawList, FrameView};
use engine::transport::draw::{DrawItemsStats, ItemSprite, ItemStyle, draw_items};

use crate::Belts;

/// The fixture's item look: sprite id = item kind mod 3 (the ids 0..=2 the pages' test atlas,
/// `public/drawables/sprites.json`, holds), half a tile, a colour per kind, layer 2, nothing
/// below 4 device pixels a tile.
pub struct FixtureStyle;

/// Colour by kind (`kind % 4`; the bench worlds use kinds `1..=4`).
pub const KIND_COLORS: [u32; 4] = [
    rgba(230, 80, 60, 255),
    rgba(240, 200, 40, 255),
    rgba(60, 170, 90, 255),
    rgba(70, 120, 230, 255),
];
pub const ITEM_LAYER: u8 = 2;
/// Sprites in the pages' test atlas (`tests/browser/pages/public/drawables/sprites.json`: ids 0, 1, 2).
pub const SPRITES: u16 = 3;
pub const ITEM_SIZE: [f32; 2] = [0.5, 0.5];
pub const MIN_PX_PER_TILE: f32 = 4.0;

impl ItemStyle for FixtureStyle {
    fn sprite(&self, item: u16) -> ItemSprite {
        ItemSprite {
            sprite: SpriteId(item % SPRITES),
            layer: ITEM_LAYER,
            size: ITEM_SIZE,
            color: KIND_COLORS[usize::from(item % 4)],
        }
    }

    fn min_px_per_tile(&self) -> f32 {
        MIN_PX_PER_TILE
    }
}

thread_local! {
    /// Test-only observation hook (as `fx-drawables`' `LAST_PX_PER_TILE`): the last `extract`'s
    /// [`DrawItemsStats`]. Never read by the client itself.
    pub static LAST_STATS: Cell<DrawItemsStats> = const {
        Cell::new(DrawItemsStats { lines: 0, items: 0, culled: 0, too_small: false })
    };
}

/// `Game::Client` of `fx-belts`.
#[derive(Default)]
pub struct BeltsClient;

impl ClientSide<Belts> for BeltsClient {
    fn extract(&self, view: &FrameView<'_, Belts>, out: &mut DrawList) {
        let st = draw_items(view, &FixtureStyle, out);
        LAST_STATS.with(|c| c.set(st));
    }
}
