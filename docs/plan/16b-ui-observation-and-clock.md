# M16b: `G::Ui` → UI ring → `onUi`, and `client.clock()`

Status: not started · After: 16d · Tyler-dependent: no (Q1 answered: `serde_json` approved)

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

**This section covers steps 1-2 only** (commits `M16b step 1: ...`, `M16b step 2: ...`, base
`df678f5`). Steps 3-5 (TS drain, `onUi`, `clock()`, fixture `Ui`, page, browser tests) are a second
implementer's, built against the exact seam shapes below.

### Files, beyond the brief's own list

`packages/engine/crates/engine/src/client/frame_view.rs` (new), `client/ui.rs` (new) -- the brief's
own Files-touched line already names these two. Also touched, not named there: `client/texel.rs`
(`ClientSide::extract`/`ui` signatures), `client/core.rs` (`ClientCore::mutations()`), `game.rs`
(`FrameView`/`Clocks` re-export), `client.rs` (module wiring), `Cargo.toml` (`no_alloc_ui`'s
`[[test]]` entry). No fixture, page or TS file touched -- `fixtures/puts` is untouched; step 1's own
`ui_json_matches_ts_shape` test uses a local test-only `Ui`/`Game` (see below), not `PutsUi`.

### `FrameView<'a, G>` and `Clocks`: exact shapes (`client/frame_view.rs`)

```rust
pub struct Clocks { pub authoritative: Tick, pub predicted: Tick }  // Clone, Copy, PartialEq, Eq, Debug, Default

pub struct FrameView<'a, G: Game> { /* private: world, clocks, me */ }
impl<'a, G: Game> FrameView<'a, G> {
    pub fn new(world: &'a dyn WorldRead<G>, clocks: Clocks, me: PlayerId) -> Self;
    pub fn world(&self) -> &dyn WorldRead<G>;
    pub fn clocks(&self) -> Clocks;
    pub fn me(&self) -> PlayerId;
}
```

Re-exported at `crate::client::{FrameView, Clocks}` and, for the existing `crate::game::FrameView`
import path every `ClientSide` implementor already uses, `pub use crate::client::frame_view::
{Clocks, FrameView};` in `game.rs` -- the same re-export pattern `TickCx` already established
(`game.rs` no longer defines a `FrameView` shell struct at all). **`ClientSide::extract`/`ui`'s own
signatures changed** from `&FrameView<G>` (never valid Rust once `FrameView` takes a lifetime) to
`&FrameView<'_, G>` (`client/texel.rs`) -- the only breaking change to an existing seam in this cut;
`fixtures/puts`'s `PutsClient` and `fixtures/terrain`'s `Vis` both compile unchanged (neither
overrides `ui`/`extract`).

### `ClientCore::mutations()`: the "since the last call" signal (`client/core.rs`)

```rust
pub fn mutations(&self) -> u64
```

New field `mutations: u64` on `ClientCore<G>`, `wrapping_add(1)`'d at the end of `on_frame`'s
success path (after `apply`, before returning `Ok`). Every applied frame bumps it, including a bare
heartbeat (no sections): `apply` always calls `Replica::set_tick`, so "on_frame ran" and "the
replica mutated" coincide for every real frame -- this is a call counter, not a diff of the replica
itself, and is documented as such at its definition.

### `UiObserver<G>`: the policy (`client/ui.rs`)

```rust
pub struct UiObserver<G: Game> { /* private: current: G::Ui, previous: G::Ui, dirty: bool, last_mutations: u64 */ }
impl<G: Game> UiObserver<G> {
    pub fn new() -> Self;                                   // G::Ui::default() x2, dirty=false, last_mutations=0
    pub fn mark_dirty(&mut self);                            // the dirty-flag setter -- see below
    pub fn maybe_run(&mut self, client: &G::Client, view: &FrameView<'_, G>, mutations: u64, out: &mut Vec<u8>) -> bool;
}
impl<G: Game> Default for UiObserver<G> { .. }                // delegates to new()
```

`maybe_run`'s policy, exactly as Scope: `should_run = mutations != self.last_mutations ||
self.dirty`; if not, returns `false` with zero cost (no `ui` call, no comparison). If it runs:
records `last_mutations`, clears `dirty`, calls `client.ui(view, &mut self.current)`, compares
`self.current != self.previous`; on a real change, appends the kind-1 record to `out` (`push_ui_
record::<G>`, private to this module: `serde_json::to_string` + `[1u8][len u32 LE][json bytes]`)
and `core::mem::swap`s `current`/`previous`, returning `true`; otherwise returns `false`. Re-exported
at `crate::client::UiObserver`.

**Kind-1 constant**: `const UI_RECORD_KIND_UI: u8 = 1`, private to `client::ui` (mirrors
`game_instance.rs`'s own private `UI_RECORD_KIND_ACTION_RESULT: u8 = 2` -- neither is exported;
a consumer outside the crate never needs the numeric value by name, only the record shape).

**The dirty-flag setter, for cut 2**: `UiObserver::mark_dirty(&mut self)` is the only setter that
exists after this cut. It is reachable natively (this cut's own tests call it directly) but **not
yet reachable from TypeScript or a browser test** -- no ABI export was added for it, since nothing
in steps 1-2 needs one and `ClientSide::frame`/`FrameCx` (M18's own job, still a no-op shell) is the
only planned production caller. **Cut 2 needs to add its own test-only ABI export** (something in
the shape of `sim_warm_one`/`client_gen_stats`'s "test hook" convention, e.g. a new `Instance`
method + extern wrapper that reaches `ClientInstance::ui.mark_dirty()`) if `ui_reruns_when_dirty_
flag_set`'s browser-level equivalent needs to set the flag from a Playwright test before M18 lands a
real production setter. **Any such export bumps `ABI_VERSION`** (unchanged at 12 by this cut: no
export was added, no existing export's params/result changed).

### Where `G::Client` is constructed, and where the `ui` call sits (`game_instance.rs`)

`ClientInstance<G>` gained two fields: `client: G::Client` (built once, `G::Client::default()`, in
`ClientInstance::init` -- lives for the instance, never reconstructed) and `ui: UiObserver<G>`
(`UiObserver::new()`, same place).

**Gate fix ("Delivery order"), replacing this section's own first draft.** The first draft ran
`ui.maybe_run` only inside `GameInstance::frame` (the `frame(t_ms)` ABI export), reasoning "by the
time this runs, every `on_frame` applied since the last `frame` call has already landed" -- true,
but irrelevant to the bug: `worker/client.ts`'s `body()` calls `frame()` **before** `netPump.pump()`
(which calls `on_frame`), so a given wake's `frame()` call reflects replica state as of the
*previous* wake, not the frame `on_frame` is about to apply *this* wake. A frame that both mutates
state `ui` reads and carries an action result therefore drained as `[Result(Confirmed)]` with no
accompanying `Ui` record at all in that same drain -- the *opposite* of "a result handler sees
current state" (M16 brief, M16b Planning decisions). Confirmed live: `ui_record_precedes_its_own_
frames_action_result_and_reflects_the_mutation`, written against the first draft, failed with
`records == [(2, "{\"seq\":1,\"result\":\"Confirmed\"}")]` -- zero kind-1 records, not merely
mis-ordered ones.

**Fix: the `ui` call now also runs inside `GameInstance::on_frame`'s `Client` arm**, immediately
after `core.on_frame(bytes)` succeeds (replica already mutated) and the dirty-chunk drain, but
**before** `core.drain_results` pushes that same frame's kind-2 records:

```rust
// on_frame, right after core.on_frame(bytes) => Ok(_) and the drain_dirty_for_upload call:
let mutations = core.mutations();
let replica = core.view();                                    // &Replica<G>: WorldRead<G>
let clocks = Clocks { authoritative: replica.tick(), predicted: replica.tick() };  // = until M26
let me = replica.own_player();
let view = FrameView::new(replica as &dyn WorldRead<G>, clocks, me);
ui.maybe_run(client, &view, mutations, ui_buf);                // BEFORE core.drain_results below
core.drain_results(|seq, result| push_result_record::<G>(ui_buf, seq, result));
```

This ties a kind-1 record directly to the frame that produced it, at zero added latency (no "hold
results pending a rAF" scheme, one of the two candidates offered -- rejected: it would cost a whole
extra rAF of result latency against 0004/0012's "at most one tick plus the network" budget, for no
benefit once the call site itself moves). `on_frame` can run more than once per wake (once per
downlink message `netPump.pump()` drains); each call independently orders its own kind-1 before its
own kind-2, which is correct regardless of how many times that happens.

**`GameInstance::frame`'s own call to `ui.maybe_run` is unchanged and still there**, now normally a
no-op (`mutations` already matches what the `on_frame` call above just recorded) -- it remains the
only path for the dirty-flag-only case: client-side state changed (M18's future `FrameCx::
ui_dirty()`) with **no** new host frame since the last check. No double-append risk: `UiObserver`'s
own `should_run` gate (`mutations != last_mutations || dirty`) is false on this second call unless
the flag was set in between.

`ui_buf` is the *same* `Vec<u8>` `push_result_record` (kind 2) already appends to and `client_poll_
ui` already drains record-by-record (M16, unchanged) -- a kind-1 record lands in it exactly like a
kind-2 one, and `client_poll_ui`'s own never-split/drop-if-too-big contract (M16 Deviations) applies
identically to both kinds, since it only ever looks at `[kind][len]`.

**Delivery order now holds by construction, not by coincidence of wake ordering.** The Provides'
rule ("`onUi` then results") no longer depends on `worker/client.ts`'s `frame`-before-`on_frame`
wake order at all: it is enforced entirely inside `on_frame` itself, on the native side, so cut 2's
TS drain has nothing further to prove about ordering -- it only needs to preserve `ui_buf`'s own
append order when copying it onto `uiRing` (already true, unchanged: `client_poll_ui` copies whole
records in order).

### `ui_json_matches_ts_shape`, and why it does not use `PutsUi`

The brief allows adding `fixtures/puts`'s `type Ui = PutsUi`/`type Client = PutsClient` now if the
golden-JSON test needs it (step 4's own fixture work, pulled forward). Not done: `push_ui_record`'s
shape is plain `serde_json::to_string` with no envelope beyond the kind-1 record header, provable
with any `Serialize + TS` type, so `client/ui.rs`'s own test module builds a local `UUi { n: u32 }`
and asserts the record bytes decode to `{"n":42}`. Keeps this cut inside `crates/engine` only, as
the brief's own Files-touched line for steps 1-2 lists; cut 2's step 4 adds `PutsUi` for real once a
fixture page needs one.

### Zero-GC proof: `tests/no_alloc_ui.rs` (new test binary, `required-features = ["testing"]`)

`ui_constant_value_does_not_grow_the_arena`: builds a real `GameInstance::<NGame>` (`Role::Client`)
with a `Copy`-only `NUi { motd_id: u32 }` and an `NClient` whose `ui` always writes the same value,
drives 40 warm-up `(on_frame heartbeat, frame)` pairs (past the one real `Default` -> constant
change), then measures `abi::arena::live_bytes()` growth over 300 and 1,200 further frames and
asserts equality (M15's own template, "equality, not a budget"). **Measured**: both windows read `0`
B of growth in the passing run. **Failability proven** (required by the brief) by temporarily making
`NClient::ui` write a different value every call: `8,064` B over 300 frames vs `35,712` B over 1,200
(`~30.72` B/frame of growth the longer window alone paid for) -- watched red, reverted before
committing.

### Verified

Pre-gate-fix: `pnpm test rust -t ui_` -> `rust pass 8 tests`; `pnpm test rust` (full) -> `rust pass
303 tests`; `pnpm test wasm -t puts` -> `wasm pass 3 tests`; `pnpm test wasm -t terrain` -> `wasm
pass 3 tests`; `pnpm lint` -> `biome pass · rustfmt pass · clippy pass · tsc pass`.

Post-gate-fix (delivery order): `cargo nextest run --features testing -E 'test(ui_record_precedes)'`
against the pre-fix code -> **FAILED**, `records == [(2, "{\"seq\":1,\"result\":\"Confirmed\"}")]`,
`left: 1, right: 2` (asserted 2 records, got 1 -- zero `Ui` records at all in that drain). After the
fix: same command -> `PASS`; `cargo nextest run --features testing -E 'test(ui_record_precedes) or
test(ui_) or binary(no_alloc_ui) or test(client_poll_ui)'` -> `9 tests run: 9 passed` (the new
ordering test, all `client::ui::tests::*`, all `client_poll_ui_*`, and `no_alloc_ui` still equal-
growth). `pnpm test rust` (full) -> `rust pass 304 tests`. `pnpm lint` -> `biome pass · rustfmt pass
· clippy pass · tsc pass`. Full `pnpm test`/`pnpm test:slow`/browser suites not run (delegation
prompt: targeted runs only, orchestrator gates the full suite).

### Decisions needed / notes for cut 2

- A test-only ABI export for the dirty flag (see above) -- exact name/signature and the
  `ABI_VERSION` bump are cut 2's to choose and record.
- The `context artifacts` line ("update `add-action-type` with a 'surface the outcome in `Ui`' step
  if the session found it missing") was not exercised: this cut never added an action whose outcome
  is surfaced through `Ui` (that needs a real fixture `Ui` field, cut 2's step 4). Left for cut 2 to
  judge once `PutsUi` exists.
- `docs/plan/device-checks.md`: brief says "none"; untouched.
