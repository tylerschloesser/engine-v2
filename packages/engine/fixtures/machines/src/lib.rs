//! Fixture game `fx-machines` (docs/plan/21-entities-and-timers.md, docs/plan/
//! 21b-timers-wakeups-and-tickcx.md): a 2x2 multi-tile entity that exercises footprint occupancy,
//! footprint-scoped delta/snapshot delivery, the state-budget check and (M21b) the timer wheel,
//! wake queue and an active-list "Spinner" end to end.
//!
//! Handlers: `Place { origin }` spawns a `Machine` anchored at `origin` (its footprint is the
//! prototype's 2x2, 0024 §7) after asking the tiles it would cover for `NOT_BUILDABLE` (0007 §6:
//! "the same bit query names no tile type" -- water and another machine share the bit, so this
//! handler names neither). `Feed { at }`/`Remove { at }` look an entity up by position through the
//! now-real `WorldRead::entity_at` (M21); `Move { at, to }` relocates one, checked the same way
//! `Place` is.
//!
//! `growth`: `Place` declares `Growth::entities(1)`; every other handler declares `Growth::NONE`
//! (none of them ever adds an entity or a modified tile -- `Move`/`Feed` overwrite an existing
//! entity's whole value, `Remove` only removes).
//!
//! **Tick rule (M21b)**: `Feed` sets `fed = true` and (through `Authority`'s auto-wake, being an
//! apply-time put) queues the entity for the same tick's `next_woken()` -- the "put itself is the
//! wake-up" pattern (docs/plan/21b-timers-wakeups-and-tickcx.md Planning decisions), since `apply`
//! has no `wake_at` of its own to call. Woken + fed + idle (`done_at == 0`, i.e. not already
//! smelting) schedules `done_at = now + SMELT` via `wake_at`; due pops from the timer wheel,
//! `count += 1`, then sleeps (`fed = false`, `done_at = 0`) until fed again -- one smelt cycle per
//! `Feed`. A second, non-smelting kind of `Machine` (`is_spinner: true`, spawned once at genesis)
//! never touches the timer wheel at all: its first `next_woken()` visit puts it on the `SPINNER`
//! active list, and every following tick the rule scans that list and toggles `lit` once its own
//! per-tick accumulator reaches `SPIN_PERIOD` ticks -- the integer-accumulator pattern of 0006
//! ("Rates and continuous quantities"), demonstrating the "always active, never sleeps" half of
//! 0007 §7 alongside the smelter's "sleep until woken" half.

use engine::game::{
    Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::time::{Tick, TickRate, Ticks};
use engine::world::{
    ChunkCoord, Footprint, PrototypeId, Registry, SystemId, Tile, TilePos, TraitSet,
};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// 0006: "a furnace computes its finish tick and sleeps" (0007 §7). At the default 20 Hz, 100
/// ticks.
pub const SMELT: Ticks = TickRate::HZ_20.secs(5);

/// The `Spinner`'s own toggle period (0006 "Rates and continuous quantities": the integer-
/// accumulator pattern). At the default 20 Hz, 10 ticks.
pub const SPIN_PERIOD: Ticks = TickRate::HZ_20.millis(500);

/// The active-list system the Spinner registers with (docs/plan/21b-timers-wakeups-and-tickcx.md
/// Scope: "a `Spinner` prototype lives on an active list"), set once by `Machines::register`
/// (`Store::new`, before any tick runs) and read by `Machines::tick`. `Registry::system` always
/// hands out the same sequential id (`0`, the only system this fixture ever registers) for any
/// `Registry` it is called on, so `OnceLock` -- set at most once per process, read many -- holds the
/// one value every `Store<Machines>` in this process agrees on, with no `unsafe`.
static SPINNER_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();

fn spinner_sys() -> SystemId {
    *SPINNER_SYS
        .get()
        .expect("Machines::register must run before Machines::tick")
}

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`). `#[ts(export)]`: `Action`'s own two struct-variant fields need a
/// generated file too (ts-rs writes one only for an opted-in type it is referenced from).
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

/// `NOT_BUILDABLE` (0007 §6): the one trait bit this fixture declares, shared by water (base id
/// [`WATER_BASE`]) and the `Machine` prototype -- `Place`/`Move` ask `traits_at` for it, naming
/// neither source.
pub const NOT_BUILDABLE: TraitSet = TraitSet(1 << 0);
/// The worldgen's water base tile id.
pub const WATER_BASE: u8 = 1;
/// The worldgen's grass (buildable) base tile id.
pub const GRASS_BASE: u8 = 0;
/// The `Machine` prototype's footprint (2x2, 0007 §5): both axes well under any of 0007 §3's
/// chunk edges, so it overlaps at most 4 chunks when anchored on a corner.
pub const MACHINE_FOOTPRINT: Footprint = Footprint { w: 2, h: 2 };

/// One action per handler this fixture exercises.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Place {
        origin: Pos,
    },
    Feed {
        at: Pos,
    },
    Move {
        at: Pos,
        to: Pos,
    },
    Remove {
        at: Pos,
    },
    /// M21b: spawns a `Spinner` (`Machine.is_spinner = true`) at `origin`, checked the same way
    /// `Place` is. Appended last, not inserted among the M21 variants, so every pre-existing
    /// encoded `Action` value (goldens included) keeps its own postcard variant index.
    PlaceSpinner {
        origin: Pos,
    },
}

/// `From<Unknown>` (0003: "add a `?` to each read and `impl From<Unknown> for Reject`").
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`): the target chunk is not held (never reachable
    /// on the host, only meaningful for a predicting client, M25).
    Unknown,
    /// `Feed`/`Move`/`Remove`: no entity at that position.
    NotFound,
    /// `Place`/`Move`: some tile the new footprint would cover carries `NOT_BUILDABLE` (water or
    /// another machine).
    Blocked,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Replicated whole-value entity (0003: "plain data, no `Vec`"), anchored at its own `origin`
/// (`Game::anchor`, 0024 §7). Two kinds share this one type (0022 §3: "`G::Entity` is a single
/// type"): an ordinary smelter (`fed`/`done_at`/`count`, the timer wheel) and a `Spinner`
/// (`is_spinner`/`lit`/`spin_acc`, an active list) -- `is_spinner` selects which fields the tick
/// rule (`Machines::tick`) reads.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Machine {
    pub origin: Pos,
    /// Set by `Feed`; cleared once its smelt cycle completes (`Machines::tick`'s "due" handler).
    pub fed: bool,
    /// The tick this machine's current smelt cycle finishes, or `0` if idle (not currently
    /// smelting) -- `0` doubles as "idle" because a real `wake_at` never targets tick 0 (genesis
    /// runs at tick 0, before any timer can be scheduled).
    pub done_at: u32,
    pub count: u32,
    /// `true` for a `Spinner` (spawned by `Action::PlaceSpinner`): never smelts, lives on the
    /// active list instead of the timer wheel.
    pub is_spinner: bool,
    /// The Spinner's own toggled field.
    pub lit: bool,
    /// The Spinner's per-tick integer accumulator (0006 "Rates and continuous quantities").
    pub spin_acc: u32,
}

/// No per-player state this fixture needs yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

/// No global state this fixture needs yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global;

/// The 4 tiles a [`MACHINE_FOOTPRINT`] anchored at `origin` covers.
fn covers(origin: Pos) -> [TilePos; 4] {
    let t = origin.tile();
    [
        TilePos::new(t.x, t.y),
        TilePos::new(t.x + 1, t.y),
        TilePos::new(t.x, t.y + 1),
        TilePos::new(t.x + 1, t.y + 1),
    ]
}

/// "Ask the tiles" (0007 §6): `true` if any tile the footprint at `origin` would cover carries
/// `NOT_BUILDABLE` -- whether from the tile itself (water) or an occupant (another machine),
/// `traits_at`'s own union answers with one query naming neither.
fn blocked(w: &dyn WorldRead<Machines>, origin: Pos) -> Result<bool, Unknown> {
    for p in covers(origin) {
        if w.traits_at(p)?.contains(NOT_BUILDABLE) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub struct Machines;

impl Game for Machines {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = MachinesWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Machine;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(r: &mut Registry) {
        r.set_base_traits(WATER_BASE, NOT_BUILDABLE);
        // The only prototype: `Machine`'s own 2x2, sharing the water bit (module doc comment).
        let id = r.add_prototype(NOT_BUILDABLE, MACHINE_FOOTPRINT);
        debug_assert_eq!(id, PrototypeId(0));
        // M21b: the Spinner's own active-list system (`spinner_sys`, module doc comment). `set`
        // is a no-op after the first `Store::new` in this process -- `Registry::system` always
        // hands out the same sequential id, so every later call would only try to store the exact
        // same value again.
        let _ = SPINNER_SYS.set(r.system("spinner"));
    }

    fn prototype(_e: &Machine) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Machine) -> TilePos {
        e.origin.tile()
    }

    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global);
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Place { origin } => {
                let r: &dyn WorldRead<Machines> = w;
                if blocked(r, *origin)? {
                    return Err(Reject::Blocked);
                }
                w.spawn(Machine {
                    origin: *origin,
                    ..Default::default()
                });
                Ok(())
            }
            Action::PlaceSpinner { origin } => {
                let r: &dyn WorldRead<Machines> = w;
                if blocked(r, *origin)? {
                    return Err(Reject::Blocked);
                }
                w.spawn(Machine {
                    origin: *origin,
                    is_spinner: true,
                    ..Default::default()
                });
                Ok(())
            }
            Action::Feed { at } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                let mut m = w.entity(id)?.copied().ok_or(Reject::NotFound)?;
                m.fed = true;
                w.put_entity(id, m);
                Ok(())
            }
            Action::Move { at, to } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                let mut m = w.entity(id)?.copied().ok_or(Reject::NotFound)?;
                let r: &dyn WorldRead<Machines> = w;
                if blocked(r, *to)? {
                    return Err(Reject::Blocked);
                }
                m.origin = *to;
                w.put_entity(id, m);
                Ok(())
            }
            Action::Remove { at } => {
                let id = w.entity_at(at.tile())?.ok_or(Reject::NotFound)?;
                w.despawn(id);
                Ok(())
            }
        }
    }

    /// M21b tick rule (module doc comment): `next_woken` starts a smelt cycle for a freshly fed,
    /// idle machine or puts a freshly placed Spinner on its active list; `next_due` finishes a
    /// smelt cycle (`count += 1`, then sleep until fed again); the Spinner active list toggles
    /// `lit` on its own per-tick accumulator.
    fn tick(cx: &mut TickCx<'_, Self>) {
        while let Some(id) = cx.next_woken() {
            let Some(m) = cx.entity(id).ok().flatten().copied() else {
                continue; // despawned before this tick got to it.
            };
            if m.is_spinner {
                cx.activate(spinner_sys(), id);
                continue;
            }
            if m.fed && m.done_at == 0 {
                let mut m = m;
                m.done_at = (cx.tick() + SMELT).0;
                cx.wake_at(id, Tick(m.done_at));
                cx.put_entity(id, m);
            }
        }

        while let Some(id) = cx.next_due() {
            let Some(mut m) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            m.count += 1;
            // Sleep until fed again (module doc comment: "one smelt cycle per `Feed`").
            m.fed = false;
            m.done_at = 0;
            cx.put_entity(id, m);
        }

        let sys = spinner_sys();
        for i in 0..cx.active_len(sys) {
            let Some(id) = cx.active_at(sys, i) else {
                continue; // a tombstoned slot, not yet compacted (0007 §7).
            };
            let Some(mut m) = cx.entity(id).ok().flatten().copied() else {
                continue;
            };
            m.spin_acc += 1;
            if m.spin_acc >= SPIN_PERIOD.0 {
                m.spin_acc -= SPIN_PERIOD.0;
                m.lit = !m.lit;
            }
            cx.put_entity(id, m);
        }
    }

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Place { .. } | Action::PlaceSpinner { .. } => Some(Growth::entities(1)),
            Action::Feed { .. } | Action::Move { .. } | Action::Remove { .. } => Some(Growth::NONE),
        }
    }

    /// HOST ONLY, never replayed (0004 Pipeline step 2): unused here (every rejection this
    /// fixture needs is a real `apply`-time read, `admit`'s default `Ok` is unchanged).
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }
}

/// A sparse, deterministic water grid (0007 §6's own bit, not a realistic biome -- Non-scope:
/// worldgen itself is M08's): every 8th tile on both axes is water, everything else grass. Dense
/// enough that a fixed scenario can reliably place a machine near or away from one; sparse enough
/// that most footprints never touch it by accident.
pub struct MachinesWorldgen;

const EDGE: i32 = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for MachinesWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, _params: &(), chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        let bx = chunk.x.wrapping_mul(EDGE);
        let by = chunk.y.wrapping_mul(EDGE);
        for ty in 0..EDGE {
            let wy = by.wrapping_add(ty);
            for tx in 0..EDGE {
                let wx = bx.wrapping_add(tx);
                let water = wx.rem_euclid(8) == 0 && wy.rem_euclid(8) == 0;
                out[(ty * EDGE + tx) as usize] =
                    Tile::new(if water { WATER_BASE } else { GRASS_BASE }, 0, 0);
            }
        }
    }
}

engine::export_game!(Machines);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn water_is_not_buildable() {
        let mut r = Registry::new();
        Machines::register(&mut r);
        assert!(
            r.tile_traits(Tile::new(WATER_BASE, 0, 0))
                .contains(NOT_BUILDABLE)
        );
        assert!(
            !r.tile_traits(Tile::new(GRASS_BASE, 0, 0))
                .contains(NOT_BUILDABLE)
        );
        assert!(r.prototype_traits(PrototypeId(0)).contains(NOT_BUILDABLE));
        assert_eq!(r.footprint(PrototypeId(0)), MACHINE_FOOTPRINT);
    }

    #[test]
    fn covers_is_the_2x2_block() {
        let got = covers(Pos { x: 5, y: 5 });
        assert_eq!(
            got,
            [
                TilePos::new(5, 5),
                TilePos::new(6, 5),
                TilePos::new(5, 6),
                TilePos::new(6, 6),
            ]
        );
    }
}
