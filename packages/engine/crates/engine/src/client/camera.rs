//! `CameraBlock`: the client role's read side of the camera block (docs/decisions/0019-camera-
//! input-and-overlay.md §1; docs/plan/06b-workers-and-spawn.md, Scope and Planning decisions
//! "Worker frame clock"). Byte-for-byte the same 80 bytes `packages/engine/src/camera/block.ts`
//! defines (`CAM_OFF_*`): the TS side writes and copies the block's live bytes whole into this
//! role's `Camera` region (0014 §4's copy-in rule, a plain `set()`, never field-by-field), so this
//! struct only ever reads region memory that JS already retried a seqlock read to get clean.
//! `seq`, the seqlock sequence word, arrives too but carries no meaning here.

use crate::abi::{RegionId, RegionLayout};
use crate::wire::CameraReport;

#[repr(C)]
pub struct CameraBlock {
    pub seq: i32,
    pub cursor_valid: u32,
    pub centre: [f64; 2],
    pub frame_time_ms: f64,
    pub velocity: [f32; 2],
    pub tiles_across: f32,
    pub zoom_rate: f32,
    pub half_extent_tiles: [f32; 2],
    pub dpr: f32,
    _reserved0: u32,
    pub cursor_tile: [i32; 2],
    /// M17 (docs/plan/17-drawlist-and-sprites.md, steps 4-6 Deviations "`px_per_tile()` wired for
    /// real"): the real device-pixel viewport size (`render/viewport.ts`'s own `renderer.viewport.
    /// widthPx/heightPx`, post render-scale), written by `frame-loop.ts`'s `tick()` every rAF, right
    /// after `applyPending()` refreshes the renderer's viewport and before `writeCameraAndWake()`.
    /// Fills what was `_reserved1: [u32; 2]` -- offset 72, no other field moved, no byte grown
    /// (`CameraBlock::BYTES` stays 80: `camera/block.ts`'s own 80-byte layout already reserved this
    /// pair, unused, since M06).
    pub viewport_px: [f32; 2],
}

impl CameraBlock {
    pub const BYTES: usize = core::mem::size_of::<CameraBlock>();

    /// A raw pointer into `layout`'s `Camera` region, or `None` when the region is absent (this
    /// role is not `Client`) or somehow too small. Raw, not `&CameraBlock`, so the caller can take
    /// it while still holding `layout` immutably borrowed elsewhere and defer the (safe, once
    /// dereferenced) borrow to a point past any conflicting `&mut` use of `layout` (docs/plan/
    /// 06b-workers-and-spawn.md, Deviations): the pointer itself borrows nothing.
    ///
    /// The pointer is 8-aligned (`RegionLayout::region`'s own alignment), matching this struct's
    /// alignment (8, from its `f64` fields) exactly, and valid for `Self::BYTES` bytes.
    pub fn ptr(layout: &RegionLayout) -> Option<*const CameraBlock> {
        let ptr = layout.ptr(RegionId::Camera);
        if ptr.is_null() || (layout.len(RegionId::Camera) as usize) < Self::BYTES {
            return None;
        }
        Some(ptr.cast())
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md, Planning decisions "The camera
    /// report is built in Rust from the camera-block copy, not in TS": quantises this frame's
    /// camera state into the 0010 wire shape `ClientCore::set_camera` takes. Tile-unit `f64`
    /// centre and `f32` half-extent/velocity round to the nearest integer (`f64`/`f32::round`,
    /// both determinism-rule-legal ops -- this module is client-role, outside the deterministic
    /// core anyway, `crates/engine/CLAUDE.md`); `as i32`/`as u16`/`as i16` saturate rather than
    /// wrap or panic on an out-of-range value (Rust's own defined `as` cast behaviour since 1.45),
    /// so an extreme camera position clamps here already, ahead of `host::subs::clamp_report`'s
    /// own untrusted-input clamp on the wire's far side.
    pub fn to_report(&self) -> CameraReport {
        CameraReport {
            center_x: self.centre[0].round() as i32,
            center_y: self.centre[1].round() as i32,
            half_w: self.half_extent_tiles[0].round() as u16,
            half_h: self.half_extent_tiles[1].round() as u16,
            vel_x: self.velocity[0].round() as i16,
            vel_y: self.velocity[1].round() as i16,
        }
    }
}

/// Test-only constructor (`docs/plan/08b-gen-workers-and-queue.md`, `TerrainFeed` tests): every
/// reserved field zero, every other field as given. Gated behind `test`/`testing` so it never
/// exists in a release build; private fields make a struct literal impossible from a sibling
/// module (`client/terrain_feed.rs`), so this lives here.
#[cfg(any(test, feature = "testing"))]
impl CameraBlock {
    pub fn for_test(centre: [f64; 2], velocity: [f32; 2], half_extent_tiles: [f32; 2]) -> Self {
        CameraBlock {
            seq: 0,
            cursor_valid: 0,
            centre,
            frame_time_ms: 0.0,
            velocity,
            tiles_across: 0.0,
            zoom_rate: 0.0,
            half_extent_tiles,
            dpr: 1.0,
            _reserved0: 0,
            cursor_tile: [0, 0],
            viewport_px: [0.0, 0.0],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_block_is_80_bytes_matching_block_ts() {
        assert_eq!(CameraBlock::BYTES, 80);
        assert_eq!(core::mem::offset_of!(CameraBlock, seq), 0);
        assert_eq!(core::mem::offset_of!(CameraBlock, cursor_valid), 4);
        assert_eq!(core::mem::offset_of!(CameraBlock, centre), 8);
        assert_eq!(core::mem::offset_of!(CameraBlock, frame_time_ms), 24);
        assert_eq!(core::mem::offset_of!(CameraBlock, velocity), 32);
        assert_eq!(core::mem::offset_of!(CameraBlock, tiles_across), 40);
        assert_eq!(core::mem::offset_of!(CameraBlock, zoom_rate), 44);
        assert_eq!(core::mem::offset_of!(CameraBlock, half_extent_tiles), 48);
        assert_eq!(core::mem::offset_of!(CameraBlock, dpr), 56);
        assert_eq!(core::mem::offset_of!(CameraBlock, cursor_tile), 64);
        assert_eq!(core::mem::offset_of!(CameraBlock, viewport_px), 72);
    }

    #[test]
    fn camera_block_ptr_is_none_without_the_region() {
        let layout = RegionLayout::new();
        assert!(CameraBlock::ptr(&layout).is_none());
    }
}
