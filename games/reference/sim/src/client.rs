//! `RefClient: ClientSide<RefGame>` (docs/plan/20b-reference-player-and-collect-ui.md Scope):
//! `PlayerPresence`, the critically damped camera-follow spring, the own-player circle + range
//! ring, and the depletion `tile_visual` override moved here from `lib.rs` (steps 1-3 landed it
//! there before this module existed).
//!
//! `.claude/rules/hot-paths.md` applies to everything in this file: `frame`/`extract` run once per
//! client frame, so neither allocates in steady state (`RefClient`'s own spring state is fixed-size
//! fields, never a `Vec`).

use std::cell::RefCell;

use engine::client::{ClientSide, DrawList, FrameCx, FrameView, SCREEN_PX_STROKE, TileTexel};
use engine::game::Presence;
use engine::world::{Tile, TilePos, WorldPos};

use crate::rules::collect::in_range;
use crate::worldgen::terrain_at;
use crate::{
    Inventory, MAX_IN_RANGE, RefGame, RefParams, TileXY, UiCollecting, UiInRange, WorldXY, content,
};

/// `Presence` sketch from `0001-camera-and-presence.md` (Decision, `Presence` code block),
/// verbatim: `PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel: [i16; 2] }` = 12 bytes encoded, well
/// inside the 32-byte cap (`engine::presence::MAX_ENCODED_BYTES`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct PlayerPresence {
    pub pos: [i32; 2],
    pub vel: [i16; 2],
}

impl Presence for PlayerPresence {
    fn pos(&self) -> WorldPos {
        WorldPos {
            x: self.pos[0],
            y: self.pos[1],
        }
    }

    fn vel(&self) -> [i32; 2] {
        [self.vel[0] as i32, self.vel[1] as i32]
    }
}

/// The spring's natural frequency (rad/s, critically damped: 0001 Sources, closed-form damped
/// spring). Chosen for feel (settles in well under a second at 20-120 Hz); "nothing depends on its
/// bits" (0001 Decision, "Spring constants") -- not tuned against any test's exact numbers, only
/// against "visibly lags, then settles" (`spring_settles_and_is_dt_independent`,
/// `reference_player_circle_lags_and_settles`).
const SPRING_OMEGA: f64 = 6.0;

/// The own-player circle's diameter in tiles (Requirements: "Players are drawn as circles"; no
/// number given, so a value that reads clearly at the default zoom is chosen here).
const PLAYER_DIAMETER_TILES: f32 = 0.6;

/// Opaque green-ish player colour (rgba8, arbitrary -- Requirements name no colour).
const PLAYER_COLOR: u32 = 0x40c0_40ff;
/// A faint ring colour (translucent, low alpha) so the range indicator reads as a hint, not a
/// second solid shape.
const RANGE_RING_COLOR: u32 = 0x40c0_4060;

/// `extract`'s own layer for the player circle and range ring (`0..8`, 0018 §2); low, so terrain
/// (layer 0, implicitly) sits under it and any future UI-ish drawable (buttons are DOM, not drawn)
/// would sit above.
const LAYER_PLAYER: u8 = 1;

/// A drawable smaller than this many CSS px is skipped entirely (Scope: "both skipped when
/// `FrameView.zoom` makes the circle smaller than 2 px" -- read via `px_per_tile()`, the accessor
/// that exact wording names, not `zoom()` itself, since "smaller than 2 px" is a screen-space
/// question `px_per_tile()` answers directly).
const MIN_VISIBLE_PX: f32 = 2.0;

/// One critically damped spring step, closed form (0001 Sources: https://www.ryanjuckett.com/
/// damped-springs/, "Case 3: Critical Damping"), for a target that itself moves at a (locally)
/// constant velocity: `x0`/`v0` are the offset and relative velocity from the target *at the start
/// of this step*; the formula treats the target as stationary at its current position for the
/// duration of `dt` (an ordinary approximation for a springy follow effect, not a physical
/// simulation) and the caller adds `target_vel * dt` back on.  Pure, ordinary `f64`: this is
/// `ClientSide` code, never hashed, replicated or replayed (0001 Decision: "the spring lives here,
/// in ordinary floats ... nothing depends on its bits") -- `sim/**` is still globbed by
/// `.claude/rules/determinism.md`, so the one transcendental this needs (`exp`) is called under an
/// explicit `#[allow]` rather than silently exempted.
///
/// `dt < 0.0` is treated as `0.0` (no-op step): a defensive guard, never expected in practice
/// (`FrameCx::dt_ms()` is already clamped to `0..100`, 0003).
pub fn spring_step(
    pos: f64,
    vel: f64,
    target: f64,
    target_vel: f64,
    omega: f64,
    dt: f64,
) -> (f64, f64) {
    if dt <= 0.0 {
        return (pos, vel);
    }
    let x0 = pos - target;
    let v0 = vel - target_vel;
    // SAFETY/justification (`.claude/rules/determinism.md`'s own required comment): `omega * dt`
    // is a finite, non-negative product of two ordinary floats (never NaN by construction above);
    // this whole function is `ClientSide`-only presence/visual state, never part of `Store`, the
    // log, a snapshot or a hash (0001 Decision), so its bits cannot desync a replay.
    #[allow(clippy::disallowed_methods)]
    let exp_term = (-omega * dt).exp();
    let new_x = (x0 + (v0 + omega * x0) * dt) * exp_term;
    let new_v = (v0 - (v0 + omega * x0) * omega * dt) * exp_term;
    (target + new_x, target_vel + new_v)
}

/// `nearest_land_tile`'s own defensive bound (M20b step 5): worldgen scatters land generously (a
/// world is mostly land near any real seed, `worldgen.rs`'s own `classify`), so this is never
/// expected to matter -- it only stops a pathological `RefParams` (all water, say) from spiralling
/// forever, falling back to the origin instead.
const SPAWN_SEARCH_MAX_RADIUS: i32 = 4096;

/// The land tile (`content::SAND`, `GRASS` or `DIRT` -- anything that is not one of the two water
/// ids) nearest the origin, by real squared-Euclidean distance, found by spiralling outward in
/// Chebyshev rings (Scope: "spiralling over its own terrain function") from `(0, 0)`: ring `r`'s own
/// closest possible point is `r` tiles away (axis-aligned), so once a candidate closer than `r` is
/// already in hand, no larger ring can improve it -- an exact nearest search, not merely "first ring
/// to contain any land". Pure: only [`terrain_at`] (worldgen's own per-tile classification, no I/O)
/// and integer/float arithmetic on locals -- called once, at construction (`RefClient::default`/
/// `with_spring_state`), never per frame, so the ring-by-ring scan itself is exempt from `.claude/
/// rules/hot-paths.md`'s no-allocation rule the same way any one-time setup is (its own header
/// comment) even though nothing here allocates anyway.
pub fn nearest_land_tile(seed: u64, params: &RefParams) -> TilePos {
    let mut best: Option<TilePos> = None;
    let mut best_sq: i64 = i64::MAX;

    for radius in 0..=SPAWN_SEARCH_MAX_RADIUS {
        if (radius as i64) * (radius as i64) > best_sq {
            break;
        }
        if radius == 0 {
            consider_spawn_tile(seed, params, 0, 0, &mut best, &mut best_sq);
            continue;
        }
        for x in -radius..=radius {
            consider_spawn_tile(seed, params, x, -radius, &mut best, &mut best_sq);
            consider_spawn_tile(seed, params, x, radius, &mut best, &mut best_sq);
        }
        for y in -(radius - 1)..=(radius - 1) {
            consider_spawn_tile(seed, params, -radius, y, &mut best, &mut best_sq);
            consider_spawn_tile(seed, params, radius, y, &mut best, &mut best_sq);
        }
    }
    // Falls back to the origin only if [`SPAWN_SEARCH_MAX_RADIUS`] was exhausted with no land tile
    // found at all (this const's own doc comment: not expected against any real seed/params).
    best.unwrap_or(TilePos::new(0, 0))
}

/// One candidate tile for [`nearest_land_tile`]'s own spiral: updates `best`/`best_sq` in place
/// when `(x, y)` is land and strictly closer (by squared distance) than the current best.
fn consider_spawn_tile(
    seed: u64,
    params: &RefParams,
    x: i32,
    y: i32,
    best: &mut Option<TilePos>,
    best_sq: &mut i64,
) {
    if terrain_at(seed, x, y, params) < content::SAND {
        return; // Water (`DEEP_WATER`/`WATER`), not land.
    }
    let dx = x as i64;
    let dy = y as i64;
    let d = dx * dx + dy * dy;
    if d < *best_sq {
        *best_sq = d;
        *best = Some(TilePos::new(x, y));
    }
}

/// Q24.8 raw units per tile (0007 §2).
const Q8: f64 = 256.0;

fn quantize_pos(tiles: f64) -> i32 {
    // Ordinary `round`/`as` (determinism-rule-legal): saturates rather than panics on an extreme
    // value, matching `CameraBlock::to_report`'s own precedent for client-only float-to-int
    // conversions.
    (tiles * Q8).round() as i32
}

fn quantize_vel(tiles_per_sec: f64) -> i16 {
    (tiles_per_sec * Q8)
        .round()
        .clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

/// `ClientSide<RefGame>`: the camera-follow spring (`frame`), the own-player circle + range ring
/// (`extract`), and the resource layer's depletion-stage `tile_visual` override (unchanged from
/// steps 1-3, moved here).
pub struct RefClient {
    /// Tiles, world space. Not `Default`-initialized to the origin and left there: `frame`'s first
    /// call (`initialized == false`) snaps it to the camera's own centre instead, so a fresh
    /// client never visibly springs in from `(0, 0)`.
    spring_pos: [f64; 2],
    /// Tiles per second, world space.
    spring_vel: [f64; 2],
    initialized: bool,
    /// M20b step 3: the tiles currently in [`content::RANGE_Q8`] of the spring, each carrying the
    /// live position at the moment it entered the set (Planning decisions "Where `from` comes
    /// from"). `RefCell`, not a plain field: [`ClientSide::ui`] takes `&self` (the trait's own
    /// signature), but the "which tiles are already tracked, and what was their own entry
    /// position" bookkeeping can only be done where the *previous* call's result is still visible
    /// -- `ui()` is also the one place `FrameView`'s tile reads are available at all (`frame` gets
    /// no `WorldRead`). Fixed capacity ([`MAX_IN_RANGE`]) reserved once, at `Default`/
    /// `with_spring_state`; `ui()` only ever pushes up to that capacity or removes, never grows it
    /// (`.claude/rules/hot-paths.md`).
    tracked_range: RefCell<Vec<UiInRange>>,
    /// The nearest land tile to the origin (`nearest_land_tile`), copied into `Ui.spawn` unchanged
    /// on every `ui()` call (never a per-frame value, the `Ui` rule). `Default`/`with_spring_state`
    /// seed it with [`content::SEED`] + default [`RefParams`] (native tests never call `on_init`,
    /// below); a real WASM instance immediately overwrites it with the seed/params its own world was
    /// actually created with, via `ClientSide::on_init` (gate round 1 fix).
    spawn: TileXY,
}

impl Default for RefClient {
    fn default() -> Self {
        RefClient {
            spring_pos: [0.0, 0.0],
            spring_vel: [0.0, 0.0],
            initialized: false,
            tracked_range: RefCell::new(Vec::with_capacity(MAX_IN_RANGE)),
            spawn: TileXY::from_tile(nearest_land_tile(content::SEED, &RefParams::default())),
        }
    }
}

impl RefClient {
    /// Test-only convenience (native tests: `extract_hash_player_circle`, `sim/tests/`): a client
    /// already settled at `pos`/`vel`, skipping `frame`'s first-call snap. Plain `pub`, not
    /// feature-gated -- `reference-sim` is `publish = false` (never distributed), unlike the engine
    /// crate's own `CameraBlock::for_test`.
    pub fn with_spring_state(pos: [f64; 2], vel: [f64; 2]) -> Self {
        RefClient {
            spring_pos: pos,
            spring_vel: vel,
            initialized: true,
            tracked_range: RefCell::new(Vec::with_capacity(MAX_IN_RANGE)),
            spawn: TileXY::from_tile(nearest_land_tile(content::SEED, &RefParams::default())),
        }
    }

    /// The spring's own current position, tiles (test-only accessor; Deviations).
    pub fn spring_pos(&self) -> [f64; 2] {
        self.spring_pos
    }

    /// The spawn tile `Ui.spawn` publishes (test-only accessor, gate round 1 fix): lets a native
    /// test check `on_init`'s own effect directly, the same reason `spring_pos` exists.
    pub fn spawn(&self) -> TileXY {
        self.spawn
    }
}

/// Full (7-10) / half (4-6) / low (1-3) units of [`content::UNITS_PER_TILE`] (Planning decisions
/// "Depletion stages").
fn depletion_stage(aux: u16) -> u8 {
    if aux >= 7 {
        content::RESOURCE_STAGE_FULL
    } else if aux >= 4 {
        content::RESOURCE_STAGE_HALF
    } else {
        content::RESOURCE_STAGE_LOW
    }
}

impl ClientSide<RefGame> for RefClient {
    /// Gate round 1 fix (docs/plan/20b-reference-player-and-collect-ui.md; engine change: `client::
    /// texel::ClientSide::on_init`, called once by `game_instance::ClientInstance::init` right
    /// after `Default::default()`, before `frame`/`extract`/`ui` ever run): recomputes `Ui.spawn`
    /// against the seed/params this instance's own world was *actually* created with, replacing the
    /// `Default`/`with_spring_state` fallback's own `content::SEED` + `RefParams::default()` guess.
    /// Real pages never notice (their own world already uses that exact seed/params); a browser
    /// test can now exercise the real spawn pipeline against a *different* world (`test-entry.ts`'s
    /// own `?altSpawnParams` option, `ClientOptions.test.game`) whose nearest land tile is not the
    /// trivial "origin is already land" case every real seed hits (Deviations has the full finding:
    /// `content::SEED`'s own height-channel value at the origin lattice point is `0.0` regardless of
    /// seed, identical to `nearest_land_tile`'s own fallback, so a test asserting spawn `== (0, 0)`
    /// could never tell a working search from a broken one without this).
    fn on_init(&mut self, seed: u64, params: &RefParams) {
        self.spawn = TileXY::from_tile(nearest_land_tile(seed, params));
    }

    /// Integrates the spring toward the camera block's own centre/velocity (0001 Decision:
    /// "writes `G::Presence` once per client frame from the camera block"), then writes the
    /// quantized result into `presence`. Calls `cx.ui_dirty()` whenever the spring actually moved
    /// this frame (M18's `FrameCx::ui_dirty()`, 0024 §7d): `in_range` (M20b step 3) depends on the
    /// spring position, which changes every frame the camera moves even though no host mutation
    /// occurred, so `ui()` must re-run on exactly those frames too.
    fn frame(&mut self, cx: &mut FrameCx<'_, RefGame>, presence: &mut PlayerPresence) {
        let camera = cx.camera();
        let target = camera.centre;
        let target_vel = [camera.velocity[0] as f64, camera.velocity[1] as f64];

        if !self.initialized {
            self.spring_pos = target;
            self.spring_vel = target_vel;
            self.initialized = true;
        } else {
            let dt = (cx.dt_ms() as f64 / 1000.0).max(0.0);
            let (nx, nvx) = spring_step(
                self.spring_pos[0],
                self.spring_vel[0],
                target[0],
                target_vel[0],
                SPRING_OMEGA,
                dt,
            );
            let (ny, nvy) = spring_step(
                self.spring_pos[1],
                self.spring_vel[1],
                target[1],
                target_vel[1],
                SPRING_OMEGA,
                dt,
            );
            self.spring_pos = [nx, ny];
            self.spring_vel = [nvx, nvy];
        }
        cx.ui_dirty();

        presence.pos = [
            quantize_pos(self.spring_pos[0]),
            quantize_pos(self.spring_pos[1]),
        ];
        presence.vel = [
            quantize_vel(self.spring_vel[0]),
            quantize_vel(self.spring_vel[1]),
        ];
    }

    /// Draws the own player as a `circle` plus a faint `ring` of radius `RANGE` with
    /// `SCREEN_PX_STROKE` (Scope), both skipped when `view.px_per_tile()` would render the circle
    /// smaller than [`MIN_VISIBLE_PX`].
    fn extract(&self, view: &FrameView<'_, RefGame>, out: &mut DrawList) {
        let px_per_tile = view.px_per_tile();
        if px_per_tile > 0.0 && PLAYER_DIAMETER_TILES * px_per_tile < MIN_VISIBLE_PX {
            return;
        }
        let pos = WorldPos {
            x: quantize_pos(self.spring_pos[0]),
            y: quantize_pos(self.spring_pos[1]),
        };
        out.circle(
            LAYER_PLAYER,
            pos,
            [PLAYER_DIAMETER_TILES, PLAYER_DIAMETER_TILES],
            PLAYER_COLOR,
        );
        let range_diameter_tiles = 2.0 * content::RANGE_Q8 as f32 / 256.0;
        let ring = out.ring(
            LAYER_PLAYER,
            pos,
            [range_diameter_tiles, range_diameter_tiles],
            RANGE_RING_COLOR,
        );
        ring.flags |= SCREEN_PX_STROKE;
    }

    /// `Ui { me, inventory, collecting, in_range, spawn }` (Scope; module doc comment "M20b step
    /// 3", spawn added step 5): `me`/`inventory`/`collecting` read straight off
    /// `view.world().player(view.me())`; `in_range` from a bounding-box scan around the spring
    /// position, diffed against [`Self::tracked_range`] so each entry's own `from` only changes
    /// when that tile's own membership does; `spawn` is copied from [`Self::spawn`] unchanged (never
    /// recomputed here). `out` is cleared and refilled, never grown past `Ui::default`'s own
    /// reserved capacity ([`MAX_IN_RANGE`]).
    fn ui(&self, view: &FrameView<'_, RefGame>, out: &mut crate::RefUi) {
        let world = view.world();
        out.me = view.me().0;
        out.inventory = Inventory::default();
        out.collecting = None;
        out.spawn = self.spawn;
        if let Ok(player) = world.player(view.me()) {
            out.inventory = player.inventory;
            out.collecting = player.collecting.map(|c| UiCollecting {
                tile: c.tile,
                done_at: c.done_at.0,
            });
        }

        let from = WorldPos {
            x: quantize_pos(self.spring_pos[0]),
            y: quantize_pos(self.spring_pos[1]),
        };
        // A square wide enough that every tile whose *centre* could be within `RANGE_Q8` of `from`
        // is visited: `RANGE` tiles plus one, to cover the player's own fractional offset inside
        // its own tile ([`content::RANGE_SCAN_TILES`], also [`MAX_IN_RANGE`]'s own derivation).
        let range_tiles = content::RANGE_SCAN_TILES;
        let player_tile = TilePos::new(
            self.spring_pos[0].floor() as i32,
            self.spring_pos[1].floor() as i32,
        );

        let mut tracked = self.tracked_range.borrow_mut();
        let mut seen = [false; MAX_IN_RANGE];
        for dy in -range_tiles..=range_tiles {
            for dx in -range_tiles..=range_tiles {
                let tile = TilePos::new(player_tile.x + dx, player_tile.y + dy);
                let Ok(t) = world.tile(tile) else { continue };
                let resource = t.resource();
                if resource == 0 || !in_range(from, tile) {
                    continue;
                }
                let key = TileXY::from_tile(tile);
                if let Some(i) = tracked.iter().position(|e| e.tile == key) {
                    tracked[i].resource = resource;
                    seen[i] = true;
                } else if tracked.len() < MAX_IN_RANGE {
                    tracked.push(UiInRange {
                        tile: key,
                        resource,
                        from: WorldXY {
                            x: from.x,
                            y: from.y,
                        },
                    });
                    seen[tracked.len() - 1] = true;
                }
            }
        }
        // Drop anything not confirmed this pass (left range, or its resource is gone) -- in place,
        // no allocation.
        let mut i = 0;
        tracked.retain(|_| {
            let keep = seen[i];
            i += 1;
            keep
        });

        out.in_range.clear();
        out.in_range.extend_from_slice(&tracked);
    }

    /// Table lookup (`TileTexel::from_tables`) for the base layer; the resource layer adds the
    /// depletion stage on top (`content.rs`'s own doc comment: a resource id doubles as its own
    /// "full" stage visual id, so `resource_id + stage` is the whole formula).
    fn tile_visual(t: Tile) -> TileTexel {
        let mut texel = TileTexel::from_tables(t);
        let resource = t.resource();
        if resource != 0 {
            texel.resource = resource as u16 + depletion_stage(t.aux()) as u16;
        }
        texel
    }
}
