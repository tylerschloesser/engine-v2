# 0037: Host-side `apply` atomicity: the undo journal is adopted

Status: Accepted (2026-09-25). Settles the item deferred in [0003](0003-game-facing-api.md)
Consequences (4), [0004](0004-action-timing-and-rejection.md) Consequences and
[0012](0012-prediction-and-reconciliation.md) Consequences ("enforcing host-side atomicity of
`apply` with an undo journal, because its cost is unmeasured"). Implemented in M21b
(`docs/plan/21b-timers-wakeups-and-tickcx.md`).

## Context

`Game::apply` must validate before it writes, so that a rejected action leaves the world exactly as
it found it ([0003](0003-game-facing-api.md) "the author's rules: validate first, write after").
Since [0012](0012-prediction-and-reconciliation.md), the host has enforced this only by assertion:
`Sim::step` panics if a rejecting `apply` recorded any write, catching a broken handler in
development but doing nothing for one that slips through review. The alternative — an undo journal
that records enough to roll a bad write back — was named in three ADRs and built by none, because
its cost was unmeasured: a per-write recording pass added to every `apply` call, for a benefit
(atomicity beyond an assert) that only matters when a handler is already wrong.
[0023](0023-action-growth-declaration.md) fixed the bar precisely, for exactly this milestone to
clear or miss: "adopt if median `apply` cost rises ≤ 10% and the counting allocator shows zero
steady-state allocations."

## Decision

**1. Adopt.** `UndoJournal<G>` (`packages/engine/crates/engine/src/authority.rs`) records, on the
first touch of each key within one `apply` call, its pre-image: the old `Tile`, the old
`Option<G::Entity>` (covers both a put and a despawn), the old `Option<G::Player>`, or the old
`G::Global`, plus whether an `Authority`-side entity put pushed a wake-up (0007 §7's auto-wake,
`docs/plan/21b-timers-wakeups-and-tickcx.md`). `Sim::step` begins recording before every `G::apply`
call and discards it on `Ok`; a rejecting `apply` that nonetheless wrote replays the journal
backwards, restoring the store directly. Because the replay goes through `Store::apply`'s own
inverse deltas, every side effect `Store::apply` itself derives — `ChunkIndex`, `entity_count`,
`modified_tile_count` — is restored for free; only the wake-queue push needed its own explicit undo
entry. `journal_rolls_back_store_indexes_wakes_counts`
(`packages/engine/crates/engine/tests/undo_journal.rs`) proves all four, independent of this
decision, via a test-only bypass of the panic/rollback branch below.

**2. Debug and test builds keep the panic, unconditionally.** `Authority::
handle_rejected_apply_write` checks `UNDO_JOURNAL_ADOPTED && !cfg!(debug_assertions)`: adopting the
journal changes only the release-build branch. A handler that writes before validating still panics
immediately in every build an author runs locally or in CI, naming the action and the violation —
the journal is a release-mode safety net, not a replacement for that feedback. This also means
adopting it changed no existing test's behavior: every test in this crate builds with
`debug_assertions` on.

**3. Measured** (`fixtures/machines/tests/journal_bench.rs`, `slow_apply_journal_overhead`, slow
tier, native, `fx-machines`): 10,000 mixed `Place`/`Feed`/`Move`/`Remove` actions in bounded,
self-contained tetrads over 50 round-robin origins, about 5% deliberately rejecting
(`Reject::NotFound`, a clean validate-first reject that never touches the journal), journal
recording on vs off, median of 7 trials each.

| | Median (10k actions) |
|---|---|
| Baseline (journal disabled) | 1.990167 ms |
| With journal | 2.040458 ms |
| Overhead | **2.5%** |

Steady-state allocation: after warm-up, one further full script pass with the journal on grew the
counting allocator's (`engine::abi::Arena`) live bytes by **0 B**. Both numbers clear
[0023](0023-action-growth-declaration.md)'s bar by a wide margin (2.5% ≪ 10%; 0 B growth, not merely
a small one), so the decision is adopt, not a closer call this ADR needs to hedge.

**4. Released, not yet used: [0023](0023-action-growth-declaration.md)'s own noted alternative.**
That ADR's Alternatives rejected lists "apply, measure, roll back if over budget" as exact but
blocked on this same undo journal, and says outright: "if the journal is adopted this can replace
the declaration without touching logs: both reject the same actions only when declarations are
exact, so the switch would be a build (sim identity) change like any rules change." The journal
existing does not itself change the growth-declaration mechanism — `Game::growth` and the
pre-`apply` state-budget check are unchanged by this milestone (Non-scope) — it only means that
substitution is now buildable, should a future milestone want the more precise check.

## Alternatives rejected

- **Not adopting** (keep the assert as the only enforcement, forever). Was the default outcome had
  either measurement missed the bar; the numbers above did not require it.
- **Recording only when a handler is already suspected of misbehaving** (e.g. only in a
  fuzz/property-test harness, never in the normal path). Would leave production release builds with
  no atomicity guarantee at all, the exact gap [0012](0012-prediction-and-reconciliation.md) deferred
  closing; the measured cost of recording unconditionally is low enough that there is no reason to.
- **Panicking in release builds too, journal or not.** Rejected by the milestone brief itself
  (`docs/plan/21b-timers-wakeups-and-tickcx.md` Planning decisions): a released game should not crash
  a live world over a bug the journal can quietly correct; the violation is still visible through
  `Authority::apply_rollbacks` and a `warn` log (mirroring [0023](0023-action-growth-declaration.md)'s
  own growth-audit convention), not silently swallowed.

## Consequences

- `Rejected(Game(_))` outcomes are unconditionally atomic in every build now, not merely in the ones
  where the author's own `apply` code happens to be correct.
- A game author who ships a handler that writes before validating no longer risks a wedged or
  torn world in production (0005's panic-recovery path is unaffected: this covers a rejecting
  `apply`, not a panicking one); they still see the panic in every debug and test run, so the
  incentive to fix it is unchanged.
- `Authority::apply_rollbacks` is a new counter (`engine::test`-visible via `Authority::
  apply_rollbacks()`), never hashed or replicated, for the same reason `growth_violations`
  (0023) is not: it is host-diagnostic, not sim state.
- Deferred, not part of this decision: actually replacing the growth-declaration check with
  "apply, measure, roll back" (item 4 above) — no milestone has asked for the extra precision yet.
- The trigger to revisit: if a future measurement (a heavier action mix, a game with much larger
  per-write payloads) shows the overhead climbing past the 10% bar on real content, the flag can be
  flipped back to `false` without touching any other code, since the assert path was never removed.

## Sources

- [0003](0003-game-facing-api.md) Consequences (4); [0004](0004-action-timing-and-rejection.md)
  Consequences; [0012](0012-prediction-and-reconciliation.md) Consequences; [0023](
  0023-action-growth-declaration.md) Alternatives rejected ("Apply, measure, roll back") and its own
  adopt criterion.
- Measured 2026-09-25, this repository, `fixtures/machines/tests/journal_bench.rs`
  (`slow_apply_journal_overhead`), `cargo nextest run -p fx-machines --features engine/testing
  --test journal_bench -P slow --no-capture`, this machine (Apple Silicon, native `dev` test
  profile — a bench for a release-mode decision, run in the profile the repository's own tooling
  provides; no separate `--release` harness exists for this milestone to build one).
