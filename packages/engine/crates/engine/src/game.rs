//! `Game` and its companions (docs/decisions/0003-game-facing-api.md Decision, associated items
//! verbatim; `anchor` is 0024 §7's addition). Declared whole now, shells included, because
//! associated type defaults are unstable: a later milestone adding e.g. `type Ui` would break
//! every fixture's `impl Game` header (docs/plan/12-store-and-game-trait.md Planning decisions
//! "Shell types now, not later"). Behaviour lives elsewhere: `WorldRead`/`WorldWrite` are filled
//! in by M12b (their methods, and `Authority`/`Predicting`/`View`, are out of scope here); so is
//! `OldStore`'s fields, named on its own shell below. `FrameView`'s fields are real (M16b, grown by
//! M17), and `DrawList`'s are real as of M17 (0018 §2): `crate::client::drawlist`/`crate::client::
//! frame_view` re-export here, the same way `TickCx`'s `authority.rs` does. `Presence`/
//! `PresenceTable` are real as of M19 steps 1-3 (docs/plan/19-presence-channel.md):
//! `crate::presence` re-exports here for the same reason.

use ts_rs::TS;

use crate::client::ClientSide;
use crate::codec::Codec;
use crate::time::TickRate;
use crate::world::{PrototypeId, Registry, TilePos};
use crate::worldgen::Worldgen;

/// A read hit state this replica does not hold (0003). `?` turns it into the game's `Reject` via
/// `From`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Unknown;

/// A player id, assigned at first join (0013's token mapping; 0003: "a small integer"). `0` is
/// never assigned ("none"), mirroring `EntityId`'s convention (docs/plan/12-store-and-game-trait.md
/// Scope).
#[derive(
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
pub struct PlayerId(pub u32);

/// An entity id (docs/decisions/0022-entity-ids-and-provisional-ids.md §1): allocated only by the
/// host, starting at 1, monotonic, never reused; `0` is never allocated ("none"); bit 31 is never
/// set on a real id (reserved for a client-local provisional id -- the constructor and the
/// `Deserialize` guard that rejects one on the wire are M25's, 0022 §5).
#[derive(
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
pub struct EntityId(pub u32);

impl EntityId {
    /// Reserved for a client-local provisional id (0022 §5); never set on a real, host-allocated
    /// id.
    pub const PROVISIONAL_BIT: u32 = 1 << 31;

    #[inline]
    pub const fn is_provisional(self) -> bool {
        self.0 & Self::PROVISIONAL_BIT != 0
    }
}

/// An engine-defined connection event (0003), logged and replayed like any other `Game::on_player`
/// input.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlayerEvent {
    Joined,
    Connected,
    Disconnected,
}

/// Real now (docs/plan/19-presence-channel.md steps 1-3, 0001 "Presence is an engine channel",
/// 0024 §6): re-exported here (built by `crate::presence`) for the same reason `TickCx`/`FrameCx`/
/// `FrameView`/`DrawList` are -- `Game`'s own `type Presence: Presence` names it at this path.
pub use crate::presence::Presence;

/// The write context `Game::tick` receives (0003: "`TickCx` is a `WorldWrite` plus iteration over
/// active entities", 0007 §7), built and filled in by M12b (`crate::authority::TickCx`, minimal:
/// player iteration only; M21b adds wake/timer/active-list methods). HOST ONLY. Re-exported here
/// because `Game::tick`'s own signature names it at this path.
pub use crate::authority::TickCx;

/// Real now (docs/plan/18-picking-and-overlay.md steps 4-6, 0019): the per-client-frame context
/// `ClientSide::frame` receives (the camera block, the spring, input events; `cx.follow(..)`).
/// Re-exported here (built by `crate::client::frame_cx`) for the same reason `FrameView`/`DrawList`
/// are, below.
pub use crate::client::frame_cx::FrameCx;

/// Real now, minimal (M16b: `world`/`clocks`/`me`; M17 adds the visible rect, zoom, cursor tile;
/// docs/plan/19-presence-channel.md steps 4-6 add `own_presence()`/`presences()`, 0018/0019, 0003:
/// "`FrameView`: `WorldRead` + clocks + presences"): built by `crate::client::frame_view`,
/// re-exported here because `ClientSide::extract`/`ui`'s own signatures name it at this path (same
/// pattern as `WorldRead`/`WorldWrite`/`TickCx` below). `RemotePresence` is `FrameView::
/// presences()`'s own per-call argument type, re-exported for the same reason.
pub use crate::client::frame_view::{Clocks, FrameView, RemotePresence};

/// Real now (M17, 0018 §2): the per-frame draw list `ClientSide::extract` fills. Re-exported here
/// (built by `crate::client::drawlist`) for the same reason `FrameView`/`Clocks` are, above.
pub use crate::client::drawlist::DrawList;

/// Real now (docs/plan/19-presence-channel.md steps 1-3): re-exported here (built by
/// `crate::presence`) for the same reason as [`Presence`] above -- `Game::admit`'s own signature
/// names it at this path.
pub use crate::presence::{PresenceEntry, PresenceTable};

/// Shell (M24b gives it fields, 0005): the old-schema store `Game::migrate` reads from.
pub struct OldStore {
    _private: (),
}

/// A `Game::migrate` failure: the old schema cannot be brought forward (0005).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SaveIncompatible;

/// Every world read, object-safe so a handler compiles once against `&dyn WorldRead<G>` (0003:
/// "`dyn` is deliberate ... relies on trait-object upcasting"). Built by M12b
/// (`crate::world_access`); re-exported here because `Game`'s own method signatures name it at
/// this path.
pub use crate::world_access::WorldRead;

/// Every world write, one `Delta` per put (0011). Built by M12b (`crate::world_access`);
/// re-exported here for the same reason as [`WorldRead`].
pub use crate::world_access::WorldWrite;

/// A worst-case declaration of what one action's `apply` may *add* to the two deterministic state
/// counts of 0007 §8 (docs/decisions/0023-action-growth-declaration.md Decision, verbatim): read
/// by the host's state-budget check (`crate::host::budget`), before `apply` runs, so a shrinking
/// action (e.g. removing a building) is never refused just because the world happens to be full.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Growth {
    pub entities: u16,
    pub modified_tiles: u16,
}

impl Growth {
    pub const NONE: Growth = Growth {
        entities: 0,
        modified_tiles: 0,
    };

    pub const fn entities(n: u16) -> Growth {
        Growth {
            entities: n,
            modified_tiles: 0,
        }
    }

    pub const fn tiles(n: u16) -> Growth {
        Growth {
            entities: 0,
            modified_tiles: n,
        }
    }
}

/// The game-facing API (0003 Decision). A game author implements this once; the engine derives
/// deltas, hashing, snapshots and replay from it (0011, 0005).
pub trait Game: Sized + 'static {
    /// Bumped when a replicated type's layout changes (0005).
    const SCHEMA_VERSION: u32;
    const TICK_RATE: TickRate = TickRate::HZ_20;
    /// 4, 5 or 6: chunk edge 16, 32 or 64 tiles (0007).
    const CHUNK_BITS: u32 = 5;
    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6 (0005 "Sim identity"): the game
    /// crate's own version, embedded in `Identity.game_version`. Defaulted so every existing `Game`
    /// impl keeps compiling; a real game overrides it with `env!("CARGO_PKG_VERSION")` written in
    /// its *own* crate root (macro hygiene: `env!` expanding inside `export_game!` would read the
    /// invoking game crate's manifest, not the engine's, but this default -- evaluated here, in the
    /// engine crate, if a game never overrides it -- cannot do that itself).
    const GAME_VERSION: &'static str = "0.0.0";

    /// Pure per-chunk generator plus its `Params` (0008); not defined here.
    type Worldgen: Worldgen;
    /// Plain data: no `Vec`, `String` or `Box` (0011).
    type Action: Codec + TS;
    type Reject: Codec + TS + From<Unknown>;
    /// Replicated whole-value; plain data, no `Vec`.
    type Entity: Codec + Clone + PartialEq;
    /// Private per-player state; plain data.
    type Player: Codec + Clone + PartialEq;
    /// One value for every client; the engine roster rides the same scope (0011).
    type Global: Codec + Clone + PartialEq;
    type Presence: Presence;
    /// What the DOM overlay observes.
    type Ui: serde::Serialize + TS + PartialEq + Default;
    /// Per-client, never replicated, hashed or replayed.
    type Client: ClientSide<Self>;

    /// At init: trait tables + entity prototypes (`TraitSet`, footprint), 0007.
    fn register(r: &mut Registry);
    /// The engine derives occupancy and delta scope from this.
    fn prototype(e: &Self::Entity) -> PrototypeId;
    /// The tile an entity's footprint is anchored at (0024 §7): `prototype` carries no position,
    /// so the engine has no other way to derive scope or occupancy.
    fn anchor(e: &Self::Entity) -> TilePos;

    /// Once, at tick 0 of a new world.
    fn genesis(w: &mut dyn WorldWrite<Self>);
    /// `Joined | Connected | Disconnected`, logged.
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent);
    fn apply(
        w: &mut dyn WorldWrite<Self>,
        who: PlayerId,
        a: &Self::Action,
    ) -> Result<(), Self::Reject>;
    /// Per-action opt-out for actions that cascade (0012).
    fn predict(_a: &Self::Action) -> bool {
        true
    }
    /// Worst-case net growth of `apply(a)` (0023): `None` (the default) means undeclared, and the
    /// world's `max_action_growth` applies instead (0004).
    fn growth(_a: &Self::Action) -> Option<Growth> {
        None
    }
    /// HOST ONLY. `TickCx` is a `WorldWrite`: the same recording write path.
    fn tick(cx: &mut TickCx<'_, Self>);
    /// HOST ONLY, never replayed (0001, 0004).
    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Self::Action,
    ) -> Result<(), Self::Reject> {
        Ok(())
    }
    fn migrate(
        _from_schema: u32,
        _old: &mut OldStore,
        _w: &mut dyn WorldWrite<Self>,
    ) -> Result<(), SaveIncompatible> {
        Err(SaveIncompatible)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_id_policy_zero_is_not_provisional() {
        assert!(!EntityId(0).is_provisional());
    }

    #[test]
    fn entity_id_policy_bit_31_marks_provisional() {
        assert!(!EntityId(1).is_provisional());
        assert!(!EntityId(0x7FFF_FFFF).is_provisional());
        assert!(EntityId(EntityId::PROVISIONAL_BIT).is_provisional());
        assert!(EntityId(EntityId::PROVISIONAL_BIT | 5).is_provisional());
    }

    #[test]
    fn entity_id_policy_ord_matches_u32() {
        assert!(EntityId(1) < EntityId(2));
        assert!(PlayerId(1) < PlayerId(2));
    }
}
