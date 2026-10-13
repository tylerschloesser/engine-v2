//! Sim rules, one file per feature (`games/reference/CLAUDE.md`): `collect` (M20), `craft` (M32) and
//! `place` (M33), `furnace` (M33b), `belt` (M51) and `belts::topology` (M52), and the tick dispatch.

use engine::game::{EntityId, TickCx, WorldRead};

use crate::{RefEntity, RefGame};

pub mod belt;
pub mod collect;
pub mod craft;
pub mod furnace;
pub mod place;

/// Belt lines (M52): `topology` maps placed belts onto the engine's transport lines.
pub mod belts {
    pub mod topology;
}

/// The game's tick rule (M52): collects, then the entity wakes drained once and dispatched by
/// variant: a furnace to [`furnace::advance`], a belt to [`belts::topology::on_wake`] (placed,
/// rotated, picked up), and under `test-hooks` a request to `belts::topology::test_insert`. Every
/// spawn or put from `apply` wakes its entity into the same tick; a tick put wakes nothing, so an idle
/// world visits nothing. Belts never set a timer: the due drain reaches only furnaces.
pub fn tick(cx: &mut TickCx<'_, RefGame>) {
    collect::tick(cx);
    while let Some(id) = cx.next_woken() {
        dispatch(cx, id);
    }
    while let Some(id) = cx.next_due() {
        dispatch(cx, id);
    }
}

fn dispatch(cx: &mut TickCx<'_, RefGame>, id: EntityId) {
    match cx.entity(id).ok().flatten().copied() {
        Some(RefEntity::Furnace(_)) => furnace::advance(cx, id),
        Some(RefEntity::Belt(b)) => belts::topology::on_wake(cx, id, b),
        #[cfg(feature = "test-hooks")]
        Some(RefEntity::TestRequest(r)) => belts::topology::test_insert(cx, id, r),
        None => {} // despawned before this tick got to it.
    }
}
