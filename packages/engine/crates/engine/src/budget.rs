//! The state-budget check (docs/decisions/0004-action-timing-and-rejection.md "State-budget
//! check", docs/decisions/0023-action-growth-declaration.md "The check"): run from
//! [`crate::sim::Sim::step`], immediately before `Game::apply`, for game actions only -- never for
//! `on_player`, `genesis`, `migrate` or tick rules (0023: "the budget is soft by that margin").
//! **Deterministic-core-resident, not host-role-resident** (docs/plan/21-entities-and-timers.md
//! Deviations): `Sim::step` runs identically live, in replay and in recovery, with no `Host<G>` in
//! the loop at all (`testkit::run_script`, `fx-puts`'s own replay tests), and crate `CLAUDE.md`'s
//! own layering rule (`tests/module_layering.rs`) forbids the deterministic core from importing
//! the host role's own module -- the brief's own Files list named a path under that module, but
//! the check has to be reachable from the deterministic core, so this lives at `crate::budget`
//! instead, a sibling of `authority.rs`/`sim.rs`.
//!
//! Nominal costs are fixed by the engine (0007 §8), never taken from `size_of`, so they are equal
//! in every build (`nominal_costs_are_constants`): 128 B per entity, 12 B per modified tile.

use crate::authority::Authority;
use crate::game::{Game, Growth};
use crate::sim::EngineReject;

/// 0007 §8's own figures, verbatim.
pub const ENTITY_COST_BYTES: u32 = 128;
pub const TILE_COST_BYTES: u32 = 12;

/// 0022 §2: "a world has 2^31 - 2 ids" (0 is never allocated, bit 31 is reserved for a provisional
/// id): the highest real id `WorldWrite::spawn` may ever allocate.
const MAX_REAL_ID: u32 = crate::game::EntityId::PROVISIONAL_BIT - 1;

/// Test-only switch (`under_declared_growth_counts_in_release`): forces [`audit`] to take its
/// release-mode branch (keep the writes, count the violation) even though the test binary itself
/// is built with `debug_assertions` on -- a real `--release` test run is impractical (it would
/// also disable every other `debug_assert!` in the crate this milestone's own tests rely on
/// staying live). Defaults to the real, unmodified `cfg!(debug_assertions)` behaviour.
#[cfg(any(test, feature = "testing"))]
static FORCE_RELEASE_AUDIT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(any(test, feature = "testing"))]
pub fn set_force_release_audit_for_test(force: bool) {
    FORCE_RELEASE_AUDIT.store(force, std::sync::atomic::Ordering::Relaxed);
}

fn audit_panics_on_violation() -> bool {
    #[cfg(any(test, feature = "testing"))]
    {
        if FORCE_RELEASE_AUDIT.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
    }
    cfg!(debug_assertions)
}

/// How many real ids remain before [`MAX_REAL_ID`], given the next id `spawn` would allocate.
fn ids_remaining(next_entity_id: u32) -> u32 {
    (MAX_REAL_ID + 1).saturating_sub(next_entity_id)
}

/// 0023 "The check": rejects with [`EngineReject::StateBudgetFull`] when either count's headroom
/// cannot absorb `declared`'s growth (or, if `declared` is `None`, `max_action_growth`'s own
/// nominal headroom -- 0004's original rule, unchanged for an undeclared action), or when 0022
/// §2's id-exhaustion clause fires (the same declared entity count, or `max_action_growth`'s own
/// implied entity count when undeclared).
pub(crate) fn check<G: Game>(
    authority: &Authority<G>,
    declared: Option<Growth>,
) -> Result<(), EngineReject> {
    let store = authority.store();
    let free_entities = authority
        .max_entities()
        .saturating_sub(store.entity_count());
    let free_tiles = authority
        .max_modified_tiles()
        .saturating_sub(store.modified_tile_count());
    let ids_left = ids_remaining(store.next_entity_id());

    match declared {
        Some(g) => {
            let nominal = (g.entities as u32).saturating_mul(ENTITY_COST_BYTES)
                + (g.modified_tiles as u32).saturating_mul(TILE_COST_BYTES);
            debug_assert!(
                nominal <= authority.max_action_growth(),
                "Game::growth declared {g:?} (nominal {nominal} B), over this world's own \
                 max_action_growth ({} B): a game bug -- 0023 'The check'",
                authority.max_action_growth()
            );
            if g.entities as u32 > free_entities || g.modified_tiles as u32 > free_tiles {
                return Err(EngineReject::StateBudgetFull);
            }
            if (g.entities as u32) > ids_left {
                return Err(EngineReject::StateBudgetFull);
            }
        }
        None => {
            let entity_headroom = free_entities.saturating_mul(ENTITY_COST_BYTES);
            let tile_headroom = free_tiles.saturating_mul(TILE_COST_BYTES);
            if entity_headroom < authority.max_action_growth()
                || tile_headroom < authority.max_action_growth()
            {
                return Err(EngineReject::StateBudgetFull);
            }
            let undeclared_entities = authority.max_action_growth() / ENTITY_COST_BYTES;
            if undeclared_entities > ids_left {
                return Err(EngineReject::StateBudgetFull);
            }
        }
    }
    Ok(())
}

/// 0023 "Honesty is audited, not trusted": call after a successful `apply`, with the two counts
/// sampled immediately before it ran. `declared` is exactly what [`check`] was given for this same
/// action. Debug/test builds panic (naming the action's `Debug` and both numbers); release builds
/// keep the writes and bump [`Authority::record_growth_violation`], logging at `warn`.
pub(crate) fn audit<G: Game>(
    authority: &mut Authority<G>,
    declared: Option<Growth>,
    before: (u32, u32),
) {
    let Some(declared) = declared else {
        // An undeclared action has nothing it promised not to exceed (0004's own headroom rule,
        // not a per-action cap): nothing to audit against.
        return;
    };
    let (entities_before, tiles_before) = before;
    let store = authority.store();
    let added_entities = store.entity_count().saturating_sub(entities_before);
    let added_tiles = store.modified_tile_count().saturating_sub(tiles_before);
    let over_entities = added_entities > declared.entities as u32;
    let over_tiles = added_tiles > declared.modified_tiles as u32;
    if !over_entities && !over_tiles {
        return;
    }
    let action_ty = core::any::type_name::<G::Action>();
    if audit_panics_on_violation() {
        panic!(
            "an action of type {action_ty} under-declared its growth: declared {declared:?}, \
             added ({added_entities} entities, {added_tiles} modified tiles) (0023 'Honesty is \
             audited, not trusted')"
        );
    }
    authority.record_growth_violation();
    crate::abi::panic::log(
        crate::abi::registry::LogLevel::Warn,
        &format!(
            "growth_violation: an action of type {action_ty} under-declared (declared \
             {declared:?}, added {added_entities} entities, {added_tiles} modified tiles)"
        ),
    );
}
