//! `Draw`/`DrawList` (docs/decisions/0018-renderer.md §2; docs/plan/17-drawlist-and-sprites.md
//! Scope): the engine-owned, preallocated per-frame draw list `ClientSide::extract` fills. Two
//! lists, one sort (Planning decisions): `extract` appends to a scratch list in the client arena
//! (`DrawList::{sprite, circle, ring, rect, bar, radial, ghost}`, this module); `sort_into` then
//! counting-sorts it by `layer` into the caller-supplied region bytes in one pass (count per layer,
//! prefix sums, scatter) -- stable, O(n), no comparisons, and `layer_count` falls out of the first
//! pass. A full scratch list drops the record and bumps a debug counter (`dropped`) rather than
//! growing (`.claude/rules/hot-paths.md`).
//!
//! `pos` crosses as `WorldPos` (Q24.8 per axis, absolute); every builder converts it to a `Draw`'s
//! own `[f32; 2]`, relative to the frame's window origin, by integer subtraction *before* the f32
//! cast (0018 §2: "Q24.8 minus window origin in integers, then f32") -- exact regardless of how far
//! the window origin sits from the world origin (0018 §5), proven by
//! `drawlist_pos_relative_to_window_origin_exact_at_2pow23` below.

use crate::world::{TilePos, WorldPos};

/// 0018 §2: "Capacity: 65,536 records (2 MiB)".
pub const CAPACITY: usize = 65_536;
/// One `Draw`, little-endian (0018 §2's `#[repr(C)]` layout, encoded explicitly rather than relied
/// on: `draw_layout_is_32_bytes_le` golden-checks the exact byte order).
pub const DRAW_BYTES: usize = 32;
/// The slot header (Planning decisions: "Slot header is 1,024 bytes, not 256", 0024 §11).
pub const HEADER_BYTES: usize = 1_024;
pub const BODY_BYTES: usize = CAPACITY * DRAW_BYTES;
/// One `RegionId::DrawList`/triple-buffer slot: header then body, contiguous.
pub const REGION_BYTES: usize = HEADER_BYTES + BODY_BYTES;
/// `Draw::layer` is `0..8` (0018 §2); `layer_count` in the header has one `u32` per layer.
pub const LAYER_COUNT: usize = 8;

// Header field offsets (Planning decisions "Slot header is 1,024 bytes"). M17 (this module) writes
// `frame_seq`, `record_count`, `window_origin`, `layer_count`, `dropped`, `frame_time_ms`; steps 4-6
// of docs/plan/18-picking-and-overlay.md (this cut) add `follow_valid`/`follow` (`cx.follow(..)`,
// 0019 §1) and `anchor_mask`/`anchors` (`DrawList::anchor`, 0019 §5). `flags` at offset 52 and the
// 24-byte gap `104..128` still have no owner (Deviations: left zero). None of these new offsets fall
// inside `hash_region`'s own `[4, 48)`/`[88, 92)` ranges, so the `fixtures/drawables` DrawList golden
// does not move.
const OFF_FRAME_SEQ: usize = 0;
const OFF_RECORD_COUNT: usize = 4;
const OFF_WINDOW_ORIGIN: usize = 8;
const OFF_LAYER_COUNT: usize = 16;
const OFF_FOLLOW_VALID: usize = 48;
const OFF_FOLLOW: usize = 56;
const OFF_ANCHOR_MASK: usize = 76;
const OFF_DROPPED: usize = 88;
const OFF_FRAME_TIME_MS: usize = 96;
const OFF_ANCHORS: usize = 128;

/// `DrawList::anchor`'s own slot count (0019 §5: "64 slots"); `anchor_mask`'s two `u32` words cover
/// exactly this many bits.
pub const ANCHOR_SLOTS: usize = 64;

/// Tiles a window origin is snapped to (Planning decisions "Window origin": "the camera centre's
/// tile, snapped to a multiple of 64 tiles").
const WINDOW_GRID_BITS: i32 = 6;

/// `Draw::kind_sprite`'s top 4 bits (0018 §2).
const KIND_SHIFT: u16 = 12;
const SPRITE_ID_MASK: u16 = 0x0FFF;

pub const KIND_SPRITE: u16 = 0;
pub const KIND_CIRCLE: u16 = 1;
pub const KIND_RING: u16 = 2;
pub const KIND_RECT: u16 = 3;
pub const KIND_BAR: u16 = 4;
pub const KIND_RADIAL: u16 = 5;
pub const KIND_GHOST: u16 = 6;

/// `Draw::flags` bits (0018 §2). `PREDICTED` is carried but not styled until M26 (this brief's
/// Scope).
pub const ANCHOR_CURSOR_TILE: u8 = 1 << 0;
pub const SCREEN_PX_STROKE: u8 = 1 << 1;
pub const PREDICTED: u8 = 1 << 2;
pub const FLIP_X: u8 = 1 << 3;

/// A sprite atlas id (0018 §4: at most 4,096 sprites -- the 12 low bits of `kind_sprite`). The
/// atlas itself is M17b's (Non-scope here); this type and `DrawList::sprite` exist now because
/// they are part of 0018 §2's `Draw`/`DrawList` shape, not the atlas.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SpriteId(pub u16);

/// One GPU instance, exactly 32 bytes little-endian (0018 §2).
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Draw {
    /// Tiles, relative to the frame's window origin (or the cursor tile, `ANCHOR_CURSOR_TILE`).
    pub pos: [f32; 2],
    /// Tiles.
    pub size: [f32; 2],
    /// Bits 12..16 kind, bits 0..12 sprite id.
    pub kind_sprite: u16,
    /// `0..8`.
    pub layer: u8,
    pub flags: u8,
    /// rgba8.
    pub color: u32,
    /// Progress `0..1` or rotation.
    pub param: f32,
    /// `0` = not pickable (0019).
    pub pick_id: u32,
}

impl Draw {
    pub const BYTES: usize = DRAW_BYTES;

    fn write_le(&self, out: &mut [u8]) {
        debug_assert_eq!(out.len(), Self::BYTES);
        out[0..4].copy_from_slice(&self.pos[0].to_le_bytes());
        out[4..8].copy_from_slice(&self.pos[1].to_le_bytes());
        out[8..12].copy_from_slice(&self.size[0].to_le_bytes());
        out[12..16].copy_from_slice(&self.size[1].to_le_bytes());
        out[16..18].copy_from_slice(&self.kind_sprite.to_le_bytes());
        out[18] = self.layer;
        out[19] = self.flags;
        out[20..24].copy_from_slice(&self.color.to_le_bytes());
        out[24..28].copy_from_slice(&self.param.to_le_bytes());
        out[28..32].copy_from_slice(&self.pick_id.to_le_bytes());
    }

    #[cfg(test)]
    fn read_le(bytes: &[u8]) -> Draw {
        assert_eq!(bytes.len(), Self::BYTES);
        Draw {
            pos: [
                f32::from_le_bytes(bytes[0..4].try_into().unwrap()),
                f32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            ],
            size: [
                f32::from_le_bytes(bytes[8..12].try_into().unwrap()),
                f32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            ],
            kind_sprite: u16::from_le_bytes(bytes[16..18].try_into().unwrap()),
            layer: bytes[18],
            flags: bytes[19],
            color: u32::from_le_bytes(bytes[20..24].try_into().unwrap()),
            param: f32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            pick_id: u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
        }
    }
}

/// The camera centre's tile, snapped down to a multiple of 64 (Planning decisions "Window
/// origin"): floor division by 64 via arithmetic shift (matches `ChunkDims::chunk_of`'s own
/// negative-correct style), so it changes rarely as the camera pans and DrawList hashes do not
/// change with sub-chunk camera motion.
pub fn snap_window_origin(centre: TilePos) -> TilePos {
    TilePos::new(
        (centre.x >> WINDOW_GRID_BITS) << WINDOW_GRID_BITS,
        (centre.y >> WINDOW_GRID_BITS) << WINDOW_GRID_BITS,
    )
}

/// Engine-owned, preallocated (Scope: "Fills M12's `DrawList` shell"). `extract` (`ClientSide<G>`)
/// only ever sees this through its builder methods; `begin_frame`/`sort_into` (below) are
/// `game_instance.rs`'s own follow-up calls, not part of the game-facing surface -- `pub`, not
/// `pub(crate)`, only because a fixture's own native golden test (a separate crate,
/// `fixtures/drawables`) needs to drive them directly to prove `sort_into`'s output is a pure
/// function of replica + camera (docs/plan/17-drawlist-and-sprites.md Deviations).
pub struct DrawList {
    /// Reserved once at `new()` (`.claude/rules/hot-paths.md`), cleared (not reallocated) by
    /// `begin_frame`.
    scratch: Vec<Draw>,
    /// A full list's writes land here instead: harmless, always overwritten next call, so `push`
    /// can still hand back a real `&mut Draw` without an `Option`/panic in the game-facing API.
    sink: Draw,
    window_origin: TilePos,
    dropped: u32,
    frame_seq: u32,
    record_count: u32,
    /// Steps 4-6: bit `i` set means `anchors[i]` was written this frame by `Self::anchor` (0019 §5).
    /// Cleared by `begin_frame`; a slot no `extract` call touches this frame keeps its mask bit
    /// clear (Deviations: "frozen, not hidden" is the TS reader's own choice, not this type's).
    anchor_mask: u64,
    /// Tiles relative to `window_origin`, the same convention `Draw::pos` uses (`Self::
    /// relative_pos`) -- only the slots `anchor_mask` marks valid are meaningful.
    anchors: [[f32; 2]; ANCHOR_SLOTS],
}

impl DrawList {
    pub fn new() -> Self {
        DrawList {
            scratch: Vec::with_capacity(CAPACITY),
            sink: Draw::default(),
            window_origin: TilePos::default(),
            dropped: 0,
            frame_seq: 0,
            record_count: 0,
            anchor_mask: 0,
            anchors: [[0.0, 0.0]; ANCHOR_SLOTS],
        }
    }

    /// Records dropped since the last [`Self::begin_frame`] because the scratch list was already
    /// at [`CAPACITY`] (Provides: `DrawList::dropped() -> u32`).
    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// How many records the last [`Self::sort_into`] wrote (`abi::drawlist_len`'s source).
    pub(crate) fn record_count(&self) -> u32 {
        self.record_count
    }

    /// Starts a new frame: clears the scratch list (capacity kept), resets the drop counter, and
    /// fixes `window_origin` for every builder call this frame (`game_instance.rs`'s `frame()`
    /// calls this before `G::Client::extract`).
    pub fn begin_frame(&mut self, window_origin: TilePos) {
        self.scratch.clear();
        self.window_origin = window_origin;
        self.dropped = 0;
        self.frame_seq = self.frame_seq.wrapping_add(1);
        self.anchor_mask = 0;
    }

    #[inline]
    fn relative_pos(&self, pos: WorldPos) -> [f32; 2] {
        let origin = WorldPos::from_tile(self.window_origin);
        let dx = pos.x.wrapping_sub(origin.x);
        let dy = pos.y.wrapping_sub(origin.y);
        [dx as f32 / 256.0, dy as f32 / 256.0]
    }

    fn push(&mut self, draw: Draw) -> &mut Draw {
        if self.scratch.len() == self.scratch.capacity() {
            self.dropped = self.dropped.saturating_add(1);
            self.sink = draw;
            return &mut self.sink;
        }
        self.scratch.push(draw);
        let last = self.scratch.len() - 1;
        &mut self.scratch[last]
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        &mut self,
        layer: u8,
        pos: WorldPos,
        size: [f32; 2],
        kind_sprite: u16,
        color: u32,
        param: f32,
    ) -> &mut Draw {
        let draw = Draw {
            pos: self.relative_pos(pos),
            size,
            kind_sprite,
            layer: layer.min(LAYER_COUNT as u8 - 1),
            flags: 0,
            color,
            param,
            pick_id: 0,
        };
        self.push(draw)
    }

    pub fn sprite(&mut self, layer: u8, pos: WorldPos, sprite: SpriteId) -> &mut Draw {
        let kind_sprite = (KIND_SPRITE << KIND_SHIFT) | (sprite.0 & SPRITE_ID_MASK);
        self.build(layer, pos, [0.0, 0.0], kind_sprite, 0, 0.0)
    }

    pub fn circle(&mut self, layer: u8, pos: WorldPos, size: [f32; 2], color: u32) -> &mut Draw {
        self.build(layer, pos, size, KIND_CIRCLE << KIND_SHIFT, color, 0.0)
    }

    pub fn ring(&mut self, layer: u8, pos: WorldPos, size: [f32; 2], color: u32) -> &mut Draw {
        self.build(layer, pos, size, KIND_RING << KIND_SHIFT, color, 0.0)
    }

    pub fn rect(&mut self, layer: u8, pos: WorldPos, size: [f32; 2], color: u32) -> &mut Draw {
        self.build(layer, pos, size, KIND_RECT << KIND_SHIFT, color, 0.0)
    }

    pub fn bar(
        &mut self,
        layer: u8,
        pos: WorldPos,
        size: [f32; 2],
        color: u32,
        progress: f32,
    ) -> &mut Draw {
        self.build(layer, pos, size, KIND_BAR << KIND_SHIFT, color, progress)
    }

    pub fn radial(
        &mut self,
        layer: u8,
        pos: WorldPos,
        size: [f32; 2],
        color: u32,
        progress: f32,
    ) -> &mut Draw {
        self.build(layer, pos, size, KIND_RADIAL << KIND_SHIFT, color, progress)
    }

    pub fn ghost(&mut self, layer: u8, pos: WorldPos, size: [f32; 2], color: u32) -> &mut Draw {
        self.build(layer, pos, size, KIND_GHOST << KIND_SHIFT, color, 0.0)
    }

    /// Publishes a moving position a DOM anchor can follow (0019 §5: "`client.overlay.anchorSlot`
    /// ... follows a moving position the game's Rust publishes with `out.anchor(slot, pos)`"). `pos`
    /// is stored the same way `Draw::pos` is (tiles relative to this frame's `window_origin`, via
    /// `Self::relative_pos`) -- the main thread's `anchorSlot` reads it back through the same
    /// `worldToScreen`-shaped arithmetic every other anchor uses. `slot >= `[`ANCHOR_SLOTS`]` is
    /// ignored (`Self::push`'s own "drop, don't panic" discipline for an out-of-range game value).
    pub fn anchor(&mut self, slot: u8, pos: WorldPos) {
        let slot = slot as usize;
        if slot >= ANCHOR_SLOTS {
            return;
        }
        self.anchor_mask |= 1u64 << slot;
        self.anchors[slot] = self.relative_pos(pos);
    }

    /// Counting-sorts the scratch list by `layer` into `out` (a whole `RegionId::DrawList`-shaped
    /// buffer, [`REGION_BYTES`]) and fills the header fields this milestone owns (module doc
    /// comment), including this frame's `follow` target (steps 4-6: `cx.follow(..)`, absolute world
    /// tiles -- the same unit and origin `CameraBlock::centre` uses, not window-relative like
    /// `Draw::pos`/`Self::anchors`, since the main thread hands it straight to `camera.setFollow(x,
    /// y, valid)`, itself in that same absolute-tile space). Returns the record count (`Self::
    /// record_count`'s new value). `game_instance.rs`'s `frame()` calls this once, right after `G::
    /// Client::extract` returns.
    pub fn sort_into(
        &mut self,
        out: &mut [u8],
        frame_time_ms: f64,
        follow: Option<WorldPos>,
    ) -> u32 {
        debug_assert!(out.len() >= REGION_BYTES);
        let mut counts = [0u32; LAYER_COUNT];
        for d in &self.scratch {
            counts[d.layer as usize] += 1;
        }
        let mut offsets = [0u32; LAYER_COUNT];
        let mut acc = 0u32;
        for (off, &c) in offsets.iter_mut().zip(counts.iter()) {
            *off = acc;
            acc += c;
        }
        let mut cursor = offsets;
        for d in &self.scratch {
            let li = d.layer as usize;
            let slot = cursor[li] as usize;
            cursor[li] += 1;
            let start = HEADER_BYTES + slot * DRAW_BYTES;
            d.write_le(&mut out[start..start + DRAW_BYTES]);
        }

        let record_count = self.scratch.len() as u32;
        self.record_count = record_count;

        out[OFF_FRAME_SEQ..OFF_FRAME_SEQ + 4].copy_from_slice(&self.frame_seq.to_le_bytes());
        out[OFF_RECORD_COUNT..OFF_RECORD_COUNT + 4].copy_from_slice(&record_count.to_le_bytes());
        out[OFF_WINDOW_ORIGIN..OFF_WINDOW_ORIGIN + 4]
            .copy_from_slice(&self.window_origin.x.to_le_bytes());
        out[OFF_WINDOW_ORIGIN + 4..OFF_WINDOW_ORIGIN + 8]
            .copy_from_slice(&self.window_origin.y.to_le_bytes());
        for (i, &c) in counts.iter().enumerate() {
            let off = OFF_LAYER_COUNT + i * 4;
            out[off..off + 4].copy_from_slice(&c.to_le_bytes());
        }
        out[OFF_DROPPED..OFF_DROPPED + 4].copy_from_slice(&self.dropped.to_le_bytes());
        out[OFF_FRAME_TIME_MS..OFF_FRAME_TIME_MS + 8].copy_from_slice(&frame_time_ms.to_le_bytes());

        let (follow_valid, follow_x, follow_y) = match follow {
            Some(pos) => (1u32, pos.x as f64 / 256.0, pos.y as f64 / 256.0),
            None => (0u32, 0.0, 0.0),
        };
        out[OFF_FOLLOW_VALID..OFF_FOLLOW_VALID + 4].copy_from_slice(&follow_valid.to_le_bytes());
        out[OFF_FOLLOW..OFF_FOLLOW + 8].copy_from_slice(&follow_x.to_le_bytes());
        out[OFF_FOLLOW + 8..OFF_FOLLOW + 16].copy_from_slice(&follow_y.to_le_bytes());

        let mask_lo = self.anchor_mask as u32;
        let mask_hi = (self.anchor_mask >> 32) as u32;
        out[OFF_ANCHOR_MASK..OFF_ANCHOR_MASK + 4].copy_from_slice(&mask_lo.to_le_bytes());
        out[OFF_ANCHOR_MASK + 4..OFF_ANCHOR_MASK + 8].copy_from_slice(&mask_hi.to_le_bytes());
        for (i, a) in self.anchors.iter().enumerate() {
            let off = OFF_ANCHORS + i * 8;
            out[off..off + 4].copy_from_slice(&a[0].to_le_bytes());
            out[off + 4..off + 8].copy_from_slice(&a[1].to_le_bytes());
        }

        record_count
    }
}

impl Default for DrawList {
    fn default() -> Self {
        Self::new()
    }
}

/// FNV-1a seeds for [`hash_region`] (M17 gate: native-vs-`.wasm` parity). Mirrors `test/client.ts`'s
/// own `fnv1a32`/`FNV32_SEED_LO`/`FNV32_SEED_HI` bit for bit: `u32` XOR-then-`wrapping_mul` is the
/// same operation as JS's `^=` then `Math.imul`, so the two independent implementations produce the
/// same 32-bit words for the same bytes.
const FNV32_PRIME: u32 = 0x0100_0193;
const FNV32_SEED_LO: u32 = 0x811c_9dc5;
const FNV32_SEED_HI: u32 = 0x1000_193b;

fn fnv1a32(bytes: &[u8], seed: u32) -> u32 {
    let mut h = seed;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(FNV32_PRIME);
    }
    h
}

/// A hash of `region` (a whole `RegionId::DrawList`-shaped buffer, [`REGION_BYTES`]) that is a
/// **pure function of replica + camera**, deliberately excluding `frame_seq` (offset 0, a
/// session-local call counter) and `frame_time_ms` (offset 96, wall-clock-derived) -- both would
/// make a native, one-shot `extract`+`sort_into` disagree with a `.wasm` instance driven through
/// several real ticks before the assertion, even when every replicated/camera-derived byte is
/// identical (M17 gate: "native-vs-`.wasm` equality, not self-consistency"). Hashes `record_count`
/// (4), `window_origin` (8) and `layer_count` (32) -- contiguous, offsets 4..48 -- then `dropped`
/// (4, offset 88..92), then `record_count * 32` body bytes: two independent 32-bit FNV-1a passes,
/// combined into one `u64` (`hi << 32 | lo`) so [`crate::assert_golden_hash`] can pin it directly.
/// `test/client.ts`'s `hashDrawListFields` is the TypeScript twin this milestone's own end-to-end
/// test (`tests/wasm/drawlist.test.ts`) and `fixtures/drawables/tests/drawlist_golden.rs` both call,
/// reading the *same* checked-in `tests/golden/drawables_hash.hash` file.
pub fn hash_region(region: &[u8], record_count: u32) -> u64 {
    let used_body = (record_count as usize * DRAW_BYTES).min(BODY_BYTES);
    let body = &region[HEADER_BYTES..HEADER_BYTES + used_body];
    let mut lo = fnv1a32(&region[4..48], FNV32_SEED_LO);
    lo = fnv1a32(&region[88..92], lo);
    lo = fnv1a32(body, lo);
    let mut hi = fnv1a32(&region[4..48], FNV32_SEED_HI);
    hi = fnv1a32(&region[88..92], hi);
    hi = fnv1a32(body, hi);
    ((hi as u64) << 32) | lo as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region() -> Vec<u8> {
        vec![0u8; REGION_BYTES]
    }

    fn read_record(out: &[u8], i: usize) -> Draw {
        let start = HEADER_BYTES + i * DRAW_BYTES;
        Draw::read_le(&out[start..start + DRAW_BYTES])
    }

    fn record_count(out: &[u8]) -> u32 {
        u32::from_le_bytes(
            out[OFF_RECORD_COUNT..OFF_RECORD_COUNT + 4]
                .try_into()
                .unwrap(),
        )
    }

    fn layer_count(out: &[u8], layer: usize) -> u32 {
        let off = OFF_LAYER_COUNT + layer * 4;
        u32::from_le_bytes(out[off..off + 4].try_into().unwrap())
    }

    fn dropped_field(out: &[u8]) -> u32 {
        u32::from_le_bytes(out[OFF_DROPPED..OFF_DROPPED + 4].try_into().unwrap())
    }

    #[test]
    fn draw_layout_is_32_bytes_le() {
        assert_eq!(Draw::BYTES, 32);
        let d = Draw {
            pos: [1.5, -2.5],
            size: [3.0, 4.0],
            kind_sprite: 0x1234,
            layer: 5,
            flags: 0x0A,
            color: 0xAABBCCDD,
            param: 0.25,
            pick_id: 42,
        };
        let mut buf = [0u8; 32];
        d.write_le(&mut buf);
        let mut expected = Vec::with_capacity(32);
        expected.extend_from_slice(&1.5f32.to_le_bytes());
        expected.extend_from_slice(&(-2.5f32).to_le_bytes());
        expected.extend_from_slice(&3.0f32.to_le_bytes());
        expected.extend_from_slice(&4.0f32.to_le_bytes());
        expected.extend_from_slice(&0x1234u16.to_le_bytes());
        expected.push(5);
        expected.push(0x0A);
        expected.extend_from_slice(&0xAABBCCDDu32.to_le_bytes());
        expected.extend_from_slice(&0.25f32.to_le_bytes());
        expected.extend_from_slice(&42u32.to_le_bytes());
        assert_eq!(buf.to_vec(), expected);
        assert_eq!(Draw::read_le(&buf), d);
    }

    #[test]
    fn drawlist_counting_sort_stable() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(0, 0));
        // Push in a deliberately unsorted layer order, tagging `color` with push order so
        // stability within a layer is checkable.
        let layers = [3u8, 0, 3, 1, 0, 3];
        for (i, &layer) in layers.iter().enumerate() {
            dl.circle(layer, WorldPos::default(), [1.0, 1.0], i as u32);
        }
        let mut out = region();
        let n = dl.sort_into(&mut out, 0.0, None);
        assert_eq!(n, layers.len() as u32);

        // Layer 0 records (push order 1, 4) come before layer 1 (push order 3) before layer 3
        // (push order 0, 2, 5) -- ascending layer, stable within each.
        let got: Vec<u32> = (0..n)
            .map(|i| read_record(&out, i as usize).color)
            .collect();
        assert_eq!(got, vec![1, 4, 3, 0, 2, 5]);
    }

    #[test]
    fn drawlist_layer_counts_and_prefix() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(0, 0));
        for _ in 0..5 {
            dl.circle(2, WorldPos::default(), [1.0, 1.0], 0);
        }
        for _ in 0..3 {
            dl.circle(7, WorldPos::default(), [1.0, 1.0], 0);
        }
        let mut out = region();
        let n = dl.sort_into(&mut out, 0.0, None);
        assert_eq!(n, 8);
        assert_eq!(layer_count(&out, 2), 5);
        assert_eq!(layer_count(&out, 7), 3);
        for l in [0, 1, 3, 4, 5, 6] {
            assert_eq!(layer_count(&out, l), 0);
        }
        assert_eq!(record_count(&out), 8);
    }

    #[test]
    fn drawlist_full_drops_and_counts() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(0, 0));
        for _ in 0..(CAPACITY + 10) {
            dl.circle(0, WorldPos::default(), [1.0, 1.0], 0);
        }
        assert_eq!(dl.dropped(), 10);
        let mut out = region();
        let n = dl.sort_into(&mut out, 0.0, None);
        assert_eq!(n, CAPACITY as u32);
        assert_eq!(record_count(&out), CAPACITY as u32);
        assert_eq!(dropped_field(&out), 10);

        // A fresh frame clears the drop counter (Scope: full-list drops are per frame).
        dl.begin_frame(TilePos::new(0, 0));
        dl.circle(0, WorldPos::default(), [1.0, 1.0], 0);
        assert_eq!(dl.dropped(), 0);
    }

    #[test]
    fn drawlist_pos_relative_to_window_origin_exact_at_2pow23() {
        let mut near = DrawList::new();
        near.begin_frame(TilePos::new(0, 0));
        let pos_near = WorldPos { x: 300, y: -500 };
        near.circle(0, pos_near, [1.0, 1.0], 0);

        let mut far = DrawList::new();
        let far_origin = TilePos::new((1 << 23) - 64, -(1 << 23) + 64);
        far.begin_frame(far_origin);
        let base = WorldPos::from_tile(far_origin);
        let pos_far = WorldPos {
            x: base.x + 300,
            y: base.y - 500,
        };
        far.circle(0, pos_far, [1.0, 1.0], 0);

        let mut out_near = region();
        near.sort_into(&mut out_near, 0.0, None);
        let mut out_far = region();
        far.sort_into(&mut out_far, 0.0, None);

        assert_eq!(
            read_record(&out_near, 0).pos,
            read_record(&out_far, 0).pos,
            "translation-invariant: same offset from window origin, exact regardless of distance \
             from the world origin (0018 §5)"
        );
        assert_eq!(
            read_record(&out_near, 0).pos,
            [300.0 / 256.0, -500.0 / 256.0]
        );
    }

    #[test]
    fn drawlist_snap_window_origin_floors_to_64() {
        assert_eq!(snap_window_origin(TilePos::new(0, 0)), TilePos::new(0, 0));
        assert_eq!(
            snap_window_origin(TilePos::new(63, 65)),
            TilePos::new(0, 64)
        );
        assert_eq!(
            snap_window_origin(TilePos::new(-1, -65)),
            TilePos::new(-64, -128)
        );
    }

    fn follow_valid(out: &[u8]) -> u32 {
        u32::from_le_bytes(
            out[OFF_FOLLOW_VALID..OFF_FOLLOW_VALID + 4]
                .try_into()
                .unwrap(),
        )
    }

    fn follow_xy(out: &[u8]) -> (f64, f64) {
        (
            f64::from_le_bytes(out[OFF_FOLLOW..OFF_FOLLOW + 8].try_into().unwrap()),
            f64::from_le_bytes(out[OFF_FOLLOW + 8..OFF_FOLLOW + 16].try_into().unwrap()),
        )
    }

    fn anchor_mask(out: &[u8]) -> u64 {
        let lo = u32::from_le_bytes(
            out[OFF_ANCHOR_MASK..OFF_ANCHOR_MASK + 4]
                .try_into()
                .unwrap(),
        );
        let hi = u32::from_le_bytes(
            out[OFF_ANCHOR_MASK + 4..OFF_ANCHOR_MASK + 8]
                .try_into()
                .unwrap(),
        );
        (hi as u64) << 32 | lo as u64
    }

    fn anchor_xy(out: &[u8], slot: usize) -> (f32, f32) {
        let off = OFF_ANCHORS + slot * 8;
        (
            f32::from_le_bytes(out[off..off + 4].try_into().unwrap()),
            f32::from_le_bytes(out[off + 4..off + 8].try_into().unwrap()),
        )
    }

    /// `drawlist.anchor_table_and_mask` (Tests added): `DrawList::anchor` writes both the mask bit
    /// and the tiles-relative-to-`window_origin` value; a slot no `anchor` call touches this frame
    /// keeps its mask bit clear; a later frame that calls `anchor` for a different slot set does not
    /// resurrect a stale bit (`begin_frame` clears the whole mask).
    #[test]
    fn drawlist_anchor_table_and_mask() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(0, 0));
        dl.anchor(0, WorldPos { x: 512, y: 768 }); // (2.0, 3.0) tiles
        dl.anchor(63, WorldPos { x: 256, y: -256 }); // (1.0, -1.0) tiles
        dl.anchor(200, WorldPos { x: 0, y: 0 }); // out of range: ignored
        let mut out = region();
        dl.sort_into(&mut out, 0.0, None);
        assert_eq!(anchor_mask(&out), (1u64 << 0) | (1u64 << 63));
        assert_eq!(anchor_xy(&out, 0), (2.0, 3.0));
        assert_eq!(anchor_xy(&out, 63), (1.0, -1.0));
        assert_eq!(
            anchor_xy(&out, 1),
            (0.0, 0.0),
            "an untouched slot stays zero"
        );

        // A fresh frame with no `anchor` calls clears every bit (Deviations: "frozen, not hidden" is
        // the TS reader's own policy -- this type's own contract is only that the mask reports
        // exactly this frame's own `anchor` calls).
        dl.begin_frame(TilePos::new(0, 0));
        let mut out2 = region();
        dl.sort_into(&mut out2, 0.0, None);
        assert_eq!(anchor_mask(&out2), 0, "begin_frame clears the whole mask");
    }

    #[test]
    fn drawlist_anchor_out_of_range_slot_ignored() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(0, 0));
        dl.anchor(64, WorldPos { x: 256, y: 256 }); // one past the last valid slot (0..64)
        let mut out = region();
        dl.sort_into(&mut out, 0.0, None);
        assert_eq!(anchor_mask(&out), 0);
    }

    /// `framecx.follow_written_to_header` (Tests added): `sort_into`'s own `follow` parameter
    /// (`game_instance.rs` passes `FrameCx::take_follow()`'s value) becomes `follow_valid`/`follow`
    /// in the header -- absolute world tiles (`WorldPos` divided by 256), the same unit `CameraBlock
    /// ::centre` uses, not window-relative.
    #[test]
    fn framecx_follow_written_to_header() {
        let mut dl = DrawList::new();
        dl.begin_frame(TilePos::new(1000, 1000));
        let mut out = region();
        dl.sort_into(&mut out, 0.0, Some(WorldPos { x: 2560, y: -1280 }));
        assert_eq!(follow_valid(&out), 1);
        assert_eq!(follow_xy(&out), (10.0, -5.0));

        // `None` writes `follow_valid = 0` and zeroes the coordinates, every frame -- a stale value
        // from a previous frame's real target never leaks through once a game returns control.
        dl.begin_frame(TilePos::new(1000, 1000));
        let mut out2 = region();
        dl.sort_into(&mut out2, 0.0, None);
        assert_eq!(follow_valid(&out2), 0);
        assert_eq!(follow_xy(&out2), (0.0, 0.0));
    }
}
