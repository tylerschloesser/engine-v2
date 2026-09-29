//! `RemotePresences<G>` (docs/plan/19-presence-channel.md Provides: "newest `{ sample,
//! sample_tick, arrived_ms }` per remote player"): the client's own store of the newest presence
//! sample per remote player, applied from the wire's `Presence` section (`wire::read_presence`,
//! `client::core::ClientCore::apply`). `FrameView::presences()` is its read side; M30 replaces
//! that read side with a real interpolation buffer -- until then a remote avatar simply snaps to
//! the newest sample (Goal: "remote samples are exposed raw (snapped)").

use std::collections::BTreeMap;

use crate::game::{Game, PlayerId};
use crate::interp::{Interp, InterpBuffer, InterpKey, InterpMode, PushResult};
use crate::presence::Presence as _;
use crate::time::Tick;

/// One remote player's newest known sample (Provides).
pub struct RemotePresenceEntry<G: Game> {
    pub sample: G::Presence,
    /// The host tick the sample was originally captured on (`frame.tick - age_ticks`, the wire's
    /// own `Presence` section field, `wire/CLAUDE.md`) -- not the tick it was relayed on.
    pub sample_tick: Tick,
    /// The client's own wall-clock reading (`CameraBlock::frame_time_ms`, ms) at the first
    /// `frame(t_ms)` after the frame carrying this sample was decoded (docs/plan/30-interpolation.md
    /// Deviations: `on_frame`'s signature is unchanged, so arrival is stamped by
    /// [`RemotePresences::stamp_arrivals`], one client frame late at most). Until stamped
    /// ([`Self::stamped`] false) it holds the tick-derived stand-in M19 used
    /// (`sample_tick` through `G::TICK_RATE`).
    pub arrived_ms: f64,
    /// Whether [`Self::arrived_ms`] is a real client clock reading yet.
    pub stamped: bool,
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
    /// docs/plan/30-interpolation.md: every remote player's samples, keyed `InterpKey::Player`;
    /// [`FrameView::presences`](super::frame_view::FrameView::presences) reads interpolated
    /// positions from here. `entries` keeps the newest raw sample (`RemotePresence::sample`).
    buffer: InterpBuffer<InterpKey>,
    /// Any entry still waiting for [`Self::stamp_arrivals`].
    unstamped: bool,
}

impl<G: Game> RemotePresences<G> {
    pub fn new() -> Self {
        RemotePresences {
            entries: BTreeMap::new(),
            buffer: InterpBuffer::new(G::TICK_RATE.hz_value()),
            unstamped: false,
        }
    }

    pub(crate) fn apply_sample(&mut self, who: PlayerId, sample: G::Presence, sample_tick: Tick) {
        let pushed = self.buffer.push(
            InterpKey::Player(who),
            sample_tick.0 as f64,
            sample.pos(),
            sample.vel(),
        );
        if pushed == PushResult::OutOfOrder {
            return; // an older sample than the newest held: never replaces it
        }
        let arrived_ms = sample_tick.0 as f64 * 1000.0 / G::TICK_RATE.hz_value() as f64;
        self.unstamped = true;
        self.entries.insert(
            who,
            RemotePresenceEntry {
                sample,
                sample_tick,
                arrived_ms,
                stamped: false,
            },
        );
    }

    /// The frame with host tick `frame_tick` carried (or re-relayed) `who`'s newest sample: it is
    /// still valid as of that tick, so the silence timer restarts (`InterpBuffer::refresh`).
    pub(crate) fn refresh(&mut self, who: PlayerId, frame_tick: Tick) {
        self.buffer
            .refresh(InterpKey::Player(who), frame_tick.0 as f64);
    }

    /// Stamps every not-yet-stamped entry with the client clock reading `local_ms` (see
    /// [`RemotePresenceEntry::arrived_ms`]). No allocation.
    pub(crate) fn stamp_arrivals(&mut self, local_ms: f64) {
        if !self.unstamped {
            return;
        }
        for e in self.entries.values_mut() {
            if !e.stamped {
                e.arrived_ms = local_ms;
                e.stamped = true;
            }
        }
        self.unstamped = false;
    }

    /// Rebase or resync (0018 section 8, M28b): forgets every remote's samples. Each remote comes
    /// back with the host's next relay of its sample (`Interp` or `Hold`, never a sweep).
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.buffer.clear();
        self.unstamped = false;
    }

    pub(crate) fn apply_gone(&mut self, who: PlayerId) {
        self.entries.remove(&who);
        self.buffer.remove(InterpKey::Player(who));
    }

    /// `who`'s interpolated state at `render_t` (host ticks); `None` if unknown or faded out.
    pub fn sample(&self, who: PlayerId, render_t: f64) -> Option<Interp> {
        self.buffer.sample(InterpKey::Player(who), render_t)
    }

    /// `(rendered, extrapolated)`: how many remotes are visible at `render_t`, and how many of
    /// them are in [`InterpMode::Extrap`].
    pub(crate) fn count_modes(&self, render_t: f64) -> (u32, u32) {
        let (mut rendered, mut extrap) = (0, 0);
        for &who in self.entries.keys() {
            if let Some(s) = self.sample(who, render_t) {
                rendered += 1;
                if s.mode == InterpMode::Extrap {
                    extrap += 1;
                }
            }
        }
        (rendered, extrap)
    }

    /// The `i`th visible remote at `render_t` in ascending `PlayerId` order (test hook source).
    pub(crate) fn nth_visible(&self, render_t: f64, i: usize) -> Option<(PlayerId, Interp)> {
        self.entries
            .keys()
            .filter_map(|&who| self.sample(who, render_t).map(|s| (who, s)))
            .nth(i)
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

    #[test]
    fn interpolates_between_samples_and_gone_is_immediate() {
        let mut r = RemotePresences::<RGame>::new();
        r.apply_sample(PlayerId(1), RPresence { x: 0 }, Tick(10));
        r.apply_sample(PlayerId(1), RPresence { x: 1000 }, Tick(12));
        // Zero velocity samples: Hermite between them is a smoothstep, halfway at the midpoint.
        let mid = r.sample(PlayerId(1), 11.0).unwrap();
        assert_eq!(mid.pos.x, 500);
        assert_eq!(mid.mode, InterpMode::Interp);
        // An out-of-order sample never replaces the newest raw sample nor the buffer.
        r.apply_sample(PlayerId(1), RPresence { x: -5 }, Tick(11));
        assert_eq!(r.debug_get(PlayerId(1)).unwrap().sample.x, 1000);
        assert_eq!(r.sample(PlayerId(1), 11.0).unwrap().pos.x, 500);
        r.apply_gone(PlayerId(1));
        assert!(r.sample(PlayerId(1), 11.0).is_none());
    }

    #[test]
    fn refresh_keeps_a_resting_remote_solid() {
        let mut r = RemotePresences::<RGame>::new();
        r.apply_sample(PlayerId(1), RPresence { x: 7 }, Tick(10));
        assert!(
            r.sample(PlayerId(1), 10.0 + 40.0).is_some(),
            "2 s later, before fade starts"
        );
        assert!(
            r.sample(PlayerId(1), 10.0 + 100.0).is_none(),
            "5 s of silence: faded out"
        );
        // The same sample re-relayed on frames up to tick 110: solid at tick 110 + 20.
        r.apply_sample(PlayerId(1), RPresence { x: 7 }, Tick(10));
        r.refresh(PlayerId(1), Tick(110));
        let s = r.sample(PlayerId(1), 110.0).unwrap();
        assert_eq!((s.alpha, s.pos.x), (1.0, 7));
    }

    #[test]
    fn clear_drops_every_remote_and_the_next_relay_restores_it() {
        let mut r = RemotePresences::<RGame>::new();
        r.apply_sample(PlayerId(1), RPresence { x: 7 }, Tick(10));
        r.apply_sample(PlayerId(2), RPresence { x: 9 }, Tick(10));
        r.clear();
        assert_eq!(r.iter().count(), 0);
        assert!(r.sample(PlayerId(1), 10.0).is_none());
        // The host's next relay of the held sample brings the remote back.
        r.apply_sample(PlayerId(1), RPresence { x: 7 }, Tick(10));
        assert_eq!(r.sample(PlayerId(1), 10.0).unwrap().pos.x, 7);
    }

    #[test]
    fn stamp_arrivals_stamps_once() {
        let mut r = RemotePresences::<RGame>::new();
        r.apply_sample(PlayerId(1), RPresence::default(), Tick(10));
        assert!(!r.debug_get(PlayerId(1)).unwrap().stamped);
        r.stamp_arrivals(1234.5);
        let e = r.debug_get(PlayerId(1)).unwrap();
        assert_eq!((e.stamped, e.arrived_ms), (true, 1234.5));
        r.stamp_arrivals(9999.0);
        assert_eq!(r.debug_get(PlayerId(1)).unwrap().arrived_ms, 1234.5);
    }
}
