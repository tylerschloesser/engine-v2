# M16b: `G::Ui` → UI ring → `onUi`, and `client.clock()`

Status: not started · After: 16 · Tyler-dependent: PRE-PLAN §11 item 1 (`serde_json`; assumed approved)

Split from M16 (size). M17 depends on this milestone (it grows the `FrameView` defined here).

## Goal
When the replica changes or client-side state is marked dirty (0024 §7d), the engine calls `ClientSide::ui` into a reused `G::Ui`, and only if the value differs writes its JSON to the UI ring; the main thread parses once per change and calls `client.onUi`. `client.clock()` exposes the clock block. A fixture page shows a DOM counter driven by `onUi` and a progress value derived from a `done_at` tick and `clock()`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0003-game-facing-api.md` ("How the UI observes state"; `ClientSide::ui`; `type Ui` bounds)
3. `docs/decisions/0006-time-units.md` ("On the client")
4. `docs/decisions/0016-zero-gc-definition.md` (§2 exemptions: what on this path is and is not inside the measured window)

Rules: `.claude/rules/hot-paths.md`.

## Scope
- **Minimal `FrameView<'_, G>`** (fills M12's shell) with exactly the three accessors M17 extends: `world() -> &dyn WorldRead<G>` (delegates to `ClientCore::view()`), `clocks() -> Clocks { authoritative: Tick, predicted: Tick }` (equal until M26), `me() -> PlayerId`. M17 adds visible rect, zoom, cursor tile, presences (0018).
- **`ui` call policy:** inside `frame(t_ms)`, after `on_frame`s were applied, iff a frame mutated the replica since the last call **or the client-side dirty flag is set** (0024 §7d: `Ui` may depend on client-side state such as the presence spring; M18 lands `FrameCx::ui_dirty()`, which sets the flag from `ClientSide::frame`; this milestone owns the policy and the flag, set in tests through a test hook). M25 adds "or the overlay changed". The `PartialEq` gate below is unchanged. `G::Client` is constructed with `Default` at client init and lives for the instance.
- **Change detection and encode:** two `G::Ui` values (current, previous) allocated once; `ui` writes into `current`; if `current != previous`, serialise with `serde_json` into the UI-out region as a kind-1 record (`[kind u8 = 1][len][JSON]`), swap. `G::Ui` may own `Vec`/`String` (it is not replicated), so this path may allocate inside the WASM arena; it must not grow memory.
- **Main rAF:** in the single UI-ring drain of M16, keep only the **last** kind-1 record, `JSON.parse` it once, call `onUi(ui)` before any `onActionResult` of the same drain. No record → no call, no allocation.
- **`client.clock()`** returns a reused object `{ authoritative, predicted, ticksPerSecond }` refreshed from the clock block on call (no allocation per call).
- **Fixture:** `puts` gets `type Ui = PutsUi { motd, note, note_until, global_ticks }` with `TS`; `type Client = PutsClient` implementing `ui` only. Bindings regenerate.

## Non-scope
`extract`, DrawList, full `FrameView` (M17). `ClientSide::frame`, `FrameCx` (M18), presence (M19). Overlay anchors (M18). Predicted clock and lead (M26). Engine events on the TS surface (`onResyncing` M28b, `onLink` M29, the rest and the audit M37).

## Files, packages and crates touched
`packages/engine/src` (`client.ts`, `test.ts`), `packages/engine/crates/engine` (`client/ui.rs`, `client/frame_view.rs`), `packages/engine/fixtures/puts`.

## Seams
**Provides:** minimal `FrameView::{world, clocks, me}` (M17 grows it), `Clocks`; the `ui` call policy with its client-side dirty flag (0024 §7d; M18 adds `FrameCx::ui_dirty()`); UI-ring record kind 1; `client.onUi`, `client.clock`; `engine/test` `lastUi()`; the delivery-order rule "`onUi` then results" implemented.
**Consumes:** M16 UI ring drain, `client_poll_ui`, clock block; M15 `ClientCore::view`, `FrameSummary`; M12 `ClientSide`, `FrameView` shell.

## Planning decisions
- **`Ui` is coalesced to the newest value per rAF; action results are never coalesced.** `Ui` is state (latest wins), a result is an event. One ring with two kinds keeps their relative order observable.
- **"Changed" is decided by `PartialEq` on the Rust value, not by comparing JSON bytes,** per 0003; the JSON buffer is written only after inequality, so an unchanged UI costs one `ui` call and one comparison per frame in which `ui` ran and nothing on main.
- **`clock()` returns a reused object.** A fresh object per call would put game-UI polling on the main isolate's budget; the docs for game authors say "read the fields, do not keep the object".

## Order of work
1. `FrameView` minimal + `ui` policy, native test with a test `ClientSide`. 2. encode + kind-1 record. 3. main drain changes, `onUi`, `clock()`. 4. fixture `Ui`, bindings, page. 5. browser tests.

## Tests added
Rust: `ui_called_only_after_replica_change` (no `ClientSide::frame` caller yet), `ui_reruns_when_dirty_flag_set` (a test `ClientSide` whose `ui` depends on a client-side field; the test hook mutates it and sets the flag; M18 adds `FrameCx::ui_dirty()` as the production setter), `ui_unchanged_value_writes_nothing`, `ui_json_matches_ts_shape` (golden JSON for `PutsUi`). TS unit: `onui_gets_only_latest_per_drain`, `onui_fires_before_action_results`, `clock_returns_same_object`. Browser: `dom_counter_follows_global` (fixture page text equals the `Global` counter after `stepTick(40)`), `no_ui_change_no_main_allocation` (M04 harness, 600 frames with ticks but a constant `Ui`), `progress_from_done_at_and_clock`.

## Exit criteria
- [ ] All tests above pass; `vertical_slice` (M16) still passes.
- [ ] Regenerated `bindings/PutsUi.ts` is committed and the fixture page type-checks against it.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t ui_` · `pnpm test unit -t onui` · `pnpm test browser -t dom_counter` · `pnpm lint`.

## Budgets
Allocation per isolate, main row: unchanged `Ui` adds 0 B/frame (`no_ui_change_no_main_allocation`). Client worker row: the `ui` call with a constant value stays inside the worker budget.

## Context artifacts
Update the `add-action-type` skill with the "surface the outcome in `Ui`" step if the session found it missing.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
