//! `Delta<G>` (docs/decisions/0011-wire-format-and-deltas.md "Deltas are the only write path",
//! plus the engine-only `Roster` variant of 0024 §8): the engine-defined enum every `WorldWrite`
//! put becomes. Games never write delta types (0003); `Store<G>::apply` (`crate::store`) is the
//! only place these are interpreted.

use crate::game::{EntityId, Game, PlayerId};
use crate::world::{Tile, TilePos};

/// One replicated change (0011 Decision, verbatim, plus `Roster`). `Store::apply` is the only
/// mutator on either side of the wire: the host applies and records the same value a client
/// replica applies.
pub enum Delta<G: Game> {
    Tile {
        pos: TilePos,
        tile: Tile,
    },
    EntityPut {
        id: EntityId,
        entity: G::Entity,
    },
    EntityGone {
        id: EntityId,
    },
    Player {
        who: PlayerId,
        state: G::Player,
    },
    Global {
        state: G::Global,
    },
    /// Engine-only, sixth variant (0024 §8): 0011 puts the engine roster in `Global` scope but its
    /// `Delta` enum had no variant for it. The roster changes only through logged connection
    /// events, so it is sim state; this keeps `Store::apply` the only mutator true for it too.
    /// Wire section: `Global` (M14).
    Roster {
        who: PlayerId,
        online: bool,
    },
}

// Not `#[derive(Clone)]`: that would require `G: Clone`, which `Game` does not bound. Only the
// associated types actually held need to be `Clone`, and 0003 already requires that of
// `Entity`/`Player`/`Global`.
impl<G: Game> Clone for Delta<G> {
    fn clone(&self) -> Self {
        match self {
            Delta::Tile { pos, tile } => Delta::Tile {
                pos: *pos,
                tile: *tile,
            },
            Delta::EntityPut { id, entity } => Delta::EntityPut {
                id: *id,
                entity: entity.clone(),
            },
            Delta::EntityGone { id } => Delta::EntityGone { id: *id },
            Delta::Player { who, state } => Delta::Player {
                who: *who,
                state: state.clone(),
            },
            Delta::Global { state } => Delta::Global {
                state: state.clone(),
            },
            Delta::Roster { who, online } => Delta::Roster {
                who: *who,
                online: *online,
            },
        }
    }
}
