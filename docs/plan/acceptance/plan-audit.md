# PLAN.md audit (M39)

One row per brief in `docs/plan/<NN>*.md`, in `PLAN.md` order of numbering. Checks: the `PLAN.md` row is ticked; every exit-criteria box is ticked or explained by Deviations or `questions-for-tyler.md` "Criteria awaiting Tyler"; every Deviation that changed a decision is covered by an ADR, a `PLAN.md` "Plan-level decisions" line, or a ledger or questions entry that resolves it. Read-only: nothing was run.

Counts: 85 briefs. ok 83, issue 0, in flight 1 (39), unstarted 1 (39b). `PLAN.md` rows 01-38 are all ticked (including every `b`/`c`/`d`/`e`/`f`/`g` split); rows 39 and 39b are unticked.

Unticked boxes outside 39 and 39b: 16 (ten-press HUD, awaiting Tyler), 16c (`vertical_slice` under 3 s, unmet there, inherited and ticked by 16d), 17d (warm build at most 5 s, amended at the gate to 7.3 s, ADR 0033), 34 (smooth remote motion and throttled own-timer bars, awaiting Tyler), 38 (Fly billed cost and teardown, awaiting Tyler). None is unexplained.

Method note: the decision-change check was a skim of each Deviations section plus targeted reads of every "decision needed", "superseded" or "amended" hit, not a line-by-line read of the roughly 25,000 lines of Deviations. A decision change worded without those terms could be missed. M29's by-hand "two browser tabs" criterion is ticked on its automated portion and the by-hand part is carried by `device-checks.md` (M29).

| Brief | Row ticked | Unticked boxes (and why) | Decision changes without ADR | Status |
|---|---|---|---|---|
| 01-scaffolding.md | yes | none | none | ok |
| 02-build-and-determinism.md | yes | none | none | ok |
| 02b-vite-plugin.md | yes | none | none | ok |
| 03-browser-harness.md | yes | none | none | ok |
| 04-zero-gc-harness.md | yes | none | none | ok |
| 05-codec-and-state-hash.md | yes | none | none | ok |
| 06-sab-primitives-and-workers.md | yes | none | none | ok |
| 06b-workers-and-spawn.md | yes | none | none (budgets above 0016 strict were superseded in-brief, restored by ADR 0028) | ok |
| 07-world-model-core.md | yes | none | none | ok |
| 08-worldgen-and-gen-worker.md | yes | none | none | ok |
| 08b-gen-workers-and-queue.md | yes | none | none | ok |
| 09-renderer-terrain.md | yes | none | none (burst controls: ADR 0026; waitForWake: ADR 0027/0028) | ok |
| 09b-terrain-art-and-lifecycle.md | yes | none | none | ok |
| 10-ci-workflow.md | yes | none | none (four decisions needed: ADR 0029) | ok |
| 11-camera-and-input.md | yes | none | none (ADR 0028) | ok |
| 12-store-and-game-trait.md | yes | none | none | ok |
| 12b-world-access-and-sim-driver.md | yes | none | none | ok |
| 13-sim-host-tick-loop.md | yes | none | none | ok |
| 13b-tick-timing-allocation.md | yes | none | none (ADR 0030) | ok |
| 14-wire-framing.md | yes | none | none | ok |
| 15-connection-and-subscriptions.md | yes | none | none | ok |
| 15b-ring-connection-and-replica-rendering.md | yes | none | none | ok |
| 15c-terrain-visibility-and-cache-invalidation.md | yes | none | none (PLAN.md plan-level line) | ok |
| 15d-client-clock-allocation.md | yes | none | none | ok |
| 15e-paced-tick-measurement.md | yes | none | none | ok |
| 15f-step-sim-tick-sync-allocation.md | yes | none | none | ok |
| 15g-handoff-checks.md | yes | none | none | ok |
| `16-action-round-trip.md` | yes | 1: desktop-Chrome ten-press HUD (awaiting Tyler; questions-for-tyler.md Criteria awaiting Tyler, device-checks.md) | none (sim-stall finding handled by M16c/M16d, ADR 0032) | ok |
| `16b-ui-observation-and-clock.md` | yes | none | none (result-before-ui ordering is within 0004/0012; 'decisions for cut 2' resolved in-brief) | ok |
| `16c-browser-suite-time.md` | yes | 1: vertical_slice <3 s (unmet, escalated; inherited and ticked by 16d) | none (workers 3 to 5 is ADR 0031; stall is ADR 0032) | ok |
| `16d-sim-pacing-under-external-wakes.md` | yes | none | none (ADR 0032 amends 0030 §2; ledger row closed) | ok |
| `16e-park-timeout-diagnosis.md` | yes | none | none | ok |
| `16f-harness-waits-and-sibling-burst.md` | yes | none (step 3 cut line, escalated) | none (open watch item in ledger: connected-terrain burst) | ok |
| `17-drawlist-and-sprites.md` | yes | none | none | ok |
| `17b-sprites-and-frame-budget.md` | yes | none | none (counter/budget changes are in-brief fix round 1, budgets.json) | ok |
| `17c-client-park-stall.md` | yes | none | none (fix round 1 superseded by round 2 inside the brief; ledger row closed) | ok |
| `17d-fast-tier-wall-time.md` | yes | 1: warm build <=5 s (amended at gate to 7.3 s) | none (ADR 0033) | ok |
| `18-picking-and-overlay.md` | yes | none | none | ok |
| `18c-stepping-hash-under-load.md` | yes | none | none (ledger watch row) | ok |
| `19-presence-channel.md` | yes | none | none | ok |
| `19b-sim-park-while-armed.md` | yes | none | none (ledger row closed) | ok |
| `19c-ci-reds-frame-bench-and-admit-path.md` | yes | none | none | ok |
| `20-reference-game-v0.md` | yes | none | none (allowlist coverage gap escalated at cut 1, closed in cut 2) | ok |
| `20b-reference-player-and-collect-ui.md` | yes | none | none (ADR 0035 on_init) | ok |
| `20c-client-ack-freeze-under-untilquiescent.md` | yes | none | none (ledger row records fix) | ok |
| `21-entities-and-timers.md` | yes | none | none (no decision changed per brief) | ok |
| `21b-timers-wakeups-and-tickcx.md` | yes | none | none (undo journal is ADR 0037) | ok |
| `22-persistence-log-and-snapshots.md` | yes | none | none (container additions are ADR 0038) | ok |
| `22b-persistence-load-and-fs.md` | yes | none | none | ok |
| `23-persistence-opfs-and-lifecycle.md` | yes | none | none (snapshot-in-window is ADR 0039; Decision 3 explicitly needs no ADR) | ok |
| `24-recovery-and-migration.md` | yes | none | none (Admit EngineFault decision needed was resolved at gate: sim_fault_ack; 0024 §5 onFatal) | ok |
| `24b-upgrade-and-migration.md` | yes | none | none (0005 Upgrades caveat noted, 0024 §3 covers) | ok |
| `24c-engine-edit-rebuild-time.md` | yes | none (30 s floor unmet is a Planning decision, not a box) | none (Q14/Q14b, ADR 0049) | ok |
| `25-prediction-core.md` | yes | none | none (ADR 0022; 'decisions needed: none') | ok |
| `26-prediction-rendering-and-clocks.md` | yes | none | none (bench:frame option resolved by post-done fix; residual latency fixed in later rounds; Q10 stretch; lead test shape delay+1 documented) | ok |
| `27-server-entrypoint-and-netcode-harness.md` | yes | none | none (own_player Rust finding fixed at gate round 1, narrow exception, recorded) | ok |
| `28-sessions-and-reconnect.md` | yes | none | none (ADR 0030 cross-ref only) | ok |
| `28b-reconnect-and-lifecycle.md` | yes | none | none | ok |
| `29-net-worker-and-reference-server.md` | yes | none (criteria 3-4 of the by-hand list noted unmet in Deviations but boxes all ticked) | none: unfixed gap (client discards `Welcome` seed/params) closed by M33f, ADR 0042 | ok |
| `30-interpolation.md` | yes | none | none: formula change is ADR 0040 | ok |
| `30b-rust-rebuild-quick-wins.md` | yes | none | none | ok |
| `30c-ci-reds-after-m30.md` | yes | none | none | ok |
| `30d-hello-resent-silence.md` | yes | none | none | ok |
| `31-rates-and-integrity.md` | yes | none | none: `FrameBundle` is ADR 0041; camera 20 Hz finding fixed at gate (limiter back to 10 Hz per 0010); cap 128 to 144 is Q15 (nothing changed) | ok |
| `31b-desync-hashes.md` | yes | none | none: R2 premise note is brief-internal | ok |
| `32-reference-crafting.md` | yes | none | none | ok |
| `33-reference-furnace.md` | yes | none | none | ok |
| `33b-reference-furnace-operation.md` | yes | none | brief Planning decision "`pick_id` is the entity id" superseded by open-by-tapped-tile (brief-level only, not an ADR rule; recorded in Deviations) | ok |
| `33c-drawables-on-real-pages.md` | yes | none | none: colour byte order defect fixed in M33c (ledger row closed) | ok |
| `33d-bundle-results-and-sprite-picking.md` | yes | none | none: defect fixes, `PLAN.md` plan-level line | ok |
| `33e-reference-first-ui-races.md` | yes | none | none: `PLAN.md` plan-level line | ok |
| `33f-client-world-config-from-welcome.md` | yes | none | none: ADR 0042 (amends 0013, 0015, 0035) | ok |
| `34-reference-multiplayer.md` | yes | 1: by-hand smooth motion (and throttled own-timer bars); listed in questions-for-tyler.md "Criteria awaiting Tyler" | none: `sim_detach`/`ABI_VERSION` 38 recorded at gate as a defect fix | ok |
| `34b-reference-scripted-single-player.md` | yes | none | none: demotion is ADR 0043; straddling-furnace finding became M34d | ok |
| `34c-reference-scripted-multiplayer.md` | yes | none | none: `net.bytesPerHour` budget row added, a new row not a changed one | ok |
| `34d-straddling-entity-chunk-versions.md` | yes | none | none | ok |
| `35-packaging-and-adapters.md` | yes | none | none: engine JS budget re-decided and `./render` ruling are ADR 0045 | ok |
| `35b-bun-and-deno-adapters.md` | yes | none | none: Bun pin is ADR 0044 | ok |
| `36-slow-tier-and-benchmarks.md` | yes | none | none: genesis writes ADR 0046; bench gate floor ADR 0047 | ok |
| `36b-suite-audit-and-measurements.md` | yes | none | none: ADR 0048 (`split-debuginfo` amends 0045 §3) | ok |
| `37-robustness-events.md` | yes | none | none: ADR 0050 | ok |
| `37b-device-loss.md` | yes | none | none: SwiftShader ruling is in the ledger; 0020 §6 rule unchanged | ok |
| `38-hosting-checks.md` | yes | 2: results table (Fly billed cost) and teardown (Fly app kept for Tyler's device check, Cloudflare subdomain); Deviations and questions-for-tyler.md "Criteria awaiting Tyler" agree | none: DO no-go is ADR 0051 | ok |
| `39-acceptance.md` | no | 7 (in flight) | n/a | in flight |
| `39b-phase-4-handoff.md` | no | 8 (not started) | n/a | unstarted |
