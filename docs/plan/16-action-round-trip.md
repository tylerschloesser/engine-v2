# M16: Action round trip (vertical slice complete)

Status: done · After: 15b · Tyler-dependent: no (Q1 answered: `serde_json` approved) · Device checklist attached (**D**)

Split: `G::Ui` → UI ring → `onUi`, `client.clock()` and the minimal `FrameView` moved to `16b-ui-observation-and-clock.md` (size). M17 depends on 16b; M21 depends on this milestone only.

**Dependency note: this milestone's real "After" is now M15c, not M15b.** `docs/plan/15b-ring-connection-and-replica-rendering.md`'s Deviations moved `overlay_tile_reaches_screen` and the zero-GC panning window to `docs/plan/15c-terrain-visibility-and-cache-invalidation.md` at M15b's own gate: a chunk the client had already pristine-generated and then received a host snapshot for never came back resident while the camera held still, a pre-existing M07/M08b cache-invalidation gap M15b's own code did not introduce and could not fix in scope. This milestone's own vertical-slice marker below ("chunked world on screen") is part of M15c's own Goal, so build against M15c, not M15b, once it lands.

## M15b seams this milestone builds on
M15b landed the following surface first; read `docs/plan/15b-ring-connection-and-replica-rendering.md`'s Deviations in full before touching `client.ts`, `worker/sim.ts` or `host/`. Quoted from there rather than paraphrased, since the exact shapes matter:

- **ABI** (`ABI_VERSION` 9 -> 10): `on_frame(len) -> status` (client role; `len` bytes of the new `RegionId::Downlink` are one whole host frame, applied atomically via `ClientCore::on_frame`, then `Replica`'s dirty queue is drained straight into `Uploader::enqueue_chunk`/`patch_tile`). `client_poll_uplink(t_ms: f64) -> len` (client role; the raw `t_ms` argument is ignored, same shape as `frame`'s own `_raw_t_ms` — the real value is `camera.frame_time_ms`, already copied into the `Camera` region by the same worker pass that calls `frame` right before this).
- **`RingConnection`**'s surface: implements 0009 `Connection` over `SabSet.uplink` (`RingConsumer`) and `SabSet.downlink` (`RingProducer`), `datagrams: false`, no `bufferedAmount`. `send` copies the engine-owned view into ring slots; a full ring keeps the frame and retries next tick (0015 backpressure), counted in `downlinkRetries`; `drops` stays 0. `onMessage`/`onClose` are the 0009 `Connection` callbacks it implements. Two members a generic `Connection` doesn't carry, threaded via an optional-property cast pattern: `pumpRetries()` and `lastMessageLength`.
- **`SimHost.accept(connection)`**: allocates a `ConnId`, calls `sim_connect`, routes `onMessage` bytes → receive region → `sim_admit`, and after each tick `sim_build_frame(conn)` → `connection.send(MsgClass.ReliableOrdered, view)` when `len > 0`. `onClose` → `sim_disconnect`. **`PlayerId = conn + 1`, not `conn`**: `PlayerId(0)` is reserved as "none" (`game::PlayerId`'s own doc comment), so Rust's `Host::connect` assigns `PlayerId(conn + 1)`; `SimHost.accept`'s `ConnId` allocation stays 0-based and must line up with that offset.
- **Topology: the sim worker accepts a connection only when the SAB set it boots with actually carries a client link, and not otherwise.** `worker/sim.ts` creates and `SimHost.accept()`s a `RingConnection` only when `message.link === true`. Existing `sim`-kind pages drive ticks through `CB_SIM_STEP_REQ` and never create a client, so they carry no link, accept no connection, and keep `puts_idle_100`'s zero-connection topology by construction rather than by a flag someone has to remember not to set. **This milestone must not change that without a golden decision from the orchestrator**: `sim_worker_steps_and_hashes` compares `puts_idle_100` bit-for-bit and is `.wasm`-authoritative, read by the native Rust test from the same file (M13) — the repo's one continuous native-vs-wasm equality check.

## Goal
`client.dispatch(action)` returns a `seq`; the action travels action ring → JSON parse in the client instance → uplink → `admit` → the frame for T+1 → `apply` → `Ack` and its deltas in one network frame → `client.onActionResult(seq, result)`. No prediction. A Playwright test shows the whole slice: chunked world on screen, camera input, sim in a worker, one confirmed and one rejected action.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0004-action-timing-and-rejection.md` (all)
3. `docs/decisions/0003-game-facing-api.md` ("TypeScript types", "Actions across the boundary", last sentence of "How the UI observes state")
4. `docs/decisions/0017-packaging-and-build.md` (§5 "Bindings step", §7 dependency policy)

Also `crates/engine/src/wire/CLAUDE.md`. Mine from spikes: `spikes/prediction-api` `Client::on_frame` step 2 (pop by `ack_seq`, raise results). Rules: `hot-paths.md`, `determinism.md`.

## Scope
- **Main thread** (`client.ts`): `dispatch(action): number`; `onActionResult(cb)`; M06b's `Client.ready` now also waits for `session_state = 1`. `seq` counter seeded once from the clock block (below), first value `seed + 1`, never reset. Action-ring record: `[seq u32 LE][len u32 LE][UTF-8 JSON]`, then `Atomics.notify` of the client worker.
- **Clock block** (layout for M06's `SabSet.clockBlock` seqlock, client worker → main, 0015 §2 "clocks"): `authoritative_tick, predicted_tick (= authoritative until M26), ticks_per_second, session_state (0 connecting, 1 live), seq_seed, ack_seq`, all `u32`. Written by the client worker after each `on_frame`. `client.clock()` itself is M16b.
- **Client instance:** `on_action(len) -> status` (0014; the worker copies the ring record into `RegionId::Rx`): parse `seq` + JSON into `G::Action` (`serde_json`), re-encode with `Codec` into a fixed outbox (capacity = the 0012 pending-queue figure; M25 turns it into the pending queue); `poll_uplink` flushes actions at once (0010). `on_frame` reads `ActionResults`, and writes one result record per entry to `RegionId::Ui` (reserved for this milestone by M02): `[kind u8 = 2][len][JSON {"seq":n,"result":"Confirmed" | {"Rejected": <EngineReject or G::Reject as ts-rs types it>}}]`. New export `client_poll_ui() -> len`; the worker copies each record to `SabSet.uiRing`.
- **Main rAF:** drain the UI ring once; call `onActionResult` per kind-2 record in ring order (kind 1, `Ui`, is M16b: when both are present `onUi` fires first so a result handler sees current state).
- **Host:** `Host::on_uplink` decodes each action (`WireError` → `status` that makes `SimHost` close the connection, 0004 step 1), drops `seq <= last_seq` (resend dedup), calls `G::admit(&View, &PresenceTable::empty(), who, &a)`; failure → an `Outcome::Rejected` queued for that connection, **not** recorded; success → `Record::Action` appended to the frame being collected. `seal()` fixes that frame for T+1; `Sim::step` applies it; outcomes go to the sender's next `build_frame` as `ActionResults` in `seq` order with `ack_seq` in the header; a frame is built whenever there is an outcome (0004 "Acks ride on deltas").
- **Bindings step:** `buildGame()`/the Vite plugin run the native `export_bindings` test of 0017 §5 without gating reload; fixture `puts` derives `TS` on `Action`, `Reject`; output committed under the fixture's `bindings/`; `pnpm lint` type-checks a fixture page that calls `dispatch` with the generated type.
- **Slice page `slice.html`** (+ `src/slice.ts`, fixture app `tests/browser/pages/`, fixture `puts`, single-player topology): the page `vertical_slice` drives and the page Tyler opens on the phone, so it is listed by `pnpm device:serve`. It has a Paint control (a button that dispatches `Paint` at the tile under the screen centre) and an on-page HUD, diagnostic only and outside the zero-GC rule (as M09b's HUD): `isolated`, adapter, workers ready, `confirmed` and `rejected` (counts from `onActionResult`), `ring drops` (sum of `stats().drops` over the `SabSet` rings, M06), `engine_mem_grows` per instance (`asHarness(client).memGrows()`, M06b), and `tick` (`authoritative_tick` from the clock block). `?hud=0` hides it for the zero-GC window.
- **Skill** `.claude/skills/add-action-type/SKILL.md`, written last from what was actually done.

## Non-scope
Prediction, `NotPredictable`, pending replay (M25). Persistence (M22). Action rate limit and `RateLimited` (M31). Presence table content and witness checks (M19). State-budget check (M21). `Hello`/`Welcome` (M28), resend after reconnect (M28b). `onUi`, `clock()` (M16b).

## Files, packages and crates touched
`packages/engine/src` (`client.ts`, `worker.ts`, `vite.ts`, `test.ts`), `packages/engine/tests/browser/pages/{slice.html, src/slice.ts}`, `packages/engine/crates/engine` (`abi/client.rs`, `client/`, `host/`), `packages/engine/fixtures/puts`. Plus `.claude/skills/`.

## Seams
**Provides:** `client.dispatch`, `client.onActionResult`, the extended meaning of `client.ready`; clock block layout; action-ring and UI-ring record formats (kind 2); exports `on_action`, `client_poll_ui`; `Host` admit pipeline; `engine/test` `dispatchRaw(seq, jsonBytes)` (pre-encoded, for the zero-GC window per 0016 §2) and `actionResults()`; golden `wasm_script_a_matches_native`; page `slice.html` with its HUD field names (`confirmed`, `rejected`, `ring drops`, `engine_mem_grows`, `tick`; M23's world page and M39-large-save read the same names); skill `add-action-type`.
**Consumes:** M15b `SimHost.accept`, `sim_admit`, `sim_build_frame`, `on_frame`, `client_poll_uplink`; M15 `Host`, `ClientCore`; M14 `ActionResultsWriter/Reader`, uplink actions; M13 `sim_seal_frame`, `logSink`; M12b `Record`, `Outcome`; M06 `SabSet.{actionRing, uiRing, clockBlock}`, `SeqlockWriter`/`SeqlockReader`; M06b `Client`, `untilQuiescent`; M11 `injectPointer`; M09 `renderTo`/`readPixels`/`expectPixel`; M02 `buildGame`, `abi::registry`, `pnpm golden`; M02b the Vite plugin.

## Planning decisions
- **How write-ahead ordering is preserved for M22.** Admission only *collects* records. `sim_seal_frame()` (M13) is the single point where the frame for T+1 becomes immutable; `SimHost` calls `logSink` between it and `sim_tick()`. Here the export still returns 0, and `host_applies_only_sealed_records` proves an action admitted after the seal lands in T+2. M22 makes the export emit the 0005 log frame and sets `logSink = storage.append`; no call order changes.
- **How main learns the `seq` seed (PRE-PLAN §10 gap).** Carrier: `seq_seed` + `session_state` in the clock block. Until M28 the client worker sets them from the **first frame's `ack_seq`** (the host's `last_seq` for this player, which is what `Welcome.last_processed_action_seq` will carry); M28 switches the source to `Welcome` and nothing on main changes. Main reads the seed exactly once, when `session_state` first becomes 1.
- **`dispatch` before the first `Welcome`/frame throws** (`Error("engine: dispatch before ready")`); `client.ready` resolves at `session_state = 1`. Queueing would need a seq-less second path and hides a bootstrap bug; the world is not visible before ready anyway. After ready, `dispatch` never waits for a connection: during an outage records queue in the outbox and a full outbox or action ring throws `Error("engine: action queue full")` (0012 "dispatch fails locally").
- **Results share the UI ring** as a second record kind rather than a new ring: both are JSON at human rate for the same consumer, and ring order gives the "state before result" delivery rule for free.
- **Typed fast path for continuous actions:** decided in M14 (not built).
- **`ack_seq` is a placeholder until this milestone.** M15's frame header carries `ack_seq` on every frame, but it is always the stored `last_seq` — this milestone is what makes it real. `UplinkReader::read` returns raw `(seq, &[u8])` and carries no `G`, so decoding the action is this milestone's own work, not something M15 left partly done. See `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Seam shapes as landed".
- **Two testkit-only backdoors from M15 should be replaced, not built on.** `Host::queue_action_for_test` and `Host::genesis_for_test` exist only because this milestone's admission pipeline did not exist yet when M15 needed *some* way to drive a real `Sim::step` in its own frame-building tests. This milestone's real admit path should replace their use in tests rather than add to it. See `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Testkit-only additions beyond the brief's own Provides list".
- **`puts_script_a`'s `Bump`/`Remove` calls reject by design.** `WorldRead::entity_at` is always `Ok(None)` until M21's occupancy lands (M12b Deviations), so those handlers deterministically return `Rejected(NotFound)` in this golden — that is the "includes rejected actions" coverage the script wants, not a bug to fix here.

## Order of work
1. Host admit pipeline + native loopback tests. 2. `on_action`, outbox, results → UI-out. 3. TS `dispatch`/ring/clock block/`onActionResult`. 4. bindings step + typed fixture page. 5. WASM-under-Node script golden (`scenario.json` for `puts_script_a`, blessed with `pnpm golden puts`; the native test switches to `assert_golden`). 6. Playwright slice test, zero-GC window with `dispatchRaw`. 7. skill.

## Tests added
Rust: `action_lands_on_next_tick`, `arrival_order_within_tick`, `ack_and_deltas_share_a_frame`, `admit_reject_is_not_recorded`, `apply_reject_is_recorded_and_replays`, `resent_seq_is_dropped`, `host_applies_only_sealed_records`, `malformed_action_is_protocol_error`. TS unit: `dispatch_before_ready_throws`, `dispatch_returns_monotonic_seq_from_seed`, `ui_ring_delivers_results_in_order`, `dispatch_when_queue_full_fails_locally` (0012 pending-queue capacity: with `ack_seq` in the clock block held still, dispatches up to the capacity succeed, the next throws `action queue full` and writes nothing to the action ring; when `ack_seq` advances by one, one more dispatch succeeds. Main can know this synchronously only by counting `seq − ack_seq` from the clock block; M25 inherits the test unchanged). WASM under Node: `wasm_script_a_matches_native`. Browser: **`vertical_slice`**: page is cross-origin isolated; terrain probes pass; injected pan brings new chunks (probe + `netCounters`); a `sim` worker exists and `worldHash()` matches the golden at a fixed tick; `dispatch({ Paint })` returns 1, `onActionResult(1, "Confirmed")` fires and the probe at that tile shows the new colour in the same stepped frame as the result; `dispatch` of an out-of-range `Paint` yields `Rejected` with the typed reason. Zero-GC test now includes actions via `dispatchRaw`.

## Exit criteria
- [x] `vertical_slice` passes in Chromium; all other tests above pass.
- [ ] `pnpm device:serve` lists `slice.html`; in desktop Chrome ten presses of its Paint control show `confirmed 10`, `rejected 0`, `ring drops 0`, `engine_mem_grows 0` on every instance and an advancing `tick` on the HUD (`vertical_slice` asserts the same HUD text after its own dispatches).
- [x] `bindings/*.ts` for `puts` are committed and regenerate byte-identically; `grep -rn bigint packages/engine/fixtures/*/bindings` prints nothing (0003: TS-facing types avoid `u64`).
- [x] `.claude/skills/add-action-type/SKILL.md` exists and was followed once to add `Action::SetMotd` handling to the test page (or another variant) without reading this brief.
- [x] PLAN.md marks the vertical slice complete.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t action` · `pnpm test unit -t dispatch` · `pnpm test wasm -t script_a` · `pnpm test browser -t vertical_slice` · `pnpm test browser -t zero_gc` · `pnpm lint`.

## Budgets
Latency row: `action_lands_on_next_tick` (≤ 1 tick to authority). Allocation rows: zero-GC window with actions. Action rate / log row: uplink bytes per action recorded in `budgets.json` (fixture value; the log half is M22).

## Context artifacts
Skill `add-action-type` (0021 §4). `packages/engine/src/CLAUDE.md`: ring record formats table.

## Manual device checks
[device-checks.md, M16: Vertical slice on the phone](device-checks.md#m16-vertical-slice-on-the-phone) (`PRE-PLAN.md` §8 item 9: first on-device run of the slice).
The page is `slice.html` (Scope), listed by `pnpm device:serve --tunnel`; its HUD shows the counters the items read: `confirmed` / `rejected`, `ring drops`, `engine_mem_grows` per instance, `tick`.

## Deviations

Steps 1-5 (host admit pipeline; `on_action`, the outbox, results -> UI-out; TS `dispatch`/ring/
clock block/`onActionResult`; bindings step + typed fixture page; the WASM-under-Node `puts_
script_a` golden). Steps 6-7 (Playwright `vertical_slice` test on `slice.html`, the zero-GC window
with `dispatchRaw`, the `add-action-type` skill) are now also built, by a second implementer --
their own subsection, "Steps 6-7, as landed", is appended at the end of this section. Read this
whole Deviations section in full before touching `client.ts`, `worker/client*.ts`, `tests/support/
scenario.ts` or `slice.ts`/`slice.html`/`gc-slice.ts` again: the exact seam shapes below (especially
the clock-block field layout, the `client_clock_stats` export, and `dispatch`'s "`ready` only waits
when linked" rule) are what steps 6-7 were built against, and steps 6-7's own subsection records
what those steps found and added on top.

### ABI (`ABI_VERSION` 9 -> 10 in M15b, this milestone 10 -> 11)

`crates/engine/src/abi/registry.rs`'s `Instance` trait:

```rust
fn on_action(&mut self, _rx: &[u8]) -> Status { Status::Unsupported }
fn client_poll_ui(&mut self, _out: &mut [u8]) -> usize { 0 }
```

`export_instance!`'s extern C wrappers (both roles: client-role only in practice, since a
non-client instance's `Instance::on_action`/`client_poll_ui` default straight to
`Status::Unsupported`/`0`):

```rust
pub extern "C" fn on_action(len: u32) -> u32 { abi::on_action(&__ENGINE_SLOT, len) as u32 }
pub extern "C" fn client_poll_ui() -> u32 { abi::client_poll_ui(&__ENGINE_SLOT) }
```

`abi::on_action(slot, len)` reads `len` bytes of `RegionId::Rx` and dispatches to
`Instance::on_action`; `Status::BadLength` if `len` exceeds the region's declared capacity, the
same shape `on_input`/`sim_admit` already use. `abi::client_poll_ui(slot)` hands `Instance::
client_poll_ui` the whole `RegionId::Ui` region as `out` and returns its `usize` result cast to
`u32` -- no `Status` crosses this export, the same "always answer, cost nothing" convention
`upload_stage`/`gen_take`/`sim_warm_one` already use.

`GameInstance<G>`'s own implementation (`game_instance.rs`):

```rust
fn on_action(&mut self, rx: &[u8]) -> Status {
    match self {
        GameInstance::Client(c) => match c.core.on_action(rx) {
            Ok(()) => Status::Ok,
            Err(ActionError::Malformed) => Status::Decode,
            Err(ActionError::Full) => Status::OutOfMemory,
        },
        _ => Status::Unsupported,
    }
}
fn client_poll_ui(&mut self, out: &mut [u8]) -> usize { /* see "UI-ring record boundary" below */ }
```

`client::core::ClientCore<G>::on_action(&mut self, bytes: &[u8]) -> Result<(), ActionError>`
(`ActionError` is `pub enum ActionError { Malformed, Full }`, `pub` at `client::core` and
re-exported at `client::ActionError`) parses `bytes` as one action-ring record, `serde_json`s it
into `G::Action`, `Codec`-(postcard)-re-encodes it into a scratch `[u8; 512]`
(`MAX_ACTION_ENCODED_BYTES`), and pushes `(seq, encoded_bytes.to_vec())` onto the outbox. `Full` is
returned when the outbox already holds `OUTBOX_CAPACITY` entries; TS `dispatch` (step 3, not built)
is expected to prevent that by construction (counting `seq - ack_seq`), so this is a defence-in-
depth backstop, not the primary enforcement point.

### `RegionId::Rx`: the action-ring record, sharing the region with `on_input`

Layout exactly as the brief's Scope: `[seq u32 LE][len u32 LE][UTF-8 JSON]`, `len` counting only
the JSON bytes that follow. `bytes.len() < 8` or `len` reaching past the record's own end is
`ActionError::Malformed`.

`Rx` is the client role's one receive buffer (`RegionLayout::region`'s "one declaration per id"
rule) and is now shared by two unrelated, differently-shaped message kinds: `on_input`'s fixed
32-byte `InputEvent` records (M11) and `on_action`'s one variable-length JSON record. Declared at
`game_instance.rs`:

```rust
const INPUT_RX_BYTES: usize = InputQueue::CAPACITY * InputEvent::BYTES;   // 64 * 32 = 2048
const ACTION_RX_BYTES: usize = 1024;                                     // generous, provisional
layout.region(RegionId::Rx, INPUT_RX_BYTES.max(ACTION_RX_BYTES) as u32); // = 2048 today
```

Today `INPUT_RX_BYTES` (2048) dominates, so `ACTION_RX_BYTES` is inert headroom; a future input
queue shrink or a very large `G::Action` JSON could flip which one governs, which is exactly why
the declaration takes the `max` rather than assuming input always wins.

### `RegionId::Ui`: the result record, and the bindings/`onActionResult` type this fixes

Layout: `[kind u8][len u32 LE][JSON]`. Kind `2` is this milestone's own (`UI_RECORD_KIND_ACTION_
RESULT`, `game_instance.rs`); kind `1` (`Ui`, `G::Ui` changed) is M16b's, sharing this same region
and buffer -- a consumer must dispatch on the kind byte, not assume every record is an action
result.

**The exact JSON, copied from a real test (`game_instance::tests::client_poll_ui_produces_
confirmed_and_rejected_json`), for all three cases `Result<Applied, Rejected<G>>` can be in:**

```
Ok(Applied)                                   -> {"seq":1,"result":"Confirmed"}
Err(Rejected::Game(reject))                   -> {"seq":2,"result":{"Rejected":{"Game":"NotFound"}}}
Err(Rejected::Engine(code))                   -> {"seq":3,"result":{"Rejected":{"Engine":"RateLimited"}}}
```

**The `Game`/`Engine` tag is preserved, not flattened** (orchestrator ruling at the M16 gate,
reversing this milestone's own first draft, which had written `{"Rejected":<reason>}` with no
inner tag). Why: 0004's Decision defines `Rejected<G>` as exactly the two-variant enum `Rejected<G>
{ Game(G::Reject), Engine(EngineReject) }`, and `EngineReject`'s variants (`RateLimited`,
`StateBudgetFull`, `EngineFault`) are placeholders today -- M31 makes `RateLimited` real (the
action rate limit) and M21 makes `StateBudgetFull` real (the state-budget check), and a game whose
own `Reject` happens to name a variant `RateLimited` or `StateBudgetFull` becomes indistinguishable
from the engine's own reject by string alone if the tag is dropped. A game also needs the
distinction behaviourally: its own reject means "tell the player why"; an `Engine` reject means
"back off and retry" (or, later, "you're over budget"). **The ts-rs bindings (step 4) and `client.
onActionResult`'s public type (frozen at cut B / M16b per the coordinator) must be generated from
and match this shape** -- a flat `{"Rejected": <reason>}` union would be the wrong type to freeze.

`push_result_record<G>` (`game_instance.rs`) builds this by hand (not via a `Serialize` impl on
`Rejected<G>`, which doesn't exist and isn't added): `format!` for `Ok`, `serde_json::to_string`
of the inner `G::Reject`/`EngineReject` value wrapped in a hand-written `{"Rejected":{"Game":...}}`
/ `{"Rejected":{"Engine":...}}` shell for the two `Err` arms. `EngineReject` gained `#[derive(serde
::Serialize)]` for this (it had none before).

### `client_poll_ui`'s record-boundary contract (gate fix; the first draft was wrong)

`GameInstance::client_poll_ui` walks `ClientInstance::ui_buf` record by record and copies only
*whole* records into `out`:

- A record that fits is copied and removed from `ui_buf`.
- A record that doesn't fit **this** call is left in `ui_buf` (`ui_buf.drain(..consumed)`, not
  `clear()`) for the next `client_poll_ui` call -- never split across two polls.
- **A single record whose own `5 + len` exceeds `out.len()` in its entirety -- bigger than the
  whole `Ui` region, so it can never fit any poll ever -- is silently dropped** (consumed from
  `ui_buf`, never copied into `out`), rather than left stalling every record queued behind it
  forever. `UI_BYTES`'s sizing (below) is generous headroom, not an enforced per-record cap, so a
  game whose `G::Reject` carries a long `String` can hit this in practice.

**This drop is not counted or reported anywhere today.** No counter, no log, nothing observable
increments when it happens; a later milestone that wants to know whether it ever fires (or wants a
different policy -- e.g. truncating the reject payload instead of dropping the whole record) has to
add that itself. Tests: `client_poll_ui_never_splits_a_record_across_polls` (ten records through a
64-byte `out`, drained across several polls, decoded and asserted lossless, in order, no
duplicates) and `client_poll_ui_drops_a_record_too_big_for_any_poll_and_keeps_going` (a hand-built
105-byte record ahead of a normal one, `out` = 64 bytes: the oversized one is dropped, the normal
one still arrives).

The first draft copied `ui_buf.len().min(out.len())` bytes and then unconditionally cleared
`ui_buf` -- a record could be cut mid-`[kind][len][json]`, leaving a garbage `len` for whatever
parses the ring downstream (the TS ring parser, step 3, not built) to choke on. Fixed at the gate,
before step 3 could be built against the wrong contract.

### Outbox and `Ui`-region capacity (a TS unit test in the next cut asserts against these)

`client::core::OUTBOX_CAPACITY: usize = 32` (re-exported at `client::OUTBOX_CAPACITY`) -- the 0012
pending-queue figure ("initially 32"), reused rather than picked twice; M25 turns this same number
into the real prediction pending queue.

`game_instance.rs`'s `UI_BYTES: u32 = (client::OUTBOX_CAPACITY * 128) as u32` = **4096 bytes** --
32 outstanding results at a nominal 128 B of JSON each (comfortably over the three measured strings
above, all under 60 B). Provisional, like every other region size in this file.

### `poll_uplink` flushes actions immediately

`ClientCore::poll_uplink`'s existing 0010 pacing (at most one batch per 50 ms, at least one per
1 s) is **bypassed entirely whenever the outbox is non-empty**: `has_actions = !self.outbox.
is_empty()`, and the two rate checks only run `if !has_actions`. An action's own latency budget
(0004: "at most one tick plus the network") has no room for an extra pacing floor on top. The
outbox is cleared only when a batch actually carrying it was sent (`sink.finish()` succeeds);
otherwise it waits for the next poll. This is a judgement call, not literally specified by 0010 or
the brief, and is worth a second look if M31's real rate limiting finds it too permissive for
rapid-fire dispatch.

### Host admit pipeline: exact shapes

`host::Host::on_uplink` signature changed from `pub fn on_uplink(&mut self, conn: ConnId, bytes:
&[u8])` (M15) to:

```rust
pub struct UplinkError; // unit struct; Clone, Copy, PartialEq, Eq, Debug
pub fn on_uplink(&mut self, conn: ConnId, bytes: &[u8]) -> Result<(), UplinkError>
```

`Err(UplinkError)` on a malformed `UplinkBatch` (`UplinkReader::read` itself fails) or a malformed/
non-canonical action payload (`codec::decode_canonical::<G::Action>` fails) -- 0004 step 1's
protocol error. `Host`'s own `Instance::sim_admit` maps it:

```rust
fn sim_admit(&mut self, conn: u32, rx: &[u8]) -> Status {
    match self.on_uplink(conn, rx) {
        Ok(()) => Status::Ok,
        Err(UplinkError) => Status::Decode,
    }
}
```

`Status::Decode` is what a later step (`SimHost`, TS) reads to close the connection; that wiring
itself is not built here (Non-scope: this is steps 1-2 only).

Per action, in order: dedup (`seq <=` the host's `store.last_seq(player).unwrap_or(0)` is dropped
silently, no decode attempted) -> `codec::decode_canonical::<G::Action>` (malformed -> `Err
(UplinkError)`, whole batch call aborts, actions already admitted earlier in the same batch keep
their effect) -> `G::admit(sim.authority() as &dyn WorldRead<G>, &PresenceTable::empty(), player,
&action)` -> `Ok(())` pushes `Record::Action { who, seq, action }` onto `pending_records` (applied
at the next `tick()`); `Err(reject)` pushes `Outcome { seq, result: Err(Rejected::Game(reject)) }`
onto that connection's own `ConnSlot::pending_results` immediately, not logged, per 0004.

`ConnSlot` gained `pending_results: Vec<Outcome<G>>`. Two producers: `on_uplink` (admission-time
rejects, above) and `Host::tick` (every `Sim::step` outcome for an admitted action, routed to the
right connection by zipping a reused scratch field, `Host::scratch_action_players: Vec<PlayerId>`
-- gathered from `pending_records`'s `Record::Action` entries, in order, *before* `sim.step` drains
it, since `Sim::step` pushes one `Outcome` per `Record::Action` it sees in that same relative order
but never the `who`). `Host::build_frame` drains and clears `pending_results` into the `ActionResults`
wire section (id **1**, the lowest -- written *before* `Global`, id 2, since `FrameWriter::section`
requires strictly ascending ids) every time it runs for that connection, sorted by `seq`
(`insertion_sort_by_key`) first, so admission-time and apply-time results interleave correctly.

`game::PresenceTable<G>` (a shell with only a private `PhantomData` field until M19) gained:

```rust
impl<G: Game> PresenceTable<G> {
    pub fn empty() -> Self { PresenceTable { _marker: core::marker::PhantomData } }
}
```

the placeholder every `G::admit` call passes until M19 gives the table real content. Not in the
brief's own Files-touched list for `game.rs`, but there was no other owner for it.

### Testkit: `Host::queue_action_for_test` retained, `Loopback::action` switched to the real path

`Host::queue_action_for_test(&mut self, who: PlayerId, seq: u32, action: G::Action)` (the M15
backdoor, a direct `pending_records.push`, bypassing decode/admit entirely) is **not deleted**.
`tests/no_alloc_connection.rs` (M15b's own zero-allocation suite, outside this milestone's Files
touched) still calls it directly in `run_steady_tick`/`run_panning_tick`, and must: those calls sit
*inside* the exact windows `host_and_client_steady_state_no_alloc`/`host_and_client_bounded_camera_
no_alloc` measure, and `codec::decode_canonical` allocates a scratch buffer sized to its input on
every call -- going through the real wire path there would attribute that allocation to a window
that currently, correctly, asserts zero.

`testing::testkit::Loopback::action(&mut self, who: PlayerId, action: G::Action)` **was** switched:
it now `Codec`-encodes `action`, wraps it in a real `UplinkWriter`-built `UplinkBatch` of one
action, and calls the real `Host::on_uplink(conn, bytes)` (`conn = who.0 - 1`, recovering the
connection id from `PlayerId = conn + 1`, M15b's own convention -- `Loopback` keeps no reverse map).
Existing M15 tests in `tests/connection_and_subscriptions.rs` that call `lb.action(...)` are
unaffected in observable behaviour, since `LGame` never overrides `admit` (default `Ok`).

### Measured numbers

**Uplink bytes per action**, measured natively (not committed to any test, computed once via a
throwaway `eprintln!` and removed): `RAction::Bump { n: 12345 }` `Codec`-(postcard)-encodes to
**3 bytes** (1-byte variant tag + 2-byte varint payload); wrapped in a one-action `UplinkBatch` with
no camera and no presence (`UplinkWriter::write`), the whole batch is **12 bytes**
(1 msgtype + 1 flags + 4 `last_received_tick` + 1 `n_actions` varint + 1 `seq` varint + 1 `len`
varint + 3 action bytes). Not written into `budgets.json` -- see below.

**Host-side allocation through the real admit path: 0 B/action**, `crates/engine/tests/
no_alloc_connection.rs`'s `host_admit_path_allocates_zero_bytes_per_action` (own binary, `Arena`
global allocator, `abi::arena::live_bytes()`), flat at every window length tried (100 through
25,600 in a throwaway geometric probe; the committed test keeps 100 and 1,600, M15's own short/long
template). Every allocation the real path makes (`UplinkReader::read`'s `raw_actions: Vec`,
`Host::on_uplink`'s own `decoded: Vec`, `codec::decode_canonical`'s scratch buffer inside it) is
local to one `on_uplink` call and freed before that call returns, so a matched alloc/free pair
inside one measured call nets to zero in `live_bytes()` (allocated minus freed) -- the same
gross-vs-net distinction M15 fix round 3 already drew for `Replica::held`/`TerrainStore::
replace_overlay`.

**A harness bug found and fixed while measuring this, worth recording so it is not rediscovered as
a "defect": a run that calls `Host::on_uplink` + `Host::tick()` every action but never calls `Host
::build_frame` measures a real, reproducible, *non-zero, non-per-action* number that looks like a
leak but is a test-harness artefact.** First draft of the test did exactly that (omitted `build_
frame`); every action here is admitted and applied successfully (the fixture game never overrides
`admit`), so every tick pushed one more `Outcome` onto `ConnSlot::pending_results` -- and nothing
ever drained it, because only `Host::build_frame` drains that queue. Measured: 13,824 B over 100
actions, 32,256 B over 400, converging toward **~92 B/action** as the window grew (not a flat
per-tick constant, and not equal at the two window lengths either -- itself the tell that something
was still accumulating, the same shape M15's own fix-round-2/3 gate used to catch a similar
mis-measurement). Fixed by giving the test the real per-tick call order every connection actually
runs (`tick()`, `build_frame(conn)`, `seal()` -- `host::mod`'s own "Seam shapes as landed"); re-
measured at exactly 0 across the same window range. The lesson: **any future measurement of a path
that touches `ConnSlot::pending_results` (or, by the same shape, anything else `build_frame`
drains) must call `build_frame` in its own measured loop, or it measures an undrained queue
instead of the path it means to.**

Failability of `host_admit_path_allocates_zero_bytes_per_action` proven: an 8 B/call leak injected
into `Host::on_uplink` (`Vec::with_capacity(8)` + `mem::forget`) measured as exactly 800 B over 100
actions; reverted.

### `budgets.json`

**Untouched.** The action-rate/log row the brief's Budgets section names ("uplink bytes per action
recorded in `budgets.json`") is left to whichever cut actually owns editing that file -- its
existing formula/history convention (see the `main`/clock-block rows already in it) is involved
enough that editing it without full context risked corrupting entries unrelated to this milestone.
The measured number above (12 B/action, one-action batch, no camera/presence) is what a later cut
should record there.

### Tests added (native, beyond the brief's own named list for steps 1-2)

The brief's "Tests added" names eight Rust tests, all step 1's (host admit pipeline): `action_lands
_on_next_tick`, `arrival_order_within_tick`, `ack_and_deltas_share_a_frame`, `admit_reject_is_not_
recorded`, `apply_reject_is_recorded_and_replays`, `resent_seq_is_dropped`, `host_applies_only_
sealed_records`, `malformed_action_is_protocol_error` (`crates/engine/tests/action_round_trip.rs`,
new file, `[[test]] required-features = ["testing"]` in `Cargo.toml`). All eight proven to fail
under a targeted single-defect injection (see the orchestrator report for which line each covers);
`host_applies_only_sealed_records` is a real, distinct test (its middle assertion -- `total == 1`
after the second `action()` call and before the second `step()` -- fails if admission ever applied
directly instead of queueing), confirmed at the gate, not a duplicate of `action_lands_on_next_tick`.

Step 2 has no named native tests in the brief (its tests are TS/WASM, steps 3-5); six supplementary
tests were added for coverage of this step's own new code, all proven to fail under a targeted
defect: `client::core::tests::{on_action_queues_and_poll_uplink_flushes_it_immediately,
on_action_rejects_malformed_record, on_action_rejects_once_outbox_is_full, action_results_decode_
in_order_confirmed_and_rejected}`; `game_instance::tests::{client_poll_ui_produces_confirmed_and_
rejected_json, on_action_parses_a_valid_record_and_rejects_a_malformed_one}`, plus the two
record-boundary tests and the allocation test named above (added at the gate, not in the original
cut).

### Steps 3-5, as landed

Read this whole section before touching any of the files it names: it is the exact contract steps
6-7 build against.

### The one export that did not exist yet: `client_clock_stats` (`ABI_VERSION` 11 -> 12)

```rust
fn client_clock_stats(&mut self, _result: &mut [u8]) -> Status { Status::Unsupported }
```
`export_instance!`'s extern wrapper: `pub extern "C" fn client_clock_stats() -> u32`, role client,
0 params, result `status` -- the same shape as `sim_region_hash`/`client_region_hash`. `abi::
client_clock_stats(slot)` hands `Instance::client_clock_stats` the whole `Result` region. `Game
Instance::client_clock_stats` writes exactly two LE `u32`s into `result[..8]`:
`ClientCore::last_summary().tick.0` at offset 0, `.ack_seq` at offset 4 -- `Status::Ok` for a
`Client` variant, `BadLength` if `result` is somehow under 8 bytes, `Unsupported` for `Sim`/`Gen`.
**Deliberately carries nothing else**: `predicted_tick` (= `authoritative_tick` until M26),
`ticks_per_second` and `session_state`/`seq_seed` are all derived on the TS side (below), not
crossed here.

**`tick_hz`'s role gate was widened from `'sim'` to `'all'`** (`abi.ts`'s `ABI_EXPORTS.tick_hz.role`
and the Rust shim `abi::tick_hz`, which now matches on `slot.get()` instead of `slot.sim()`): the
answer (`Instance::tick_hz`, `G::TICK_RATE.hz_value()`) is role-independent by construction, and the
client worker now needs its own instance's real tick rate too, once at setup, for the clock block's
`ticks_per_second` field. No `ABI_VERSION` bump for this alone: params/result are unchanged, only
which role may call it, and `ABI_EXPORTS`'s `role` field is documentation the registry test does not
check.

### Clock block: field layout (`packages/engine/src/clock-block.ts`, new file)

`SabSet.clockBlock` is M06's own seqlock (`createSeqlock(CLOCK_BLOCK_DATA_BYTES)`, 32 data bytes,
`sab/layout.ts` -- now exported). This milestone uses the first 24 of those 32 bytes, six `u32`
fields in this exact order (also `clock-block.ts`'s own `CLOCK_FIELD` enum, matching
`readClockBlockInto`'s output array order):

```
offset  field
0       authoritativeTick
4       predictedTick        (= authoritativeTick until M26)
8       ticksPerSecond       (mirrored from tick_hz(), read once at worker setup)
12      sessionState         (SessionState.Connecting = 0, SessionState.Live = 1)
16      seqSeed
20      ackSeq
```
Bytes 24-31 are untouched, reserved for `revealed` (M28) and `tick_fraction` (M26): a future
milestone extends `ClockBlockView`/`writeClockBlock`/`readClockBlockInto` rather than reworking this
layout. `ClockBlockView` is hand-rolled exactly like `camera/block.ts`'s `CameraBlockView` (typed
field views built once over the raw SAB, not `sab/seqlock.ts`'s generic `SeqlockWriter`/
`SeqlockReader`, which would need an extra scratch-buffer reinterpretation on every read); both a
writer and a reader construct their own `ClockBlockView` over the same `sabs.clockBlock`.

### Who writes the clock block, and when

`worker/client-net.ts`'s `createNetPump` (not a separate always-on pump): it is the only pump that
learns, from `on_frame`'s own `Status` return, whether a real frame was actually applied this wake
(`ClientCore::last_summary()`'s default -- `tick == 0, ack_seq == 0` -- is indistinguishable from a
genuine first frame at those same values, so "a frame arrived" has to come from `on_frame`'s status,
not from reading the summary alone). Only when at least one `on_frame` call in this wake's downlink-
drain loop returned `Status.Ok` does it call `client_clock_stats()` and write the clock block. The
first time this happens, `session_state` flips `Connecting` -> `Live` and `seqSeed` is set from that
same read's `ack_seq` (Planning decisions' "read the seed exactly once, when `session_state` first
becomes 1" -- this is the worker's own half of that; main's half is next). `ticksPerSecond` is
`worker/client.ts`'s own `inst.call0(inst.x.tick_hz)`, read once at setup and passed into
`createNetPump` as a plain number, never re-read per wake.

**`createNetPump`'s signature changed** (three new trailing parameters): `createNetPump(inst, shell,
uplinkSab, downlinkSab, downlink, tx, clockBlockSab: SharedArrayBuffer, result: RegionView | null,
ticksPerSecond: number)`.

### `worker/client-action.ts` (new file): the real action/UI pump

Mirrors `client-gen.ts`/`client-upload.ts`/`client-input.ts`'s shape: built once at setup, run every
wake, unconditionally (not gated on `message.link` -- a client role always exists, and draining an
empty ring costs nothing). `createActionPump(inst, actionRingSab, uiRingSab, rx, ui)`: drains
`actionRing` (`RingConsumer.popInto` into the shared `Rx` region view, the same one `client-input.ts`
already uses for `on_input` -- `on_action` and `on_input` are different message kinds on one
region, per the brief's own Scope) into `on_action(len)`, one call per popped message; then loops
`client_poll_ui()` until it returns 0, pushing each non-empty batch onto `uiRing` via a plain
`RingProducer` (no `wake` option: main drains `uiRing` on its own per-rAF poll, never blocked in
`Atomics.wait`, so there is nothing to wake). **Mutually exclusive with `worker/client.ts`'s
pre-existing `echo`-gated test-only actionRing/uiRing round trip**: both would otherwise construct
independent `RingConsumer`/`RingProducer` pairs over the *same* SABs, corrupting each other's SPSC
head/tail bookkeeping. `worker/client.ts`'s `setup()` builds this pump only when `message.test?.echo
!== true`.

### `client.ts`: `dispatch`, `onActionResult`, the extended `ready`

`dispatch(action: unknown): number` and `onActionResult<Reject = unknown>(cb: (seq: number, result:
ActionOutcome<Reject>) => void): () => void` are new `Client` members. Two new exported types:
`EngineRejectReason = 'RateLimited' | 'StateBudgetFull' | 'EngineFault'` (hand-mirrored from `sim::
EngineReject`, since `engine` has no game to run `export_bindings` against) and `ActionOutcome
<Reject> = 'Confirmed' | { Rejected: { Game: Reject } } | { Rejected: { Engine: EngineRejectReason
} }` (`game_instance::push_result_record`'s exact JSON shape, tag preserved).

**`Client.ready`'s extended meaning is conditional, not universal**: it waits for `session_state ==
Live` only when `linked` (`options.host.kind === 'local' && options.host.connect === true`) --
computed once, above `start()`, and reused inside it so the two can never drift. Every other
topology (no `connect`, `'remote'`, or a low-level fixture with no `Game` at all) keeps `ready`'s
pre-M16 meaning ("the worker set is up"): the clock block is never written for such a topology, so
waiting on `session_state` there would hang forever. This is a real, deliberate narrowing of the
brief's own "`Client.ready` now also waits for `session_state = 1`" wording, made to avoid
regressing the dozens of existing browser pages/tests that spawn an unconnected topology and
`await client.ready` today. `'remote'` is excluded because `client.ts`'s own `linked` gate already
excluded it from ever getting a `net` pump at all (M15b, unchanged): reaching a real `session_state
= 1` over a remote connection is M27/M28's own work, Non-scope here.

**`dispatch`'s readiness check is a fresh clock-block read every call, not a cached boolean**: it
reads `session_state` straight from the clock block each time, so "dispatch before ready" and "the
session went live" are the same one signal `ready`'s own `waitForLive()` polls. `waitForLive()`
resolves the moment its first (synchronous, no timer needed) poll sees `Live`, seeding `nextSeq =
seqSeed + 1` from that exact read -- "main reads the seed exactly once" is enforced by this being
the only place `nextSeq` is ever assigned from `seqSeed`; every dispatch after that only ever does
`nextSeq += 1` on success. Polling uses the injected `Scheduler.setTimer`, never a bare
`setTimeout`.

**`dispatch`'s queue-full check is `candidateSeq - ackSeq > OUTBOX_CAPACITY` (32, mirroring `client::
core::OUTBOX_CAPACITY`), checked and the ring write attempted *before* `nextSeq` is advanced**: a
throw (either the logical backstop or the physical action-ring being full, `RingProducer.tryPush`
returning `false`) leaves `nextSeq` untouched, so the *next* successful call reuses the same
candidate `seq` -- this is what makes `dispatch_when_queue_full_fails_locally`'s "advance `ack_seq`
by one, exactly one more succeeds" true. `dispatch`'s own action-ring `RingProducer` is constructed
once, with `{ control, index: WORKER_CLIENT }` as its wake target, so a successful `tryPush` already
notifies the client worker (Scope's "then `Atomics.notify` of the client worker") with no separate
call.

**The per-rAF UI-ring drain lives inside `createClient()` itself**, not in `frame-loop.ts` (its own
`onUi` hook stays exactly as before, a no-op default `FrameLoopOptions` field for M16b to use):
`createClient()` registers its own `scheduler.requestFrame` loop, started once `start()` resolves,
running for the client's whole life (cancelled in `destroy()`). Each tick calls a private
`pollActionResults()` that drains `uiRing`, walks `[kind u8][len u32 LE][json]` records in a popped
message, and for **kind 2 only** parses the JSON and fires every registered `onActionResult`
listener, in ring order. **An unknown kind (M16b's future kind 1, `Ui`) is skipped by its own length
field** (`i = bodyStart + recLen`), never parsed, never crashing -- this is what keeps M16b's own
addition from being a breaking change to this code. This path is **not zero-GC** (JSON parsing
inherently allocates, and the exit criterion's own "zero-GC window with `dispatchRaw`" -- step 6,
Non-scope here -- is where that gets budgeted): a later cut owns making it allocation-free once
actions are actually flowing; this design only guarantees it does not allocate more than the
JSON-parse itself requires.

**`ClientTestHandle` gained `writeActionRecord(seq: number, jsonBytes: Uint8Array): boolean`**: the
exact low-level primitive `dispatch` itself uses (same `RingProducer`, same scratch buffer) minus
the seq-counter/session-state bookkeeping. **`engine/test` now also has `dispatchRaw(client, seq,
jsonBytes)` and `actionResults(client)` built on top of it** (added at the gate, corrected from an
earlier report that called these step 6's -- they are this milestone's own Provides names and later
briefs consume them by name, so they had to exist before handoff): `dispatchRaw` throws the same
`"engine: action queue full"` `dispatch` does when the ring has no room, but never the "before
ready" check (a zero-GC caller already knows the session is live) and never reads the clock block
or advances a `seq` counter -- the caller supplies both. `actionResults` subscribes to `client.
onActionResult` lazily, on its first call per `Client`, and returns the same live array every call
(never a fresh subscription) -- read its contents, don't expect it to clear itself.

### Gate-round fix: `connect: true` pages deadlocked at boot, then a second fix for a self-inflicted 11 s stall

Three existing pages -- `connected.ts`, `connected-terrain.ts`, `gc-connected-terrain.ts` (all
pre-M16, M15b/M15c) -- `await client.ready` immediately after `createClient()`, before wiring any
of their own test hooks (`__stepTick`, `drive()`, ...). Once `ready` started waiting for
`session_state = 1` (above), this deadlocked: nothing outside the page can reach a hook that
doesn't exist yet, and nothing inside the page drives a tick either, since these pages' own sim
ticks are test-driven (no `test.flags.pace`), not real-time-paced. `connected-paced.ts` (`test.
flags.pace = true`) was never affected -- its sim ticks itself. All three pages now call `await
pumpUntilLive(client)` (`engine/test`, new) in place of `await client.ready`, before wiring their
own hooks. **Neither `Client.ready` nor `dispatch`'s own contract changed at all** -- this is
entirely a page-boot-order fix, inside `tests/`, not a seam change: `dispatch_before_ready_throws`
still fails if the readiness guard is removed, and `ready` still means exactly what this
milestone's own Scope says.

**First version of `pumpUntilLive` was itself the cause of an 11.28 s stall the orchestrator caught
before hand-off** (do not repeat this shape): it retried `stepSimTickSync` on a macrotask, using a
caught throw as its own "are the workers up yet" signal (`clientTestHandle(client).workers.length
=== 0` throws; `> 0` attempts the call for real). But `workers` is populated *before* a worker has
finished its own async setup -- `stepSimTickSync` busy-spins the main thread until the sim worker
acks, so the first attempt reliably started too early and then blocked the very thread the worker's
own setup needed a turn on to finish. Measured with a precise timestamp probe (page start, each
worker's `engine_init ok`, `stepSimTickSync` entry/exit, `client.ready` resolution): the first real
`stepSimTickSync` attempt entered at 59 ms and did not return until 11,346 ms -- exactly when all
three workers' `engine_init ok` logs fired, immediately after the spin gave up (its own iteration
limit) and yielded the thread back. Not "waiting harmlessly through boot": the spin was the reason
boot took that long. `pumpUntilLive`'s own convergence (~13 loop iterations once unblocked) was
never the cost; a proxy readiness check that blocks was.

**Fixed by exposing a real signal instead of inferring one from a blocking call's own failure
mode**: `ClientTestHandle` gained `workersReady: Promise<void>` (`client.ts`'s own `workersUp`, the
promise `start()` itself returns, captured separately from `ready`'s further `waitForLive()`
chaining -- `ready`'s own composition is otherwise unchanged). `pumpUntilLive` now `await`s
`workersReady` *before* its first `stepSimTickSync` call, never inferring readiness from a caught
throw. Re-measured with the same probe: `pageReady` at **82 ms** (was 11,380 ms) -- `stepSimTickSync`
never blocks at all once genuinely called after every worker's own handshake completed.

**Verified**: `pnpm test browser -t connected` -> `browser pass 12 tests 5.7s/25s`; `pnpm test
browser -t gc-connected` -> `browser pass 6 tests 4.2s/25s`; the full `pnpm test browser` -> `browser
pass 110 tests 22s/25s`, matching the pre-M16 baseline (~23 s) the orchestrator measured on
`10bbde5`. All 17 `connected`/`gc-connected` tests also pass repeatably through a direct `pnpm exec
playwright test --project chromium --project gc -g connected` invocation.

### `tests/support/scenario.ts`: the `script` scenario kind (step 5)

New exported types `ScriptAction = { seq: number; action: unknown }`, `ScriptEntry = { tick: number;
connect?: boolean; actions?: ScriptAction[] }`, `ScriptScenario = { kind: 'script'; role: 'sim';
config: InstanceConfig; encoderConfig: InstanceConfig; genesis?: boolean; script: ScriptEntry[];
checkpointAt: number }`, folded into `HashScenario`. **`runHashScenario` throws if handed a `script`
scenario** (it takes one instance; a script scenario needs two) -- the real driver is the new
`runScriptScenario(sim: EngineInstance, encoder: EngineInstance, scenario: ScriptScenario):
string[]`, exported alongside it. No TS postcard encoder was written (0003 rejects that
alternative): `encoder` is a second, client-role instance of the *same* `.wasm`, used purely to turn
each scripted action's JSON into real wire bytes via `on_action` + `client_poll_uplink` -- exactly
`client.dispatch`'s own client-side half -- whose output is copied byte-for-byte into the sim
instance's `Rx` region for `sim_admit`. Per `ScriptEntry`, in order: idle-fill ticks up to `tick -
1`, then `sim_connect`/every `actions` entry's admit (queuing, not yet applying), then exactly one
`sim_tick()` call that applies everything queued together -- the same "one `Sim::step(batch)` call
per distinct `Tick`" shape `engine::testing::testkit::run_script` uses natively. One checkpoint, at
`checkpointAt`.

**`Host::connect`'s extra `Record::Player{Connected}`** (`script_a()`, the native script, only ever
queues a single `Joined` entry; `sim_connect` queues both `Joined` and `Connected`) **is a proven
no-op for this fixture**: `Sim::step` calls `G::on_player` for every `Record::Player` regardless of
variant, and `Puts::on_player` only ever matches `PlayerEvent::Joined`, so the extra record changes
nothing `state_hash()` can see. Measured, not assumed: `pnpm golden puts` produced
`golden-script-a.json`'s checkpoint as `7bdddfc9c749b1fb` on the first try, exactly the value this
brief's own delegation prompt named in advance, and `puts_scenarios.rs`'s native `puts_script_a_
golden` (still driving `Sim<Puts>` directly via `run_script`) reads the same file and agrees.

`golden.mjs` special-cases `scenario.kind === 'script'`: it instantiates a second, client-role
instance from `scenario.encoderConfig` and calls `runScriptScenario` instead of `runHashScenario`.
New fixture files: `fixtures/puts/golden/scenario-script-a.json` (the script above, JSON-encoded
exactly as `client.dispatch` would encode it) and the golden it wrote, `golden-script-a.json`.
`tests/golden/puts_script_a.hash` (the old native-only byte golden) is deleted -- nothing else
referenced it once `puts_script_a_golden` switched to `assert_golden_named`.

**`testing::mod.rs` gained `assert_golden_named(fixture_dir, file_name, checkpoints)`**, `assert_
golden`'s sibling with an explicit file name instead of the hardcoded `golden.json`: needed because
`fx-puts` now has two native-checked goldens in one fixture directory. `assert_golden` itself is
unchanged (calls `assert_golden_named(dir, "golden.json", checkpoints)`).

### `EngineReject`'s TS binding, and a real footgun it exposed

`EngineReject` (`sim.rs`) derives `ts_rs::TS` but **deliberately not `#[ts(export)]`**: that
attribute only controls whether ts-rs's derive macro *also* emits its own `export_bindings_
enginereject` test (`output_path()`/`export_all()` exist unconditionally either way), and adding it
made every plain `cargo test -p engine` write an unwanted `crates/engine/bindings/EngineReject.ts`
as a side effect (found the hard way, then reverted). `fixtures/puts/src/lib.rs` has its own `#[test]
fn export_bindings_enginereject()` that calls `<engine::sim::EngineReject as ts_rs::TS>::
export_all(&Config::from_env())` directly -- no `#[ts(export)]` needed for that call to work.

**A real, separate footgun**: ts-rs's own default (`TS_RS_IMPORT_EXTENSION` unset) emits
extension-less relative imports (`import type { Pos } from "./Pos"`), which fail `tsc` under this
repo's `nodenext` module resolution. `buildGame()`'s new `bindings` option (`build-game.ts`) always
sets `TS_RS_IMPORT_EXTENSION=js` alongside `TS_RS_EXPORT_DIR`, but that only covers regeneration
routed through it (`scripts/build-fixtures.mjs`, the Vite plugin). A bare `cargo test`/`cargo
nextest run` over `fx-puts` (no wrapper) regenerates the same files using ts-rs's raw defaults --
losing the `.js` extension and the committed biome formatting both. Fixed with a new root
`.cargo/config.toml`'s `[env]` table (`TS_RS_EXPORT_DIR = "bindings"`, `TS_RS_IMPORT_EXTENSION =
"js"`), which cargo applies to every test binary it spawns, wrapper or not. The committed `.ts`
files still won't byte-match a *bare* `cargo test` run's own output exactly (ts-rs's own quote/
semicolon/trailing-comma style differs from biome's), only after `pnpm format` -- the same
"reformat in place" step `golden.mjs` already takes for its own written files, for the same reason.

### Measured: `puts-dispatch.html`'s build

`pnpm exec vite build --config packages/engine/tests/browser/pages/vite.config.ts` succeeds with
the new page included (`puts-dispatch-*.js` in the manifest); `pnpm --filter engine typecheck`
(which includes `tests/browser/pages/tsconfig.json`) is clean. Never opened by a Playwright spec in
this cut -- see the brief's own step-4/step-6 split in the delegation prompt.

### Gate fix: resend dedup covered only the post-apply window, not the same-tick one

A review agent found and confirmed by running: `Host::on_uplink`'s resend dedup compared each
incoming `seq` against a single `Store::last_seq(player)` snapshot taken at the top of the call,
but `Store::last_seq` only advances inside `Sim::step`, at the next `tick()` -- not when an action
is merely admitted into `pending_records`. Two `on_uplink` calls carrying the same `seq` *between*
two ticks both saw the same stale snapshot, both admitted, and `Sim::step` applied both. Reachable
in the ordinary case, not a corner case: `worker/sim.ts` drains the uplink ring on every wake, and
`ClientCore::poll_uplink` flushes a non-empty outbox immediately (this milestone's own Scope), so
more than one `on_uplink` call per tick window is normal, and a reconnect resend is exactly the
case the guard exists for. Verified before the fix: `Bump{n:5}` as `seq` 1, then a resend of `seq`
1 before any `step()`, totalled **10** instead of 5.

Fixed with `ConnSlot::highest_admitted_seq: u32` -- the highest `seq` this connection has ever had
*admitted* (queued into `pending_records`, not merely decoded), tracked as a running value across
every action within one `on_uplink` call (so an in-batch duplicate is caught too) and persisted
across calls. Seeded from itself each call and folded against `Store::last_seq` via `.max()`, so a
genuine reconnect (a fresh `ConnSlot`, back at 0) still dedups correctly against the player's
persisted history. Only advances on a successful admit (`Ok`), not on an admission-time reject,
since 0004 never logs a rejected `seq` and a resend of it is safe to re-admit (it touches no sim
state).

**`resent_seq_is_dropped` (this milestone's own step-1 test) was the eighth instance of this
repo's recurring "a test that cannot fail for the reason it claims" defect**, and was green across
two prior gates with the bug present. It resent only *after* `lb.step()` had applied the first
copy, exercising only the post-apply path, while its own comment ("as a reconnect would") implied
the general guarantee; it also used `SetTotal` (idempotent last-write-wins), which would have
masked a double-apply even if one had occurred in that window. Split into `resent_seq_is_dropped_
after_apply` (the original, comment fixed to say exactly what it covers) and `resent_seq_is_
dropped_before_apply` (new: `Bump`, additive, resent in the same tick-to-tick window, before the
first copy is ever applied). The new test proven to fail against the pre-fix logic: the single-
snapshot dedup restored temporarily, watched go red at `10 != 5`, reverted. `arrival_order_within_
tick` re-verified unaffected.

### Gate fix: a locally dropped action produced no `onActionResult` -- now counted, not silently lost

`worker/client-action.ts`'s pump called `inst.call1(inst.x.on_action, len)` and discarded the
returned `Status`. `ActionError::Malformed -> Status.Decode` (a corrupt ring record) and
`ActionError::Full -> Status.OutOfMemory` (the outbox at capacity) therefore produced no visible
effect at all: `dispatch()` had already handed the app a `seq` on main, and nothing would ever
resolve it -- no error, no counter, no log.

**Ruling (orchestrator, not this implementer's to relitigate): check the `Status` and surface it
through the existing counters mechanism. Do not synthesise a local `Rejected` result record** -- a
locally-dropped action never reached the host, so it is not a host verdict, and 0004's `Rejected<G>`
is a host-only shape; a local-rejection path belongs to **M25's pending queue**, not this backstop.
This is a defence-in-depth path, not the primary enforcement: main-thread `dispatch()` already
enforces outbox capacity synchronously (counting `seq - ack_seq` before ever writing a ring
record), and the malformed-record path is reachable in practice only through `engine/test`'s
`dispatchRaw` (test-only) or a genuine race between that check and this pump's own drain.

Fixed by adding `RingConsumer.recordDrop()` (`sab/ring.ts`) -- the consumer-side counterpart of the
`RingProducer.recordDrop()` every other full/rejected ring write in this package already uses
(`client-net.ts`'s uplink drop, this same file's own `uiProducer.recordDrop()`), sharing the same
`RING_DROPS` counter/physical control word as the producer side: both answer "how many messages
sent into this ring never had any further effect". `client-action.ts`'s pump now calls
`actionConsumer.recordDrop()` whenever `on_action` returns anything but `Status.Ok`. New unit test
`ring.consumer_record_drop_shares_the_producers_counter` (`sab/ring.test.ts`), proven to fail
against a no-op `recordDrop()` injected into `RingConsumer`, reverted.

**Nothing in this cut reads the action ring's own `stats().drops`.** `slice.html`'s own HUD field
`ring drops` (the brief's own Scope, "sum of `stats().drops` over the `SabSet` rings") is step 6,
not built yet; once it exists, a locally-dropped action will already be counted there without
further plumbing, since it shares `netCounters`'s aggregation shape by construction. Until then,
**a locally dropped action produces no `onActionResult` and is otherwise invisible except through
`stats().drops` read directly off `SabSet.actionRing`.** This is a known, accepted gap, not a
hidden one: a real local-rejection UX (so the app can tell the player "that action never left the
device") is **M25's** job, when the pending queue gives prediction a real place to reconcile a
locally-dropped `seq` against.

### Gate check: the clock block's own seqlock retry loop had no committed test

A review agent noted no committed test drives `readClockBlockInto`'s own torn-read retry branch
(`clock-block.ts`). Checked: `sab/seqlock.test.ts`'s `seqlock.no_torn_read` (a real cross-worker
race) covers `SeqlockReader`/`SeqlockWriter`, but `clock-block.ts` does not use that generic pair --
its own module doc comment says why ("hand-rolled shape ... for the same reason" as `camera/
block.ts`: individual typed `u32` field views, not one opaque byte blob through a scratch buffer).
`camera/block.test.ts`, the same hand-rolled shape's own precedent, has no such test either. So
this was a genuine, previously-uncovered gap, not a redundant check -- **added**:
`clock_block: a read that never sees an even seq word exhausts its retries and reports it`
(`clock-block.test.ts`), single-threaded (the seq word held odd via a direct `Atomics.store`,
simulating a writer paused mid-update -- the worst case the retry loop exists for, not a real
cross-thread race, which no test in this file or `camera/block.test.ts` attempts): asserts
`readClockBlockInto` returns `false` and leaves `out` untouched after exhausting every retry.
Proven to fail against a defect (the odd-seq check removed, forcing an unconditional `true`
return): watched red at `expected true to be false`, reverted. The complementary case -- a real
writer flipping the seq back even partway through a genuine race, so a later retry succeeds -- is
not tested here either (it would need real thread interleaving, the same infrastructure `seqlock.
no_torn_read` uses for the generic class); left as-is, matching the existing coverage level for
this hand-rolled shape.

### Steps 6-7, as landed

A second implementer's own cut, built against the Deviations above. Commits `M16 step 6: ...`
(five commits: `Puts::admit` bound check, `slice.html`, the zero-GC window, the `uplinkBytesPerAction`
row) and `M16 step 7: ...` (the skill), plus one lint-only fix commit.

#### `Puts::admit` gained a real, deterministic `Reject::Game` path (`fixtures/puts/src/lib.rs`)

`vertical_slice`'s own "out-of-range Paint yields Rejected" assertion needs a real `G::Reject`
outcome for an action that (unlike `Bump`/`Remove`) can never fail at `apply` time -- `set_tile`
itself is infallible (0003). Non-scope explicitly rules out both real `EngineReject` paths
(`StateBudgetFull` is M21, `RateLimited` is M31), so the only place left is `Game::admit` (0004
Pipeline step 2, admission-time, never logged). Added: `Reject::OutOfRange` (a new variant) and a
`Puts::admit` override --

```rust
fn admit(
    _w: &dyn WorldRead<Self>,
    _p: &PresenceTable<Self>,
    _who: PlayerId,
    a: &Action,
) -> Result<(), Reject> {
    if let Action::Paint { pos, .. } = a
        && (pos.x.abs() > PAINT_BOUND || pos.y.abs() > PAINT_BOUND)
    {
        return Err(Reject::OutOfRange);
    }
    Ok(())
}
```

`PAINT_BOUND: i32 = 1_000_000` -- a fixture-only demo threshold, deliberately not a world-model
rule (`docs/spec/world.md`: "coordinates are unbounded; the cap applies to *materialized* chunks
held in memory" is unaffected: this never touches `apply`/`Sim`/`sim_hash`, so it changes no
golden). Verified against both existing goldens by rebuild + rerun, unaffected: `puts_idle_100`
(no Paint at all) and `puts_script_a` (`Paint` at `(2, 2)` and `(-3, 8)`, both far inside the
bound). Bindings regenerated via `node scripts/build-fixtures.mjs` (never a bare `cargo test` --
see the steps 1-5 section above, "A real footgun"): `bindings/Reject.ts` gained `'OutOfRange'`,
byte-identical after `pnpm format`. Failability proof: reverting the check to `if false && (...)`
made `vertical_slice`'s Phase 6 time out on `expect.poll(rejected).toBe(1)` after 5 s instead of
seeing it flip -- watched red, reverted.

#### `slice.html` + `src/slice.ts`: real production page, not a harness page

Single-player topology (`host: { kind: 'local', world: { worldId: 'slice', params: { seed: '1',
worldgen: null } }, connect: true }`, fixture `puts`, `genWorkers: 1`), a real, document-attached
canvas, real camera/input (`createClient` installs both automatically whenever a real `canvas` and
`window` are present -- no test scaffolding needed for this part), and `test: { flags: { pace:
true } }` -- the same combination `connected-paced.ts` (M15b) already established: `pace: true`
arms the sim worker's real-time `AtomicsTimer` pacing (`worker/sim.ts`'s `!message.test ||
message.test.pace === true` gate) while `test` being present at all keeps the parked-only
`test-call` channel (`worldHash`/`netCounters`/`simCounters`) reachable, which `client.ready`
itself does not need but this page's own test hooks and the phone HUD's `engine_mem_grows` field
do.

**The canvas is configured `rgba8unorm`, not the browser's own preferred format.**
`frame-loop.ts`'s `createRealFrameLoop` always calls `configureCanvasContext`, which hardcodes
`navigator.gpu.getPreferredCanvasFormat()` (`bgra8unorm` on this machine) with no override. But
`engine/test.renderTo`'s own offscreen probe target (the `Renderable` overload every existing
pixel-probe test, `connected-terrain.spec.ts` included, already uses) is hardcoded `rgba8unorm`,
and one `TerrainRenderer` draws through *one* pipeline built for *one* color format -- a page that
both renders to a real canvas and offers a same-renderer pixel probe needs the two to agree. Fixed
by not calling `createRealFrameLoop` at all: `slice.ts` configures the canvas context itself
(`ctx.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' })` -- a canvas format WebGPU
always accepts; "preferred" is a performance hint, not a requirement) and assembles
`createViewportController` + `createFrameLoop` directly, `createRealFrameLoop`'s own two building
blocks, with its own `onCamera` hook doing the same `pxPerTile`-based frame-uniform computation
`device.ts` already does. `attachVisibilityHandling(loop)` is still wired (M16-background's own
device check). No existing page had combined a real canvas render with a same-pipeline pixel probe
before this; every other real-canvas page (`device.ts`) never reads pixels back, and every
pixel-probe page (`connected-terrain.ts`) never draws to a real canvas.

**HUD fields** (Provides, read verbatim by `docs/plan/device-checks.md`'s "M16: Vertical slice on
the phone" section, already pre-written and left unchanged -- it already matched this shape):
`isolated`, `adapter`, `workers ready`, `session live`, `confirmed`, `rejected`, `ring drops`,
`engine_mem_grows`, `tick`. `ring drops` sums `RingConsumer(sab).stats().drops` (side-effect-free:
`stats()` only `Atomics.load`s the shared drop counter, never the pop cursor) over every `SabSet`
ring (`uploadRing`, `actionRing`, `inputRing`, `uiRing`, `uplink`, `downlink`, every `genRequest`/
`genResult` pair) -- the same enumeration `test/client.ts`'s own private `ringSabs` uses, rebuilt
here since that helper isn't exported. `tick` reads `authoritative_tick` straight from the clock
block via `clock-block.ts`'s own `ClockBlockView`/`readClockBlockInto`/`CLOCK_FIELD`. `engine_mem_
grows` requires the worker parked (`Harness.memGrows()`'s own doc comment) -- refreshed on a
3-second interval, each reading its own brief park/resume pair, the same cost `connected-paced.ts`
already accepts for a parked-only reading; `?hud=0` hides the DOM element (a long device session
without the visual noise) but the counters underneath keep updating either way.

**Test hooks** (all `__slice`-prefixed except `__setCamera`/`__writeFrameUniform`/`__renderAndRead`/
`__errors`/`__adapterInfo`/`__tick`/`__netCounters`/`__worldHash`/`__ringDrops`/`__hudText`, which
reuse existing shared names): `__dispatchPaintAt(x, y)`, `__paintUnderCentre()` (the production
Paint control's own target -- `floor(cameraState.centreX/Y)`, the camera centre tile, since an
on-screen-centred camera means the screen-centre world tile *is* the camera centre tile),
`__sliceConfirmed()`/`__sliceRejected()`/`__sliceLastReject()` (plain accessors over module-level
counters the one `client.onActionResult` subscription maintains -- not the bare `__confirmed`/
`__rejected` `puts-dispatch.ts` already declares as plain `number` fields, nor topology.ts's own
6-argument `__injectPointer`: `declare global` merges every page's `Window` augmentation into one
shared TS project, so a same-named, differently-typed redeclaration is a real `tsc` error, not a
style choice), `__sliceInjectPointer` (wraps `engine/test.injectPointer`, paired via
`attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)` at setup -- `real-
camera.ts`'s own pattern), `__worldHashAndTick()` (see below).

#### `vertical_slice` (`tests/browser/vertical-slice.spec.ts`): one test, seven phases

Chromium only. Phase 1: `openPage` itself asserts `crossOriginIsolated`; `expectAdapter` records a
real WebGPU adapter. Phase 2: a pristine-terrain probe at tile `(20, 20)` -- deliberately *not*
`(0, 0)` or any other member of `fixtures/puts`'s own `WALK` constant (the tick rule's fixed
once-a-second overlay near the origin): by the time this phase runs, the real-time-paced sim has
already ticked at least once (a linked connection's very first frame already reports `tick: 1`),
so `WALK`'s own tile `(0, 0)` is *already* non-pristine before the test ever touches it -- proven
live: probing `(0, 0)` instead reads the overlay colour (`got 30, want 34`) immediately, not
"eventually". Phase 3: a real drag (`__sliceInjectPointer` down/move.../up, `camera.spec.ts`'s own
shape) at `tilesAcross: 64` (zoomed well out: at the Paint-probe camera's own `tilesAcross: 8`, the
same drag distance pans only a couple of tiles, nowhere near a 32-tile chunk edge, and
`chunkEntersPristine` never moves at all -- measured directly, twice, before widening the zoom and
the drag distance) brings new chunks into subscription (`netCounters().chunkEntersPristine`
grows). Phase 4: see "worldHash", below. Phase 5: a full `Paint` round trip with a pixel diff at
tile `(50, 50)` (clear of both `WALK` and the Phase 2 probe tile) -- `resource: 2` maps through the
*identity* resource table straight to visual id 2 (`WATER`, `connected-terrain.spec.ts`'s own
colour), the same visual a player-dispatched `Paint` reaches regardless of `aux` (only the tick
rule's own overlay goes through `PutsClient::tile_visual`'s `aux != 0` swap). Phase 6: an
out-of-range `Paint` (`(2_000_000, 2_000_000)`) yields `{ Rejected: { Game: 'OutOfRange' } }`.
Phase 7: the HUD text contains the same field values the assertions above just produced.

**`worldHash()` "matches the golden at a fixed tick" turned out infeasible against a literal fixed
tick, and was adapted.** The brief's own wording names `fixtures/puts/golden/scenario-connected.
json`/`golden-connected.json` (`df47fa55da493c78` at tick 100, one connection, zero actions -- the
exact scenario `slice.html`'s own topology matches up to Phase 4) as the obvious target. It does
not work as a literal `expect.poll(tick).toBe(100)` followed by a plain `worldHash()` read, for a
reason specific to real-time pacing under this page's own continuous rendering (see the next
subsection): the sim can advance by dozens of ticks in one resync catch-up burst once pacing
recovers, so a poll for `tick === 100` can jump straight over it and never observe it; polling for
`tick >= 100` instead risks reading `worldHash()` at some tick *past* 100 (a real, different, but
*correct* value for that later tick), which a literal `.toBe('df47fa55da493c78')` would then fail
for the wrong reason. Fixed by comparing against a reference computed **the same way `pnpm golden`
itself computes one**, parameterized by the tick actually observed instead of a hardcoded 100:
`__worldHashAndTick()` (new) parks once, reads `worldHash()` and `simCounters().ticksRun` (==
`Tick.0` for this page, which never drives a manual tick itself) in that same park window so the
pair can never drift apart, then resumes; the spec (Node context, not `page.evaluate`) loads the
built fixture (`tests/support/fixtures.ts`'s `loadFixture('puts')`), reads the committed `scenario-
connected.json` (`tests/support/fixtures.ts`'s `readGolden`), and calls `runHashScenario` twice --
once completely unmodified (self-check: `expect(...).toEqual(['df47fa55da493c78'])`, so a change to
the fixture's own genesis/tick rule is caught here too, not only by `pnpm golden`'s own gate), once
with `ticks`/`checkpointEvery` set to the tick actually observed -- and compares that second
result against the browser's own reading. This is the exact mechanism `scripts/golden.mjs` itself
runs; only the tick parameter is dynamic. `expect.poll(tick).toBeGreaterThanOrEqual(50)` (20 s
timeout) gates entry to this phase.

**A previously unexercised interaction: continuous real rendering can starve `AtomicsTimer.poll()`
for seconds at a time under ADR 0030's own `wokenBy === lastWokenBy` guard.** `worker/sim.ts`'s
`body()` only calls `atomicsTimer.poll()` (the thing that actually advances a paced tick) when this
wake's `wokenBy` (the sim worker's own `W_WAKE` control word, read fresh each `body()` pass) is
*unchanged* from the previous pass's -- the guard's whole point (steps 1-3's own inert landing,
made live by steps 1-5, Deviations above) is to skip a spurious extra tick on a genuine *external*
wake (a linked client's own uplink push) without ever missing a genuine timer-only wake. `slice.
html` is the first page in this repo to pair `pace: true` with a *continuously rendering, really
panning* topology: `createFrameLoop`'s own `tick()` calls `client.writeCameraAndWake()`
unconditionally every real animation frame (not gated on whether the camera actually moved), and
the client's own net pump sends a fresh uplink batch at the 0010 rate-limit ceiling (at most one
per 50 ms) whenever there is anything to report -- which, while panning, is on essentially every
eligible window. With external wakes arriving at close to the same ~50 ms cadence as the sim's own
pacing timer, two *consecutive* `body()` passes with no external wake between them become rare, and
`poll()` -- hence ticking -- can stall for whole seconds at a time (measured directly: `tick` held
at exactly `1` across a full second of Phase 1-3 real elapsed time, then advanced from `69` to `460`
in under 20 s once whatever jitter breaks the lock-step recovers -- never *permanently* stalled in
every measurement taken, always eventually recovers). No existing page had exercised this
combination: every other real-panning zero-GC page (`gc-connected-terrain.ts`) drives ticks through
a manual clock and `stepSimTickSync`, never `pace: true`; `connected-paced.spec.ts`'s own poke is a
bounded 1.5 s window, not a page that pans forever. **Not fixed here**: `worker/sim.ts` is outside
this milestone's own Files touched (owned by M13/M15b/ADR 0030), and the guard itself is correct in
isolation -- what's new is a real page that keeps the external-wake rate this high, continuously,
which nothing before M16 did. `vertical_slice`'s own `expect.poll` calls around Phases 4-6 all
carry generous, explicit timeouts (20 s) for exactly this reason, not Playwright's 5 s default.
Recorded here as a genuine finding for whoever next touches real-time pacing or `worker/sim.ts`,
not something this cut owns fixing.

**A rare, unreproduced-on-demand race was observed once** during this milestone's own debugging
(not since, across roughly 20 further runs, sequential and `--repeat-each 8`/`--workers 3`): Phase
6's `confirmed` counter read `2` (the out-of-range dispatch reported `Confirmed`) while `rejected`
stayed `0` for 400+ further ticks, even though `Puts::admit`'s own bound check was proven correct
in isolation three separate ways (a direct native call, a JSON-parse-then-`Codec`-round-trip native
call matching `ClientCore::on_action`'s exact steps, and the browser page itself passing on every
other run). Not reproduced since fixing the `pace`/`configureCanvasContext` issues above, and not
chased further given the time already spent and that the underlying admit logic is proven correct
independent of the browser; `expect.poll`'s own 20 s timeouts (added for the pacing finding above)
also make this shape fail loudly rather than hang, if it recurs. Worth a second look if `vertical_
slice` ever shows this failure mode again.

#### `gc-slice.html` + `src/gc-slice.ts`: the zero-GC window with actions (`pageId: 'zero_gc_action'`)

A second, separate page from `slice.html` -- `installGcPage`'s manual-clock, harness-driven shape
(`gc-connected-terrain.ts`'s own real connected+rendered+panning topology, reused near-verbatim)
cannot share a script with a real `requestAnimationFrame` production loop. `pageId:
'zero_gc_action'` (not the file's own `gc-slice` name) so `pnpm test browser -t zero_gc` -- the
brief's own Verification command -- matches every generated test title (`zeroGcSuite` names tests
`${pageId} clean`/`${pageId} neg ...`).

One `dispatchRaw(client, seq, PAINT_JSON_BYTES)` call every 30 frames inside the measured window
(`PAINT_JSON_BYTES` built once via `TextEncoder`, outside `drive()` -- 0016 §2: JSON encoding never
runs inside the window). A dispatched action's own *result* is drained and `JSON.parse`d by
`client.ts`'s own per-rAF `pollActionResults` pump, which runs unconditionally once `createClient()`
starts (registered inside `createClient` itself, not opt-in) and allocates by construction whenever
a kind-2 record is actually present -- the gap steps 1-5's own Deviations named ("a later cut owns
making it allocation-free... the zero-GC window with `dispatchRaw` -- step 6 -- is where that gets
budgeted").

**`main`'s own `budgets.json` row was first written `class: "budgeted"`, pre-emptively, without
first measuring `"strict"` -- corrected at the gate.** The reasoning above (JSON parsing allocates
by construction) explains *allocation*, not *GC events*, and assertion A is about GC events; the
honest answer to "did `strict` actually fail" is that it was never tried first. Measured on review
(`playwright test --project gc --grep "zero_gc_action clean" --repeat-each 8 --workers 1` with
`class: "strict"`): 8/8 clean runs pass, and every negative control (`object main`, `burst main`
included) passes 8/8 too, `burst main` now correctly tripping assertion A as well as B. The
~1,296 B/600 frames `pollActionResults` adds (20 dispatches at `DISPATCH_EVERY_FRAMES = 30`,
~65 B/parse) is real allocation but too small to cross V8's young-generation scavenge threshold --
the same reason `connected-terrain`'s own ~102 B/frame, over the same 600-frame window, triggers no
GC event either. `main` is now `"strict"`, matching every isolate on every other page; the row's own
`bytesPerFrame` (115) and its derivation are unchanged (class does not change what is measured, only
how assertion A reads the trace).

**Measured** (`playwright test --project gc --grep "zero_gc_action clean" --repeat-each 8
--workers 1`, this machine): `main` 106.59-106.92 B/frame (hardware; `byFn`: the same three sites
`connected-terrain` already pays -- `draw@terrain` 28,800 B, `drain@terrain` 12,000 B,
`stepFrame@client` 7,200 B -- plus `pollActionResults@client-*` ~1,296 B over the 600-frame window,
20 dispatches at ~65 B/parse each). `ceil(106.92) + 8 = 115` -- only 4 B above `connected-terrain`'s
own 111, confirming the action path itself is cheap. Software mode (`GC_MODE=software`,
`--repeat-each 6`): a flat `80.9467` B/frame every run -- `ceil + 8 = 89`, almost exactly
`connected-terrain`'s own 80.50-80.52 (the software instrument's own attribution walk does not
appear to reach `pollActionResults`, a `scheduler.requestFrame` callback `client.ts` registers on
its own rather than a call `drive()` itself makes -- the hardware-mode `byFn` figure above is what
actually prices that site). `client`/`gen0`: constant 0.8267 B/frame, reused `connected-terrain`'s
own `8` strict figure unchanged. `sim`: 7.93-9.94 B/frame (slightly above `connected-terrain`'s own
6.46-8.19: the extra is the admit path's own gross allocation inside the window before its matching
free -- `no_alloc_connection.rs`'s `host_admit_path_allocates_zero_bytes_per_action` already proves
this nets to exactly 0 B/action once freed, the same gross-vs-net shape `connected-terrain`'s own
`sim` formula documents for `runOneTick`/`warm`/`resync`) -- `ceil(9.94) + 8 = 18`.

**Every negative control re-verified to still trip at these numbers, against the final `"strict"`
class** (0029: never widen a budget that stops a control tripping) -- `pnpm exec playwright test
--project gc --grep "zero_gc_action neg"`, all 8 pass (now 9 with `burst main` also tripping
assertion A, see below), `object main` included (proving `B.main` still separates clean from a
genuine per-frame object leak at 115).

**A real, separate infrastructure gap was found and fixed along the way, while `main` still read
`"budgeted"`, and is kept** even though no page in this repo now uses `"budgeted"`: `zero_gc_action
neg burst main` (while `"budgeted"`) failed its *expected verdict*, not its actual verdict --
`B.main` correctly tripped (measured ~40,000 B/frame against 115), but `analyse.ts`'s own assertion
A is already class-aware (`class === 'strict' ? MinorGC + MajorGC === 0 : MajorGC === 0`, pre-dating
this milestone, untouched by it), and a `burst` control's fixed per-frame garbage reliably forces a
minor GC but not necessarily a major one -- `A.main` stayed genuinely `true`. `gc/suite.ts`'s
`expectedVerdict` assumed every isolate was `"strict"` (never previously false, since no page had
ever used `"budgeted"` before this one, briefly). Fixed by passing each isolate's own class through
(`zeroGcSuite`'s own `isolateClasses`, derived from the same `budgets.isolates` it already reads)
and only flipping `A[isolate] = false` for a `burst` control on a `"strict"` isolate; `B[isolate] =
false` is unchanged for every class. No existing `"strict"` page's own expected verdict changes
(re-verified: `connected-terrain neg object main`, `gc-loop neg burst main` both still pass) --
kept as a dormant but genuine correctness fix for whenever a future page's own isolate actually
needs `"budgeted"` (a real `MinorGC`-tolerant isolate, unlike this one). `pnpm gc software` (the
full suite, both modes), run three times across this cut: 77/77, 76/77 (one transient `parkWorkers`
timeout on `zero_gc_action neg burst main`), 77/77; and once more after the `"strict"` fix: 77/77,
76/77 (`sim neg object sim`, an unrelated pre-existing page, passed in isolation immediately after).
Both misses were on different pages under sustained back-to-back Playwright load, neither
reproduced on retry -- session load, not a real defect.

#### `budgets.json` editing tool, gate-round fix: a `json.dump` round trip re-encoded 5 untouched `§`s

Both `budgets.json` edits in this cut (the `zero_gc_action` page, the `uplinkBytesPerAction` row)
were made by loading the whole file with Python's `json` module and writing it back out, which
re-serializes every string in the file, not just the ones actually changed -- Python's default
`ensure_ascii=True` turned 5 pre-existing literal `§` characters (in `connected-terrain`'s own
`main`/`client`/`sim`/`gen0` and software formulas, untouched in content) into `§1` escape
sequences, hiding the real, reviewable diff (a changed number in this file is meant to stand out)
inside 41 lines of pure addition. Caught at the gate, not by this implementer. Fixed by restoring
those 5 lines byte-for-byte against the commit before this cut's own first touch (confirmed via a
line-by-line diff against that commit's own copy: zero non-addition lines remain), and by writing
this cut's own new formula strings with the literal `§` character instead of the escape sequence,
matching what the gate asked for. Lesson for a future edit of this specific file: edit the JSON
text directly (or via a tool that only touches the lines that actually changed), never a full
parse-and-reserialize round trip.

#### `counters.action.uplinkBytesPerAction` in `budgets.json`

Left unwritten by steps 1-5 (their own Deviations: "left to whichever cut actually owns editing
that file"). Re-measured, not copied from that section's own `eprintln!` figure, via a throwaway
native test (`crates/engine/tests/action_round_trip.rs`, `engine::bytes::CountSink` over
`UplinkWriter::write`, computed once and removed): `RAction::Bump { n: 12345 }` postcard-encodes to
**3 bytes**; wrapped in a one-action `UplinkBatch` with no camera and no presence, the whole batch
is **12 bytes** -- both figures confirmed identical to steps 1-5's own measurement.

#### `.claude/skills/add-action-type/SKILL.md`

Written from what this cut actually touched (`Puts::admit`, the bindings regeneration step,
`client.dispatch`'s typing) rather than from this brief. Exercised once, for real, before being
considered done: `__dispatchSetMotd` added to `puts-dispatch.ts` (an existing action, `SetMotd`,
already in `fixtures/puts`'s `Action` enum, so only the skill's steps 4-5 -- dispatch + typecheck --
were actually exercised by this particular addition; steps 1-3 are what `Puts::admit`'s own new
`Reject::OutOfRange` variant, above, exercised, before the skill document itself existed). Both
typechecks (`pnpm --filter engine typecheck`) and builds (`vite build`) cleanly.

#### Suite time

`pnpm test browser -t vertical_slice`: 1 test, ~7.7 s (dominated by Phase 4's real-time tick-100
wait). `pnpm test browser -t zero_gc`: 5 tests (clean + 4 fast-tier `object` negatives; `burst` is
`@slow` for every page but `gc-loop`), ~4.3 s. Full `pnpm test browser` was not run by this
implementer (the delegation prompt's own instruction: targeted runs only, the orchestrator gates
the full suite) -- report its new wall-clock time from the orchestrator's own next gate run.

#### Verified

`pnpm test rust -t action` -> 11 tests pass. `pnpm test unit -t dispatch` -> 4 tests pass. `pnpm
test wasm -t script_a` -> 1 test passes. `pnpm test browser -t vertical_slice` -> 1 test passes.
`pnpm test browser -t zero_gc` -> 5 tests pass. `pnpm lint` -> clean (one clippy `collapsible_if`
fixed along the way, a syntax-only change to `Puts::admit`, no behaviour change, re-verified against
both existing puts goldens). `pnpm gc software` -> 77/77 pass. `grep -rn bigint packages/engine/
fixtures/*/bindings` -> empty. `git diff fixtures/puts/bindings/` after the clippy fix -> empty
(bindings unaffected by the syntax-only change).

### gate round: vertical_slice pixel flake

`node scripts/repeat.mjs browser 15 --load 10` found `vertical_slice` failing 2/30 runs, always
`expectPixel(8, 8) channel r: got 34, want 30` -- 34 is `GRASS`'s own R channel exactly, so Phase
5's post-paint `WATER` read was seeing pristine `GRASS` still there.

**Hypothesis checked and rejected.** The orchestrator's hypothesis was `fx-puts`'s tick rule
(`WALK`) reaching one of the probed tiles. `WALK` (`fixtures/puts/src/lib.rs:158-166`) is a `const
[(i32, i32); 8]` of fixed offsets in `{-1,0,1}x{-1,0,1}` near the origin, indexed forever by `WALK
[g.walk_i as usize % WALK.len()]` (line 280) -- it can only ever paint one of those 8 fixed
positions, at any tick count, so it can never reach either probed tile ((20, 20) or (50, 50)). The
race was in the render catching up to a real event, not in what the sim painted.

**Real mechanism, three instances of the same shape.** `slice.html` real-time-paces its own render
loop (`requestAnimationFrame`, continuously calling `renderer.writeFrameUniform`+`draw` with the
*real* camera) and its own sim/gen/client workers, unlike every other test page in this suite. A
probe or wait built against wall-clock time or a fixed frame count assumes a bounded amount of work
finishes within that bound; under contention it does not:
1. Phase 2/5 pre-paint probes: a `setTimeout(r, 200)` after `__setCamera` assumed chunk generation
   for the new camera tile would land within 200ms of real time.
2. Phase 5 post-paint probe: `await new Promise(requestAnimationFrame)` after `Confirmed` fired
   assumed the *matching* upload-ring record (queued by the same `on_frame` call, but drained by an
   independent rAF-registered pump from the UI-ring result) would drain into `renderer`'s textures
   within one more frame.
3. `readTilePixel` itself (independent of timing): `__writeFrameUniform` then `__renderAndRead` was
   two separate `page.evaluate` calls, i.e. two separate CDP round trips with a real async gap
   between them, on a page whose own production loop calls `renderer.draw()` every real frame. Under
   contention the production loop's own rAF callback could interleave in that gap and overwrite
   `renderer.frameUniform` with the *real* camera before the probe's own draw ran, so the probe read
   the real camera's tile instead of the one it asked for -- silently, no error, just the wrong
   pixel.

**Fix, verified against the fixture (not assumed):** replaced every fixed wait with a wait on the
actual condition (`engine/test.untilQuiescent`, one rAF first -- see the `__sliceSettle` doc comment
in `slice.ts` for why the rAF has to come first, to avoid `untilQuiescent`'s own vacuous-pass trap:
right after a bare `cameraState` mutation, "every ring drained + `W_ACK==CB_FRAME_REQ`" can hold
trivially because nothing has been pushed yet), and made the pixel probe atomic (`__probeTile`: one
`page.evaluate` call doing `writeFrameUniform` + the synchronous half of `renderTo` in the same JS
turn, so nothing can interleave). Phase 3's fixed 3s wait was also replaced with `expect.poll` on
`chunkEntersPristine` actually increasing. `resumeWorkers` at the end of `__sliceSettle` un-parks
every worker `untilQuiescent`'s own trailing `parkWorkers` call parked, so the page's own production
loop and workers are still live for the next phase (confirmed: all later phases in the same test run
pass after a `__sliceSettle` call, including two more calls to it later in the same test).

**Evidence.**
- `pnpm test browser -t vertical_slice` x6 foreground (1 solo + 5 in a loop): 6/6 pass, ~7.3-7.6s
  each.
- A foreground, bounded (60s per-run kill timeout, nothing left running after) loop of `pnpm test
  browser -t vertical_slice` x20 under `--load 10` (10 CPU-burner children, killed on completion):
  `vertical_slice x20 load=10: pass=20 fail=0 hang=0`.
- **Failability shown**, isolating the atomic-probe fix specifically: with `__sliceSettle`/
  `expect.poll` left in place but `__probeTile` reverted to the pre-fix two-call `__writeFrameUniform`
  + `__renderAndRead` split, the same bounded, foreground, `--load 10` loop reproduced the exact
  original signature at run 15/30: `expectPixel(8, 8) channel r: got 34, want 30 (tol 2)`. Reverted
  back to `__probeTile` immediately after (typecheck clean, `pnpm test browser -t vertical_slice`
  passing again before committing). This confirms the atomic-probe half of the fix is load-bearing,
  not incidental, and pins the mechanism to instance 3 above (the two-call CDP gap), not merely the
  wall-clock waits.

### Orchestrator's gate (M16 done)

- **Skill verified standalone.** A fresh `general-purpose` Sonnet agent, told not to read `docs/plan/`, `PROMPT.md` or `PLAN.md`, followed `add-action-type` alone and added `Action::ClearMotd` (`SetMotd` already existed as the skill's worked example): `cargo nextest run -p fx-puts` 14/14, `bindings/Action.ts` regenerated with one line added, typecheck clean, `pnpm test wasm -t puts` and a browser page build green; then it reverted to a clean tree. It reported three gaps, all fixed in the skill at the gate: a fieldless variant serialises as a bare string (`'Roll'`), not an object; the skill never said to run the game's Rust tests; and **the golden-safety guidance covered only admission behaviour. A variant that adds a field to replicated state moves every golden hash, including `*_idle_*` scenarios that never dispatch it.** The agent hit that trap on its first try (a new `Global` field failed both `puts_idle_100` and `puts_script_a`) and backed out, so the skill now says so explicitly.
- **Repeat loops after the pixel fix (`67c67b4`):** `browser x15 load=10: pass=6 fail=9 hang=0`, and **all nine failures were the suite's wall-clock budget alone** (38-45 s against 0020 §2's 37.5 s failure line). No assertion failed: no pixel failure, no `Error` line. Quiet: `browser x15 load=0: pass=14 fail=1`, the one failure being `parkWorkers: timed out after 10000 ms` on `zero_gc_action neg object client`. That is the same test that failed the same way in the earlier 30-run quiet batch. **In isolation it went 20/20**, so this is suite-level saturation (the ledger's watch item), not a defect in the page. A quiet `pnpm test` measured `browser` 116 at 27 s. The loaded budget failures are the suite-time question in `PROMPT.md`, now measured: under `--load 10` the suite crosses the failure line in most runs.
- **Bindings:** `node packages/engine/scripts/build-fixtures.mjs` + `pnpm format` left `bindings/` byte-identical; `grep -rn bigint packages/engine/fixtures/*/bindings` printed nothing.
- **Unticked, awaiting Tyler:** the desktop-Chrome ten-press HUD check (criterion 2). `vertical_slice` asserts the same HUD text after its own dispatches, but ten presses of the real control in desktop Chrome is a by-hand check.

