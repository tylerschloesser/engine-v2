//! Fixture game `fx-puts` (docs/plan/12-store-and-game-trait.md, docs/plan/
//! 12b-world-access-and-sim-driver.md): the fixture 0003's Consequences names ("the puts cover
//! every replicated scope of 0011"). M12 declared the replicated types only; M12b adjusts them
//! (M12 Deviations: "M12b may adjust; nothing here is a fixed seam beyond 'these types exist and
//! are Codec/TS-compatible'") to match this milestone's own handler set and implements `Game`
//! (`register`/`prototype`/`anchor`/`genesis`/`on_player`/`apply`/`tick`) against real `Sim`/
//! `Authority` machinery.
//!
//! Handlers (docs/plan/12b-world-access-and-sim-driver.md Scope): `Paint` is the chunk-scoped tile
//! put; `Spawn` is the chunk-scoped entity put (anchored at its own position, 0024 §7); `Bump`/
//! `Remove` look an entity up by position through `WorldRead::entity_at`, which this milestone
//! never populates (occupancy tracking is M21, Non-scope) -- so both always reject `NotFound`,
//! deterministically, which is exactly the "includes rejected actions" golden coverage this
//! fixture is for: a real `apply`/reject round trip, with no write recorded (0004 Consequences).
//! `SetNote` is the player-scoped put (`note_until = w.tick() + NOTE_TTL`, cleared by `tick`);
//! `SetMotd` is the global-scoped put; `Roll` is the one handler that reads `SimRng`. `tick` bumps
//! a `Global` counter and paints the next tile of a fixed walk near the origin once per simulated
//! second, independent of any action (M15b needs an overlay that changes on its own).
//!
//! `Instance` is implemented directly (M02 conventions, like `fx-hash`/`fx-terrain`), not through
//! `Game`/`export_game!`: no ABI export exists yet (M13, Non-scope here). `Sim<Puts>` is driven
//! directly by native tests (`tests/*.rs`) instead.

use engine::abi::{Instance, RegionLayout, Role, Status};
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::world::{Footprint, Tile};
use engine::world::{PrototypeId, Registry, TilePos, TraitSet};
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// One action per handler this fixture exercises (docs/plan/12b-world-access-and-sim-driver.md
/// Scope): `Paint`/`Spawn` are chunk-scoped puts, `Bump`/`Remove` exercise the reject path
/// (occupancy is Non-scope, see the module doc comment), `SetNote` is player-scoped, `SetMotd` is
/// global-scoped, `Roll` reads `SimRng`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Action {
    Paint { pos: Pos, base: u8, resource: u8 },
    Spawn { at: Pos, kind: u8 },
    Bump { at: Pos },
    Remove { at: Pos },
    SetNote { n: u32 },
    SetMotd { n: u32 },
    Roll,
}

/// `From<Unknown>` (0003: "add a `?` to each read and `impl From<Unknown> for Reject`").
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`).
    Unknown,
    /// `Bump`/`Remove`: no entity at that position (always, until M21's occupancy index exists).
    NotFound,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Replicated whole-value entity (0003: "plain data, no `Vec`"): anchored at its own `pos`
/// (`Game::anchor`, 0024 §7 -- `prototype`/`anchor` carry no position of their own).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub kind: u8,
    pub amount: u16,
}

/// Private per-player state: a note with an expiry `tick` cleared by `Puts::tick`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub note: u32,
    pub note_until: engine::time::Tick,
}

/// One value for every client (0011 "Scopes"): a day counter `tick` bumps once a simulated
/// second, a message of the day `SetMotd` puts, the last `Roll` result, and the fixed walk's
/// cursor (`tick`'s own bookkeeping -- nothing else can hold it, since only `Store` persists).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub day: u32,
    pub motd: u32,
    pub last_roll: u32,
    pub walk_i: u32,
}

/// A fixed walk of 8 tiles near the origin (module doc comment: "M15b needs an overlay that
/// changes without any action"). Order is arbitrary but fixed forever: changing it changes every
/// golden that runs past one simulated second.
const WALK: [(i32, i32); 8] = [
    (0, 0),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
];

/// How long a `SetNote` note stays before `tick` clears it.
const NOTE_TTL_SECS: u32 = 5;

pub struct Puts;

impl Game for Puts {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        // No trait bits are exercised this milestone (occupancy/traits_at's occupant term is
        // Non-scope); one prototype so `prototype`/`anchor` have a real target.
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Entity) -> TilePos {
        e.pos.tile()
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        // Puts global first (mirrors `on_player(Joined)`'s own put-player-first convention,
        // docs/plan/12-store-and-game-trait.md Planning decisions), overwriting `Sim::genesis`'s
        // `Default` placeholder with the game's real initial value.
        w.put_global(Global::default());
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player::default());
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Paint {
                pos,
                base,
                resource,
            } => {
                w.set_tile(pos.tile(), Tile::new(*base, *resource, 0));
                Ok(())
            }
            Action::Spawn { at, kind } => {
                w.spawn(Entity {
                    pos: *at,
                    kind: *kind,
                    amount: 0,
                });
                Ok(())
            }
            Action::Bump { at } => match w.entity_at(at.tile())? {
                Some(id) => {
                    let mut e = w.entity(id)?.copied().ok_or(Reject::NotFound)?;
                    e.amount = e.amount.saturating_add(1);
                    w.put_entity(id, e);
                    Ok(())
                }
                None => Err(Reject::NotFound),
            },
            Action::Remove { at } => match w.entity_at(at.tile())? {
                Some(id) => {
                    w.despawn(id);
                    Ok(())
                }
                None => Err(Reject::NotFound),
            },
            Action::SetNote { n } => {
                let mut p = *w.player(who)?;
                p.note = *n;
                p.note_until = w.tick() + Puts::TICK_RATE.secs(NOTE_TTL_SECS);
                w.put_player(who, p);
                Ok(())
            }
            Action::SetMotd { n } => {
                let mut g = *w.global();
                g.motd = *n;
                w.put_global(g);
                Ok(())
            }
            Action::Roll => {
                let r = w.rng()?.below(100);
                let mut g = *w.global();
                g.last_roll = r;
                w.put_global(g);
                Ok(())
            }
        }
    }

    fn tick(cx: &mut TickCx<'_, Self>) {
        let secs_1 = Self::TICK_RATE.secs(1).0.max(1);
        if cx.tick().0 % secs_1 == 0 {
            let mut g = *cx.global();
            let (x, y) = WALK[(g.walk_i as usize) % WALK.len()];
            g.day = g.day.wrapping_add(1);
            g.walk_i = g.walk_i.wrapping_add(1);
            cx.set_tile(TilePos::new(x, y), Tile::new(1, 0, g.day as u16));
            cx.put_global(g);
        }

        for i in 0..cx.player_count() {
            let Some(who) = cx.player_id_at(i) else {
                continue;
            };
            let Ok(p) = cx.player(who) else {
                continue;
            };
            if p.note != 0 && cx.tick() >= p.note_until {
                let mut p2 = *p;
                p2.note = 0;
                cx.put_player(who, p2);
            }
        }
    }
}

/// A trivial deterministic worldgen: every tile is grass (base 1), no resource. Nothing this
/// fixture exercises depends on interesting terrain (Non-scope: worldgen itself is M08's).
pub struct FlatWorldgen;

impl engine::worldgen::Worldgen for FlatWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

impl Instance for Puts {
    fn init(_role: Role, _game_cfg_json: &str, _layout: &mut RegionLayout) -> Result<Self, Status> {
        Ok(Puts)
    }
}

engine::export_instance!(Puts);

#[cfg(test)]
mod tests {
    use super::*;
    use engine::time::Ticks;

    #[test]
    fn note_ttl_is_five_seconds() {
        assert_eq!(
            Puts::TICK_RATE.secs(NOTE_TTL_SECS),
            Ticks(Puts::TICK_RATE.hz_value() * NOTE_TTL_SECS)
        );
    }
}
