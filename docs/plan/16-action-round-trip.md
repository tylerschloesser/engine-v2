# M16: Action round trip (vertical slice complete)

Status: not started · After: 15b · Tyler-dependent: PRE-PLAN §11 item 1 (`serde_json` sign-off; assumed approved) · Device checklist attached (**D**)

Split: `G::Ui` → UI ring → `onUi`, `client.clock()` and the minimal `FrameView` moved to `16b-ui-observation-and-clock.md` (size). M17 depends on 16b; M21 depends on this milestone only.

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
- **Skill** `.claude/skills/add-action-type/SKILL.md`, written last from what was actually done.

## Non-scope
Prediction, `NotPredictable`, pending replay (M25). Persistence (M22). Action rate limit and `RateLimited` (M31). Presence table content and witness checks (M19). State-budget check (M21). `Hello`/`Welcome` (M28), resend after reconnect (M28b). `onUi`, `clock()` (M16b).

## Files, packages and crates touched
`packages/engine/src` (`client.ts`, `worker.ts`, `vite.ts`, `test.ts`), `packages/engine/crates/engine` (`abi/client.rs`, `client/`, `host/`), `packages/engine/fixtures/puts`. Plus `.claude/skills/`.

## Seams
**Provides:** `client.dispatch`, `client.onActionResult`, the extended meaning of `client.ready`; clock block layout; action-ring and UI-ring record formats (kind 2); exports `on_action`, `client_poll_ui`; `Host` admit pipeline; `engine/test` `dispatchRaw(seq, jsonBytes)` (pre-encoded, for the zero-GC window per 0016 §2) and `actionResults()`; golden `wasm_script_a_matches_native`; skill `add-action-type`.
**Consumes:** M15b `SimHost.accept`, `sim_admit`, `sim_build_frame`, `on_frame`, `client_poll_uplink`; M15 `Host`, `ClientCore`; M14 `ActionResultsWriter/Reader`, uplink actions; M13 `sim_seal_frame`, `logSink`; M12b `Record`, `Outcome`; M06 `SabSet.{actionRing, uiRing, clockBlock}`, `SeqlockWriter`/`SeqlockReader`; M06b `Client`, `untilQuiescent`; M11 `injectPointer`; M09 `renderTo`/`readPixels`/`expectPixel`; M02 `buildGame`, `abi::registry`, `pnpm golden`; M02b the Vite plugin.

## Planning decisions
- **How write-ahead ordering is preserved for M22.** Admission only *collects* records. `sim_seal_frame()` (M13) is the single point where the frame for T+1 becomes immutable; `SimHost` calls `logSink` between it and `sim_tick()`. Here the export still returns 0, and `host_applies_only_sealed_records` proves an action admitted after the seal lands in T+2. M22 makes the export emit the 0005 log frame and sets `logSink = storage.append`; no call order changes.
- **How main learns the `seq` seed (PRE-PLAN §10 gap).** Carrier: `seq_seed` + `session_state` in the clock block. Until M28 the client worker sets them from the **first frame's `ack_seq`** (the host's `last_seq` for this player, which is what `Welcome.last_processed_action_seq` will carry); M28 switches the source to `Welcome` and nothing on main changes. Main reads the seed exactly once, when `session_state` first becomes 1.
- **`dispatch` before the first `Welcome`/frame throws** (`Error("engine: dispatch before ready")`); `client.ready` resolves at `session_state = 1`. Queueing would need a seq-less second path and hides a bootstrap bug; the world is not visible before ready anyway. After ready, `dispatch` never waits for a connection: during an outage records queue in the outbox and a full outbox or action ring throws `Error("engine: action queue full")` (0012 "dispatch fails locally").
- **Results share the UI ring** as a second record kind rather than a new ring: both are JSON at human rate for the same consumer, and ring order gives the "state before result" delivery rule for free.
- **Typed fast path for continuous actions:** decided in M14 (not built).

## Order of work
1. Host admit pipeline + native loopback tests. 2. `on_action`, outbox, results → UI-out. 3. TS `dispatch`/ring/clock block/`onActionResult`. 4. bindings step + typed fixture page. 5. WASM-under-Node script golden (`scenario.json` for `puts_script_a`, blessed with `pnpm golden puts`; the native test switches to `assert_golden`). 6. Playwright slice test, zero-GC window with `dispatchRaw`. 7. skill.

## Tests added
Rust: `action_lands_on_next_tick`, `arrival_order_within_tick`, `ack_and_deltas_share_a_frame`, `admit_reject_is_not_recorded`, `apply_reject_is_recorded_and_replays`, `resent_seq_is_dropped`, `host_applies_only_sealed_records`, `malformed_action_is_protocol_error`. TS unit: `dispatch_before_ready_throws`, `dispatch_returns_monotonic_seq_from_seed`, `ui_ring_delivers_results_in_order`. WASM under Node: `wasm_script_a_matches_native`. Browser: **`vertical_slice`**: page is cross-origin isolated; terrain probes pass; injected pan brings new chunks (probe + `netCounters`); a `sim` worker exists and `worldHash()` matches the golden at a fixed tick; `dispatch({ Paint })` returns 1, `onActionResult(1, "Confirmed")` fires and the probe at that tile shows the new colour in the same stepped frame as the result; `dispatch` of an out-of-range `Paint` yields `Rejected` with the typed reason. Zero-GC test now includes actions via `dispatchRaw`.

## Exit criteria
- [ ] `vertical_slice` passes in Chromium; all other tests above pass.
- [ ] `bindings/*.ts` for `puts` are committed and regenerate byte-identically.
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
The slice page must be listed by `pnpm device:serve --tunnel` and show the counters the items read: `Confirmed` / rejected results, ring drops, `engine_mem_grows` per instance, the tick counter.

## Deviations
(filled in during Phase 3)
