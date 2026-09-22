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
//! `export_game!(Puts)` (M13, docs/plan/13-sim-host-tick-loop.md) re-points at
//! `engine::game_instance::GameInstance<Puts>`, the engine's generic `Instance` dispatcher: the
//! `.wasm` this fixture builds now has a real sim role (`sim_genesis`/`sim_tick`/`sim_hash`, driving
//! the same `Sim<Puts>` native tests already drove directly through `tests/*.rs`), so
//! `puts_idle_100`'s golden becomes `.wasm`-authoritative (0002) instead of native-blessed.

use engine::client::{ClientSide, TileTexel};
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::world::{Footprint, Tile};
use engine::world::{PrototypeId, Registry, TilePos, TraitSet};
use ts_rs::TS;

/// docs/plan/15b-ring-connection-and-replica-rendering.md, Provides: "the visible overlay comes
/// from the puts tick rule's once-per-second `set_tile`" -- a pixel-readback test needs the tick
/// rule's own tile to render *differently* from a pristine one, but `tick`'s `set_tile` only ever
/// changes `aux` (`Tile::new(1, 0, g.day as u16)`, above), never `base`/`resource`, and the default
/// `ClientSide<G> for ()` (`type Client = ();`, unused now) reads only `base`/`resource`
/// (`TileTexel::from_tables`) -- so through the default impl a painted tile is pixel-identical to
/// pristine terrain, and no browser test could ever tell them apart by reading pixels back. This
/// is purely a client-side rendering hook (0018 §2): it never touches `Sim`/`Authority`/`apply`/
/// `tick`, so it cannot change `sim_hash()` or any golden -- "do not change the fixture's rules"
/// (this milestone's brief) is about the sim-role handlers above, not this. Reuses `tests/browser/
/// pages/public/terrain/tiles.json`'s existing visual id `2` (a `TileTexel::from_tables` `()`
/// impl never reaches, since resource id `0` -- "no resource layer" -- is what a pristine tile's
/// `Tile::new(1, 0, 0)` already resolves to under the identity table `Puts::register` leaves in
/// place): painted (`aux != 0`) swaps the resource layer to that id; pristine keeps the table
/// lookup (resource `0`, "no resource", 0018 §2's own convention) untouched.
#[derive(Default)]
pub struct PutsClient;

/// `tests/browser/pages/public/terrain/tiles.json`'s own visual id 2 (declared, distinct from
/// every id a pristine `fx-puts` tile ever resolves to): the one number this file and that JSON
/// must agree on. Not read from the JSON itself (this crate has no JSON parsing and never loads
/// the asset -- only the *browser page* does, at a completely different layer, 0018 §1's "rendering
/// never touches a WASM instance").
const OVERLAY_VISUAL_ID: u16 = 2;

impl ClientSide<Puts> for PutsClient {
    fn tile_visual(t: Tile) -> TileTexel {
        let mut texel = TileTexel::from_tables(t);
        if t.aux() != 0 {
            texel.resource = OVERLAY_VISUAL_ID;
        }
        texel
    }
}

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`). `#[ts(export)]` (docs/plan/16-action-round-trip.md step 4): named
/// by `Action`'s own two struct-variant fields, so it needs its own generated file too -- ts-rs
/// inlines/imports a referenced type by name but only ever *writes* one for a type that opts in.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
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
/// global-scoped, `Roll` reads `SimRng`. `#[ts(export)]` (docs/plan/16-action-round-trip.md step
/// 4, 0017 §5's bindings step): without it ts-rs's derive macro emits no `export_bindings_action`
/// test at all, so `cargo test export_bindings` would silently write nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
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
/// `#[ts(export)]`: see `Action`'s own doc comment.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
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
    type Client = PutsClient;

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

engine::export_game!(Puts);

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

    /// docs/plan/16-action-round-trip.md step 4 (0017 §5's bindings step): `EngineReject` is
    /// defined in `engine`, not here, so ts-rs's own derive-generated `export_bindings_*` test for
    /// it lives in `engine`'s own test binary -- never run by `cargo test export_bindings` scoped
    /// to this crate (0017 §5's exact command, no `-p`/`--workspace`). This hand-written test makes
    /// the same call that generated test would have made, so `client.onActionResult`'s `Engine`
    /// half is typed here too (`sim::EngineReject`'s own doc comment has the detail).
    #[test]
    fn export_bindings_enginereject() {
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
