//! `RemotePresences<G>` (docs/plan/19-presence-channel.md Provides: "newest `{ sample,
//! sample_tick, arrived_ms }` per remote player"): the client's own store of the newest presence
//! sample per remote player, applied from the wire's `Presence` section (`wire::read_presence`,
//! `client::core::ClientCore::apply`). `FrameView::presences()` is its read side; M30 replaces
//! that read side with a real interpolation buffer -- until then a remote avatar simply snaps to
//! the newest sample (Goal: "remote samples are exposed raw (snapped)").

use std::collections::BTreeMap;

use crate::game::{Game, PlayerId};
use crate::time::Tick;

/// One remote player's newest known sample (Provides).
pub struct RemotePresenceEntry<G: Game> {
    pub sample: G::Presence,
    /// The host tick the sample was originally captured on (`frame.tick - age_ticks`, the wire's
    /// own `Presence` section field, `wire/CLAUDE.md`) -- not the tick it was relayed on.
    pub sample_tick: Tick,
    /// A tick-derived stand-in for wall-clock arrival (`sample_tick` converted through `G::
    /// TICK_RATE`): threading the client's own real frame clock into `ClientCore::on_frame`'s
    /// fixed `(&mut self, bytes: &[u8])` signature is a wider seam change than this cut takes on
    /// (Deviations) -- exact wall-clock arrival is M30's own concern once it builds the real
    /// interpolation buffer this field name anticipates; nothing in this cut reads it.
    pub arrived_ms: f64,
}

// Hand-written instead of `#[derive(Clone, Copy)]` (same reason `presence.rs`'s own
// `PresenceEntry` gives): the derive would bound `G: Clone`/`G: Copy` (the marker type itself),
// when the real requirement is `G::Presence: Copy` -- already guaranteed by the `Presence`
// supertrait bound; `Tick`/`f64` are `Copy` unconditionally.
impl<G: Game> Clone for RemotePresenceEntry<G> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<G: Game> Copy for RemotePresenceEntry<G> {}

/// Owned by `Replica<G>` (`client::replica` Deviations): applied by `apply_sample`/`apply_gone`
/// (`pub(crate)`, called only from `ClientCore::apply`'s own `Presence` section handling), read by
/// `FrameView::presences()`.
pub struct RemotePresences<G: Game> {
    entries: BTreeMap<PlayerId, RemotePresenceEntry<G>>,
}

impl<G: Game> RemotePresences<G> {
    pub fn new() -> Self {
        RemotePresences {
            entries: BTreeMap::new(),
        }
    }

    pub(crate) fn apply_sample(&mut self, who: PlayerId, sample: G::Presence, sample_tick: Tick) {
        let arrived_ms = sample_tick.0 as f64 * 1000.0 / G::TICK_RATE.hz_value() as f64;
        self.entries.insert(
            who,
            RemotePresenceEntry {
                sample,
                sample_tick,
                arrived_ms,
            },
        );
    }

    pub(crate) fn apply_gone(&mut self, who: PlayerId) {
        self.entries.remove(&who);
    }

    /// Every held remote sample, ascending `PlayerId` (`BTreeMap`'s own order, matching every
    /// other ascending-`PlayerId` iteration in this crate) -- `FrameView::presences()`'s source.
    pub fn iter(&self) -> impl Iterator<Item = (PlayerId, &RemotePresenceEntry<G>)> {
        self.entries.iter().map(|(&who, e)| (who, e))
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn debug_get(&self, who: PlayerId) -> Option<RemotePresenceEntry<G>> {
        self.entries.get(&who).copied()
    }
}

impl<G: Game> Default for RemotePresences<G> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{PrototypeId, Registry, Tile, TilePos, WorldPos};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct RPresence {
        x: i32,
    }
    impl crate::presence::Presence for RPresence {
        fn pos(&self) -> WorldPos {
            WorldPos { x: self.x, y: 0 }
        }
        fn vel(&self) -> [i32; 2] {
            [0, 0]
        }
    }

    struct RGen;
    impl Worldgen for RGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct RReject;
    impl From<Unknown> for RReject {
        fn from(_: Unknown) -> Self {
            RReject
        }
    }
    struct RGame;
    impl Game for RGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = RGen;
        type Action = ();
        type Reject = RReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = RPresence;
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &()) -> PrototypeId {
            unimplemented!()
        }
        fn anchor(_e: &()) -> TilePos {
            unimplemented!()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), RReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    /// `apply_sample`/`apply_gone`: present after a sample, absent after `Gone` (inject: skip the
    /// `apply_gone` call -- `iter()` still yields the player; revert: call it -- gone. Covers the
    /// `entries.remove`'s effect, the same pattern `presence.rs`'s own `PresenceTable` tests use).
    #[test]
    fn sample_then_gone() {
        let mut r = RemotePresences::<RGame>::new();
        assert_eq!(r.iter().count(), 0);
        r.apply_sample(PlayerId(2), RPresence { x: 5 }, Tick(10));
        let ids: Vec<PlayerId> = r.iter().map(|(who, _)| who).collect();
        assert_eq!(ids, vec![PlayerId(2)]);
        assert_eq!(r.debug_get(PlayerId(2)).unwrap().sample, RPresence { x: 5 });
        assert_eq!(r.debug_get(PlayerId(2)).unwrap().sample_tick, Tick(10));
        r.apply_gone(PlayerId(2));
        assert_eq!(r.iter().count(), 0);
    }

    #[test]
    fn iter_is_ascending_by_player_id() {
        let mut r = RemotePresences::<RGame>::new();
        r.apply_sample(PlayerId(3), RPresence::default(), Tick(1));
        r.apply_sample(PlayerId(1), RPresence::default(), Tick(1));
        r.apply_sample(PlayerId(2), RPresence::default(), Tick(1));
        let ids: Vec<PlayerId> = r.iter().map(|(who, _)| who).collect();
        assert_eq!(ids, vec![PlayerId(1), PlayerId(2), PlayerId(3)]);
    }
}
