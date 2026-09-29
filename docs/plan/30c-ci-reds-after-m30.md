# M30c: Three CI-only reds after M30

Status: not started · After: 30b · Tyler-dependent: no

Written by the orchestrator at M30b's CI read (2026-09-29). Same shape as M19c: CI-only, intermittent, so the job is to attribute from CI's own artifacts, fix the cause, and leave a failure-only diagnostic where the cause cannot be shown. Every red below passed on a same-commit rerun at least once, and every one is green locally.

## Goal
CI's fast tier passes on consecutive pushes again. Each of the three reds below has a named cause and a fix, or a committed failure-only diagnostic that will name the cause on its next occurrence. No test is weakened.

## The evidence (orchestrator, from CI runs)
Runs: 36636714669 (`M30 done`), 36639392014 (`5ad3301`), 36642513660 (`M30b done`). Suite wall times on CI are unchanged from the green M29 runs (browser 254-286 s, netcode 12-16 s), so M30 did not measurably add load.

- **A. The 900 B one-off, three binaries in one day.** It has appeared in `engine::no_alloc_ui ui_constant_value_does_not_grow_the_arena` (run 36639392014) and in `engine::no_alloc_drawlist drawlist_extract_and_sort_does_not_grow_the_arena` (run 36642513660), both as `900 B over 300 frames but 0 B over 1,200 frames`. Earlier, `host_admit_path_allocates_zero_bytes_per_action` read 900 B once (M19c, run 36087861610; 0 in 500 local runs). The same byte count in three unrelated code paths, always in the short window only, points at something the `no_alloc_*` binaries share: their counting `#[global_allocator]`, the test harness, or another thread in the process. That is a guess; the deferred-ledger row "`host_admit_path_allocates_zero_bytes_per_action` read 900 B" has the history.
- **B. `netcode ws/join-converges`** (M29 test, `packages/engine/tests/netcode/ws-transport.test.ts`). It first failed as `engine: dispatch before ready` after its fixed `advanceTicks(20)` (run 36636714669). The orchestrator's `5ad3301` replaced that with a bounded wait until every client is `Online`. Run 36642513660 then hit Vitest's 5 s test timeout inside that wait (`× ws/join-converges 5059ms`). So on CI, four real loopback handshakes can take more than 5 s of real time, and it isn't known whether the time goes to the socket, the handshake pump, `handshakesSettled`, or starvation by the parallel browser suite.
- **C. `[chromium] mp/version-mismatch-reloads-once`** (M29, browser): `waitForFunction: Test timeout of 45000ms exceeded` in run 36642513660.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/19c-ci-reds-frame-bench-and-admit-path.md` (the 900 B diagnostic already committed, and how it reads)
3. `docs/plan/29-net-worker-and-reference-server.md` (Deviations: the ws transport, `mp.html`, CI rounds 1-8)
4. `docs/decisions/0016-zero-gc-definition.md` (what the no-alloc instrument claims)

## Scope
- For each red, attribute from CI artifacts: `gh run download <id>` has `test-results/`, and `gh run view <id> --log-failed` has the rest. Where the cause isn't visible, commit a **failure-only** diagnostic, then stop so the orchestrator can push and rerun (below).
- For A: find out which thread and which call site own the 900 B. If they belong to the process rather than the measured path (for example a harness or runtime thread), fix the instrument so it counts only the measuring thread. Prove it: the instrument must still catch an allocation injected into the measured path. If they belong to the measured path, fix the path.
- For B and C: find where the real time goes and fix the cause. That can be production code, the harness, or a genuinely racy wait.

## Non-scope
Any other test. New features. Raising a zero-GC or byte budget, lengthening a timeout, adding retries, `@slow`-demoting or skipping any of these three tests. Each of those is a mask, and only the orchestrator could approve one, with an ADR.

## How CI rounds work here
The implementer never pushes. Commit diagnostics as `M30c: …` and stop. The orchestrator pushes, reruns the failing job as needed (`gh run rerun <id> --failed`, several times for a rate), and returns the run ids. One implementer is kept alive across rounds (M10's pattern).

## Files, packages and crates touched
`packages/engine/crates/engine/tests/` (no-alloc instrument and binaries), `packages/engine/tests/netcode/`, `packages/engine/src/test/`, `packages/engine/tests/browser/` (the `mp` spec and page), and production files only where attribution names them.

## Tests added
Each fix comes with a control that shows the test still fails on the defect it exists to catch. For A: an injected allocation in the measured path still fails the no-alloc test, run once and pasted.

## Exit criteria
- [ ] Deviations name each red's cause, or say what the diagnostic will print on its next occurrence.
- [ ] Two consecutive CI runs on `main` are green in the fast tier, with the orchestrator reading them.
- [ ] No budget, timeout or skip marker is changed (`pnpm gate` markers: none).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t no_alloc` · `pnpm test netcode -t ws/` · `pnpm test browser -t mp/` · `pnpm test && pnpm lint`

## Budgets
None changed.

## Context artifacts
If the no-alloc instrument changes: one line in `packages/engine/crates/engine/CLAUDE.md` saying what it counts.

## Manual device checks
none

## Deviations

Base `1369cbc`; commits `6cbfb4d` (A), `84206c2` (B), `65ceba2` (C). `pnpm gate 1369cbc`: markers none, goldens none.

### A: the 900 B is libtest's main thread (cause named; instrument fixed)

- **Attribution, measured locally with a scratch crate** (outside the repo, same toolchain 1.93.0, a counting allocator that tags each thread): libtest's main thread allocates `+608 +48 +64 +96` = **816 B (macOS)** net *after* spawning the test thread (the running-test map, timeout queue and friends), then blocks. Quiet, it finishes before the test body starts (0 B seen by the test); with the main thread delayed 20 ms per allocation (a stand-in for a starved CI runner) all 816 B land after the test thread's first allocation, i.e. inside the first measured window. The short window always runs first in every failing test, and CI read 900 B on Linux (sizes differ by platform; not measured on Linux, no container runtime running here). Also found: `Arena`'s `LIVE` counter is a non-atomic load/store pair, so two threads allocating at once can lose an update; per-thread counting sidesteps it for the instrument (production `LIVE` unchanged).
- **Fix**: `engine::abi::arena::thread_live_bytes() -> isize` and `thread_high_water_bytes() -> isize` (calling thread only, signed; native-only `const` TLS `Cell`s touched from `grow_live`/`shrink_live`; on wasm32 they return `live_bytes()`/`high_water_bytes()` and `thread_delta` is an empty inline fn). Every `crates/engine/tests/no_alloc_*.rs` `live()` wrapper now returns `isize` from `thread_live_bytes()`; `no_alloc_connection.rs` imports `thread_high_water_bytes as high_water_bytes` (`admit_run_traced` returns `(isize, isize, Vec<i64>)`); `no_alloc_tick_state.rs`'s `live().saturating_sub(b)` became `(live() - b).max(0)` (same clamp).
- **Controls**: new `no_alloc_codec.rs::instrument_counts_the_measuring_thread_only` (another thread holds 900 B inside the window: its own counter reads 900, the process count moves, the measuring thread's does not; a 9 B allocation on the measuring thread reads 9). With `live()` switched back to `live_bytes()` it fails: `left: 14338, right: 13478` (+860 B from the other thread). Injected `std::mem::forget(Vec::<u8>::with_capacity(9))` per frame into `no_alloc_drawlist.rs`'s measured `run()`, reverted: `the DrawList path allocates per frame: 2700 B over 300 frames but 10800 B over 1,200 frames (9 B/frame ...)`.
- Not changed (other owners): fixture no-alloc tests outside `crates/engine/tests/` (`fixtures/predict/tests/alloc.rs`, `fixtures/migrate-v2/...`, `fixtures/machines/tests/journal_bench.rs`, `fixtures/worldgen/tests/contract.rs`, `games/reference/sim/tests/worldgen_contract.rs`) still read process-wide `live_bytes()` and carry the same latent exposure.

### B: the time was a fixed 20 ms real sleep per tick (cause named; fixed)

- **Measured locally** (scratch probe test, deleted): `ws/join-converges` reached `Online` in **3 ticks**, but each `advanceTicks` tick cost p50 23.8 ms, 20 ms of it the unconditional `setTimeout(20)`; the test runs 20 + k + 60 (`SETTLE_EXTRA_TICKS`) ticks, **~1.9 s of real time locally** with nothing in flight for almost all of it. On a loaded runner each `setTimeout(20)` stretches and still guesses short when a socket is slower.
- **Fix** (`src/test/net-harness.ts`): both loopback ends are in-process, so every raw `ws` end is wrapped by `countedEnd(raw, stats, side)` counting whole messages sent/received per direction, plus close frames (`WsPairStats { key, c2hSent, c2hRecv, h2cSent, h2cRecv, hostCalledClose, clientCalledClose, hostDown, clientDown }`). `advanceTicks` (ws only) now awaits `wsDelivered()` (polls `setTimeout(1)` until nothing is in flight) *before* `handshakesSettled()`, replacing the sleep. `WS_DELIVERY_DEADLINE_MS = 2_000`: past it, it throws naming each stuck link, e.g. (from the control below) `createNetHarness(ws): 4 message(s) still undelivered after 2000 ms real time, before host tick 2 (received/sent per direction): link 0:0: c2h 1/2, h2c 0/0, closed by host false/client false, ...`.
- **After**: probe p50 4.0 ms/tick, settle 24 ms; fast `netcode` suite **1.1 s** (was 12-16 s on CI); `pnpm test:slow netcode` 7 tests 36 s. Controls: barrier disabled -> `ws/join-converges` fails `expected [0,0,0,0] to deeply equal [1,1,1,1]` and `ws/version-mismatch` fails `expected undefined to be 4002`; a phantom second sent message -> the deadline diagnostic above.
- The close-frame accounting was needed: a first cut that dropped closed links from the count let `ws/version-mismatch`'s `advanceTicks(12)` finish before the 4002 close arrived.

### C: cause not proven on CI; three real defects fixed on that path; diagnostic committed

- **CI numbers** (run 36642513660 attempt 2 `report.json`): `mp/two-pages` 16.2 s, `mp/superseded` 14.4 s (two page boots each, so ~7 s per boot); `mp/version-mismatch-reloads-once` timed out at 45.2 s *inside* the 20 s-bounded `updating` wait, so goto + reload + second ready took over 25 s, and the second page then never reached `updating` in the time left. Locally the whole test takes ~2 s.
- **Defects found by measuring the page locally** (a scratch spec sampling `__mpLinkLog` every 500 ms for 12 s; deleted):
  1. `worker/client-net.ts` sent `Hello` once per page before the first `Welcome` (`helloSent`). Any pre-`Welcome` redial (dead timer: it runs from the dial and the server says nothing before `Hello`; or a version-mismatch retry) opened a socket that never said `Hello`: the probe showed 7 retry `open`s and 2 `silence`s but only the one original `close:4002` in 12 s. A page whose first `Hello` is lost can never be rejected or welcomed, which is the CI symptom, but no CI run has shown that this is what happened.
  2. `CB_LINK_GEN` restarted at 1 in every rebuilt `Link`, so even a per-generation resend skipped a retry's first dial. `worker/net.ts` now writes its own `dialSeq` (every dial of every `Link`) into `CB_LINK_GEN`; `createLink`'s `onUp(conn, gen)` signature is unchanged (net.ts ignores `gen`).
  3. `client.ts`'s `scheduleVersionMismatchRetry` rescheduled itself forever and every rejection started another chain. With (1) fixed that multiplies: **61 rejections in 1.5 s** (control below). Now `scheduleVersionMismatchRetry()` (no argument) keeps one pending retry at a time and a persistent step (`versionMismatchRetryStep`, `versionMismatchRetryPending`); the next retry is scheduled by the next rejection. After: rejections at 0, 0.5, 1.5, 3.5, 8.5 s (the 0/500/1000/2000/5000 schedule).
  4. Found by the new regression test: `server.ts`'s `pumpHandshakes` attached a stale queue entry whose `ConnId` a new connection had reused (the first socket died after its `Hello`), sent the `Welcome` to the dead socket and marked the new connection settled, so it streamed frames without ever getting a `Welcome` (diagnostic read `state=connecting log=["open:-","close:1006","open:-"]` after 44 s). Now it also requires `conns[entry.conn] === entry.connection`.
- **Tests**: new `mp/hello-resent-after-pre-welcome-drop` (`startTestServer({ dropFirstHello: true })`, a new optional field: kill the first socket when its first message arrives, before any reply); it fails without (1) or without (4). `mp/version-mismatch-reloads-once` gains `2 <= VersionMismatch closes <= 5` in its existing 1.5 s window; reverting (1) alone -> `Expected: >= 2, Received: 1`; reverting (3) alone -> `Expected: <= 5, Received: 61`.
- **Failure-only diagnostic** (`mpDiagnostics(page)` in `mp.spec.ts`, used by both tests): Node-side step marks, every page `load`, and the link state/log polled every 250 ms (so it survives the timeout), appended to the thrown error. Verified it prints after a real 45 s test timeout: `[mp diagnostics] load @33 ms; last link @44654 ms state=connecting log(newest first)=["open:-","close:1006","open:-"]`. On a recurrence it will say which step ate the time and whether the second page ever saw a `close:4002`, a `close:4004` (Full), or only `silence`.

### Other

- One full local `pnpm test` run failed `[chromium] semantic input keyboard focus rules` (unrelated file, amid CVDisplayLink noise); the immediate rerun of the full suite and 3 isolated runs of that test passed.
