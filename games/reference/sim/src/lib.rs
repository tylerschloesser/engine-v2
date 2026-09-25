//! `reference-sim`: the reference game's Rust crate (docs/plan/20-reference-game-v0.md). Step 1
//! (Order of work) scaffolds the crate with `export_game!(RefGame)` and no-op rules only, so the
//! page boots and the `.wasm` exists; every later step in this brief fills it in.
//!
//! Module layout (mirrors `games/reference/CLAUDE.md`, written in a later step): `noise.rs` (step
//! 2, thin wrapper over `engine::noise`), `worldgen.rs` (`RefWorldgen`/`RefParams`; step 1 is a
//! flat placeholder, step 2 is the real simplex/fBm generator), `content.rs` (terrain/resource ids
//! and, from step 4 on, `TraitSet`s and `Game::register`).

use engine::client::ClientSide;
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, TilePos};
use ts_rs::TS;

pub mod content;
pub mod worldgen;

pub use worldgen::{RefParams, RefWorldgen};

/// Step 1 placeholder (Scope: "no-op rules"). Replaced wholesale in step 4 by the real
/// `Action::{StartCollect, CancelCollect}` (see this brief's Deviations for the exact shape once
/// written).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum RefAction {
    Noop,
}

/// Step 1 placeholder; step 4 replaces it with the real `Reject`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum RefReject {
    Unknown,
}

impl From<Unknown> for RefReject {
    fn from(_: Unknown) -> Self {
        RefReject::Unknown
    }
}

/// Step 1 placeholder; step 4 replaces it with the real `PlayerState`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefPlayer;

/// Step 1 placeholder; step 4 replaces it with the real `GlobalState` (empty for now per Scope).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefGlobal;

/// Step 1 placeholder entity type: this game has no entities yet (furnaces arrive with M32).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RefEntity;

/// Step 1 placeholder; step 4 gives this the real (`Default`-only, per Scope) shape.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct RefUi;

/// `type Client = ()` for now: `ClientSide<RefGame>`'s default no-op impl (0018 §2). Step 5 gives
/// the resource layer its depletion-stage `tile_visual` override.
#[derive(Default)]
pub struct RefClient;

impl ClientSide<RefGame> for RefClient {}

pub struct RefGame;

impl Game for RefGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = RefWorldgen;
    type Action = RefAction;
    type Reject = RefReject;
    type Entity = RefEntity;
    type Player = RefPlayer;
    type Global = RefGlobal;
    type Presence = ();
    type Ui = RefUi;
    type Client = RefClient;

    fn register(_r: &mut Registry) {
        // Step 4 (content.rs): trait bits (`NOT_BUILDABLE`, `COLLECTABLE`) and the entity
        // prototype table.
    }

    fn prototype(_e: &RefEntity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(_e: &RefEntity) -> TilePos {
        TilePos::new(0, 0)
    }

    fn genesis(_w: &mut dyn WorldWrite<Self>) {}

    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {
        // Step 4/5: `w.put_player(who, RefPlayer::default())` on `Joined`.
    }

    fn apply(
        _w: &mut dyn WorldWrite<Self>,
        _who: PlayerId,
        _a: &RefAction,
    ) -> Result<(), RefReject> {
        Ok(())
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &RefAction,
    ) -> Result<(), RefReject> {
        Ok(())
    }
}

engine::export_game!(RefGame);

#[cfg(test)]
mod tests {
    use super::*;
    use engine::world::{ChunkCoord, Tile};
    use engine::worldgen::Worldgen;

    /// Proves the `Worldgen` impl compiles and produces something for the game's own `Tile`
    /// pipeline, independent of `Game`/`Sim` (step 1's own smoke test; step 2 adds the real
    /// coverage named in Tests added).
    #[test]
    fn worldgen_generate_fills_every_tile() {
        let mut out = vec![Tile::VOID; 32 * 32];
        RefWorldgen::generate(1, &RefParams::default(), ChunkCoord::new(0, 0), &mut out);
        assert!(out.iter().all(|t| *t != Tile::VOID));
    }
}
