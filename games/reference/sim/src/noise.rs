//! Noise helpers for `RefWorldgen` (docs/plan/20-reference-game-v0.md Order of work step 2;
//! Planning decisions "Noise helpers stay in the game crate (`sim/src/noise.rs`)").
//!
//! **Deviation** (recorded in full under this brief's Deviations): that planning decision predates
//! `engine::noise` (docs/plan/08-worldgen-and-gen-worker.md), which now exists as an *optional*
//! module -- "a game's `Worldgen` impl may use", dropped by LTO if unused -- and which the
//! `fx-worldgen` fixture already calls directly. Reimplementing f64 simplex fBm here would
//! duplicate that exact, already-`.claude/rules/determinism.md`-compliant algorithm; this file
//! instead keeps the *shape* the planning decision wants (a game-owned module composing the two
//! noise channels `RefWorldgen::generate` reads) while reusing the engine's implementation.

use engine::noise::fbm2;

/// XORed into the moisture channel's seed so height and moisture read independent fields, not the
/// same noise at half frequency (`fx-worldgen`'s own precedent, ported from `spikes/
/// determinism-hash`).
const MOISTURE_SEED_XOR: u32 = 0x5bd1_e995;

/// Height channel: `octaves`-octave fBm at `freq`, roughly `[-1, 1]` (0008 §1).
#[inline]
pub fn height(seed32: u32, x: f64, y: f64, freq: f64, octaves: u32) -> f64 {
    fbm2(seed32, x * freq, y * freq, octaves)
}

/// Moisture channel: same shape as [`height`], independent by seed derivation.
#[inline]
pub fn moisture(seed32: u32, x: f64, y: f64, freq: f64, octaves: u32) -> f64 {
    fbm2(seed32 ^ MOISTURE_SEED_XOR, x * freq, y * freq, octaves)
}
