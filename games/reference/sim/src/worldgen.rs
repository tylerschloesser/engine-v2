//! `RefWorldgen`/`RefParams` (docs/plan/20-reference-game-v0.md Scope). Step 1: a flat placeholder
//! (every tile deep water, no resources) so `RefGame` compiles and the page boots against a real
//! `Worldgen` impl. Step 2 replaces `generate` with the real five-octave height / three-octave
//! moisture simplex fBm plus the `hash2` resource scatter (Order of work).

use engine::world::{ChunkCoord, Tile};
use engine::worldgen::Worldgen;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::content;

/// Seed-independent knobs (Scope: "octave counts, scales, sea level, per-resource density").
/// Step 1 has no fields yet (nothing to configure about a flat world); step 2 fills these in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RefParams {}

pub struct RefWorldgen;

impl Worldgen for RefWorldgen {
    type Params = RefParams;
    const WORLDGEN_VERSION: u32 = 1;

    fn generate(_seed: u64, _params: &RefParams, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(content::DEEP_WATER, 0, 0));
    }
}
