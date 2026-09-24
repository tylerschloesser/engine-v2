//! `Presence` and `PresenceTable<G>` (docs/decisions/0001-camera-and-presence.md "Presence is an
//! engine channel"; amended by [0024](../../../../docs/decisions/0024-planning-amendments.md) §6:
//! `Default`, and the 32-byte limit per encoded sample, not at init). Real now
//! (docs/plan/19-presence-channel.md, steps 1-3): M12 declared the trait empty and `PresenceTable`
//! fieldless (`game.rs`'s own doc comment); both are filled in here and re-exported from `game.rs`
//! the same way `TickCx`/`FrameCx`/`FrameView`/`DrawList` already are, so every existing
//! `crate::game::{Presence, PresenceTable}` import path stays the same.
//!
//! **Presence never enters `Store`, the log or a hash.** Structurally: `Game::apply`/`Game::tick`
//! take no `PresenceTable` parameter at all (only `Game::admit`, HOST ONLY, does), so the sim core
//! has no way to *read* a sample even if one existed in scope -- see the compile-fail doc test on
//! [`PresenceTable`] below. This module itself imports nothing from `host`/`client`
//! (`tests/module_layering.rs`'s scan covers this file), so it stays part of the deterministic
//! core's own dependency graph the same way `game.rs` (which names `Presence` in `Game::Presence`)
//! already must.

use crate::codec::Codec;
use crate::game::{Game, PlayerId};
use crate::time::Tick;
use crate::world::WorldPos;

/// Ephemeral, unlogged, per-player, game-defined data (0001 Decision, verbatim plus 0024 §6's
/// `Default` bound): fixed *shape*, at most 32 bytes *encoded* -- the size limit is per sample
/// ([`MAX_ENCODED_BYTES`], enforced where a sample is decoded/relayed, not at construction: a
/// `Codec` (postcard) encoding is value-dependent, so nothing here can check it up front. `()` = no
/// presence (`impl Presence for ()` below).
pub trait Presence: Codec + Copy + Default + 'static {
    /// Q24.8 (0007). Picks relay recipients (the chunk containing it) and feeds interpolation
    /// (M30).
    fn pos(&self) -> WorldPos;
    /// Q24.8 tiles per second. Every other field a game adds takes the newer of two samples as a
    /// whole (0001: "other fields take the newer sample").
    fn vel(&self) -> [i32; 2];
}

impl Presence for () {
    fn pos(&self) -> WorldPos {
        WorldPos::default()
    }
    fn vel(&self) -> [i32; 2] {
        [0, 0]
    }
}

/// The 32-byte cap on one encoded [`Presence`] sample (0001: "at most 32 bytes encoded"; 0024 §6:
/// "The 32-byte limit applies to each encoded sample ... An oversize sample is dropped and
/// counted"). Checked wherever untrusted bytes decode into a sample (`Host::on_uplink`,
/// docs/plan/19-presence-channel.md steps 4-6's own site) -- this constant is this crate's single
/// home for the number, `wire/CLAUDE.md`'s convention for a shared limit.
pub const MAX_ENCODED_BYTES: usize = 32;

/// One player's held sample (Provides): `Host<G>` keeps at most one of these per connected player,
/// stamped with the tick it was received on so a relayed copy can carry `age_ticks` (steps 4-6).
pub struct PresenceEntry<G: Game> {
    pub sample: G::Presence,
    pub received_at: Tick,
}

// Hand-written instead of `#[derive(Clone, Copy)]`: the derive macro would bound `G: Clone`/`G:
// Copy` (the type parameter itself, almost never implemented by a game's zero-sized `Game` marker
// type), when the real requirement is `G::Presence: Copy` -- already guaranteed by the `Presence`
// supertrait bound above, and `Tick` is `Copy` unconditionally.
impl<G: Game> Clone for PresenceEntry<G> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<G: Game> Copy for PresenceEntry<G> {}

/// The presence samples `Game::admit` reads (0001: "readable by exactly one game hook, `admit`").
/// Owned by `Host<G>` (one table per world, keyed by `PlayerId`); a game never constructs one
/// itself (`empty()` exists only for `Game::admit`'s default body and native tests that need a
/// table with nothing in it, e.g. replay -- `apply`/`tick` cannot name this type at all, so no
/// amount of game code can smuggle a sample into deterministic state through it: see the
/// compile-fail doc test below.
///
/// ```compile_fail
/// // `Game::apply`'s own signature has no `PresenceTable` parameter (0001: "readable by exactly
/// // one game hook, `admit`"); a game that tries to add one fails to satisfy `Game`, which is
/// // exactly the guarantee this type's own doc comment claims.
/// use engine::game::{Game, PresenceTable, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
/// use engine::world::{PrototypeId, Registry, TilePos};
/// use engine::worldgen::Worldgen;
///
/// struct NoGen;
/// impl Worldgen for NoGen {
///     type Params = ();
///     const WORLDGEN_VERSION: u32 = 0;
///     fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [engine::world::Tile]) {
///         out.fill(engine::world::Tile::VOID);
///     }
/// }
///
/// #[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
/// struct NoReject;
/// impl From<Unknown> for NoReject {
///     fn from(_: Unknown) -> Self {
///         NoReject
///     }
/// }
///
/// struct NoGame;
/// impl Game for NoGame {
///     const SCHEMA_VERSION: u32 = 0;
///     type Worldgen = NoGen;
///     type Action = ();
///     type Reject = NoReject;
///     type Entity = ();
///     type Player = ();
///     type Global = ();
///     type Presence = ();
///     type Ui = ();
///     type Client = ();
///
///     fn register(_r: &mut Registry) {}
///     fn prototype(_e: &()) -> PrototypeId {
///         unimplemented!()
///     }
///     fn anchor(_e: &()) -> TilePos {
///         unimplemented!()
///     }
///     fn genesis(_w: &mut dyn WorldWrite<Self>) {}
///     fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
///     fn apply(
///         _w: &mut dyn WorldWrite<Self>,
///         _p: &PresenceTable<Self>,
///         _who: PlayerId,
///         _a: &(),
///     ) -> Result<(), NoReject> {
///         Ok(())
///     }
///     fn tick(_cx: &mut TickCx<'_, Self>) {}
/// }
/// ```
pub struct PresenceTable<G: Game> {
    entries: std::collections::BTreeMap<PlayerId, PresenceEntry<G>>,
}

impl<G: Game> PresenceTable<G> {
    /// No presence samples: `Game::admit`'s own default body, and every native test that wants a
    /// presence-free replay (0001 Consequences: "replays show the world evolving without
    /// avatars" -- `run_script`'s callers never build a real one). Not `Default`: `game.rs`'s own
    /// former doc comment on this ("a shell type with fields would silently stop meaning 'empty'
    /// ... a named constructor makes that day's diff obvious at every call site") still applies now
    /// that the table has real content -- `Default::default()` would silently mean the same thing
    /// as `empty()` today, but a reader skimming a call site sees `empty()` and knows exactly what
    /// it is getting, which `Default::default()` does not convey.
    pub fn empty() -> Self {
        PresenceTable {
            entries: std::collections::BTreeMap::new(),
        }
    }

    /// `who`'s held sample, if the host has one (Provides).
    pub fn get(&self, who: PlayerId) -> Option<&PresenceEntry<G>> {
        self.entries.get(&who)
    }

    /// Every held sample, ascending `PlayerId` (Provides) -- `BTreeMap`'s own iteration order,
    /// which is also `.claude/rules/determinism.md`'s required container for anything a host-side
    /// loop iterates (not that presence is hashed, but `Host::build_frame`'s per-tick relay build,
    /// steps 4-6, needs a stable order to test against).
    pub fn iter(&self) -> impl Iterator<Item = (PlayerId, &PresenceEntry<G>)> {
        self.entries.iter().map(|(&who, entry)| (who, entry))
    }

    /// Engine-internal (Provides): `Host::on_uplink`'s own call site (docs/plan/
    /// 19-presence-channel.md step 3) records the latest sample here after its own 32-byte and
    /// world-cap checks pass. Replaces any previously held sample for `who` unconditionally (0001:
    /// "keeps the latest sample per player ... never queued").
    pub fn on_sample(&mut self, who: PlayerId, sample: G::Presence, received_at: Tick) {
        self.entries.insert(
            who,
            PresenceEntry {
                sample,
                received_at,
            },
        );
    }

    /// Engine-internal (Provides): `Host::disconnect`'s own call site (steps 4-6) -- "on
    /// disconnect the host tells clients at once and drops the sample from relay" (0001). Exists
    /// now (step 3) so the table's own contract is complete even though nothing calls it yet in
    /// this cut; a no-op if `who` has no held sample.
    pub fn remove(&mut self, who: PlayerId) {
        self.entries.remove(&who);
    }

    /// Engine-internal (Provides): M28's own call site, restoring a returning player's last known
    /// sample from the host-side session table (0001: "the host keeps each player's last sample in
    /// the host-side session table ... so a returning player's camera can start where they were",
    /// 0013). `received_at` is stamped `Tick(0)`: M28 owns deciding whether that reads sensibly for
    /// its own `age_ticks` relay (steps 4-6) or whether a restore needs its own tick parameter --
    /// not decided here, since nothing in this cut calls this method (Non-scope: M28).
    pub fn restore(&mut self, who: PlayerId, sample: G::Presence) {
        self.entries.insert(
            who,
            PresenceEntry {
                sample,
                received_at: Tick(0),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TestPresence {
        x: i32,
        y: i32,
    }
    impl Presence for TestPresence {
        fn pos(&self) -> WorldPos {
            WorldPos {
                x: self.x,
                y: self.y,
            }
        }
        fn vel(&self) -> [i32; 2] {
            [0, 0]
        }
    }

    #[test]
    fn unit_presence_pos_and_vel_are_the_origin_and_zero() {
        assert_eq!(().pos(), WorldPos::default());
        assert_eq!(().vel(), [0, 0]);
    }

    #[test]
    fn max_encoded_bytes_is_32() {
        assert_eq!(MAX_ENCODED_BYTES, 32);
    }

    // A minimal `Game` shim, `PresenceTable<Self>`'s own generic parameter (never driven: no
    // `apply`/`tick`/`genesis` call in this file, the same pattern `client/texel.rs`'s and
    // `client/frame_cx.rs`'s own test modules use for the same reason).
    struct TGen;
    impl crate::worldgen::Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(
            _seed: u64,
            _params: &(),
            _chunk: crate::world::ChunkCoord,
            out: &mut [crate::world::Tile],
        ) {
            out.fill(crate::world::Tile::VOID);
        }
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<crate::game::Unknown> for TReject {
        fn from(_: crate::game::Unknown) -> Self {
            TReject
        }
    }
    struct TGame;
    impl Game for TGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = TGen;
        type Action = ();
        type Reject = TReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = TestPresence;
        type Ui = ();
        type Client = ();
        fn register(_r: &mut crate::world::Registry) {}
        fn prototype(_e: &()) -> crate::world::PrototypeId {
            unimplemented!()
        }
        fn anchor(_e: &()) -> crate::world::TilePos {
            unimplemented!()
        }
        fn genesis(_w: &mut dyn crate::game::WorldWrite<Self>) {}
        fn on_player(
            _w: &mut dyn crate::game::WorldWrite<Self>,
            _who: PlayerId,
            _ev: crate::game::PlayerEvent,
        ) {
        }
        fn apply(
            _w: &mut dyn crate::game::WorldWrite<Self>,
            _who: PlayerId,
            _a: &(),
        ) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut crate::game::TickCx<'_, Self>) {}
    }

    /// `get`/`on_sample`: absent before the first sample, present and equal to the last `on_sample`
    /// call after it (inject: skip the `on_sample` call -- `get` stays `None`; revert: call it --
    /// `get` returns the sample. Covers the `entries.get`/`entries.insert` branch pair).
    #[test]
    fn get_reflects_the_most_recent_on_sample() {
        let mut t = PresenceTable::<TGame>::empty();
        assert!(t.get(PlayerId(1)).is_none());
        t.on_sample(PlayerId(1), TestPresence { x: 1, y: 2 }, Tick(5));
        let e = t.get(PlayerId(1)).unwrap();
        assert_eq!(e.sample, TestPresence { x: 1, y: 2 });
        assert_eq!(e.received_at, Tick(5));
        // A second sample for the same player replaces, never queues (0001).
        t.on_sample(PlayerId(1), TestPresence { x: 3, y: 4 }, Tick(6));
        let e2 = t.get(PlayerId(1)).unwrap();
        assert_eq!(e2.sample, TestPresence { x: 3, y: 4 });
        assert_eq!(e2.received_at, Tick(6));
    }

    /// `iter` in ascending `PlayerId` regardless of insertion order (Provides).
    #[test]
    fn iter_is_ascending_by_player_id() {
        let mut t = PresenceTable::<TGame>::empty();
        t.on_sample(PlayerId(3), TestPresence::default(), Tick(1));
        t.on_sample(PlayerId(1), TestPresence::default(), Tick(1));
        t.on_sample(PlayerId(2), TestPresence::default(), Tick(1));
        let ids: Vec<PlayerId> = t.iter().map(|(who, _)| who).collect();
        assert_eq!(ids, vec![PlayerId(1), PlayerId(2), PlayerId(3)]);
    }

    /// `remove`: a held sample is gone afterward (inject: skip the `remove` call -- `get` still
    /// finds it; revert: call it -- `get` returns `None`. Covers `entries.remove`'s effect).
    #[test]
    fn remove_drops_a_held_sample() {
        let mut t = PresenceTable::<TGame>::empty();
        t.on_sample(PlayerId(1), TestPresence::default(), Tick(1));
        assert!(t.get(PlayerId(1)).is_some());
        t.remove(PlayerId(1));
        assert!(t.get(PlayerId(1)).is_none());
        // A no-op on a player never sampled.
        t.remove(PlayerId(9));
        assert!(t.get(PlayerId(9)).is_none());
    }

    /// `restore`: seeds a sample as if it had been sampled, at `Tick(0)` (see the method's own doc
    /// comment on why).
    #[test]
    fn restore_seeds_a_sample_at_tick_zero() {
        let mut t = PresenceTable::<TGame>::empty();
        t.restore(PlayerId(1), TestPresence { x: 7, y: 8 });
        let e = t.get(PlayerId(1)).unwrap();
        assert_eq!(e.sample, TestPresence { x: 7, y: 8 });
        assert_eq!(e.received_at, Tick(0));
    }
}
