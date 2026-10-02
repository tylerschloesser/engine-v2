# Deferred ledger audit (M39)

Audit of every row of `docs/plan/deferred-ledger.md` (rows are cited by their line number, `L<n>`, in that file). Each row was checked against the cited ADR, brief section or Deviations, not against the row's own claim. Read-only: nothing was run.

Counts: 146 rows. closed 82, open: owned, unanswered 45, open: watch item 19.

Reading the "owned, unanswered" rows: 12 of them (L10, L17, L21, L25, L26, L35, L38, L40, L44, L47, L48, L50) are Tyler-run device checks in `docs/plan/device-checks.md`, none of which is ticked yet; they are owned by M39's device checklist and are not defects. The other rows name a milestone as owner that is ticked and whose Deviations or ADR does not answer them. Judgement calls: L8 and L76 are marked closed on weaker evidence than the rest, and the closed rows of part 2 that cite an ADR rest on the ADR existing and covering the topic, not on a full trace.

| Ledger row (short) | Closed by | Status |
|---|---|---|
| Typed fast path for continuous action streams (L7) | `docs/plan/14-wire-framing.md` Planning decision (line 44): not built, flag bits 2-7 kept free | closed |
| Zero-GC negative control raises a sibling isolate's reading, gc-sim `main` 28 B (L8) | `docs/plan/15f-step-sim-tick-sync-allocation.md`: the +28.0 B/frame on `main` attributed to `stepSimTickSync` and fixed; sibling-hook nesting in `docs/decisions/0029-zero-gc-software-mode-attribution.md` | closed |
| Presence as optional replay track (L9) | `docs/plan/19-presence-channel.md` line 43: not built | closed |
| Determinism on x86-64, iPhone, Android (L10) | x86-64 closed (CI runs cited, M10); iPhone is the unticked M03 device check in `docs/plan/device-checks.md`; Android: no device (Q5) | open: owned, unanswered |
| `+simd128` and `wasm-opt` (L11) | `docs/decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md` §5: both stay off | closed |
| Provisional ids for predicted entities (L12) | `docs/decisions/0022-entity-ids-and-provisional-ids.md` | closed |
| Taint rule after `NotPredictable` (L13) | `docs/plan/25-prediction-core.md` Planning decision (three candidate rules), criterion ticked at line 76 ("chosen taint rule ... under Deviations") | closed |
| Per-action growth declaration (L14) | `docs/decisions/0023-action-growth-declaration.md` | closed |
| Overlay change list + predicted flag (L15) | `docs/plan/26-prediction-rendering-and-clocks.md` (`OverlayDiff`, `is_predicted`), M26 ticked | closed |
| Undo journal (L16) | `docs/decisions/0037-undo-journal-adopted.md` | closed |
| Own-timer completion gap of one RTT (L17) | M26 decided (stretch over duration + lead); M34 by-hand feel check is unticked, listed in `questions-for-tyler.md` "Criteria awaiting Tyler" | open: owned, unanswered |
| Lead estimation; iterating reads; `entity(id)` (L18) | `docs/plan/26-prediction-rendering-and-clocks.md` line 46 (median of last 8); ADR 0022 §7 | closed |
| Exact `TickCx`/`FrameCx`/`FrameView`/`OldStore` shapes (L19) | M12b/M21b, M17, M18, M24b briefs (`OldStore` at `24b` line 35) all ticked | closed |
| Reference-game coverage check (L20) | `docs/plan/reference-coverage.md` | closed |
| OPFS append/flush latency on iOS Safari (L21) | Retune rule fixed in M23 brief; `M23-opfs-latency` in `device-checks.md` unticked | open: owned, unanswered |
| `Rescale` helper for `migrate` (L22) | `docs/plan/24b-upgrade-and-migration.md` line 18 (`Rescale` + `RescaleTicks`) | closed |
| Entity store layout, `EntityId` reuse (L23) | ADR 0022 | closed |
| Overlay promotion at 512; area effects (L24) | `docs/plan/07-world-model-core.md` Planning decision 9 (line 56): not built | closed |
| On-device validation of 64 MiB world-budget split (L25) | Engine half done (M07 `memory_bytes`, M36 `mem.simHighWaterLargeSave` 88 MiB); device run is M39, large-save items unticked | open: owned, unanswered |
| ms per chunk on iPhone / Android (L26) | M08 device check in `device-checks.md` unticked; Android no device | open: owned, unanswered |
| Sampled pristine-hash check (L27) | `docs/plan/08-worldgen-and-gen-worker.md` line 50: decided none | closed |
| Noise helpers into engine crate (L28) | `engine::noise`, M08 (ticked; brief decision) | closed |
| Durable Object adapter feasibility (L29) | `docs/decisions/0051-durable-objects-no-go.md` | closed |
| WebTransport adapter (L30) | `docs/plan/27-server-entrypoint-and-netcode-harness.md` line 45: not built, revisit triggers | closed |
| Real frame sizes vs bandwidth budget (L31) | M15 counters, M31 `budgets.json`, ADR 0048 (839 B/s downlink measurement) | closed |
| Engine-side byte diffing (L32) | ADR 0048 §6: not needed (masked 0.696) | closed |
| Section ids, varint coding, overlay run format (L33) | M14 goldens and `wire/CLAUDE.md` | closed |
| "Copy my player link" (L34) | `docs/plan/28-sessions-and-reconnect.md` line 54: not built | closed |
| iOS Safari worker-owned socket after resume (L35) | `M29-socket-resume` in `device-checks.md` unticked | open: owned, unanswered |
| Final export list, region ids, status codes (L36) | `packages/engine/crates/engine/src/abi/registry.rs` exists; `abi-registry` test in M02 | closed |
| Where `engine.log` is decoded (L37) | `packages/engine/src/loader.ts` `LoaderHooks.onLog` | closed |
| On-device memory ceilings (L38) | `M11-memory` in `device-checks.md` unticked | open: owned, unanswered |
| Ring capacities, uplink poll, control block, `yield` (L39) | M06, M06b, M29 briefs, all ticked | closed |
| COOP/COEP listings on a real static host (L40) | `docs/plan/38-hosting-checks.md` line 27 and `device-checks.md` line 233: explicitly unverified, handed to M39b | open: owned, unanswered |
| Periodic snapshot inside strict zero-GC window (L41) | `docs/decisions/0039-snapshot-write-is-a-budgeted-event.md` | closed |
| Final main-thread B/frame and anchoring constants (L42) | `packages/engine/budgets.json` has `gc.pages.drawables` (line 383) and `anchors` (line 420) | closed |
| Software-adapter form of assertion B (L43) | M10 (ticked), ADR 0029 | closed |
| Packaging-spike untested items (L44) | Linux watch closed (M10 CI); `server.fs.allow` defect fixed and `ts-rs zero bytes` test in `35-packaging-and-adapters.md` (lines 91, 98); posted `Module` in real Safari is the unticked `M35-safari-build-*` / `M11-boot` device checks | open: owned, unanswered |
| One crate or several (L45) | `docs/plan/01-scaffolding.md` line 83: one crate, split triggers | closed |
| Real release build time, profiles, restore-on-edit (L46) | ADR 0045, ADR 0050 | closed |
| Zero-GC harness run by hand in Safari and Firefox (L47) | `M17b-harness-desktop-safari` in `device-checks.md` unticked | open: owned, unanswered |
| Terrain shader fill-rate on real phones (L48) | `M09b-fill-rate` in `device-checks.md` unticked | open: owned, unanswered |
| Exact WGSL, manifest schema, upload-ring layout, frame clock (L49) | M09, M17b, M06b briefs, ticked | closed |
| Overlay anchoring on iOS Safari (L50) | `M18-anchors` in `device-checks.md` unticked | open: owned, unanswered |
| "Follow with user offset" (L51) | `docs/plan/11-camera-and-input.md`: not in v1 | closed |
| Input-ring layout, easing, wheel constants, `FrameCx` (L52) | M11, M18 briefs, ticked | closed |
| Spike B: SwiftShader WebGPU on ubuntu-latest (L53) | M10, CI runs cited in row | closed |
| Spike C: byte-identical traces over loopback `ws` (L54) | `docs/plan/29-net-worker-and-reference-server.md` Deviations: `ws/spike-c` converged, byte-identical | closed |
| 30 s rebuild numbers; sccache vs shared target (L55) | ADR 0048 (no cache tool), ADR 0049 (45 s budget) | closed |
| `createClient` option local vs remote host (L61) | `docs/plan/06b-workers-and-spawn.md` line 37 | closed |
| `client.input` surfacing in `FrameCx` (L62) | `docs/plan/18-picking-and-overlay.md` line 60 (`cx.input()`) | closed |
| How main learns `last_processed_action_seq` (L63) | `docs/plan/16-action-round-trip.md` line 50 (`seq_seed`); M28 switches to `Welcome` | closed |
| `dispatch` before `Welcome` (L64) | `docs/plan/16-action-round-trip.md` line 51: throws | closed |
| `TileTexel::from_tables` registration (L65) | `Registry::set_base_visual` in `world/traits.rs:130` | closed |
| Where test files live (L66) | `docs/plan/01-scaffolding.md` line 75 | closed |
| `browser` suite headroom trip-wire (L72) | ADR 0033, then 0036 (48 s), then 0048 | closed |
| Software-mode attribution on `main` needed at all? (L73) | No mention in `36b-suite-audit-and-measurements.md` or ADR 0048; M36b was the owner and did not answer it | open: owned, unanswered |
| Non-zero `wasm` runner exit with passing report (L74) | `docs/plan/17d-fast-tier-wall-time.md` (`watchCrate` fix); row text itself says "Closed" | closed |
| `Host::chunk_versions` never pruned (L75) | `docs/plan/31b-desync-hashes.md` Planning decision line 90: kept, R5 accepted | closed |
| Client `Cache::events` never drained (L76) | `docs/plan/15c-terrain-visibility-and-cache-invalidation.md` (Uploader is the consumer; draining by `Uploader::on_frame`) | closed |
| `gc-sim-paced` `main` budget vs interpreter worst case (L77) | `docs/plan/15d-client-clock-allocation.md` | closed |
| `parkWorkers` timeout under saturation (L78) | `docs/plan/17c-client-park-stall.md` (row says closed by M17c; 16e/16f instrumentation) | closed |
| `ManualClock` boxes `HeapNumber`, ~12 B/frame (L79) | Only noted in `15d` line 224 and `09` line 650; no brief or ADR addresses it; gc-sim half fixed by 15f | open: owned, unanswered |
| Cache-invalidation gap, `evict_if_present` (L80) | `docs/plan/15c-terrain-visibility-and-cache-invalidation.md` | closed |
| `server.ts` `resync()` has no running-ahead branch (L81) | `docs/plan/15e-paced-tick-measurement.md` line 182 names M36b as candidate; `36b`, `36` and ADR 0048 do not address it | open: owned, unanswered |
| `SimHost.runOneTick` ~2.27 B/frame on connected sim (L82) | Owner "M31 or M36b": neither Deviations nor ADR 0048 mention it | open: owned, unanswered |
| Locally dropped action yields no `onActionResult` (L83) | Owner M25: `25-prediction-core.md` covers queue full and local Rejected as hint, not the malformed/outbox-drop seq | open: owned, unanswered |
| Sim paced under external wakes stalls (L84) | ADR 0032 (exists; row cites `sim_ticks_steadily_under_external_wakes`) | closed |
| `untilQuiescent` resolves before a delta's upload is queued (L85) | Owner M17b/M18: no fix found (M20c fixed a different `ringSabs` hang) | open: owned, unanswered |
| Uplink batch ~50 ms after camera move vs "send only on change" (L86) | `19-presence-channel.md` Deviations only notes camera relies on the 50 ms batch floor; not reconciled with 0010 | open: owned, unanswered |
| `sim-paced` `formula` string quotes pre-M15b numbers (L87) | No milestone edit found; text only | open: owned, unanswered |
| `AtomicsTimer` clock read per real tick vs per-frame ceiling (L88) | ADR 0032 Amendment records it; row says watch | open: watch item |
| Resync window after catch-up skips chunk warming (L89) | ADR 0032 Amendment; not observed, `chunksWarmed` counter | open: watch item |
| `connected-terrain neg burst @slow` main 111.07 vs 111 at load 10.7 (L90) | Row itself: not reproduced, watch | open: watch item |
| `pnpm test` build step WARN 32-42 s (L91) | ADR 0033 (exists, warm build 7.3 s) | closed |
| `gc-test` skill: `resume()` parked workers before driving `stepFrame` (L92) | `.claude/skills/gc-test/SKILL.md` lines ~108, 193-197 describe it (M17c) | closed |
| `browser` suite 24 s of 25 s at M17b (L93) | ADR 0033 / 0036 / 0048 §1 (browser p50 41 s of 48 s) | closed |
| `terrain: chunks generate, upload and evict` CI flake x2 (L94) | Row: watch, never local | open: watch item |
| Pointer slot reused after longpress inherits stale `wasActive`/`heldMs` (L95) | No fix or ADR found; M18's own fix (`18-picking-and-overlay.md` ~L849) is a different case | open: owned, unanswered |
| `fx-terrain` `frame()` no longer clears `InputQueue` (L96) | Accepted in row (fixture-only; `GameInstance` clears every frame) | closed |
| `input.game_record_survives_overflow` never reaches 64+1 (L97) | Owner M33: no overflow test found in M33 briefs | open: owned, unanswered |
| `stepping: 1,000 stepTick()` wrong hash once in 30 (L98) | M18c diagnostic; did not recur in 195 runs | open: watch item |
| Admit path / `no_alloc_*` 900 B net on CI (L99) | `30c-ci-reds-after-m30.md` line 65: `thread_live_bytes` fix; row records cause | closed |
| Fx-overlap debug panic on an entity put over another id's tile (L100) | Owner M33: `33-reference-furnace.md` has game-side `place_overlapping_*` tests only; assert neither added nor declined | open: owned, unanswered |
| `park('sim')` timeout while Armed on `gc: flat transport parity` (L101) | M19b (shared `Wake` word); PLAN row ticked | closed |
| `RemotePresenceEntry::arrived_ms` tick-derived (L102) | `30-interpolation.md` line 119 (`tick_fraction(local_ms)`, arrival threaded) | closed |
| Harness worker crash never rejects pending `parkOne`/`send` (L103) | No owner milestone addressed it | open: owned, unanswered |
| `bench.frame_worstcase` record_count 65,408 on CI (L104) | `19c-ci-reds-frame-bench-and-admit-path.md` section A (setup drain waits on published slot), ticked | closed |
| Undo journal does not restore player slot or `SimRng` (L105) | `25-prediction-core.md` Deviations (~L136-141): neither matters to client reconciliation | closed |
| `SnapshotWriter` materialises whole snapshot in arena (L106) | `36-slow-tier-and-benchmarks.md` high-water: 88 MiB ceiling with one whole snapshot, inside 96 MiB arena; stall 51 ms inside 83 ms | closed |
| `logSink` `subarray()` per logged tick (L107) | ADR 0039 / M23: strict sim-worker zero-GC with Persistence armed (log append stays strict) | closed |
| No byte golden for a log crossing two segments (L108) | Owner M24/M36: nothing found in 24 or 36 Deviations | open: owned, unanswered |
| Engine-edit rebuild ~147 s before suites (L109) | ADR 0048 §3, ADR 0049 (45 s budget, Q17 answered) | closed |
| Client-side `apply` panic traps the client instance; prediction opt-out (L110) | Candidate M26: none; M37's client-trap reaction covers re-instantiation, not the prediction question | open: owned, unanswered |
| `replace_overlay` re-materialises synchronously on client worker (L111) | Owner M31/M36b: no reference-worldgen join-burst measurement found | open: owned, unanswered |
| Acks only through the player slot (L112) | Row's own M28b ruling: documented contract, `netcode/CLAUDE.md` | closed |
| `engine/test` imports `node:fs` transitively; grep misses dynamic import (L113) | Conditional trigger only; not hit | open: owned, unanswered |
| `createBytePump` uplink `.slice` per message (L114) | Owner M35/M35b: no mention in either brief | open: owned, unanswered |
| `reference-server` default world `BadConfig` (L115) | `34-reference-multiplayer.md` line 24 (`world.json`), ADR 0042 | closed |
| Remote client can't learn seed/params (L116) | ADR 0042 (M33f) | closed |
| `device-serve/proxy-and-apps` skipped on CI (L117) | Row: owner whoever revisits `buildGame` bindings; not revisited | open: owned, unanswered |
| Fresh DOM anchor shows at layer origin for a frame (L118) | Candidate M37: not in 37 or ADR 0050 | open: owned, unanswered |
| Reference pan snapped back by spawn `moveTo` (L119) | Closed by L141 row (M33e, `shouldMoveToSpawn`) | closed |
| `paced_session_lands_periodic_snapshots` ~1 in 15 unattributed (L120) | Owner M36b: only appears as a FAIL in 36b timing runs; never attributed | open: owned, unanswered |
| Chrome for Testing EXC_GUARD crashes baseline (L121) | Row: machine watch | open: watch item |
| Full-suite-only `reference_*` flakes (L122) | Row: watch | open: watch item |
| Chrome crash rate rose 2026-09-29 (L123) | Row: machine watch | open: watch item |
| Degrade saves only headers, not bytes (L124) | ADR 0048 §6 (byte diffing not needed, 0011); coalescing not pursued | closed |
| Per-tick pacing cost not O(1) per chunk (L125) | `36-slow-tier-and-benchmarks.md` step 5b: encode once per chunk per tick, 2.87 ms median (ledger L156 residual) | closed |
| Frame overflow loses other held chunks' deltas (L126) | Row: low, revisit if a game can produce such a chunk | open: owned, unanswered |
| Hash-all not on in Vite dev server (L127) | Owner M37: not in 37 or ADR 0050 | open: owned, unanswered |
| No browser first-differing-offset line for a desync (L128) | Same as L127; `onDesync` carries hashes only | open: owned, unanswered |
| `assertConverged` phase-sensitive under degrade (L129) | No harness fix found | open: owned, unanswered |
| `unit` at its 3 s budget (L130) | ADR 0048 §2 (`unit` runs first, 1.26 s) | closed |
| `mp/hello-resent-after-pre-welcome-drop` silence (L131) | `30d-hello-resent-silence.md` Deviations, ticked | closed |
| Rejected `Hello` settle stalls later `Hello`s (L132) | `37-robustness-events.md` ~L104 says `accept` untouched, rows unchanged | open: owned, unanswered |
| `paced-session-lands-periodic-snapshots` red once at load 12 (L133) | Row: second sighting gets attributed (see L120) | open: watch item |
| Drawables never reached a production page (L134) | M33c (`attachClientDrawables`), ticked | closed |
| `client.onUi` on real rAF, stepped test races it (L135) | Fixed in two cases (M33, M33e `readUi`); decision on engine-side option deferred to a third case | open: owned, unanswered |
| Action results lost in `FrameBundle` (L136) | M33d, ticked (row says closed) | closed |
| Sprites unpickable (L137) | M33d | closed |
| `stepFrame` writes no viewport (L138) | M33d | closed |
| `Loopback` sends `last_received_tick` 0 (L139) | M33d | closed |
| Reference tile (58, 55) never completes `collectN` (L140) | Row: unexplained, watch (M34b did not need a far resource) | open: watch item |
| Reference first-`Ui` races (L141) | M33e (`shouldMoveToSpawn`, `readUi`), 0 in 60 | closed |
| `unit` 3.4-3.7 s of 3 s under load (L142) | ADR 0048 §2 | closed |
| Chrome crash 2026-09-30 07:32 (L143) | Row: machine watch | open: watch item |
| `plugin-dev.test.ts` ENOENT `fx_hash.wasm` once (L144) | Row: second sighting gets attributed | open: watch item |
| `WorldMismatch` has no reload policy or end-to-end test (L145) | Owner M37: `37-robustness-events.md` ~L96 leaves it "unchanged"; no ADR 0050 policy, no scenario | open: owned, unanswered |
| Load-only `browser` reds 2026-09-30 (L146) | Row says diagnosis owed before M36; M36b did not attribute | open: owned, unanswered |
| Chrome crashes 2026-09-30 08:24-09:40 (L147) | Row: machine watch | open: watch item |
| `net.hashesBytesPerS` 68.6 vs 66 B/s ceiling (L148) | Owner M36b budget audit: not in 36b or ADR 0048 | open: owned, unanswered |
| Host detach presence thin cover (L149) | M34c `reference_returning_player_supersedes_and_keeps_presence` | closed |
| Netcode harness seed is a number (L150) | M34c / M34b (`worldSeed`) | closed |
| One `ERR_HTTP_RESPONSE_CODE_FAILURE` sighting (L151) | Owner M36b: not mentioned; single sighting | open: watch item |
| First `Ui` on remote page before roster frame (L152) | Owner M37: not in 37 or ADR 0050 | open: owned, unanswered |
| F5 during startup gets `world-busy` (L153) | ADR 0050 §6; `37-robustness-events.md` ~L114 (`world-owner`, `WORLD_LOCK_WAIT_MS`) | closed |
| Sibling-burst collateral on `net` in multiplayer neg burst (L154) | Owner M36b: not addressed in 36b or ADR 0048 | open: owned, unanswered |
| M30b first-launch tax recurred 2026-09-30 (L155) | ADR 0048 §3 (`split-debuginfo = "packed"`, cause found) | closed |
| `slow_tick_large_save` headroom 2.87 ms vs 3 ms (L156) | Row: watch, re-run quiet before charging a red | open: watch item |
| `drawables neg burst sim @slow` timed out 90 s once on CI (L157) | Row: second sighting gets a diagnosis | open: watch item |
| 15 fast browser tests red under local macOS SwiftShader (L158) | Orchestrator ruling in row: local-only artefact, CI green | open: watch item |
| `trap: gen twice is fatal` red once in 8 local runs (L159) | Row: unreproduced, second sighting gets diagnosis | open: watch item |
| `hidden_tab_upload...` red under local SwiftShader (L160) | Row: same local-only ruling | open: watch item |
| Slow-tier gc burst tests ~11 s under 90 s CI timeout (L161) | Row: diagnosis owed, never answer with `gcTimeoutMs` | open: owned, unanswered |
| `Persistence.open` instantiates module twice on restore (L162) | ADR 0051 records it as the DO no-go cause; no fix or decision | open: owned, unanswered |

## Open rows and recommended disposition

### From L7-L81

- L10 (iPhone determinism; Android): Phase 4 carry-forward (Tyler-run device check, Android no device).
- L17 (own-timer feel check): Phase 4 carry-forward (criterion awaiting Tyler, M34).
- L21 (OPFS iOS latency): Phase 4 carry-forward (M39 device checklist; a result may need an ADR superseding 0005's interval).
- L25 (64 MiB split on device): Phase 4 carry-forward (M39 large-save device run).
- L26 (ms/chunk on iPhone/Android): Phase 4 carry-forward (M08 device check).
- L35 (iOS socket resume): Phase 4 carry-forward (M29 device check; tunes only 0013 timeouts).
- L38 (on-device memory ceilings): Phase 4 carry-forward (M11-memory device check).
- L40 (COOP/COEP on a static host): Phase 4 carry-forward (already handed to M39b).
- L44 (posted Module in real Safari): Phase 4 carry-forward (M35/M11 Safari device checks).
- L47 (zero-GC harness in desktop Safari/Firefox): Phase 4 carry-forward (M17b device check).
- L48 (terrain fill-rate on phones): Phase 4 carry-forward (M09b device check).
- L50 (iOS overlay anchoring): Phase 4 carry-forward (M18-anchors device check; a failure needs an ADR superseding 0019).
- L73 (drop software-mode attribution on `main`?): Phase 4 carry-forward (simplification, not a defect); or one-line ADR decision "keep".
- L79 (`ManualClock` HeapNumber box): Phase 4 carry-forward (test-only, absorbed by budgets); or "watch, no action".
- L81 (`resync()` no running-ahead branch): Phase 4 carry-forward; ADR 0030 amendment if closed ("bounded" claim holds one direction only).

### From L82-L162

Owned, unanswered:
- L82 runOneTick 2.27 B/frame: Phase 4 carry-forward (budgeted in `connected-terrain` `sim: 17`).
- L83 dropped action no result: Phase 4 carry-forward.
- L85 untilQuiescent vs delta upload: Phase 4 carry-forward.
- L86 50 ms uplink vs send-on-change: Phase 4 carry-forward (or a one-line ADR 0010 note).
- L87 budgets.json formula text: Phase 4 carry-forward (text fix).
- L95 stale pointer slot state: Phase 4 carry-forward.
- L97 game_record_survives_overflow: Phase 4 carry-forward.
- L100 overlap assert on registered prototypes: Phase 4 carry-forward, or a Deviations note declining it.
- L103 harness worker crash never rejects park: Phase 4 carry-forward.
- L108 two-segment log golden: Phase 4 carry-forward.
- L110 client-side prediction trap policy: ADR (NotPredictable vs re-instantiate).
- L111 synchronous re-materialise cost: Phase 4 carry-forward (measure with reference worldgen).
- L113 `engine/test` node imports: Phase 4 carry-forward (trigger-conditional).
- L114 `createBytePump` uplink copy: Phase 4 carry-forward.
- L117 device-serve test skipped on CI: Phase 4 carry-forward.
- L118 fresh DOM anchor at origin: Phase 4 carry-forward (small production fix).
- L120 and L146 load-only `browser` reds (`paced_session`, `no_ui_change`): Phase 4 carry-forward (attribution owed).
- L126 frame overflow residue: Phase 4 carry-forward (low).
- L127 and L128 hash-all in dev server, browser desync offset: Phase 4 carry-forward.
- L129 `assertConverged` phase under degrade: Phase 4 carry-forward.
- L132 rejected `Hello` settle stall: Phase 4 carry-forward (small fix with test).
- L135 `onUi` on stepped frames: Phase 4 carry-forward (decide at a third case).
- L145 `WorldMismatch` policy and test: ADR (page policy) plus a netcode scenario.
- L148 `hashesBytesPerS` over ceiling: Phase 4 carry-forward, or ADR if the ceiling scales with activity.
- L152 first Ui before roster: Phase 4 carry-forward.
- L154 `net` sibling-burst collateral: Phase 4 carry-forward.
- L161 slow-tier burst timeout headroom: Phase 4 carry-forward (diagnosis).
- L162 `Persistence.open` double instantiate: ADR when fixed; Phase 4 carry-forward until then.

Watch items (disposition "watch, no action"): L88, L89, L90, L94, L98, L121, L122, L123, L133, L140, L143, L144, L147, L151, L156, L157, L158, L159, L160.
