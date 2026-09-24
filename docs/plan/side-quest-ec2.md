# Side quest: can development continue on the EC2 box?

Status: **paused 2026-09-24 23:50 UTC in Phase 3** (Tyler travelling); see "Paused" below · Written 2026-09-24 at the end of the M18–M19b session · Temporary: delete once
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

## Paused (2026-09-24 23:50 UTC): how to resume

- **On the box:** tmux `sq-T8-load10` runs the last measurement, a fresh 15-run `--load 10` batch into `~/sidequest/out/load10/` (8 of 15 done at 23:44, about 9 min per run). tmux `sq-release` waits for it, then removes `/run/claudebox/hold`, so the box hibernates about 20 min later. If the next ssh hangs, the resume came back without network: check `claudebox console` for `ena … error -62`, then `aws --profile admin --region us-west-2 ec2 reboot-instances --instance-ids i-0eaafbfc2bdd53ba7`. Everything needed is on disk in `~/sidequest/`.
- **Next steps:** `sudo touch /run/claudebox/hold`; check that `sq-*` sessions are gone; copy `~/sidequest/out/` to the Mac (`ssh … 'tar -C ~/sidequest -czf - out' | tar -xzf - -C <scratch>`); write the box's T1–T9 tables from `out/log.txt`, `summary.tsv` and the json files; then Phase 4.
- **Box results already known (from the stopped agent's interim report):** T1 cold build 143.7 s, `browser` 136.5 s. T2 warm build about 5.6 s, all pass. T3 pass. T4 about 150 s per Rust-edit rebuild. T5 had 5 passes and 1 fail (`terrain: chunks generate, upload and evict`, a ledger item). T6 pass. T7 pass, `frame-bench` smoke included. T9 `gc software` 104 of 104 pass, forced dump captured. T8 quiet 13/15, `--load 4` 14/15; all three failures were said to match a known ledger flake, still to be confirmed from the log. The first `--load 10` batch stopped at 14/15 when the box was force-hibernated (`out/load10-partial/`).
- **Incident, which is a finding for P/E:** about 21:40 UTC the claudebox `unattended-hard` alarm (6 h with no tmux client) force-hibernated the box mid-run. That path **ignores the hold file**. The resume then came back with no network (`ena … PM: failed to restore async: error -62`). The orchestrator rebooted the instance at 22:10 UTC. Unattended runs on the box longer than 6 h need a tmux client attached, or a claudebox change.
- **Scratch files** are in the Mac session's scratchpad, which is lost on a reboot. Their summaries are copied into Results → Phase 3 below. The measurement script's final text is in the Appendix.

## Results

### Phase 0
Asked 2026-09-24. Tyler's answers:
1. **Reboot:** end the other sessions, then reboot. The `tailscale` and `thai` sessions were already killed (no tmux server running at 15:42 UTC).
2. **Release upgrade:** **yes**, 22.04 → 24.04 before measuring (against the recommendation). Before it, the orchestrator took EBS snapshot `snap-00cc2b8f3a434be2f` of root volume `vol-070bd9a0333b239c3` (instance `i-0eaafbfc2bdd53ba7`, tag `purpose=engine-v2-side-quest`) as the rollback path.
3. **Contention:** the other sessions are killed, so measurements run on an otherwise idle box.

Hold file `/run/claudebox/hold` touched 15:42 UTC. Uptime was 16 days, load1 0.29.

### Phase 1
Done 2026-09-24, 15:44–16:25 UTC.

| | Before | After |
|---|---|---|
| Ubuntu | 22.04.5 | **24.04.5** (`do-release-upgrade`, 12 min, SSM dropped for ~6–8 min mid-upgrade and came back on its own) |
| Kernel | 6.8.0-1063-aws | 7.0.0-1013-aws |
| libc6 | 2.35-0ubuntu3.15 | 2.39-0ubuntu8.9 |
| Mesa (`libgl1-mesa-dri`, `mesa-vulkan-drivers`) | 23.2.1 (vulkan drivers absent) | 25.2.8 |
| `libvulkan1` | absent | 1.3.275 |
| Claude Code | 2.1.278 | 2.1.281 |

- **Hibernation config survived both reboots:** `/proc/cmdline` keeps `nokaslr`, `resume=` and `resume_offset=169984`; `/sys/power/state` lists `disk`; `claudebox-watchdog.timer` active and logging `hold=1`; SSM agent 3.3.4793.0 unchanged. `hibinit-agent` is inactive both before and after (a oneshot at first boot).
- **Apt sources** the upgrade disabled: `github-cli.list` re-enabled as-is (`stable`), `tailscale.list` re-enabled with `jammy` → `noble`.
- **Toolchain, next to the box's own:** Node 22.18.0 (nvm default still 22.23.2); pnpm 11.25.0 through pnpm's own `packageManager` switching, no corepack; rustup `--no-modify-path --default-toolchain none`, so `rust-toolchain.toml` picks 1.93.0; Bun 1.3.8 in `~/.bun-1.3.8/bin` (`~/.bun/bin/bun` still 1.4.2); nextest 0.9.145, built by `pnpm setup:tools`. Playwright cache: `chromium-1243`, `chromium_headless_shell-1243`, `firefox-1543`, `webkit-2359`.
- `~/sidequest/env.zsh`: sources nvm, `nvm use 22.18.0`, prepends `~/.bun-1.3.8/bin` and `~/.cargo/bin` to `PATH`.
- Step times: clone 12 s, `pnpm install --frozen-lockfile` 3 s, `pnpm setup:tools` 205 s (mostly the nextest build), `playwright install --with-deps` 60 s.

**First runs, at `71abd9e`:**
1. `ENGINE_GPU` unset, `pnpm test browser -t readback`: **passed, 30 tests, 22 s**. This contradicts the expected `expectAdapter` failure: on arm64 24.04 with Mesa's Vulkan installed, Chromium falls back to SwiftShader by itself. Its cold build took 141 s (`fixtures` 132 s).
2. `CI=true ENGINE_GPU=swiftshader GC_MODE=software`, the same test: pass, 30 tests, 14 s. Adapter line, the same in both runs: `{"vendor":"google","architecture":"swiftshader","device":"","description":"","isFallbackAdapter":true}`. **SwiftShader WebGPU works on Linux arm64.**
3. Full `pnpm test --budget-scale 1000` in CI mode: **all green**. `rust` 366 at 1.8 s, `unit` 215 at 10 s, `wasm` 55 at 6 s, `browser` 170 at 135 s; build 5.5 s (already warm from run 1); wall 145 s.

### Phase 3
Both machines at `71abd9e`. Box tables are still to write (see Paused). Raw notes follow.

**Mac** (M3 Max, 14 cores, hardware mode):
```
Mac Phase 3 @71abd9e, M3 Max 14 cores, hardware mode. Raw: scratchpad/measure/out/
T1: install 0.3s; cold pnpm test 80.9s wall (build 53s: fixtures 49s); browser 27.1s.
T2 (n=6): wall median 31.5s (31.0–33.4); build 3.2–3.8s; rust 0.7, unit 1.6, wasm 1.7–1.9, browser 26.9/26.9/28.7.
T3 lint: 12.3 (cold), 1.0, 1.0.
T4 Rust edit: append 45.5/45.7/46.5, restore 45.0/47.0/45.9; median ~45.8s; buildMs 16.8–19.0 (fixtures 14–17s). NOT 151s.
T5 TS edit: ~31s (= warm T2); buildMs 3.1–3.5.
T6 wall medians: readback 8.8 (suite 4.8), anchors 8.1 (4.2), presence-worker-path 5.7 (1.8), rust -t presence 4.1, unit 4.9.
T7 slow: wall 38.2; wasm 17.6, browser 29.2, frame-bench 5.3, unit 1.5. All pass.
T8: quiet 15/15 pass (slowest 27s, 449s wall); load10 15/15 (slowest 34s of 35!, 580s). Spotlight reindexing load1 15–20 during T7/T8 (flag).
T9: pnpm gc hw 104 pass; pnpm gc software 103/104: `sim neg object sim` fail = ledger line 8 (sibling isolate nudge, M06b). Margins all ~7–9 B except sim/sim hw 3.14 B; sim-page sw main budget 0 by design. Software: echo, no_ui_change ≤1 B unresolved.
```

**T10, CI:**
```
T10 CI reference (x86-64 ubuntu-latest, SwiftShader, scale 1000), runs 36021066170 (e3b733a, Xeon 6973P-C), 36016875505 (e72935c, Xeon 8370C), 36014036176 (c4b3225, EPYC 7763; attempt 1 failed on the known frame-bench record_count flake).
Fast tier medians (s): rust 2.43, unit 11.00, wasm 6.92, browser 195.01 (range 137.8–199.6), buildMs 66.36. Step `pnpm test` wall median 263 s (190–271).
Slow tier medians (s): rust 0.52, unit 13.63, wasm 54.64, browser 235.10, frame-bench 36.35, buildMs 4.11. Step wall median 278 s (197–310).
Lint 6 s. Playwright install 37 s.
Raw: scratchpad/t10/ci-<runId>/timings{,-slow}.json
```

### Analysis
(G, P, E, proposed thresholds)

### Decision
(Tyler's pick and what was done)

### Appendix: measurement script
`~/sidequest/measure.sh` on the box. The box agent may have patched it there; diff before re-use.

```bash
#!/usr/bin/env bash
# Side-quest-ec2.md Phase 3 measurement script. Same text runs on the Mac and the box.
#
# Usage:
#   MODE=mac|box REPO=<path to engine-v2 checkout> OUT=<output dir> ./measure.sh [T1|T2|...|T9]
#   With no section arg, runs T1..T9 in order (not recommended interactively -- takes a long time;
#   the box agent should run sections individually inside tmux, per the side-quest brief).
#
# MODE=mac: every `pnpm test*`/`pnpm gc*` command runs exactly as a developer would run it --
#   hardware GPU, no env overrides, no --budget-scale.
# MODE=box: every `pnpm test`/`pnpm test:slow` (and anything that spawns one, i.e. repeat.mjs) gets
#   CI=true ENGINE_GPU=swiftshader GC_MODE=software in its environment, plus --budget-scale 1000.
#   `pnpm lint` and `pnpm gc*` are not `pnpm test*`, so they run in box mode with the CI env vars
#   only (no --budget-scale/--timings-json: neither flag exists on those commands).
#
# Every timed command appends to $OUT/log.txt (uptime, top-5 CPU processes, the command, its full
# output, exit code, wall ms) and one row to $OUT/summary.tsv (label, run, wall_ms, exit). Nothing
# here is quiet -- read $OUT/log.txt for the actual pass/fail lines; this script only times and
# records, it does not classify results.
#
# Do not run this concurrently with any other test run on the same machine (side-quest rule: two
# agents on the same machine never run tests at once).

set -uo pipefail

MODE="${MODE:-mac}"
REPO="${REPO:-$(pwd)}"
OUT="${OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/out}"
mkdir -p "$OUT"

LOG="$OUT/log.txt"
TSV="$OUT/summary.tsv"
[ -f "$TSV" ] || printf 'label\trun\twall_ms\texit\n' > "$TSV"

cd "$REPO" || { echo "REPO not found: $REPO" >&2; exit 2; }

now_ms() { node -e 'console.log(Date.now())'; }

ps_top5() {
  if [ "$(uname)" = "Darwin" ]; then
    ps -eo pcpu,comm -r | head -5
  else
    ps -eo pcpu,comm --sort=-pcpu | head -5
  fi
}

# run_timed <label> <run> -- <argv...>
# Runs argv, capturing full stdout+stderr into $LOG under a labelled section, plus a summary.tsv
# row. Returns the command's own exit code (does not abort the script on failure -- a failure is
# data, per the side-quest rule "do not debug anything").
run_timed() {
  local label="$1" run="$2"
  shift 2
  {
    echo "=== $label run=$run mode=$MODE $(date -u +%FT%TZ) ==="
    echo "-- uptime --"
    uptime
    echo "-- ps top5 --"
    ps_top5
    echo "-- cmd: $* --"
  } >>"$LOG"
  local start end code out
  start=$(now_ms)
  out=$("$@" 2>&1)
  code=$?
  end=$(now_ms)
  {
    echo "$out"
    echo "-- exit=$code wall_ms=$((end - start)) --"
  } >>"$LOG"
  printf '%s\t%s\t%s\t%s\n' "$label" "$run" "$((end - start))" "$code" >>"$TSV"
  return $code
}

# build_test_argv <test|test:slow> [suite args...] -- sets global array TCMD (without
# --timings-json; the caller appends that with a run-specific path).
build_test_argv() {
  local sub="$1"
  shift
  if [ "$MODE" = "box" ]; then
    TCMD=(env CI=true ENGINE_GPU=swiftshader GC_MODE=software pnpm "$sub" "$@" --budget-scale 1000)
  else
    TCMD=(pnpm "$sub" "$@")
  fi
}

# box_env_prefix -- global array, empty on Mac, the CI env vars on the box. For commands that are
# not `pnpm test*` (lint, gc) but should still see box conditions.
box_env_prefix() {
  if [ "$MODE" = "box" ]; then
    BENV=(env CI=true ENGINE_GPU=swiftshader GC_MODE=software)
  else
    BENV=()
  fi
}

find_cargo_target_dir() {
  # The repo's own target/, not a spike's.
  echo "$REPO/target"
}

# ---------------------------------------------------------------------------
# T1: cold setup -- pnpm install, clean target/, first pnpm test. 1 run.
t1() {
  run_timed T1-install 1 pnpm install
  local target
  target=$(find_cargo_target_dir)
  echo "=== T1 cargo clean: removing $target ===" >>"$LOG"
  if [ -d "$target" ]; then
    du -sh "$target" >>"$LOG" 2>&1
    command rm -rf "$target"
  else
    echo "(no target dir at $target)" >>"$LOG"
  fi
  build_test_argv test
  run_timed T1-first-test 1 "${TCMD[@]}" --timings-json "$OUT/T1-first-test.json"
}

# ---------------------------------------------------------------------------
# T2: warm fast tier, x3.
t2() {
  for i in 1 2 3; do
    build_test_argv test
    run_timed T2 "$i" "${TCMD[@]}" --timings-json "$OUT/T2-run${i}.json"
  done
}

# ---------------------------------------------------------------------------
# T3: lint, x3.
t3() {
  box_env_prefix
  for i in 1 2 3; do
    run_timed T3 "$i" "${BENV[@]+"${BENV[@]}"}" pnpm lint
  done
}

# ---------------------------------------------------------------------------
# T4: one-line Rust edit rebuild, x3 (6 timed rebuilds: append, restore).
t4() {
  local f="packages/engine/crates/engine/src/lib.rs"
  for i in 1 2 3; do
    echo "// sq" >>"$f"
    build_test_argv test
    run_timed T4-append "$i" "${TCMD[@]}" --timings-json "$OUT/T4-append-${i}.json"
    git checkout -- "$f"
    build_test_argv test
    run_timed T4-restore "$i" "${TCMD[@]}" --timings-json "$OUT/T4-restore-${i}.json"
  done
}

# ---------------------------------------------------------------------------
# T5: one-line TS edit rebuild, x3 (6 timed rebuilds).
t5() {
  local f="packages/engine/src/client.ts"
  for i in 1 2 3; do
    echo "// sq" >>"$f"
    build_test_argv test
    run_timed T5-append "$i" "${TCMD[@]}" --timings-json "$OUT/T5-append-${i}.json"
    git checkout -- "$f"
    build_test_argv test
    run_timed T5-restore "$i" "${TCMD[@]}" --timings-json "$OUT/T5-restore-${i}.json"
  done
}

# ---------------------------------------------------------------------------
# T6: inner loop, x3 each.
t6() {
  local i
  for i in 1 2 3; do
    build_test_argv test browser -t readback
    run_timed T6-browser-readback "$i" "${TCMD[@]}" --timings-json "$OUT/T6-browser-readback-${i}.json"
  done
  for i in 1 2 3; do
    build_test_argv test browser -t anchors
    run_timed T6-browser-anchors "$i" "${TCMD[@]}" --timings-json "$OUT/T6-browser-anchors-${i}.json"
  done
  for i in 1 2 3; do
    build_test_argv test browser -t presence-worker-path
    run_timed T6-browser-presence-worker-path "$i" "${TCMD[@]}" --timings-json "$OUT/T6-browser-presence-worker-path-${i}.json"
  done
  for i in 1 2 3; do
    build_test_argv test rust -t presence
    run_timed T6-rust-presence "$i" "${TCMD[@]}" --timings-json "$OUT/T6-rust-presence-${i}.json"
  done
  for i in 1 2 3; do
    build_test_argv test unit
    run_timed T6-unit "$i" "${TCMD[@]}" --timings-json "$OUT/T6-unit-${i}.json"
  done
}

# ---------------------------------------------------------------------------
# T7: slow tier, x1.
t7() {
  build_test_argv test:slow
  run_timed T7 1 "${TCMD[@]}" --timings-json "$OUT/T7.json"
}

# ---------------------------------------------------------------------------
# T8: reliability. Mac: quiet x15, then --load 10 x15. Box script (same text) also does --load 4.
# Split into sub-labels so a batch that doesn't fit in a 10-minute Bash call can be run separately:
# t8-quiet, t8-load4, t8-load10.
t8_repeat() {
  local label="$1" extra_load="$2"
  box_env_prefix
  local dir="$OUT/${label}"
  mkdir -p "$dir"
  local args=(node scripts/repeat.mjs browser 15)
  if [ -n "$extra_load" ]; then
    args+=(--load "$extra_load")
  fi
  if [ "$MODE" = "box" ]; then
    # A box `browser` run takes ~135 s quiet, past repeat.mjs's 120 s default kill timeout.
    args+=(--budget-scale 1000 --timeout 600)
  fi
  args+=(--timings-json "$dir")
  run_timed "T8-${label}" 1 "${BENV[@]+"${BENV[@]}"}" "${args[@]}"
}
t8-quiet() { t8_repeat quiet ""; }
t8-load4() { t8_repeat load4 4; }
t8-load10() { t8_repeat load10 10; }
t8() {
  t8-quiet
  [ "$MODE" = "box" ] && t8-load4
  t8-load10
}

# ---------------------------------------------------------------------------
# T9: zero-GC margins. Normal runs first (pass/fail only, no numbers on a pass), then a
# forced-budget-of-1 run to dump every page/isolate's measured B/frame from the failure JSON
# (gc-test skill). Always restores budgets.json, even if a step fails.
BUDGETS="packages/engine/budgets.json"

t9_force_budgets_to_1() {
  node -e '
    const fs = require("node:fs");
    const path = "'"$BUDGETS"'";
    const b = JSON.parse(fs.readFileSync(path, "utf8"));
    for (const page of Object.values(b.gc.pages)) {
      for (const iso of Object.values(page.isolates)) iso.bytesPerFrame = 1;
      if (page.software) {
        for (const iso of Object.values(page.software.isolates)) iso.attributedBytesPerFrame = 1;
      }
    }
    fs.writeFileSync(path, JSON.stringify(b, null, 2) + "\n");
  '
}

t9_restore_budgets() {
  git checkout -- "$BUDGETS"
}

t9() {
  box_env_prefix
  # Normal runs (record pass/fail + wall; numbers usually absent on a pass). The box has no hardware
  # adapter, so it runs the software mode only.
  [ "$MODE" = "box" ] || run_timed T9-hardware-normal 1 "${BENV[@]+"${BENV[@]}"}" pnpm gc
  run_timed T9-software-normal 1 "${BENV[@]+"${BENV[@]}"}" pnpm gc software

  # Forced-budget-1 runs to dump every page/isolate's measured bytes. Restore always runs, even on
  # failure of the forced runs themselves.
  t9_force_budgets_to_1
  [ "$MODE" = "box" ] || run_timed T9-hardware-forced 1 "${BENV[@]+"${BENV[@]}"}" pnpm gc -t clean
  run_timed T9-software-forced 1 "${BENV[@]+"${BENV[@]}"}" pnpm gc software -t clean
  t9_restore_budgets

  echo "=== T9 git status after restore ===" >>"$LOG"
  git status --short >>"$LOG"
}

# ---------------------------------------------------------------------------
main() {
  local sections=("$@")
  if [ ${#sections[@]} -eq 0 ]; then
    sections=(T1 T2 T3 T4 T5 T6 T7 T8 T9)
  fi
  for s in "${sections[@]}"; do
    case "$s" in
    T1) t1 ;;
    T2) t2 ;;
    T3) t3 ;;
    T4) t4 ;;
    T5) t5 ;;
    T6) t6 ;;
    T7) t7 ;;
    T8) t8 ;;
    T8-quiet) t8-quiet ;;
    T8-load4) t8-load4 ;;
    T8-load10) t8-load10 ;;
    T9) t9 ;;
    *)
      echo "unknown section: $s (expected T1..T9, T8-quiet, T8-load4, T8-load10)" >&2
      exit 2
      ;;
    esac
  done
}

main "$@"
```
