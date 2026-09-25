//! The state-budget check's second half (docs/decisions/0023-action-growth-declaration.md
//! Consequences: "the scripted 'state budget when full' test ... gains a second half: placing is
//! rejected, removing is accepted, and placing then succeeds again") and the growth-honesty audit
//! (docs/plan/21-entities-and-timers.md Tests added), against `fx-machines`'s own real handlers.

use engine::game::PlayerId;
use engine::sim::{EngineReject, Record, Rejected, Sim, WorldParams};
use fx_machines::{Action, Machines, Pos, Reject};

fn genesis(
    seed: u64,
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
) -> Sim<Machines> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities,
        max_modified_tiles,
        max_action_growth,
    })
}

#[test]
fn full_world_rejects_place_accepts_remove_then_place() {
    let mut sim = genesis(1, 1, 1_000_000, 4096);
    let mut out = Vec::new();

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "the one free slot must accept a Place"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Place {
                origin: Pos { x: 10, y: 10 },
            },
        }],
        &mut out,
    );
    assert!(
        matches!(
            out[0].result,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ),
        "a full world must reject a further Place"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Remove {
                at: Pos { x: 2, y: 2 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "a full world must still accept a Remove (Growth::NONE always passes)"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 4,
            action: Action::Place {
                origin: Pos { x: 10, y: 10 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "the freed slot must accept a Place again"
    );
}

/// "Honesty is audited, not trusted" (0023): replays a script exercising every handler with the
/// audit on (`Sim::step` always runs it) and requires zero violations -- every declared `growth`
/// in `fx-machines::Machines::growth` must match what `apply` actually adds.
#[test]
fn growth_declarations_are_honest() {
    let mut sim = genesis(2, 1_000_000, 1_000_000, 4096);
    let script: Vec<Record<Machines>> = vec![
        Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Feed {
                at: Pos { x: 2, y: 2 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Move {
                at: Pos { x: 2, y: 2 },
                to: Pos { x: 10, y: 10 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 4,
            action: Action::Remove {
                at: Pos { x: 10, y: 10 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 5,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        },
    ];
    let mut out = Vec::new();
    for (i, record) in script.into_iter().enumerate() {
        sim.step(&[record], &mut out);
        assert!(
            out[0].result.is_ok(),
            "script action {i} (seq {}) was rejected",
            i + 1
        );
    }
    assert_eq!(
        sim.authority().growth_violations(),
        0,
        "no handler may add more than it declared"
    );
}

/// Budgets: "occupancy maintenance is O(footprint), asserted by a counter `index_ops_per_put <=
/// footprint area + 4`" (gate round 1 review: nothing asserted this). `MACHINE_FOOTPRINT` is 2x2
/// (area 4): one `ChunkIndex::add`/`remove` call (one `Store::add_to_index`/`remove_from_index`
/// pass) touches exactly `area` tiles, so it must cost at most `area + 4 = 8` ops regardless of
/// how many chunks the footprint straddles. `Place`/`Remove` make one such call each (add-only,
/// remove-only); `Move` makes both in the same `apply` (remove the old footprint, add the new
/// one), so its own combined delta is bounded by `2 * (area + 4) = 16`.
#[test]
fn index_ops_per_put_is_bounded_by_footprint_area_plus_four() {
    const AREA: u64 = 4; // MACHINE_FOOTPRINT: 2x2
    const PER_CALL_BOUND: u64 = AREA + 4;

    let mut sim = genesis(3, 1_000_000, 1_000_000, 4096);
    let mut out = Vec::new();
    let ops = |sim: &Sim<Machines>| sim.authority().store().debug_index_ops();

    // Place, anchored on a chunk border (world tile 63/64): straddles two chunks, still one
    // `add_to_index` pass over the 4 footprint tiles.
    let before_place = ops(&sim);
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 63, y: 5 },
            },
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let place_ops = ops(&sim) - before_place;
    assert!(
        place_ops <= PER_CALL_BOUND,
        "Place: {place_ops} index ops, bound is {PER_CALL_BOUND} (footprint area {AREA} + 4)"
    );

    // Move, to another border position: one remove pass (old footprint) + one add pass (new
    // footprint), each individually bounded the same way.
    let before_move = ops(&sim);
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Move {
                at: Pos { x: 63, y: 5 },
                to: Pos { x: 127, y: 5 },
            },
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let move_ops = ops(&sim) - before_move;
    assert!(
        move_ops <= 2 * PER_CALL_BOUND,
        "Move: {move_ops} index ops, bound is {} (one remove pass + one add pass, each <= {PER_CALL_BOUND})",
        2 * PER_CALL_BOUND
    );

    // Remove: one remove pass over the (new) footprint.
    let before_remove = ops(&sim);
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Remove {
                at: Pos { x: 127, y: 5 },
            },
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let remove_ops = ops(&sim) - before_remove;
    assert!(
        remove_ops <= PER_CALL_BOUND,
        "Remove: {remove_ops} index ops, bound is {PER_CALL_BOUND} (footprint area {AREA} + 4)"
    );
}

/// Gate round 1 review: "with no engine panic, the only thing stopping two entities sharing a
/// tile ... is `fixtures/machines`'s own `NOT_BUILDABLE` check" -- proves that check actually
/// rejects an overlapping `Place`, with no write, for a plain in-chunk overlap and for one where
/// the overlapped tile is the far (non-anchor) corner of a machine straddling a chunk border.
#[test]
fn place_overlapping_an_existing_machine_by_one_tile_is_blocked() {
    let mut sim = genesis(4, 1_000_000, 1_000_000, 4096);
    let mut out = Vec::new();

    // First machine: origin (2,2), covers (2,2)/(3,2)/(2,3)/(3,3), all within one chunk.
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let count_after_first = sim.authority().store().entity_count();

    // Second machine: origin (3,3) overlaps the first by exactly one tile, (3,3).
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Place {
                origin: Pos { x: 3, y: 3 },
            },
        }],
        &mut out,
    );
    assert!(
        matches!(out[0].result, Err(Rejected::Game(Reject::Blocked))),
        "a footprint overlapping an existing machine by one tile must be rejected, not silently \
         placed on top of it"
    );
    assert_eq!(
        sim.authority().store().entity_count(),
        count_after_first,
        "a rejected Place must record no write"
    );

    // A second machine straddling a chunk border (world tiles 63/64, chunks (1,0)/(2,0)): origin
    // (63, 5) covers (63,5)/(64,5)/(63,6)/(64,6). Overlap it by one tile at (64, 5) -- the far,
    // non-anchor corner, in chunk (2,0) -- from a third machine anchored inside that same chunk,
    // proving the check finds the occupant across the border, not just at its own anchor tile.
    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Place {
                origin: Pos { x: 63, y: 5 },
            },
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let count_after_border = sim.authority().store().entity_count();

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 4,
            action: Action::Place {
                origin: Pos { x: 64, y: 4 },
            },
        }],
        &mut out,
    );
    assert!(
        matches!(out[0].result, Err(Rejected::Game(Reject::Blocked))),
        "an overlap across a chunk border (at the non-anchor tile of the existing machine) must \
         also be rejected"
    );
    assert_eq!(
        sim.authority().store().entity_count(),
        count_after_border,
        "a rejected cross-border Place must record no write"
    );
}
