//! Fixture game `fx-predict` (M25 step 1): a 2x2 `Place`-able machine,
//! `Deposit` (addressed by tile, so a follow-up can name a machine the client has only predicted),
//! a timed `Collect`, `Roll` (draws from `w.rng()`, host-only under prediction), `Cascade`
//! (`predict() == false`), and `SetGlobal` (`w.put_global`). Modelled on
//! the Phase 1 `prediction-api` spike's `RefGame`, renamed to the real engine's own method
//! names (`spawn`/`put_entity`/`despawn`/`entity_at`/`entity`/`tile`/`traits_at`/`player`/
//! `put_player`/`global`/`put_global`/`rng`).
//!
//! `can_place` is shared by `apply` and (a later milestone's) placement ghost, taking only the read
//! half (`&dyn WorldRead<Predict>`, 0003's own "shared rule helpers" example).

use engine::client::{ClientSide, DrawList, FrameView, PREDICTED};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::time::{TickRate, Ticks};
use engine::world::{Footprint, PrototypeId, Registry, TilePos, TraitSet, WorldPos};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    pub fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// The one trait bit this fixture declares, shared by water and the `Machine` prototype (0007 §6:
/// "the same bit query names no tile type").
pub const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
/// A resource-layer bit: whether `Collect` may target a tile.
pub const COLLECTABLE: TraitSet = TraitSet(1 << 1);

pub const WATER_BASE: u8 = 1;
pub const GRASS_BASE: u8 = 0;
pub const RESOURCE_ID: u8 = 1;
/// A machine's own 2x2 footprint (0007 §5): well under any chunk edge, overlapping at most 4
/// chunks anchored on a corner.
pub const MACHINE_FOOTPRINT: Footprint = Footprint { w: 2, h: 2 };
/// How long `Collect` takes (0006: an integer tick count, never a wall-clock duration).
pub const COLLECT_TICKS: Ticks = TickRate::HZ_20.secs(1);
/// Starting inventory (`on_player`), generous enough that the fixture's own tests can place
/// several machines and deposit several times without running out by accident.
pub const START_FURNACES: u16 = 2;
pub const START_COAL: u16 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    /// Spawns a `Machine` anchored at `origin` (its footprint is the registered 2x2).
    Place { origin: Pos },
    /// Like [`Action::Place`], but writes the spent inventory *before* drawing from the sim RNG
    /// (an audit roll the host discards): declines under prediction through `rng()` rather than
    /// through the placement read, and only after already writing (M25 Tests added: `taint_rollback_visibility`, "A failing through rng()
    /// after a read" -- proving the overlay rollback undoes a write, not just a read that never
    /// happened).
    PlaceChecked { origin: Pos },
    /// Addressed by tile, not by `EntityId` (0022 §6): a follow-up naming a machine the client has
    /// only predicted must still mean the same thing once the host resolves it.
    Deposit { at: Pos, count: u16 },
    /// Starts a timed collection at `tile` (must carry [`COLLECTABLE`]); resolved by
    /// [`Predict::tick`].
    Collect { tile: Pos },
    /// Draws from the sim RNG (host only under prediction, 0003: "`Unknown` under prediction").
    Roll,
    /// Opts out of prediction entirely (`Predict::predict` returns `false` for this variant):
    /// bumps `Global.value` for real on the host, never predicted on the client.
    Cascade,
    /// `w.put_global` (0003): the one action that writes the global scope directly.
    SetGlobal { value: i32 },
    /// `w.set_tile` (M26 step 3: the texel tests need
    /// a predicted tile write, which nothing above provides). Declines like `Place` if `tile` is
    /// already occupied by a machine (the same conflict shape, so a rival's `Place` landing before
    /// this action's own reject ack reproduces 0012's "conflicting delta arrives before the reject
    /// ack" case for a *tile*, not an entity).
    Paint { tile: Pos, base: u8 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`) -- never reachable on the host, only meaningful
    /// for a predicting client (M25).
    Unknown,
    /// `Place`/`Deposit`/`Collect`: some tile the action would touch carries [`NOT_BUILDABLE`], or
    /// (`Collect`) lacks [`COLLECTABLE`].
    NotBuildable,
    NoResource,
    /// `Place`: no furnace left to place. `Deposit`: not enough coal to deposit.
    NoItem,
    /// `Deposit`: no machine at that tile.
    NoFurnace,
    /// `Collect`: already collecting.
    Busy,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Replicated whole-value entity (0003: "plain data, no `Vec`"): two kinds share this one type
/// (0022 §3), selected by nothing here yet (this fixture has only the smelter kind).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Machine {
    pub origin: Pos,
    pub coal: u16,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Collecting {
    pub tile: Pos,
    /// The tick this collection was started at -- under prediction, `Predicting::tick()`'s own
    /// frozen value (0012 "Frozen predicted tick"), so replays never rewrite it.
    pub started_at: u32,
    pub done_at: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub furnaces: u16,
    pub coal: u16,
    pub collecting: Option<Collecting>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub value: i32,
}

/// Shared by `apply` and a later milestone's placement ghost (0003's own "shared rule helpers"
/// example): takes only the read half, names neither water nor another machine (0007 §6: "the same
/// bit query names no tile type" -- both carry [`NOT_BUILDABLE`]).
pub fn can_place(w: &dyn WorldRead<Predict>, origin: Pos) -> Result<(), Reject> {
    let t = origin.tile();
    for dy in 0..MACHINE_FOOTPRINT.h as i32 {
        for dx in 0..MACHINE_FOOTPRINT.w as i32 {
            let p = TilePos::new(t.x + dx, t.y + dy);
            if w.traits_at(p)?.contains(NOT_BUILDABLE) {
                return Err(Reject::NotBuildable);
            }
        }
    }
    Ok(())
}

/// What the DOM overlay observes (M26 step 1: fixture
/// `ClientSide` `ui`): the local player's own inventory, read through `FrameView::predicted_player`
/// (overlay-then-replica) so it reads the exact same value before and after an ack that changes
/// nothing visible (M25's own "converges with no visible change" property, now also true of the
/// `Ui` a game observes, not just `Loopback::visible`) -- `swap_is_one_render`'s own "Ui inventory
/// is constant" assertion is what this exists to make true.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Ui {
    pub furnaces: u16,
    pub coal: u16,
}

/// `ClientSide<Predict>` (M26 step 1): one `rect` per
/// visible `Machine`, at its anchor tile, `PREDICTED` set from `view.is_predicted(id)` (Planning
/// decisions "`predicted` flag": "`extract` asks `view.is_predicted(id)` ... and sets `PREDICTED`"
/// -- true for a provisional id or a real id the overlay currently overrides, so the flag reads
/// `1` from the moment `Place`/`PlaceChecked` predicts a spawn until the ack pops it, then `0`
/// forever after, with no other transition: `swap_is_one_render`/`reject_is_one_render`'s own
/// pinned property).
#[derive(Default)]
pub struct PredictClient;

const MACHINE_LAYER: u8 = 0;
const MACHINE_COLOR: u32 = 0xB0_60_20_FF;

impl ClientSide<Predict> for PredictClient {
    fn extract(&self, view: &FrameView<'_, Predict>, out: &mut DrawList) {
        for (id, _e, origin) in view.entities() {
            let pos = WorldPos::from_tile(origin);
            let size = [MACHINE_FOOTPRINT.w as f32, MACHINE_FOOTPRINT.h as f32];
            let draw = out.rect(MACHINE_LAYER, pos, size, MACHINE_COLOR);
            if view.is_predicted(id) {
                draw.flags |= PREDICTED;
            }
        }
    }

    fn ui(&self, view: &FrameView<'_, Predict>, out: &mut Ui) {
        if let Ok(p) = view.predicted_player(view.me()) {
            out.furnaces = p.furnaces;
            out.coal = p.coal;
        }
    }
}

pub struct Predict;

impl Game for Predict {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = PredictWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Machine;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = Ui;
    type Client = PredictClient;

    fn register(r: &mut Registry) {
        r.set_base_traits(WATER_BASE, NOT_BUILDABLE);
        r.set_resource_traits(RESOURCE_ID, COLLECTABLE);
        let id = r.add_prototype(NOT_BUILDABLE, MACHINE_FOOTPRINT);
        debug_assert_eq!(id, PrototypeId(0));
    }

    fn prototype(_e: &Machine) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Machine) -> TilePos {
        e.origin.tile()
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(
                who,
                Player {
                    furnaces: START_FURNACES,
                    coal: START_COAL,
                    collecting: None,
                },
            );
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Action) -> Result<(), Reject> {
        match *a {
            Action::Place { origin } => {
                let mut p = *w.player(who)?;
                if p.furnaces == 0 {
                    return Err(Reject::NoItem);
                }
                let r: &dyn WorldRead<Predict> = w;
                can_place(r, origin)?;
                p.furnaces -= 1;
                w.put_player(who, p);
                w.spawn(Machine { origin, coal: 0 });
                Ok(())
            }
            Action::PlaceChecked { origin } => {
                let mut p = *w.player(who)?;
                if p.furnaces == 0 {
                    return Err(Reject::NoItem);
                }
                let r: &dyn WorldRead<Predict> = w;
                can_place(r, origin)?;
                p.furnaces -= 1;
                w.put_player(who, p); // written before the decline below (validate first is
                // still honoured: every read that could reject already ran)
                let rng = w.rng()?; // Unknown under prediction; a real draw on the host
                let _ = rng.below(6);
                w.spawn(Machine { origin, coal: 0 });
                Ok(())
            }
            Action::Deposit { at, count } => {
                let mut p = *w.player(who)?;
                let id = w.entity_at(at.tile())?.ok_or(Reject::NoFurnace)?;
                let mut m = *w.entity(id)?.ok_or(Reject::NoFurnace)?;
                if p.coal < count {
                    return Err(Reject::NoItem);
                }
                m.coal += count;
                p.coal -= count;
                w.put_player(who, p);
                w.put_entity(id, m);
                Ok(())
            }
            Action::Collect { tile } => {
                let mut p = *w.player(who)?;
                if p.collecting.is_some() {
                    return Err(Reject::Busy);
                }
                if !w.traits_at(tile.tile())?.contains(COLLECTABLE) {
                    return Err(Reject::NoResource);
                }
                let now = w.tick();
                p.collecting = Some(Collecting {
                    tile,
                    started_at: now.0,
                    done_at: (now + COLLECT_TICKS).0,
                });
                w.put_player(who, p);
                Ok(())
            }
            Action::Roll => {
                let r = w.rng()?;
                let _ = r.below(6);
                Ok(())
            }
            Action::Cascade => {
                let mut g = *w.global();
                g.value += 1;
                w.put_global(g);
                Ok(())
            }
            Action::SetGlobal { value } => {
                let mut g = *w.global();
                g.value = value;
                w.put_global(g);
                Ok(())
            }
            Action::Paint { tile, base } => {
                let t = tile.tile();
                if w.entity_at(t)?.is_some() {
                    return Err(Reject::NotBuildable);
                }
                let cur = w.tile(t)?;
                w.set_tile(t, cur.with_base(base));
                Ok(())
            }
        }
    }

    /// `Cascade` cascades (its own effect is unbounded from a predicting client's point of view,
    /// 0012 "per-action opt-out for actions that cascade"): never predicted, always sent, resolved
    /// only by the host.
    fn predict(a: &Action) -> bool {
        !matches!(a, Action::Cascade)
    }

    /// HOST ONLY. Resolves a due `Collect`: rewards one unit of coal, clears `collecting`. No wake
    /// queue here (this fixture's own player table is "tens of rows", `fx-machines`'s own
    /// reasoning for `TickCx::player_id_at`) -- a plain scan, not the timer wheel.
    fn tick(cx: &mut TickCx<'_, Self>) {
        let now = cx.tick().0;
        for i in 0..cx.player_count() {
            let Some(who) = cx.player_id_at(i) else {
                continue;
            };
            let Ok(mut p) = cx.player(who).copied() else {
                continue;
            };
            let Some(c) = p.collecting else { continue };
            if c.done_at > now {
                continue;
            }
            p.collecting = None;
            p.coal += 1;
            cx.put_player(who, p);
        }
    }

    /// HOST ONLY, never replayed (0004): unused here (every rejection this fixture needs is a real
    /// `apply`-time read).
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

/// A sparse, deterministic worldgen (module doc comment; matches the spike's own `RefGame::
/// pristine`): water for `x <= -3`, a `COLLECTABLE` patch at `8..12 x 8..12`, grass elsewhere.
pub struct PredictWorldgen;

const EDGE: i32 = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for PredictWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(
        _seed: u64,
        _params: &(),
        chunk: engine::world::ChunkCoord,
        out: &mut [engine::world::Tile],
    ) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        let bx = chunk.x.wrapping_mul(EDGE);
        let by = chunk.y.wrapping_mul(EDGE);
        for ty in 0..EDGE {
            let wy = by.wrapping_add(ty);
            for tx in 0..EDGE {
                let wx = bx.wrapping_add(tx);
                let tile = if wx <= -3 {
                    engine::world::Tile::new(WATER_BASE, 0, 0)
                } else if (8..12).contains(&wx) && (8..12).contains(&wy) {
                    engine::world::Tile::new(GRASS_BASE, RESOURCE_ID, 3)
                } else {
                    engine::world::Tile::new(GRASS_BASE, 0, 0)
                };
                out[(ty * EDGE + tx) as usize] = tile;
            }
        }
    }
}

engine::export_game!(Predict);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn water_and_resource_carry_the_expected_bits() {
        let mut r = Registry::new();
        Predict::register(&mut r);
        assert!(
            r.tile_traits(engine::world::Tile::new(WATER_BASE, 0, 0))
                .contains(NOT_BUILDABLE)
        );
        assert!(
            r.tile_traits(engine::world::Tile::new(GRASS_BASE, RESOURCE_ID, 3))
                .contains(COLLECTABLE)
        );
        assert!(r.prototype_traits(PrototypeId(0)).contains(NOT_BUILDABLE));
        assert_eq!(r.footprint(PrototypeId(0)), MACHINE_FOOTPRINT);
    }
}
