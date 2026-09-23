//! `FrameView<'a, G>` and `Clocks` (docs/decisions/0003-game-facing-api.md: "`FrameView`:
//! `WorldRead` + clocks + presences"): the read-only per-frame view `ClientSide::extract`/`ui`
//! receive. Minimal here (docs/plan/16b-ui-observation-and-clock.md Scope: "the three accessors
//! M17 extends: `world`, `clocks`, `me`"); M17 adds the visible rect, zoom, cursor tile and
//! presences (0018, 0019).
//!
//! Lives beside `client/ui.rs` rather than as a shell in `game.rs` (which now just re-exports both
//! types) for the same reason `TickCx` lives in `authority.rs`: the fields it holds are this
//! crate's own client-side plumbing, not something a game ever constructs.

use crate::game::{Game, PlayerId};
use crate::time::Tick;
use crate::world_access::WorldRead;

/// The authoritative and predicted tick a client observes (0003; 0006 "On the client" -- `client.
/// clock()` exposes the same pair to TypeScript). `predicted` equals `authoritative` until M26
/// gives prediction a real lead ([`docs/decisions/0012-prediction-and-reconciliation.md`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Clocks {
    pub authoritative: Tick,
    pub predicted: Tick,
}

/// The read-only view `ClientSide::extract`/`ui` receive (0003 "Contexts": the `View` role).
/// Borrows the replica for its own lifetime `'a` through `&dyn WorldRead<G>` (object-safe by
/// design, 0003: "`dyn` is deliberate ... trait-object upcasting") rather than owning a copy, so
/// one `FrameView` shape serves every `Game` with no generic read implementation per caller.
pub struct FrameView<'a, G: Game> {
    world: &'a dyn WorldRead<G>,
    clocks: Clocks,
    me: PlayerId,
}

impl<'a, G: Game> FrameView<'a, G> {
    pub fn new(world: &'a dyn WorldRead<G>, clocks: Clocks, me: PlayerId) -> Self {
        FrameView { world, clocks, me }
    }

    pub fn world(&self) -> &dyn WorldRead<G> {
        self.world
    }

    pub fn clocks(&self) -> Clocks {
        self.clocks
    }

    pub fn me(&self) -> PlayerId {
        self.me
    }
}
