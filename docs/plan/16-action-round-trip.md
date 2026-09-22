# M16: Action round trip (vertical slice complete)

Status: not started · After: 15b · Tyler-dependent: no (Q1 answered: `serde_json` approved) · Device checklist attached (**D**)

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
- [ ] `vertical_slice` passes in Chromium; all other tests above pass.
- [ ] `pnpm device:serve` lists `slice.html`; in desktop Chrome ten presses of its Paint control show `confirmed 10`, `rejected 0`, `ring drops 0`, `engine_mem_grows 0` on every instance and an advancing `tick` on the HUD (`vertical_slice` asserts the same HUD text after its own dispatches).
- [ ] `bindings/*.ts` for `puts` are committed and regenerate byte-identically; `grep -rn bigint packages/engine/fixtures/*/bindings` prints nothing (0003: TS-facing types avoid `u64`).
- [ ] `.claude/skills/add-action-type/SKILL.md` exists and was followed once to add `Action::SetMotd` handling to the test page (or another variant) without reading this brief.
- [ ] PLAN.md marks the vertical slice complete.
- [ ] `pnpm test` and `pnpm lint` are green.

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
(filled in during Phase 3)
