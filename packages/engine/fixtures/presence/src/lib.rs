//! Fixture game `fx-presence` (docs/plan/19-presence-channel.md, steps 1-3): the presence-channel
//! fixture 0001 asks for (`docs/spec/reference-game.md`: "Player position is presence, not world
//! state"; 0001 "Witness-carrying actions"). `Presence = { pos, vel }`, 12 bytes, the exact shape
//! ADR 0001's own "reference game" example gives (`PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel:
//! [i16; 2] }`); `Action::Poke { tile, from }` is the witness-carrying action 0001's own
//! `StartCollect` example is modelled on, with two independent distance checks:
//!
//! - `admit` (host only, never replayed, 0001 Decision "Admission"): compares `from` against the
//!   player's latest presence sample (`PresenceTable::get`) and rejects `NoSample` (no sample at
//!   all) or `TooFar` (farther than [`ADMIT_TOLERANCE_TILES`] from that sample) -- the tolerance
//!   absorbs staleness, exactly 0001's own reference-game number (16 tiles).
//! - `apply` (host live, host replay, client prediction, 0001 Decision "`apply`"): checks
//!   `dist(from, tile) <= `[`POKE_RANGE_TILES`]` in integer Q24.8 fixed point, from the action's own
//!   bytes alone -- no `PresenceTable` in scope at all (`apply`'s signature cannot name one, 0001:
//!   "readable by exactly one game hook, `admit`"), so this check is self-contained and replayable.
//!
//! Both checks share [`dist_sq`], integer-only (`.claude/rules/determinism.md`: no floats in
//! sim/`apply` code).

use engine::client::{ClientSide, DrawList, FrameCx, FrameView};
use engine::game::{
    Game, PlayerEvent, PlayerId, Presence as PresenceTrait, PresenceTable, TickCx, Unknown,
    WorldRead, WorldWrite,
};
use engine::world::{PrototypeId, Registry, Tile, TilePos, WorldPos};
use ts_rs::TS;

/// A tile coordinate, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS` -- the same reason `fixtures/puts`'s own `Pos` exists).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct TileXY {
    pub x: i32,
    pub y: i32,
}

impl TileXY {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// A Q24.8 world position, plain data (same reason as [`TileXY`]; not `engine::world::WorldPos`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct WorldXY {
    pub x: i32,
    pub y: i32,
}

impl WorldXY {
    fn world(self) -> WorldPos {
        WorldPos {
            x: self.x,
            y: self.y,
        }
    }
}

/// 0001's own reference-game shape, verbatim: `PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel:
/// [i16; 2] }`, 12 bytes encoded -- comfortably under [`engine::presence::MAX_ENCODED_BYTES`] (32).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct PlayerPresence {
    pub pos: [i32; 2],
    pub vel: [i16; 2],
}

impl PresenceTrait for PlayerPresence {
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

/// One tile in Q24.8 raw units (`WorldPos::from_tile`'s own constant, `256 = 1 << 8`, duplicated
/// here since that conversion is `crate`-private in `engine::world::coords`).
const SUBTILE: i64 = 256;

/// Squared Q24.8 distance between two world positions, integer-only (`.claude/rules/
/// determinism.md`): widened to `i64` before subtracting so two extreme-range coordinates cannot
/// overflow `i32` (0007 §2's own valid range is `[-2^23, 2^23)` tiles, i.e. `i32` raw units already
/// near the edges of `i32`'s own range once multiplied by 256).
fn dist_sq(a: WorldPos, b: WorldPos) -> i64 {
    let dx = a.x as i64 - b.x as i64;
    let dy = a.y as i64 - b.y as i64;
    dx * dx + dy * dy
}

/// `admit`'s own tolerance (0001 "reference game: reject if farther than 16 tiles from the
/// sample"), reused verbatim.
const ADMIT_TOLERANCE_TILES: i64 = 16;
/// `apply`'s own range (0001's `StartCollect` example uses "16 tiles" too for its own reference
/// implementation, but that is `admit`'s tolerance, a different check with a different purpose;
/// this fixture picks a materially smaller, distinct number for `apply`'s own deterministic range
/// so a test can tell the two checks apart -- see `Reject::TooFar` vs. `Reject::OutOfRange`).
const POKE_RANGE_TILES: i64 = 2;

fn within(dist: i64, tiles: i64) -> bool {
    dist <= (tiles * SUBTILE) * (tiles * SUBTILE)
}

/// One witness-carrying action (0001 Decision): `from` is the client's own presence position when
/// it pressed the button, copied into the action so `apply` can re-check it without reading
/// non-sim state (0001 "Witness-carrying actions"). `#[ts(export)]` (docs/plan/
/// 16-action-round-trip.md step 4): without it ts-rs's derive macro emits no `export_bindings_*`
/// test at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Poke { tile: TileXY, from: WorldXY },
}

/// `From<Unknown>` (0003: "add a `?` to each read and `impl From<Unknown> for Reject`").
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`).
    Unknown,
    /// `admit`: no presence sample recorded for this player (0001 "reject ... if no sample
    /// exists").
    NoSample,
    /// `admit`: `from` is farther than [`ADMIT_TOLERANCE_TILES`] from the player's latest presence
    /// sample.
    TooFar,
    /// `apply`: `dist(from, tile) > `[`POKE_RANGE_TILES`] in fixed point, from the action's own
    /// bytes alone -- deterministic, replayable, independent of `admit`'s own (already-passed, by
    /// the time `apply` runs) tolerance check.
    OutOfRange,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Private per-player state: how many `Poke`s this player has had applied, and the last tile
/// poked -- just enough for a test to observe that `apply` actually ran (docs/plan/
/// 19-presence-channel.md Tests added: `apply_range_is_replayable`/`presence_is_not_state` compare
/// state hashes, which fold this in).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub poke_count: u32,
    pub last_tile: TileXY,
}

/// The game's own per-client-frame hooks (docs/plan/19-presence-channel.md steps 4-6, Order of
/// work step 5): `frame` writes a presence sample that changes every call (a simple counter-driven
/// walk along `x`, independent of the camera -- this fixture's own worker-path browser test drives
/// `frame()` directly through the harness, with no guarantee a camera ever moves, and the exit
/// criterion is "`uplinkPresenceBytes` while changing every frame"); `extract` draws a circle per
/// remote presence (Provides: "the fixture's `extract` draws a circle per presence"). In a
/// single-player topology a player's own sample is never relayed back to them (0010 host drop
/// rule), so `presences()` yields nothing there -- `extract`'s own loop still runs, exercising the
/// (empty) iteration path.
#[derive(Default)]
pub struct PresenceClient {
    t: i32,
}

impl ClientSide<Presence> for PresenceClient {
    fn frame(&mut self, _cx: &mut FrameCx<'_, Presence>, presence: &mut PlayerPresence) {
        self.t = self.t.wrapping_add(1);
        presence.pos = [self.t, 0];
        presence.vel = [1, 0];
    }

    fn extract(&self, view: &FrameView<'_, Presence>, out: &mut DrawList) {
        view.presences(&mut |p| {
            out.circle(0, p.pos, [0.5, 0.5], 0xFFFF_FFFF);
        });
    }
}

pub struct Presence;

impl Game for Presence {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = ();
    type Player = Player;
    type Global = ();
    type Presence = PlayerPresence;
    type Ui = ();
    type Client = PresenceClient;

    fn register(_r: &mut Registry) {
        // No entities, no prototypes: this fixture exercises the presence channel and
        // witness-carrying actions only (Non-scope: replicated entities, `puts`'s own job).
    }

    fn prototype(_e: &()) -> PrototypeId {
        unimplemented!("fx-presence never spawns an entity")
    }

    fn anchor(_e: &()) -> TilePos {
        unimplemented!("fx-presence never spawns an entity")
    }

    fn genesis(_w: &mut dyn WorldWrite<Self>) {}

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player::default());
        }
    }

    /// Deterministic, replayable, self-contained (module doc comment): reads only `a`'s own bytes,
    /// never a `PresenceTable` (its signature cannot name one).
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Action) -> Result<(), Reject> {
        let Action::Poke { tile, from } = a;
        let tile_world = engine::world::WorldPos::from_tile(tile.tile());
        if !within(dist_sq(tile_world, from.world()), POKE_RANGE_TILES) {
            return Err(Reject::OutOfRange);
        }
        let mut p = *w.player(who)?;
        p.poke_count = p.poke_count.saturating_add(1);
        p.last_tile = *tile;
        w.put_player(who, p);
        Ok(())
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}

    /// HOST ONLY, never replayed (0001 Decision "Admission"; Consequences: "`admit` runs on the
    /// host only ... it needs its own unit tests").
    fn admit(
        _w: &dyn WorldRead<Self>,
        p: &PresenceTable<Self>,
        who: PlayerId,
        a: &Action,
    ) -> Result<(), Reject> {
        let Action::Poke { from, .. } = a;
        let Some(entry) = p.get(who) else {
            return Err(Reject::NoSample);
        };
        if !within(
            dist_sq(entry.sample.pos(), from.world()),
            ADMIT_TOLERANCE_TILES,
        ) {
            return Err(Reject::TooFar);
        }
        Ok(())
    }
}

/// A trivial deterministic worldgen: every tile is grass, no resource (this fixture's own world
/// contents are never read -- Non-scope, same as `fixtures/puts`'s own `FlatWorldgen`).
pub struct FlatWorldgen;

impl engine::worldgen::Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

engine::export_game!(Presence);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dist_sq_is_symmetric_and_zero_at_the_same_point() {
        let a = WorldPos { x: 100, y: -50 };
        let b = WorldPos { x: -20, y: 30 };
        assert_eq!(dist_sq(a, a), 0);
        assert_eq!(dist_sq(a, b), dist_sq(b, a));
    }

    #[test]
    fn within_is_inclusive_at_the_boundary() {
        // Exactly 2 tiles apart on one axis: inside `POKE_RANGE_TILES` (<=), not beyond it.
        let a = WorldPos { x: 0, y: 0 };
        let b = WorldPos {
            x: (POKE_RANGE_TILES * SUBTILE) as i32,
            y: 0,
        };
        assert!(within(dist_sq(a, b), POKE_RANGE_TILES));
        let c = WorldPos {
            x: (POKE_RANGE_TILES * SUBTILE) as i32 + 1,
            y: 0,
        };
        assert!(!within(dist_sq(a, c), POKE_RANGE_TILES));
    }
}
