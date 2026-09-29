# M30b: Rust rebuild time, simple options only

Status: not started · After: 30 · Tyler-dependent: partly (a macOS setting only Tyler can change; everything else runs without him)

Written by the orchestrator at M30's gate, at Tyler's request (2026-09-29): "investigate speeding up the rust build. I only want to consider simple options and/or quick wins. I'd prefer a long build over complexity." **That sentence is this brief's governing rule.** A change that makes the build faster but the repo harder to understand is out of scope, however large its payoff.

## Goal
We know why a one-line edit in `packages/engine/crates/engine/src/` now costs 208-494 s before the first suite starts, when it cost 54-58 s on 2026-09-26 (deferred-ledger row "After any engine-crate change `pnpm test` spends ~147 s…"). Every simple fix that measurably helps is applied. Everything else is written down as rejected, with the reason.

## What is already known
- M24c attribution (its Deviations): compile + link is ~27-30 s. The rest was macOS's first-launch security check on each freshly linked test binary (~1.2-3 s each, 67 binaries then), all executed by the fixtures step's `--workspace` bindings run (`BINDINGS_CARGO_ARGS`, `packages/engine/src/build-game.ts`).
- Tyler enabled macOS Developer Tools for his terminal. Re-measured 2026-09-26: 54-58 s wall (`fixtures` 38-40 s, `reference` ~7 s, `doctests` ~4.7 s).
- This session measured `build WARN 226s/10s (fixtures 208s)` on the first `pnpm test`, and `518s (fixtures 494s)` after M30 step 2 added one Rust test binary. The machine is shared with other sessions (check `uptime` before each timing).
- `--workspace` on the bindings step is deliberate (M17d; pinned by `scripts/lib/build-game-bindings-scope.test.mjs`). M24c showed `--lib` only moves the cost into `cargo-tests`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§3, the compilation paragraph) and `docs/decisions/0033-fast-tier-budget-after-build-fix.md`
3. `docs/plan/24c-engine-edit-rebuild-time.md` (Deviations: the attribution method and the consolidation pattern)

## Scope
Candidates, in this order. Measure each before and after, and keep only what helps:
1. **Explain the regression first.** Is the first-launch check back? Measure one freshly linked binary's first and second `--list` run, as M24c did. Check whether Developer Tools is still on for the app that actually runs the builds. A Claude Code session may run under a different parent app than the terminal Tyler enabled; `sudo spctl developer-mode enable-terminal` covers only Terminal. Also check whether the binary count, machine load or anything else moved. If the fix is a macOS setting, you cannot change it: write the exact steps for Tyler under Deviations and report it.
2. **Cargo profile settings only**, for example `debug = "line-tables-only"` or `debug = 0` for dependencies under `[profile.dev]`/`[profile.test]`. Keep a setting only if it measurably helps and backtraces still show file:line.
3. **Fixture test-binary consolidation**, the ledger's named next step, using M24c's existing `tests/main.rs` + `mod` pattern and guard. Do it only if step 1's numbers show the binary count still dominates *after* any macOS fix, and it is pure file moves. Otherwise record it as rejected with the measured payoff it would have had.

## Non-scope
Anything that adds a tool, a moving part or a concept: sccache, a shared target dir, alternative linkers, the Cranelift backend, nightly flags, `cargo-hakari`-style workspace hacks, splitting or merging crates, changing the build-step pipeline or `BINDINGS_CARGO_ARGS`, CI caching. Changing what any test asserts. Changing 0020 §3's 30 s budget: if it stays out of reach, record the floor and stop; the ADR is the orchestrator's.

## Files, packages and crates touched
Root `Cargo.toml` (profiles), fixture crates' `tests/` only under candidate 3, `scripts/lib/engine-test-binary-layout.test.mjs` (or a sibling guard) only under candidate 3.

## Seams
**Provides:** none. **Consumes:** M17d's build steps, M24c's guard and consolidation pattern.

## Planning decisions
1. **Simplicity beats speed** (Tyler, above). When in doubt, reject and record.
2. **Timing discipline.** Every timed run carries its `uptime` line. The command is `touch packages/engine/crates/engine/src/lib.rs && pnpm test unit`, three runs per data point. A run at a 1-minute load above ~8 is discarded and re-taken. No wall-clock tests (17d fix round 1).
3. **Test list unchanged.** Sorted `cargo nextest list --workspace` has the same count before and after, and no test body changes (M24c Planning decision 1).

## Order of work
1. Baseline and regression attribution (no code change). 2. Apply the kept candidates, re-measuring after each. 3. Final three-run measurement and a warm `pnpm test`.

## Tests added
None, unless candidate 3 is taken; then extend the binary-layout guard and show it failing on a stray file.

## Exit criteria
- [ ] Deviations hold the baseline, the regression's cause (or what was ruled out) and a before/after table per candidate, each with `uptime`.
- [ ] Every candidate is applied or rejected, each with a one-line reason; any macOS step for Tyler is written out exactly.
- [ ] The sorted `cargo nextest list --workspace` count is unchanged.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`touch packages/engine/crates/engine/src/lib.rs && pnpm test unit` (×3, before and after) · `cargo nextest list --workspace | sort | wc -l` · `pnpm test` · `pnpm lint`

## Budgets
0020 §3 compilation budget (≤ 30 s from a one-line Rust edit to tests starting): measured, not necessarily met.

## Context artifacts
If a profile setting or consolidation lands: one line in `packages/engine/crates/engine/CLAUDE.md` saying what was chosen and why.

## Manual device checks
none

## Deviations
**Cause (no code change): the stale `target/` directory, not the code.** Measured with `touch packages/engine/crates/engine/src/lib.rs`; first-launch time is `<bin> --list` on a freshly linked binary.
- Old `target/` (created 2026-09-26; its dirs carry the xattr `com.apple.provenance`): every freshly linked test binary costs a constant **5.5 s** on first launch (12 of 12 sampled; second launch 0.01-0.02 s). 168 binaries; `--no-run` build 83 s. Full `pnpm test unit`: **577 s** (fixtures 549 s), load 14.4 at start (`15:37`).
- Same commands, any *fresh* target dir (`CARGO_TARGET_DIR` in the scratchpad or in the repo, opt-level 0/2/3 variants for unique content): first launch **0.14-0.29 s**, workspace `--no-run` 21-55 s. Identical binary content (same hashes) was slow in the old dir and fast in the new one, so it is not a per-content cache and not the path `target/`. Removing the xattr from `target/debug/deps` alone did not help.
- Fix applied: `mv target target-old`, cold rebuild (41 s), `rm -rf target-old`. `xattr target` now lists only `com.apple.metadata:com_apple_backup_excludeItem`.
- Ruled out: binary count (168 now; M24c had 67-80, the growth is only ~2x), machine load (fast runs happened at load 16-20), debuginfo size (binaries are 1-4 MB), Developer Tools being off (`DevToolsSecurity -status` says "Developer mode is currently disabled" in this session's shell, yet fresh dirs are fast, so the setting is not what separates the two cases).
- Process tree of a Bash call here: `zsh <- claude <- zsh <- tmux (pid 1453, ppid 1)`; iTerm2 is running separately. The build processes' parent app is therefore the tmux server, not Terminal/iTerm, so `spctl developer-mode enable-terminal` (Terminal only) would not cover them. **Not needed now, but if the 5.5 s/binary tax returns on a fresh dir, Tyler's steps:** System Settings > Privacy & Security > Developer Tools > "+" > add `/opt/homebrew/bin/tmux` (the server process, `which tmux`) and iTerm.app, toggle on, then `tmux kill-server` and start a new session. **Recurrence check:** `xattr target` (a `com.apple.provenance` entry) or a sample `touch ...lib.rs && cargo test --workspace --no-run` then `time target/debug/deps/<fx_*> --list` (5.5 s = bad, 0.2 s = good); fix is `rm -rf target` (cold build ~40-90 s).

**Result** (`pnpm test unit` after the touch; `uptime` 1-min load at start; the machine stayed loaded by other sessions, so every run is an upper bound):

| state | load at start | wall | fixtures |
|---|---|---|---|
| before (old target) | 14.4 | 577 s | 549 s |
| after, cold (first run) | 4.5 | 63 s | 44 s |
| after | 10.0 | 36 s | 22 s |
| after | 18.7 | 36 s | 23 s |
| after (target-old removed) | 15.9 | 39 s | 25 s |
| after | 20.3 | 39 s | 26 s |
| after | 25.7 | 40 s | 27 s |

Floor: `reference` 7.5 s + fixtures 22-27 s + doctests 1 s = 33-40 s, over 0020 §3's 30 s by ~3-10 s (compile+link of the workspace test build, ~20 s alone). Budget unchanged (orchestrator's).

**Candidate 2 (profile settings): rejected.** Measured on `fx-puts` in a scratch target: `debug=0` 11.07 s -> 9.80 s (about 1 s), costs file:line in backtraces; not worth it.
**Candidate 3 (fixture test-binary consolidation): rejected.** With the tax gone a binary costs 0.2 s to launch, so the 168 binaries cost roughly 30 s of parallel launches at worst versus 900 s before; the payoff (<= a few s) is not worth moving files.
**Sorted `cargo nextest list --workspace | wc -l`:** 643 (equals the suite's 643 rust tests; no test or config changed). `pnpm test` and `pnpm lint` green (rust 643, unit 290, wasm 156, netcode 55, browser 217). No Cargo/profile change, so no `CLAUDE.md` line.
**Note:** an untracked `target-*` copy in the repo root (not in `.gitignore`) makes `scripts/lib/context-artifacts.test.mjs` fail with `spawnSync git ENOBUFS`; keep scratch target dirs outside the repo.
