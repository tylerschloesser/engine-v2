//! The fixture's client (M49): `extract` draws one belt sprite per belt tile in view (M50,
//! [`draw_belts`]: `Transport::for_each_tile_in` over the replica's tile index, a belt's two lanes
//! one tile), then every visible item through the engine's `transport::draw::draw_items` with
//! [`FixtureStyle`], and nothing else (no entity, no tile art). The DrawList golden
//! (`tests/drawlist_belts.rs`), the `gc-belts` and `belts-bench` pages and the netcode motion test
//! read what it draws.

use std::cell::Cell;

use engine::client::drawlist::{SpriteId, rgba};
use engine::client::{ClientSide, DrawList, FrameView};
use engine::transport::draw::{DrawItemsStats, ItemSprite, ItemStyle, draw_items};
use engine::world::WorldPos;

use crate::Belts;

/// The fixture's item look: sprite id = item kind mod 3 (the ids 0..=2 the pages' test atlas,
/// `public/drawables/sprites.json`, holds; the atlas sizes them), a colour per kind, layer 2,
/// nothing below 20 device pixels a tile (M50: 64 tiles across a 1280 x 720 canvas, about 25,400
/// records held at that edge; at 80 across, 16 px, about 34,000 items put the client worker's
/// `frame` over the 2.7 ms desktop proxy in 3 of 10 runs).
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
pub const MIN_PX_PER_TILE: f32 = 20.0;
/// The belt tile sprite (M50): the test atlas's id 2 (1 x 1 tile, pivot at its centre), layer 1
/// (under the items), one grey.
pub const BELT_SPRITE: SpriteId = SpriteId(2);
pub const BELT_LAYER: u8 = 1;
pub const BELT_COLOR: u32 = rgba(120, 120, 130, 255);

impl ItemStyle for FixtureStyle {
    fn sprite(&self, item: u16) -> ItemSprite {
        ItemSprite {
            sprite: SpriteId(item % SPRITES),
            layer: ITEM_LAYER,
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

/// One [`BELT_SPRITE`] at the centre of every belt tile in `view.visible()` (M50); returns how
/// many. Nothing without the replica's transport. No allocation.
pub fn draw_belts(view: &FrameView<'_, Belts>, out: &mut DrawList) -> u32 {
    let Some(t) = view.transport_follow() else {
        return 0;
    };
    let mut n = 0;
    t.for_each_tile_in(view.visible(), &mut |tile, _| {
        let c = WorldPos::from_tile(tile);
        let pos = WorldPos {
            x: c.x + 128,
            y: c.y + 128,
        };
        out.sprite(BELT_LAYER, pos, BELT_SPRITE).color = BELT_COLOR;
        n += 1;
    });
    n
}

impl ClientSide<Belts> for BeltsClient {
    fn extract(&self, view: &FrameView<'_, Belts>, out: &mut DrawList) {
        draw_belts(view, out);
        let st = draw_items(view, &FixtureStyle, out);
        LAST_STATS.with(|c| c.set(st));
    }
}
