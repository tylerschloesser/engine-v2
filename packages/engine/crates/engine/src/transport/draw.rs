//! Drawing items (M49, docs/decisions/0078 A12): the client role's one transport reader, called
//! from a game's `ClientSide::extract`. Outside the deterministic core like `client/` (floats in
//! the item clock's fraction only; positions and geometry stay integer).
//!
//! [`draw_items`] walks the replica's held lines (`Transport::index`), keeps a line one of whose
//! segments' tile boxes meets [`FrameView::visible`], and draws each of its items once as a sprite
//! styled by the game's [`ItemStyle`]: at the item clock ([`FrameView::item_time`], `T + frac`)
//! through the follower's run walk ([`super::follow::Follower::for_each_item`]; an item past the
//! front of a held `Next` is drawn on its target), mapped to the
//! world by the line's segments (`pos_to_world_slot`, exact integers), culled per item to the
//! visible rectangle. Below [`ItemStyle::min_px_per_tile`] it draws nothing. An `unknown` line
//! draws nothing. No allocation: the DrawList is reserved once (0018 §2).

use super::Transport;
use crate::client::drawlist::{DrawList, SpriteId};
use crate::client::frame_view::FrameView;
use crate::game::Game;
use crate::world::TileRect;

/// How one item kind is drawn.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ItemSprite {
    pub sprite: SpriteId,
    pub layer: u8,
    /// Tiles.
    pub size: [f32; 2],
    /// `drawlist::rgba`.
    pub color: u32,
}

/// The game's item look (M51 gives the reference game its own).
pub trait ItemStyle {
    /// The sprite for item kind `item` (0076 §1's opaque id).
    fn sprite(&self, item: u16) -> ItemSprite;
    /// Below this many device pixels per tile no item is drawn.
    fn min_px_per_tile(&self) -> f32;
}

/// What one [`draw_items`] call did (M50's extract time per 1,000 items reads it).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct DrawItemsStats {
    /// Held lines whose segments meet the visible rectangle.
    pub lines: u32,
    /// Items drawn.
    pub items: u32,
    /// Items of those lines outside the visible rectangle (or past the line's geometry).
    pub culled: u32,
    /// Nothing drawn: the zoom is below [`ItemStyle::min_px_per_tile`].
    pub too_small: bool,
}

fn meets(t: &Transport, slot: u32, visible: &TileRect) -> bool {
    t.seg_slice(slot).iter().any(|r| {
        let (lo, hi) = super::geometry::tile_box(&r.seg);
        visible.intersects(&TileRect::new(lo, hi))
    })
}

/// Draws every visible item of every held line (module doc). Nothing without
/// [`FrameView::with_transport`] or before the replica's first forecast frame.
pub fn draw_items<G: Game>(
    view: &FrameView<'_, G>,
    style: &impl ItemStyle,
    out: &mut DrawList,
) -> DrawItemsStats {
    let mut st = DrawItemsStats::default();
    let (Some(t), Some(item_time), Some(tick)) = (
        view.transport_follow(),
        view.item_time(),
        view.transport_follow().and_then(Transport::forecast_tick),
    ) else {
        return st;
    };
    if view.px_per_tile() < style.min_px_per_tile() {
        st.too_small = true;
        return st;
    }
    let frac = item_time - f64::from(tick);
    let visible = view.visible();
    for k in 0..t.index.len() {
        let slot = t.index[k].1;
        if !meets(t, slot, &visible) {
            continue;
        }
        st.lines += 1;
        t.for_each_item(slot, frac, &mut |item, on, pos| {
            let Some(wp) = t.pos_to_world_slot(on, pos) else {
                st.culled += 1;
                return;
            };
            if !visible.contains(wp.tile()) {
                st.culled += 1;
                return;
            }
            let s = style.sprite(item.0);
            let d = out.sprite(s.layer, wp, s.sprite);
            d.size = s.size;
            d.color = s.color;
            st.items += 1;
        });
    }
    st
}
