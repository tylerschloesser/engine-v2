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

## Cut 2 (steps 3-5): exact seam shapes as landed

Built against the exact seam shapes in the section above (`UI_RECORD_KIND_UI = 1`,
`UiObserver::mark_dirty()`, `ClientCore::mutations()`, the delivery-order fix). Commits `M16b step
3: ...`, `M16b step 4: ...`, `M16b step 5: ...`, plus one `M16b: ...` context-artifact commit for
the `add-action-type` skill. Base `20ef818`.

### `client_ui_mark_dirty`: the dirty-flag test-only export (`ABI_VERSION` 12 -> 13)

Exactly the shape steps 1-2's own Deviations named ("something in the shape of `sim_warm_one`/
`client_gen_stats`'s own 'test hook' convention"), but actually mirrors `sim_region_hash`/
`client_region_hash`/`sim_conn_counters`'s own shape more closely -- a zero-param, zero-region
export reached only through `callParked`, not a production-facing one:

```rust
// abi/registry.rs, Instance trait:
fn client_ui_mark_dirty(&mut self) -> Status { Status::Unsupported }
// export_instance!'s extern wrapper:
pub extern "C" fn client_ui_mark_dirty() -> u32 { $crate::abi::client_ui_mark_dirty(&__ENGINE_SLOT) as u32 }
// abi/mod.rs:
pub fn client_ui_mark_dirty<T: Instance>(slot: &Slot<T>) -> Status { .. rt.inst.client_ui_mark_dirty() }
// game_instance.rs, GameInstance<G>:
fn client_ui_mark_dirty(&mut self) -> Status {
    match self { GameInstance::Client(c) => { c.ui.mark_dirty(); Status::Ok } _ => Status::Unsupported }
}
```

`src/abi.ts`: `client_ui_mark_dirty: { role: 'client', params: 0, result: 'status' }`, `ABI_VERSION
= 13`. No region crosses either way. `engine/test.markUiDirty(client): Promise<void>` (`test/
client.ts`) reaches it through `callParked(client, 'client', 'client_ui_mark_dirty', [], 0)`, the
same "reached by name through the parked-only `test-call` channel" shape `hostRegionHash`/
`replicaHash`/`netCounters` already use -- requires the client worker parked. Native test
`game_instance::tests::client_ui_mark_dirty_forces_a_rerun_with_no_new_frame` (a small `MGame`/
`MClient` pair whose `ui` reads a module-level `static AtomicU32` standing in for real client-side
state, since this test drives a `GameInstance` from the outside with no handle on `ClientInstance::
client` itself) proves the whole path end to end: a real replica mutation with the signal still at
`Default` writes nothing; the signal changing with no new host frame is unnoticed by a bare
`frame()` call; `client_ui_mark_dirty()` then a `frame()` call forces a real rerun that finds the
change and writes exactly `{"n":5}"`.

### `client.ts`'s UI-ring drain: exact shape

`pollActionResults` (unchanged name) now does one walk over every popped ring message in a drain,
tracking `lastUiText: string | undefined` (overwritten on every kind-1 record seen -- Planning
decisions' "coalesced to the newest value") and appending each kind-2 record's parsed `{seq,
result}` into two **reused, index-tracked, parallel arrays** (`pendingSeqs: number[]`,
`pendingOutcomes: ActionOutcome<unknown>[]`, a `pendingCount` local reset to 0 each call, `arr[i] =
x` not `.push`) rather than firing `onActionResult` inline as the old M16 code did -- necessary
because a kind-1 record can land *anywhere* in the byte stream relative to a kind-2 one (more than
one `on_frame` call can land between two drains, each with its own kind-1-then-kind-2 pair), so
whether a `Ui` record exists at all in this drain is only known once the whole walk is done. After
the walk: if `lastUiText` is set, `JSON.parse` it once and call every `onUi` listener; then replay
every pending `(seq, outcome)` pair to every `onActionResult` listener, in ring order -- "`onUi`
then results" therefore holds inside one drain regardless of the two kinds' relative byte order
(proven directly: `onui_fires_before_action_results` pushes the kind-2 record *first* in raw bytes
and still observes `['ui', 'result']`).

`client.onUi<Ui = unknown>(cb): () => void` mirrors `onActionResult<Reject>`'s own listener-array/
unsubscribe shape exactly. `client.clock(): ClockSnapshot` (`ClockSnapshot = { authoritative,
predicted, ticksPerSecond }`, all `number`) reads the clock block fresh every call into one reused
object, mutating its three fields in place -- **the function implementing it is named
`readClockSnapshot`, not `clock`**, because `clock` already names the injected `Clock` (`options.
test?.clock ?? systemClock`) the whole `createClient` closure scope closes over; the public `Client`
shape still gets the name `clock` via `clock: readClockSnapshot` in the returned object literal.
Reuses the same `clockScratch: Uint32Array(6)` `dispatch`/`waitForLive` already read into -- never
inside the same call as either, so sharing it costs nothing.

### Existing test adjusted, not weakened: `ui_ring_delivers_results_in_order`'s "unknown kind"

This M16-era unit test pushed a kind-1 record with 6 zero bytes as its body, commented "an unknown
kind (1, M16b's future `Ui` record)" -- exactly the placeholder this milestone was always going to
retire. Once kind 1 became real, `JSON.parse`ing that all-zero body would throw. Changed the raw
kind byte from `1` to `99` (a genuinely unclaimed kind) and reworded the comment; every assertion
and the two real kind-2 records the test proves arrive in order are untouched. This is a correction
to keep the test proving what it always proved (skip-an-unknown-kind, deliver known kinds in order),
not a weakening -- `onui_gets_only_latest_per_drain`/`onui_fires_before_action_results` (new) are
what now cover kind 1's own real behaviour.

### `fixtures/puts`: `PutsUi` and `PutsClient::ui`

```rust
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct PutsUi { pub motd: u32, pub note: u32, pub note_until: u32, pub global_ticks: u32 }
```

`note_until` crosses as a raw tick count (`u32`, `Tick::0`), not `engine::time::Tick` itself (no
`TS`/`Serialize` derive there, and adding one to a core engine type for one fixture field felt like
the wrong lever) -- 0006 "On the client" already expects the UI to derive remaining time from a raw
`done_at` tick plus `client.clock()`, never to read a `Tick` type across the boundary directly.
`PutsClient::ui` mirrors `Global::motd`/`day` (every client, 0011 "Scopes") into `motd`/
`global_ticks`, and the caller's own `Player::note`/`note_until` (via `view.world().player(view.
me())`) into `note`/`note_until` -- `0`/`0` on `Err(Unknown)` (not yet replicated), matching a
never-set-or-already-expired note's own value, so a page never has to special-case "not replicated
yet" separately from "no note".

### `puts-ui.html`/`src/puts-ui.ts`: the fixture page, and a real trap it found

A real, connected topology (`pumpUntilLive`, `puts-dispatch.ts`'s own shape), `onUi<PutsUi>`
driving two `<div>`s (`#global` = `global_ticks`, `#progress` = a `note_until`/`clock()`-derived
remaining-ticks value, `0` when `note_until === 0`) -- the game-owned DOM overlay 0003 names, never
touched from anywhere but that one `onUi` handler. Both elements are seeded `'0'` at setup, before
the handler is even registered: `onUi` only ever fires for a change delivered *after* a listener
subscribes (the same "coalesced to the newest, but only from here on" shape `onActionResult` already
has), and `pumpUntilLive`'s own ticking happens *before* this page's `onUi` call, so a real change it
already produced (`Global.day`'s very first bump, `Puts::tick`'s own `cx.tick().0 % 20 == 0` firing
at `cx.tick() == 0`, i.e. the first tick ever) would otherwise leave both elements blank forever.

**A real, reproducible hang, found live and fixed before it reached a committed test**: two
`stepTick`-family calls in a row, with no `resumeWorkers` in between, hangs the *second* one's own
`stepSimTickSync` forever (`SPIN_LIMIT` exhausted, no error, no console output -- a silent spin, not
a crash) -- `stepTick`'s own trailing `untilQuiescent()` parks every worker as its postcondition
(Seams doc comment on `ClientTestHandle.workersReady` and `untilQuiescent` itself), and a parked
worker's `Atomics.wait` is not woken by a bare `Atomics.notify` the way `stepSimTickSync`'s own wake
assumes an already-running worker needs -- it needs the explicit `{ type: 'resume' }` message
`resumeWorkers` sends. `connected.ts`'s own `__advance` already does exactly this (`await
resumeWorkers(client)` first, every call, "safe and cheap" even when nothing was parked) but nothing
documented it as a *rule* before this cut hit it directly: a fixed `page.evaluate` reproduction
(`__dispatchSetNote` then a bare second `__stepTick(1)`) hung at `SPIN_LIMIT`, confirmed cured by
inserting `__resume()` first. `puts-ui.spec.ts`'s own `advance(page, ticks)` helper does this before
every `__stepTick` call, including the first (a no-op there). Recorded here since the next page that
chains more than one `stepTick`/`stepSimTickSync` call per test will hit the identical silent hang
otherwise.

A **second, separate cross-thread-race finding**: dispatching an action and then advancing several
ticks *in one batched `stepSimTickSync(n)` call* can apply all `n` ticks before the client worker's
own action-ring drain (a real, separate OS thread, woken by `dispatch`'s own `RingProducer.tryPush`)
ever gets a turn to admit it -- `stepSimTickSync` has no synchronous handshake with that drain the
way `stepFrame`'s own lockstep has with the client's frame ack. Fixed in the spec by ticking one at a
time, each its own `page.evaluate` round trip (a real wall-clock gap the client worker's OS thread
can run in), polling `__confirmed` rather than assuming a fixed tick count.

### `gc-ui.html`/`src/gc-ui.ts` + `budgets.json`'s `no_ui_change` entry: `no_ui_change_no_main_allocation`

A real, connected, bare-canvas (no renderer, `gc-sim.ts`'s own shape) topology: `on_frame` only
ever runs from a real client net pump, which only exists once linked, so a page with no connection
at all would never call `ClientSide::ui` even once. A real host tick runs only every
`TICK_EVERY_FRAMES = 50` frames (12 real ticks over the 600-frame window) -- ticking every frame,
`gc-connected-terrain.ts`'s own shape, would cross `fx-puts`'s own 20-tick `Global.day` boundary
roughly 30 times inside the window, which is a *different* test ( `dom_counter_follows_global`'s
own territory), not this one. At 12 ticks (pre-tick 0..11), the rule's own `% 20 == 0` guard fires
only at the very first tick, writing back exactly `PutsUi::default()`'s own values (`Global::
default()` is already `day: 0, motd: 0`, and nothing here ever dispatches `SetNote`/`SetMotd`), so
`push_ui_record` never runs for the life of this page -- `harness.stepFrame()` still runs every
frame regardless, so real per-frame client work ("ticks") keeps happening throughout.

**Measured `strict` first, as the brief's own note required** (no `"budgeted"` pre-emption):
`main` 21.88-22.07 B/frame across 8 clean runs (`playwright test --project gc --grep "no_ui_change
clean" --repeat-each 8 --workers 1`), `byFn` showing only the harness's own per-frame CDP
bookkeeping (`next@:0`, `isTypedArray@:65`, `entries@:0`, `values@:0`, `evaluate@:305`, `run@gc-
page`) -- **no `pollActionResults@client-*` entry at all**, the direct proof that zero UI-ring JSON
parsing happened. `ceil(22.07) = 23`, `+ 8` margin `= 31`. `client`: a constant 0.8333 B/frame
across 8 clean runs -- kept at the shared strict-worker `8` every sibling `client`/`gen0`/`sim` row
uses, not `ceil(0.83) + 8`. Software mode: a flat `0.4` B/frame attributed to `main` across 6 clean
runs (`GC_MODE=software`, `--repeat-each 6`); `ceil(0.4) = 1`, `+ 8 = 9`. Every control re-verified
at these final numbers: `object`/`burst` on both `main` and `client`, hardware and software clean,
all pass/trip as expected (`--repeat-each 4`, 20/20 hardware; `GC_MODE=software --repeat-each 4`,
4/4 clean). `budgets.json` edited as text (never parse-and-reserialize), confirmed by `git diff` as
a pure addition with no line outside the new block touched.

### `zero_gc_action` re-measured, not changed: a real, permanent baseline shift

Adding `type Ui = PutsUi` to `fixtures/puts` is a change every existing page built on that fixture
inherits, including `gc-slice.ts`'s own `zero_gc_action` page (M16, unrelated to this cut's own
Files touched, `slice.ts`/`gc-slice.ts` never edited here per the brief's own "don't touch" list).
`gc-slice.ts` calls `stepSimTickSync(client, 1)` every one of its 600 measured frames, so `Global.
day` now crosses `fx-puts`'s own 20-tick boundary about 30 times inside that window -- each one a
real kind-1 record `main`'s own `pollActionResults` now parses, on top of the ~20 kind-2 `dispatchRaw`
results the page already produced. **Re-measured** (`playwright test --project gc --grep
"zero_gc_action clean" --repeat-each 8 --workers 1`): `main` now reads 112.06-112.51 B/frame (was
106.59-106.92 pre-this-cut, M16's own Deviations) -- **still under the existing 115 B/frame budget**
(headroom narrowed from ~8 B to ~2.5 B, not exceeded), so **no `budgets.json` change was made**: the
brief names only `no_ui_change`'s own budget as this cut's to derive, and 0029's "never widen a
budget that stops a control tripping" cuts the other way too -- a budget that still holds needs no
touching. Every negative control on `zero_gc_action` (`object`/`burst`, all four isolates)
re-verified still passing/tripping at the unchanged `115` (`--repeat-each 4`, 36/36). Recorded here
as a genuine finding for whoever next changes `fx-puts`'s own `Ui` shape or tick rule: this page's
own headroom is real but thin now, and a further `Ui`-producing change to this fixture should
re-measure it again before assuming 115 still holds.

### Suite time (report.json durations, this machine)

`dom_counter_follows_global` 263 ms, `progress_from_done_at_and_clock` 276 ms, `no_ui_change clean`
501 ms, `no_ui_change neg object main` 500 ms, `no_ui_change neg object client` 382 ms -- five new
fast-tier tests, ~1.9 s combined, each well under 0020 §4's 3 s p95 target. Full `pnpm test`
(quiet): `rust pass 306 tests`, `unit pass 196 tests`, `wasm pass 44 tests`, `browser pass 122 tests
18s/25s` (was ~116-117 before this cut; +5 fast-tier tests here plus whatever M16c/M16d added in
between).

### Verified

`pnpm test rust -t ui_` -> `rust pass 10 tests`. `pnpm test unit -t onui` -> `unit pass 2 tests`.
`pnpm test browser -t dom_counter` -> `browser pass 1 tests`. `pnpm test browser -t
progress_from_done` -> `browser pass 1 tests`. `pnpm test browser -t no_ui_change` -> `browser pass
3 tests` (clean + 2 fast-tier `object` negatives; `burst` is `@slow`). `pnpm test browser -t
vertical_slice` -> `browser pass 1 tests` (unchanged, M16). `pnpm test browser -t zero_gc_action`
-> `browser pass 5 tests` (unchanged pass count, re-measured allocation above). Full `pnpm lint` ->
`biome pass · rustfmt pass · clippy pass · tsc pass`. Full `pnpm test` -> all four suites pass, as
above.

### Decisions needed / notes for later milestones

- `zero_gc_action`'s own `main` headroom is now ~2.5 B/frame, not ~8 B: a future change to
  `fx-puts`'s `Ui`/tick rule should re-measure that page, not assume the existing 115 still holds by
  a wide margin.
- `docs/plan/device-checks.md`: brief says "none"; untouched.
