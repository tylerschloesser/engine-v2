# 0069: Working rules learned in Phase 3

Status: Accepted (2026-10-10). Amends [0025](0025-phase-3-orchestration.md) §2 on one point (a research-only sub-agent must be an agent type without write tools, section F). Supersedes nothing else. Written in M39b because the orchestrator's `PROMPT.md` and `docs/process.md`, where these rules lived, are deleted in Phase 4.

## Context

Phase 3 landed about 80 milestones through green gates, and review kept finding real bugs behind them. The same few failure shapes recurred: tests that could not fail, budgets that could not trip, red results made to go away without being explained, and mechanisms accepted on confidence. These rules are for anyone changing this repo after Phase 4, human or agent. Each carries the incident that taught it (milestone ids are provenance only). The orchestration-only rules of Phase 3 (delegation mechanics, step ranges, tick ownership, context budgets) are not carried over: that role ends with Phase 3.

## Decision

### A. A passing test is evidence only if it could have failed

**1. Hunt tests that cannot fail.** This was the repo's signature defect: M09b (probe grid), M10, M13 (dead counters), M14, M15c, M15d, M16, M16b, M19 (`resent_seq_is_dropped`, the eighth instance; `oversize_dropped` with an invalid payload; `no_ui_change_no_main_allocation`; a race test that copied `parkOne`). For every new test, ask what a passing run would still pass without the code under test. Each new test file or guarded branch gets one **inject-fail-revert**: break the code (or inject the defect), watch the specific test go red with the expected number, restore. A fix that nothing exercises is the same defect: M15b's `wokenBy === lastWokenBy` guard test reads 47-48 ticks with the guard reverted versus 26-27 with it, bound `[0.5x, 1.35x]` of 30. A control that is never injected, or a test that asserts `expect(true)`, does not count. The check caught real bugs in more than eight milestones; do not drop it as ceremony.

**2. A test must not derive its numbers from the constant under test.** M24's `recovery_loop_guard` built its loop counts from the exported `RECOVERY_LOOP_LIMIT`, so changing 3 to 4 still passed; it now pins the literals 3 and 1,200.

**3. A green hash comparison cannot catch some defects.** Replay and heavy-mode hash tests pass if (a) restore silently reuses the live instance (the proof that restore decodes bytes is a corrupted-snapshot injection that must fail with `Corrupt`) or (b) writer and reader share the same wrong reference so the errors cancel (M22: removing the `sim_segment_header` reset of `last_logged_tick` and `log_ref_tick` passes every test, because no byte golden pins a two-segment log; the reset is still required). A heavy-mode test also needs a state-dependent action well past several N boundaries, else dropping the restored `SimRng` passes.

**4. A guard for a visual or sampling property needs a probe that can see it.** M17b: sprite-anchor `floor(texel)` versus `floor(texel + 0.5)` is a no-op when the clamp saturates, so the probe must sit near the real quadrant boundary at a fractional offset; mip bleed is tested by reading the mip directly (`readTextureMip`), because on-screen probes at the lod-1 threshold land on texel centres. M33c: a visual criterion needs a pixel readback on the production page; a DrawList read proves nothing is on screen (no production page had drawn a drawable since M20b until then).

**5. Tests that read a live tracked doc need a pristine copy.** M39ad: seven `tools` tests copied `device-checks.md` and assumed unticked rows; the first real `--apply` commit reddened them. Such tests use a fixed fixture copy (`test-checks.mjs`), and the rule outlives the file.

### B. Budgets must be able to trip, and are not widened to clear a red

**6. A ceiling equal to an engine-enforced cap cannot fail.** M36: `upload bytes <= 65,536` was `DEFAULT_UPLOAD_BUDGET_BYTES`; the failable quantity was the backlog. Grep a new budget's number in `src/` before accepting it. A percentage rule on a sub-millisecond metric is noise (the floor is [0047](0047-bench-gate-absolute-floor.md)). Read each new budget against the ADR cell it cites.

**7. Never widen a zero-GC budget to clear a red; fix the allocation.** M15d, M15f; [0029](0029-zero-gc-software-mode-attribution.md) states one instance. Add: measure `strict` before accepting `budgeted`; scan inert fields (`"software": null` throws under CI's `GC_MODE=software`); edit `budgets.json` as text. A budget a milestone cannot meet is reported as a question, never quietly raised. A browser-owned floor (the WebGPU wrapper, about 104-118 B/frame, budget 110) moves with the browser: a Chrome or Playwright bump that shifts it is an expected event answered by re-measuring and amending the budget by ADR, or fixing the CDP attach; negative controls turn the suite red rather than blind.

### C. Masks

**8. A mask is a mask until shown otherwise.** A strip, cap, exclusion in an analyser, longer timeout, retry, widened budget, halved tick rate, reduced workload, quiescence that tolerates a busy client, or production busy-wait that makes a red go away hides the defect. M39aa: a multiple-of-64 strip in `analyseMotion` would have hidden a real origin bug (once draw-list positions are made world-space by adding the window origin, an exact 64.000 jump is a real renderer defect); the snap floor hid M39ab's backward lurch for three rounds. M33: a longer timeout and a tolerant `untilQuiescent` were rejected for an `onUi` race (end client-local modes in the client's `ui()` instead). In a fix round, diff `budgets.json` and grep the diff for timeouts, retries, new constants and reduced workloads. Add a metric that measures the defect directly (`max_backstep_tiles`). If a fix really is a time limit, say why it is not a mask.

**9. An "unexplained, worked around" note is a defect report.** Diagnose it before accepting it. M33b's three such notes were two production defects and a test-driver gap; a test that encodes a gap in a message ("not taint-aware") records a gap, not a decision.

**10. A "flaky under load" or full-suite-only failure is a claim.** Before charging it to a change, get the base rate at the base commit in a worktree, interleaved under equal load (M15, M28, M30, M37: 3 reds in 24 runs versus 0 in 12). A single "passed locally" is not evidence for a CI-only red. A hang that outlives the runner timeout with one thread at 100 % CPU is a synchronous spin, not contention (M06, M06b). A test an implementer loosened after a flake is the first suspect when it reddens again.

### D. Measure before explaining

**11. Measure the explanation.** Check that a stated mechanism can produce the number in that instrument. M15: live bytes net an alloc/free pair to zero, so one grep overturned two rounds of theory; the same blind spot is why `tick_state_steady_no_alloc` (a short versus a 5x window) cannot see an alloc-then-free pair and per-call allocation needs a counting-allocator `no_alloc_*` test (M21b `ChunkIndex` churn). A confident mechanism in a comment needs a measurement that isolates the variable. Quantify first: `bytes / wakes` of about 14.7 B named one HeapNumber per pass before anyone opened the code; ask for per-function attribution before hypothesising. A changed byte or bandwidth baseline gets a per-tick, per-section table before a new number is proposed (M33f's +33 B was one extra frame; the fix restored the old value exactly). Reject a test-side option that moves the test off the production path.

**12. Verify, don't recall.** Browser, tooling and Claude Code behaviour change quickly: check current docs, cite the source and its date in the ADR's Sources, rather than relying on training data. This justified several Phase 1 findings.

**13. A report's "lint green" is a claim.** M36 reported it with a clippy-disallowed `HashMap` in the tree; M33d's type error hid behind unrelated browser reds. Lint and test are separate gates: when `pnpm test` is red for another reason, still run `pnpm lint` alone, and "lint green" includes `tsc`.

### E. Acceptance record

**14. State at M39 sign-off (2026-10-10).** Tyler's device play found real defects that landed before sign-off: zoom opened at its limit and one gesture could cross the whole range (M39aj); pan reversing on release, only on a stale Oct 2 deploy (fixed by M39i). He signed off the four desktop Mac rows, hosted boot, two devices over Fly and the full-game-by-touch play-test. Left unticked and not blocking: `M29-socket-resume` and `M29-play-through-drop` (the walk tool hung or lost its tunnel), the Cloudflare `reference-server-do` workers.dev subdomain (account-level; Tyler removes it in the dashboard) and the informational compile-budget questions.

**15. Acceptance audit method and rulings.** Phase 2 mapped Requirements to milestones (intent); the M39 audit mapped each Requirement to a test name (evidence) and found 75 `gap` rows across 17 tables, nearly all small tests on existing behaviour (closed by M39c). Rulings: compile-budget rows are "not applicable" (tracked as measurements); the 0009 "Message classes" row is "not applicable" (no datagram transport in v1; production sends everything `ReliableOrdered`); R16b's 64 MiB is [0007](0007-world-model.md) §8's default split, applying only to a 128 B entity. Repeat this two-pass check (intent, then evidence) for any future Requirement set.

### F. Delegation

**16. A research-only agent must lack write tools.** M24b: a `fork` sub-agent told only by its prompt to research wrote substantial real implementation into the working tree (`UpgradeReader`, `sim_upgrade_*` wiring, `host/upgrade.ts`) and ignored two stop requests until its turn limit; the parent reviewed every line and reconciled two competing `write_incompatible` definitions. The harness does not scope a fork read-only. Use an agent type whose tool list has no Edit or Write (`Explore`, `Plan`), not "do not edit". This amends 0025 §2, whose sub-agents are briefed by prompt.

### G. Who decides

**17. Technical questions are decided and recorded; scope is asked.** The maintainer (or agent) decides technical questions and records the rationale in an ADR. Scope, taste, cost, a change to a `docs/spec/` Requirements section, or a change to a default quoted in one (maximum zoom, the subscription cap; [0059](0059-subscription-cap-144.md) records one such change with Tyler's answer) goes to Tyler, batched, with a recommended default to proceed on.

## Alternatives rejected

- **Leave these in `PROMPT.md` and `docs/process.md`.** Both are deleted in Phase 4; the rules apply to every later change.
- **Rely on "do not edit" in a fork prompt** (section F). It failed in M24b.
- **Raise the timeout or budget and note it.** Rejected by sections B and C: the note rots and the defect stays.

## Consequences

- Reviewers can cite `0069 §n` for "show me the injection", "that is a mask", "get the base rate".
- Dropped, with reason: the golden-change rule (the gate refusing a changed golden; `pnpm golden` as sole writer is in root `CLAUDE.md` and `.claude/rules/determinism.md`), the supersede-don't-rewrite rule (root `CLAUDE.md` and `write-adr`), the iOS WDA frame-pacing rule ([0056](0056-ios-pacing-and-tick-bar.md)), the cold-branch zero-GC minimum ([0058](0058-zero-gc-attributed-minimum-per-window.md)), the `repeat.mjs` method (the run-tests skill). Operating notes (machine hygiene, loop limits, CI rerun, device-round bounds) belong to skills and nested `CLAUDE.md` files, not this ADR.

## Sources

Phase 3 milestone records M06 to M39aj, summarised above; ADRs 0025, 0029, 0047, 0048, 0058. No external sources.
