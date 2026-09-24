# Side quest: can development continue on the EC2 box?

Status: not started · Written 2026-09-24 at the end of the M18–M19b session · Temporary: delete once
the decision is carried out.

**How to start.** A new session, on the **Mac**, in `/Users/tyler/repos/engine-v2`, told: *"Execute
`docs/plan/side-quest-ec2.md`."* Run it on the Mac, not the box. It needs Mac baselines, and it drives
the box over ssh. You are the orchestrator: you brief, check and decide. Sub-agents run the installs
and measurements.

**Do not edit `PROMPT.md`.** It stays exactly where it is, and Tyler resumes it afterwards, on the Mac
or the box depending on this plan's result. Do not start any `PLAN.md` milestone.

## Goal

Decide, with measurements, whether Phase 3 development can move to Tyler's EC2 box ("claudebox"), and
at what cost:

1. **Fidelity.** Does the full suite run green there, in the only mode a GPU-less Linux box has (CI's:
   SwiftShader WebGPU, `GC_MODE=software`)? Are any failures specific to arm64?
2. **Performance-testing compromise.** Which checks can only ever run on the Mac? How many upcoming
   milestones need them?
3. **Throughput.** Are the suite, rebuild and inner-loop times on 4 vCPUs workable? What suite-time
   thresholds would the box need?

The output is a decision for Tyler among the three outcomes in Phase 5. Carrying the decision out
(Phase 6) happens only after Tyler picks.

## Known facts (gathered 2026-09-24; don't re-derive, re-check only what may have changed)

**The box.** It is `m7g.xlarge`, Graviton3 **arm64**, 4 vCPUs, 15 GiB RAM, no GPU, in us-west-2. It
runs Ubuntu 22.04.5, with 55 GB free on `/`. Its infra lives in `/Users/tyler/repos/claudebox`; read
its `CLAUDE.md` before touching the box. In particular:
- It **hibernates itself after 20 idle minutes.** A bare ssh shell does not count as activity.
- `sudo touch /run/claudebox/hold` blocks hibernation; `sudo rm -f /run/claudebox/hold` releases
  it. `/run` is tmpfs, so re-touch the hold after any reboot.
- `claudebox deploy` or an instance-type change **replaces or plain-stops the instance and loses its
  state.** Never run either.

**Other work on the box.** It is Tyler's general box. The tmux sessions `tailscale` and `thai` each
run a live `claude --dangerously-skip-permissions`. A reboot kills both, and anything they build
competes with our measurements for 4 vCPUs. `~/repos` holds `dotfiles`, `thai.ler.dev` and
`yahn.ty.ler.dev`.

**Pending updates.** `/var/run/reboot-required` is set (`libc6`), and 5 packages are upgradable.

**Access.** `ssh claudebox` runs `tmux new -A -s main` and refuses a remote command. Use
`ssh -o RemoteCommand=none -o RequestTTY=no claudebox '<cmd>'`. The ProxyCommand is SSM; it
starts a stopped box itself, and the first call can take a few minutes. The login shell is
**zsh**, and Node comes from nvm in the zsh config, so run tool commands as `zsh -lic '…'`.

**What is installed.**

| Tool | Box | Mac | Note |
|---|---|---|---|
| Node | nvm default 22.23.2 | 22.18.0 | repo pins `.node-version` 22.18.0 |
| pnpm | 12.3.4, global | 11.25.0 | repo pins `packageManager` pnpm@11.25.0 |
| Bun | 1.4.2 in `~/.bun` | 1.3.8 | pinned 1.3.8 by `scripts/setup-tools.mjs`; Tyler's other projects may use the box's Bun |
| Rust, rustup, cargo-nextest | none | 1.93.0, 0.9.145 | rustup reads `rust-toolchain.toml` |
| `gh` | 2.101.0, logged in as tylerschloesser | – | the repo is public |
| Claude Code | 2.1.278 | 2.1.281 | – |
| Playwright browsers | `chromium-1243` + headless shell 1243 | same build | – |
| Vulkan system packages | not installed | – | – |

The arm64 Chromium ships `libvk_swiftshader.so`, `vk_swiftshader_icd.json` and its own
`libvulkan.so.1`, which is what `--use-vulkan=swiftshader` needs. The Vulkan system packages CI
installs are absent. **WebGPU on SwiftShader under Linux arm64 has never been run for this repo.**
CI is x86-64 `ubuntu-latest` (Ubuntu 24.04).

**The Mac.** Apple M3 Max, 14 cores, 36 GB, macOS 26.6.2, a real Metal WebGPU adapter.

**How CI runs on Linux** (`.github/workflows/ci.yml`):
- `apt-get install libvulkan1 mesa-vulkan-drivers`, then `playwright install --with-deps chromium webkit firefox`.
- `CI=true ENGINE_GPU=swiftshader GC_MODE=software pnpm test --budget-scale 1000 --timings-json …`, then the same for `pnpm test:slow`. The per-run timings are uploaded as artifact `test-results`.
- Without `ENGINE_GPU=swiftshader`, Linux Chromium has no WebGPU adapter and `expectAdapter` **fails** rather than skips. That is almost certainly the "WebGPU on Ubuntu" error Tyler has seen.
- Linux also drops `@webkit-gpu` tests, since WebKitGTK has no WebGPU (`playwright.config.ts`). The `gc` per-test timeout is 90 s under SwiftShader.
- `bench.frame_worstcase` gates only on real hardware and runs a smoke mode on a software adapter.

**Mac baseline at `e72935c`** (M19b's gate, hardware mode):
- `rust` 366 at 0.7 s, `unit` 215 at 1.6 s, `wasm` 55 at 2.4 s, `browser` 170 at 24–28 s against 35 s. `browser` is 32–33 s under `--load 10`.
- `pnpm test` about 30 s wall; warm build about 7.3 s against `buildBudgetMs` 10 s (ADR 0033).
- A one-line Rust edit rebuild takes about 151 s. That is `questions-for-tyler.md` Q14, against Tyler's 30 s requirement; most of it is macOS scanning test binaries, which Linux may not pay.

**Known flakes, already on the ledger, so they are not new findings** (`docs/plan/deferred-ledger.md`):
- `bench.frame_worstcase` smoke mode, `record_count` 65,408 against 65,536 (the item `PROMPT.md` names first);
- the `stepping` hash watch;
- `parkWorkers` timeouts with other signatures;
- `terrain: chunks generate, upload…` failed once on CI;
- the `connected-terrain neg burst` margin.

**`scripts/repeat.mjs`** spawns `pnpm test <suite>` and **does not forward `--budget-scale`**. On the box
every loop run would fail on suite time.

## Rules for this side quest

- **Delegate.** Every install and every measurement is a `general-purpose` sub-agent with `model: sonnet`, briefed with this file plus the named sections. You check, re-run one claim yourself, and decide.
- **Box-side and Mac-side agents may run at the same time.** They share no tree, cargo target or ports. Two agents on the *same* machine never run tests at once.
- **Commits only from the Mac, on `main`**, gated by `pnpm test && pnpm lint` green on the Mac, then pushed (Tyler: "Just push"). The box's checkout at `~/repos/engine-v2` never commits, pushes, stashes or resets. It moves only by `git pull --ff-only`.
- **Every box-side brief must include this block verbatim:**
  > Reach the box only with `ssh -o RemoteCommand=none -o RequestTTY=no claudebox '<cmd>'`, and run tools under `zsh -lic`. Anything that may take over ~5 minutes runs in a detached tmux session named `sq-<task>` (`tmux new -d -s sq-<task> "zsh -lic '<cmd> > ~/sidequest/logs/<task>.log 2>&1; echo EXIT=\$? >> ~/sidequest/logs/<task>.log'"`), and you poll the log with short ssh calls: never one Bash call over 10 minutes, nothing left running when you report. Never touch the tmux sessions `tailscale`, `thai` or `main`, or their processes. Never reboot, never `claudebox deploy`/`stop`, never edit `~/.zshrc`/`~/.zshenv`/`~/.profile`. Never change the box's default Node, pnpm or Bun. Before every timed command, record `uptime` and `ps -eo pcpu,comm --sort=-pcpu | head -5`. If load1 is above 1.0, wait up to 5 minutes for it to drop, then measure anyway and flag it.
- **Pinned tools stay pinned; everything else is updated.** "Dated software" is ruled out by updating the OS layer (packages, kernel, glibc, Mesa/Vulkan) and Claude Code. The repo's pins (Node 22.18.0, pnpm 11.25.0, Rust 1.93.0, nextest 0.9.145, Bun 1.3.8, Playwright's Chromium 1243) are what the Mac and CI use. Matching them exactly is the fidelity this quest measures, so do not upgrade them. Install them **next to** the box's own tools:
  - Node via `nvm install 22.18.0`, used explicitly, never made the default;
  - Bun 1.3.8 unzipped from its GitHub release into `~/.bun-1.3.8/bin` (the official installer edits shell rc files: don't use it);
  - rustup with `--no-modify-path`.
  One env file, `~/sidequest/env.zsh`, puts these first on `PATH` for engine-v2 commands only.
- **No thresholds, budgets or goldens change in this quest** until Phase 6, and then only after Tyler's pick. Any change to `budgets.json`, `scripts/suites.mjs` budgets or ADR 0020/0033 goes through an ADR (`write-adr` skill).
- **Cleanup always runs**, even if the quest is abandoned halfway: Phase 7.

## Phase 0: ask Tyler once (you, no agents)

Before anything runs, batch these into one `AskUserQuestion`:

1. **Reboot for the pending OS updates.** Rebooting kills the `tailscale` and `thai` Claude sessions.
   - *Recommended:* Tyler ends those sessions first, then reboots.
   - Or: reboot now.
   - Or: skip the reboot. Apply package updates without rebooting and record that `libc6`/kernel updates are pending during every measurement.
2. **Ubuntu release upgrade 22.04 → 24.04 (CI's release).**
   - *Recommended:* no. It is a large change to a box that hosts other projects, and the arm64-versus-x86 question matters far more. Phase 6B's prototype runs 24.04 anyway.
   - Or: yes, before measuring.
3. **Measuring while the other sessions are active.**
   - *Recommended:* Tyler pauses heavy work in `tailscale`/`thai` during Phases 3–4 (about 1–2 hours) so the timings are clean.
   - Or: measure as-is and flag contended runs.

Then `sudo touch /run/claudebox/hold` on the box. Record the answers under **Results → Phase 0**.

## Phase 1: bring the box up to date and install the repo (one box-side agent)

Brief it with this file's "Known facts" and "Rules", and with `scripts/setup-tools.mjs` and CI's
`ci.yml`. Steps:
1. **First-pass updates.** `sudo apt-get update && sudo apt-get full-upgrade -y`, then `sudo apt-get install -y libvulkan1 mesa-vulkan-drivers` (CI parity). Reboot only as Phase 0 allows; after a reboot, re-touch the hold file. Run `claude update`. Record before and after versions of the kernel, `libc6`, Mesa, `libvulkan1` and Claude Code.
2. **Toolchain next to the box's own**, per Rules: nvm 22.18.0; pnpm 11.25.0 (check that `pnpm --version` inside the repo prints 11.25.0 under Node 22.18.0; if pnpm 12 won't switch, use `corepack enable` under 22.18.0); rustup `--no-modify-path`; Bun 1.3.8 into `~/.bun-1.3.8`; `~/sidequest/env.zsh` (PATH plus `nvm use 22.18.0`).
3. `git clone https://github.com/tylerschloesser/engine-v2 ~/repos/engine-v2` at the Mac's current `HEAD`. Then `pnpm install --frozen-lockfile`, `pnpm setup:tools` (it must find Bun 1.3.8 on `PATH` and not reinstall it; check that `~/.bun/bin/bun --version` still prints 1.4.2 afterwards), and `pnpm exec playwright install --with-deps chromium chromium-headless-shell webkit firefox`.
4. **First runs, recorded as they happen** (the adapter line matters):
   - `ENGINE_GPU` **unset**: `pnpm test browser -t readback`. Expected to fail at `expectAdapter`; this confirms the diagnosis.
   - Then with `CI=true ENGINE_GPU=swiftshader GC_MODE=software`: `pnpm test browser -t readback` (**the arm64 SwiftShader question**: record the adapter line) and a full `pnpm test --budget-scale 1000 --timings-json …` (cold, timed).
5. Report: versions table, before and after; the three runs' result lines; time taken for each step; anything that deviated from the Rules.

**Stop condition.** If SwiftShader WebGPU doesn't come up on arm64 after reasonable checks (adapter null, device lost, crash), stop Phase 1. Record which flags and packages were tried, skip Phase 3's browser work, and go to Phase 4 with "box = Rust/unit/wasm only". Before concluding that, try: the Vulkan packages, `--use-angle=swiftshader`, headless shell versus full Chromium, and an `about:gpu` dump via a Playwright script.

## Phase 2: make the loops usable on a slower box (one Mac-side agent; runs during Phase 1)

A small tooling change, committed from the Mac. `scripts/repeat.mjs` forwards `--budget-scale <n>`
(and optionally `--timings-json <dir>`, one file per run) to each `pnpm test <suite>`. Its usage
comment says so. Make it the smallest diff that works, with a unit test beside it if
`scripts/**/*.test.mjs` has a pattern for it. Gate: `pnpm test && pnpm lint` on the Mac, commit
`side quest: repeat.mjs forwards --budget-scale`, push. The box pulls it before Phase 3.

## Phase 3: measure, both machines at the same commit (two agents in parallel)

Both agents write one measurement script and run it, so the box (and Phase 6B's prototype) can re-run
it identically. The script lives outside the repo: on the box in `~/sidequest/measure.sh`, on the Mac
in the session scratchpad. Paste its final text into **Results → Appendix**. The same commit on both
machines; record the sha. The box runs every command with
`CI=true ENGINE_GPU=swiftshader GC_MODE=software` plus `--budget-scale 1000 --timings-json`. The Mac
runs its normal hardware mode with `--timings-json`. Record wall clock (`/usr/bin/time -p` or
`date +%s%N` deltas) and the `timings.json` files. Take the median of 3 unless stated otherwise.

| # | What | Command (box adds env + scale) | Runs |
|---|---|---|---|
| T1 | cold setup | `pnpm install`, first `pnpm test` after a clean `target/` (box: Phase 1 already has this number) | 1 |
| T2 | warm fast tier | `pnpm test`: per-suite ms, per-build-step ms, wall | 3 |
| T3 | lint | `pnpm lint` | 3 |
| T4 | one-line Rust edit | append a comment to `packages/engine/crates/engine/src/lib.rs`, `pnpm test`, restore with `git checkout -- <file>`, `pnpm test` again (both are rebuilds). This is Q14's measurement | 3 |
| T5 | one-line TS edit | the same on `packages/engine/src/client.ts` | 3 |
| T6 | inner loop | `pnpm test browser -t readback`, `-t anchors`, `-t presence-worker-path`; `pnpm test rust -t presence`; `pnpm test unit` | 3 each |
| T7 | slow tier | `pnpm test:slow`: per-suite, and the `frame-bench` line (box: smoke) | 1 |
| T8 | reliability | `node scripts/repeat.mjs browser 15` quiet, then `--load 4` (about the box's cores) and `--load 10` (`PROMPT.md`'s standard). On the box, each batch runs in tmux and is polled. Mac: quiet and `--load 10` only | 15 per batch |
| T9 | zero-GC margins | `pnpm gc software` on the box, and `pnpm gc` plus `pnpm gc software` on the Mac. Record per page and isolate: measured B/frame against budget. The `gc-test` skill says how to read these; forcing a budget to 1 dumps the numbers from a passing run. Never commit that | 1 |
| T10 | CI reference | `gh run download <id> -n test-results` for the last 3 green `main` runs: per-suite ms from `timings.json`/`timings-slow.json` | – |

Also record, once: `nproc`, load before each timed command, and every failure's first 20 lines. For
T8, record each failure's signature and whether it matches a known ledger item. **Do not debug
anything.** A failure is data for Phase 4.

## Phase 4: analyse (one Sonnet agent, then you)

Brief it with Phase 3's raw results, ADR 0020 §3–§4 and ADR 0033 (how budgets are derived),
`docs/plan/deferred-ledger.md`, and `PLAN.md`'s unticked rows. It writes **Results → Analysis**:

1. **Fidelity (G).**
   - G1: the full fast and slow tiers are green on the box in CI mode. Every failure is classified: known ledger item, a budget or time artefact of `--budget-scale`, **arm64-specific** (passes on CI x86 SwiftShader at the same sha, fails on the box), or new.
   - G1 also covers the goldens: native determinism on aarch64-linux is a platform the goldens have never met (they have matched macOS arm64 and x86-64).
   - G2: T8's quiet flake rate is at most the Mac's (about 1 in 15, known signatures only).
   - G3: T9's zero-GC software budgets hold on arm64 with each page's margin stated. A page within 2 B/frame of its budget is flagged.
2. **What only the Mac can measure (P).** Hardware-mode zero-GC budgets, the real `bench.frame_worstcase` gate against `baselines/frame.json`, `@webkit-gpu` tests, and Mac suite-time budgets. Classify **every unticked `PLAN.md` row** by its brief's Budgets and Exit criteria as *box-OK* or *needs a Mac gate*, with the reason (for example M20b: `first-playable` tag, plus `PROMPT.md`'s "run `pnpm test:slow` in hardware mode at every tag milestone"). Give the count and the next five in order.
3. **Throughput (E).** The box-to-Mac ratio for T2, T4, T5 and T6. Workable means T2 at most about 3× the Mac (about 90 s), T4 at most the Mac's 151 s (report it against Q14's 30 s), and T6 at most about 2× the Mac. Also report the box's run-to-run spread (the coefficient of variation of T2's `browser`). A noisy suite can't carry a wall-clock budget.
4. **Proposed box thresholds, not applied.** Per suite and build step, what 0020/0033's own derivation rule gives on the box's numbers, or one machine-wide `--budget-scale` if the ratios are uniform. State whether the orchestrator's "headroom" signal (for example "`browser` 25 s of 35 s") survives as a box-specific number, or only as a Mac or CI number.

Then **you** check: re-run one claimed arm64-specific failure (if any) and one T2 timing yourself on
the box before accepting.

## Phase 5: decide with Tyler (you)

One `AskUserQuestion`, with the analysis summarised in the question and your recommendation first:

- **A: continue on the current box.** Day-to-day milestones are developed and gated on the box (CI mode with box thresholds). Rows classified *needs a Mac gate* run their gate on the Mac, and so does every tag milestone. Fits when G holds and E is workable.
- **B: prototype an upgraded instance first.** Fits when G fails for arm64-specific reasons, or E is well past workable. A throwaway instance, never the claudebox stack (Phase 6B).
- **C: stay on the Mac.** The box keeps its current role. Fits when G fails badly and B isn't wanted.

Record the answer under **Results → Decision**.

## Phase 6: carry out the decision (only the picked branch)

**A.**
- (1) An ADR via the `write-adr` skill (Sonnet drafts, you review) amending ADR 0033/0020 §3 with the box's thresholds, or a machine profile such as `ENGINE_MACHINE=claudebox` setting the scale, whichever Phase 4 supports. Also: which gates stay Mac-only.
- (2) A small implementation if the ADR needs code (`scripts/lib/args.mjs`/`suites.mjs`). A `general-purpose` Sonnet agent does it; you gate on **both** machines.
- (3) A "Running on a GPU-less Linux box" section in `.claude/skills/run-tests/SKILL.md`: the env, `~/sidequest/env.zsh`, tmux plus hold for long runs, and the ssh form. That is where a resuming session learns it; `PROMPT.md` is not edited.
- (4) Move `~/sidequest/env.zsh` somewhere durable on the box, or fold it into the skill.

**B.**
- Ask Tyler for an explicit go with a cost estimate (current on-demand us-west-2 prices, looked up rather than recalled). Launching an instance is an outward action on his account.
- Then one agent launches a **throwaway** instance with `aws --profile admin --region us-west-2`:
  - `c7i.2xlarge` (x86-64, 8 vCPUs; CI's architecture), Ubuntu 24.04 amd64 from SSM parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`, 80 GB gp3;
  - SSM-only access (an instance profile with `AmazonSSMManagedInstanceCore`, no inbound rules);
  - tag `purpose=engine-v2-side-quest`.
  Optionally, `m7g.2xlarge` too, which separates core count from architecture.
- The agent runs Phase 1 steps 2–4 and Phase 3's script unchanged, compares, and **terminates** the instances, confirming `terminated`.
- Moving claudebox itself to a new type is a CDK change that replaces the instance: Tyler's call, done in the claudebox repo, never from this session. Record the recommendation only.

**C.** Record the result and go to Phase 7.

## Phase 7: clean up and hand back (always)

- `sudo rm -f /run/claudebox/hold` on the box. Without this it never hibernates, which costs money.
- Kill any `sq-*` tmux sessions. Check that nothing of ours is running (`pgrep -af "vitest|playwright|repeat.mjs|cargo"`) and that `tailscale`/`thai` are untouched.
- Terminate any Phase 6B instance.
- Fill **Results**, set `Status:` above, commit `side quest: EC2 fidelity results and decision`, and push.
- Tell Tyler in a short message: the decision, where to resume `PROMPT.md` (Mac or box), and on the box, the one sentence to start with. For example: "Read `PROMPT.md`; run tests per the `run-tests` skill's GPU-less Linux section."

## Results

### Phase 0
(answers)

### Phase 1
(versions before and after, run results, adapter line)

### Phase 3
(tables T1–T10, box and Mac side by side, with the sha)

### Analysis
(G, P, E, proposed thresholds)

### Decision
(Tyler's pick and what was done)

### Appendix: measurement script
(final text)
