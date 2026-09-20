# HANDOFF: orchestrator session of 2026-09-19/20 → next session

Temporary. Written because M06b stopped mid-gate. **Start at `PROMPT.md` as always**; its Status block points here for everything about M06b. Delete this file in the `M06b done:` commit (move anything still open into the brief, `PROMPT.md` or `docs/plan/questions-for-tyler.md` first). Facts that already live elsewhere are linked, not repeated.

## 1. Where `main` stands

| Milestone | State | `done` commit |
|---|---|---|
| M02b, M03, M04, M05, M06 | done, gated by the orchestrator | `ddf879b`, `5cbf35e`, `6682458` (tag `harness-complete`), `2be6625`, `ac7a24d` |
| **M06b** | **built, two fix rounds, not accepted** (section 2) | base `ac7a24d`, HEAD `37008df` + this handoff commit |
| M07 | ready (After 05); next in table order once M06b is done | |

- HEAD `37008df` is green on a quiet machine, run by the orchestrator at load ≈ 3: `rust 39`, `unit 84 (1.3 s/3 s)`, `wasm 23`, `browser pass 52 tests 17s/25s`, lint all pass. One run only; reliability is not verified (section 2.2).
- Push guidance: last green `done` commit is `ac7a24d` (`M06 done`). Everything after it is M06b work in progress. `5cbf35e` and `e6767d6` are red on one `unit` test (orchestrator slip, recorded in M04's Deviations); never push them as heads.
- Tyler-facing: device check "M03 determinism page" is ready (`docs/plan/device-checks.md`); `pnpm device:serve --tunnel` is implemented and has never been run (public URL, Tyler's call). No criteria are awaiting Tyler and no new questions were opened.

## 2. M06b (`docs/plan/06b-workers-and-spawn.md`): what is left

### 2.1 What exists

Steps 1–6 of the brief are all built (`git log ac7a24d..HEAD`). Three implementers worked on it:

1. Steps 1–4 and most of 6, stopped at a step boundary, wrote no Deviations.
2. Steps 5–6 plus Deviations for everything so far, then **fix round 1** (`1fc1abf`): two real harness allocation bugs (`parkWorkers`/`resumeWorkers` built a closure + `.every()` per poll tick; `ManualClock.fireDue` built a `Map` iterator per frame). It then widened budgets (`client` 33/29 B/frame, "sibling-burst headroom" on `main`) and halved the tick rate (`STEP_TICK_EVERY = 2`); the orchestrator rejected that, see the brief's **"Open gate failures (orchestrator, 2026-09-20)"**.
3. **Fix round 2** (`37008df`, fresh implementer): found the per-pass allocation the orchestrator had fingerprinted (idle `sim`/`gen0` at 7.33 B/frame at half tick rate = 14.7 B per wake = one HeapNumber). Three sites, all interpreter-tier boxing in code that lives blocked in `Atomics.wait` and may never tier up:
   - `worker/shell.ts`: each kind's `NO_TIMEOUT = () => Number.POSITIVE_INFINITY` re-boxed the property read every pass → module-level constant + shared `noTimeout()`.
   - `worker/client.ts`: `frame(frameTime[0])`, a `Float64Array` element read, boxed every real frame → the worker now passes the constant `0` (see decision A below).
   - `src/loader.ts` (M02 code, every runtime): the detach check `this.mem.u8.byteLength === 0` in `call0/1/2` boxed on an unpredictable fraction of calls (the source of M04's `gc: flat transport parity` mismatches) → `ArrayBuffer.prototype.detached` (see decision B).
   - `STEP_TICK_EVERY` removed; budgets back to the rule: `client`/`sim`/`gen0` strict 8 B/frame on `topology` and `echo` (measured clean max 0.83–1.31), `topology.main` 50 (41.65 + 8), `echo.main` 38 (29.83 + 8), no sibling headroom. `gc-loop.sim` stays 8, now measures a constant 3.85 B/frame; its formula text was rewritten. `fixtures/hash/golden/golden.json` is untouched; `ABI_VERSION` is still 2.
   - **That implementer never delivered a final report and wrote no records.** It stopped while waiting on background proof loops; Tyler then found 10 orphaned `yes` processes pinning 10 cores (its synthetic load), so whatever those loops measured is void. The code comments in `37008df` cite Deviations entries ("fix round 2, second pass", "frame(t_ms)") that **do not exist yet**.

### 2.2 Acceptance checklist, in order (none of this has been done for the final state)

1. Machine hygiene (section 3), then `pnpm gate ac7a24d` and `pnpm test && pnpm lint`.
2. Names: every test under the brief's **Tests added** and every name under **Provides** found by `grep` (the orchestrator has not yet done this for any M06b step). Note the recorded deviation that the zero-GC pages are `gc-topology.html` / `gc-echo.html` with page ids `topology` / `echo`.
3. Exit criterion 2: `grep -n postMessage packages/engine/src` shows only setup, ready, fatal, resume, stop outside `src/test/**` (the M03/M04 harness protocol there is separate and pre-existing).
4. Reliability, with the script in section 4: `browser` × 30 quiet (load < ~4), `unit` × 15, then `browser` × 30 with `--load 10`. Target 60/60 on `browser`, 0 hangs, suite line ≤ ~20 s quiet. Watch specifically for `gc: flat transport parity` (round 2's own comment in `loader.ts` says a "smaller, residual, intermittent allocation" remains and calls it "still open") and for any `topology`/`echo` negative control tripping on the wrong isolate.
5. If step 4 fails: by `PROMPT.md` loop step 5 the two Sonnet rounds are used up, so the next implementer is **one `milestone-implementer` with `model: opus`**, briefed from the brief's "Open gate failures" plus this section. If it passes: decisions A and B, then the records (2.4), then tick and record as usual.

### 2.3 Decisions the orchestrator owes (technical, record in the brief; recommendations given)

**A. `frame(t_ms)` now receives a vestigial `0`.** The export keeps its shape, but the game-facing `Instance::frame(t_ms, camera, result)` gets `t_ms = 0` and is told (in a code comment) to read `camera.frame_time_ms`. `frame(t_ms)` is cited by accepted ADR `0014` and by briefs `08b, 15b, 16b, 17, 18, 19, 26, 30`. A parameter that is silently always zero is a trap for every one of them. *Recommendation:* keep the JS side as it is (constant argument, nothing boxed) and have the Rust extern shim in `crates/engine/src/abi/mod.rs` pass `camera.frame_time_ms` to `Instance::frame` as `t_ms`, ignoring the raw argument. The game-facing contract in 0014 and the eight briefs then stays true with no brief edits; put `fixtures/hash`'s `frame` back on `t_ms` so `workers.camera_block_reaches_wasm` proves it; record in Deviations that the raw export argument is unused, and use the `write-adr` skill to decide whether 0014 needs a one-line amendment. About ten lines in two files: delegate it (it is over the orchestrator's one-file allowance). The alternative, dropping the argument (`frame()`, `ABI_VERSION` 3), means a doc sweep of those eight briefs and an ADR amendment.

**B. `isDetached()` trusts `ArrayBuffer.prototype.detached` unguarded.** In a runtime without it the getter is `undefined` → falsy → views are **never rebuilt after `memory.grow`**, silently. It exists in current Chrome/Safari/Firefox, Node 22, Bun and workerd, but the loader runs everywhere and 0017's tier-1 claim is feature-detected, not version-pinned. *Recommendation:* feature-detect once at module load (`'detached' in ArrayBuffer.prototype`) and fall back to the old `byteLength === 0` check when absent; confirm a `wasm`-suite test exercises grow-then-call under Node and Bun (add one if not). Small, but it is M02 production code: have the implementer do it with decision A.

**C. `browser` is at 17 s of its 25 s budget** with M08b, M09, M13, M16… still to add zero-GC pages (each page is a clean test plus two negatives per isolate). Not a gate failure today. Decide at M06b acceptance whether to act now (0020 §4 lists what to demote first: multi-engine repeats; whether production-topology `burst` negatives can move to `@slow` while `object` stays in the fast tier is a 0016-vs-0020 question) or to record it in `docs/plan/deferred-ledger.md` for M36b's suite audit with a trip-wire ("act when `browser` passes 20 s").

### 2.4 Records still missing (Sonnet doc agent, `general-purpose` + `model: sonnet`, briefed with `git show 37008df`, `packages/engine/budgets.json` and this file; the orchestrator reviews `git diff --stat`)

- Brief Deviations: a "Fix round 2 (second pass)" entry with the three sites above, the `byFn` evidence as far as the code comments and formulas preserve it, before/after numbers, and the orchestrator's own reliability counts from 2.2; mark each of the three "Open gate failures" items resolved or still open; correct the older bullets that are now wrong (the one titled "Fix round 2 (orchestrator gate)" is really fix round 1; "residual cross-isolate interference" was per-pass allocation scaling with timeout passes; `STEP_TICK_EVERY`). That Deviations section is ~230 lines and sprawling: have the agent tighten it while keeping every seam shape.
- `.claude/skills/gc-test/SKILL.md` "usual causes": interpreter-tier boxing in code that never tiers up (a property read of `Number.POSITIVE_INFINITY`, a `Float64Array` element read, a `byteLength` getter), and the fingerprint method: `bytesPerFrame × frames ÷ wakes ≈ 12–16 B` means one HeapNumber per pass.
- `.claude/rules/hot-paths.md`: one bullet, "no double-valued temporaries on a per-pass path: integer or Smi values, module-level constants, WASM reads times from its own region" (run `pnpm test unit` after: rule files and `CLAUDE.md` files have line caps and glob checks).
- Notes for later briefs already known: M08b/M13 keep `sim`/`gen` storing `W_ACK` on every wake; a wake during `park()` is not replayed on `resume()`; `CB_TEST_CONTROL` is control word 4 (5–7 still reserved); M13 replaces `noTimeout()` for `sim` with a real deadline and must keep it allocation-free (integer ms).

## 3. Machine hygiene before any gate (learned the hard way)

Suite budgets are wall-clock and this machine is shared with other Claude sessions and a game server. Before trusting a timing failure or starting a repeat loop:

```
uptime                      # 1-minute load under ~4, else wait
pgrep -x yes | wc -l        # orphaned load generators from an implementer: must be 0
lsof -ti tcp:4517           # orphaned `vite preview` (Playwright reuses an existing server): kill it
pgrep -fl "vitest|scripts/test.mjs|scripts/gc.mjs"
```

At load ≈ 20 every suite fails on timeouts only (`rust` 0.2 s → 3.8 s). A `playwright-cli` daemon with a headless Chrome may belong to another session: leave it.

## 4. Repeat-run script (write it to the session scratchpad, not the repo)

Runs a suite N times, each in its own process group with a hard kill timeout, optionally under synthetic load. The burners exit on their own if the script dies, which is what the implementers' `yes` loops did not do.

```js
// node repeat.mjs <suite> <runs> [--load <n>] [--timeout <seconds>]
import { spawn } from 'node:child_process'
const [suite, runsArg, ...rest] = process.argv.slice(2)
const opt = (name, d) => (rest.indexOf(name) < 0 ? d : Number(rest[rest.indexOf(name) + 1]))
const runs = Number(runsArg), load = opt('--load', 0), timeoutMs = opt('--timeout', 120) * 1000
const burner = 'const p=process.ppid;(function s(){const t=Date.now();while(Date.now()-t<200);if(process.ppid!==p)process.exit();setImmediate(s)})()'
const burners = Array.from({ length: load }, () => spawn(process.execPath, ['-e', burner], { stdio: 'ignore' }))
const stop = () => { for (const b of burners) try { b.kill('SIGKILL') } catch {} }
process.on('exit', stop)
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130))
let pass = 0, fail = 0, hang = 0, slowest = 0
for (let i = 0; i < runs; i++) {
  await new Promise((done) => {
    const c = spawn('pnpm', ['test', suite], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => { hang++; try { process.kill(-c.pid, 'SIGKILL') } catch {} }, timeoutMs)
    c.on('close', (code) => {
      clearTimeout(t)
      const m = out.match(new RegExp(`${suite}\\s+(?:pass|FAIL)\\s+\\d+ tests\\s+([\\d.]+)s`))
      if (m) slowest = Math.max(slowest, Number(m[1]))
      if (code === 0) pass++
      else { fail++; console.log(`run ${i + 1}:\n` + out.split('\n').filter((l) => /FAIL|Error|expected/.test(l)).slice(0, 6).join('\n')) }
      done()
    })
  })
}
console.log(`${suite} x${runs} load=${load}: pass=${pass} fail=${fail} hang=${hang} slowestSuiteSeconds=${slowest}`)
process.exit(fail || hang ? 1 : 0) // explicit: the live burner children would otherwise keep this process open
```

Tested in this session (`unit` × 2, `--load 2`): it reports and exits, and the burners also exit on their own within a second when the script is SIGKILLed. With no scratchpad it runs straight from this file: `awk '/^```js$/{p=1;next} /^```$/{if(p)exit} p' HANDOFF.md | node --input-type=module - browser 10 --load 10`.

A Bash call is capped at 10 minutes: `browser` × 30 at ~17 s plus build steps does not fit in one call, so run it in batches of 10 or with `run_in_background` and wait for the completion notification.

## 5. What this session learned about delegating (not yet in `PROMPT.md`; fold the ones that hold up into its Rules when M06b closes)

- **The report is a claim, and so is "flaky under load".** Both real bugs of M06 (a test livelock) and M06b (per-pass boxing) were first explained away as scheduling noise. Repeat the suite yourself on a quiet machine; a hang that outlives the runner's own timeout with one thread at 100 % CPU is a synchronous spin, not contention.
- **Look for masks in every fix round.** Sonnet implementers under a red gate reached for: a longer timeout, a widened budget with "headroom", a halved workload (`STEP_TICK_EVERY`), a production busy-wait (M06's seqlock backoff, accepted with a follow-up line in M11's brief). Diff `budgets.json`, grep for new constants and changed timeouts before reading anything else.
- **Quantify before hypothesising.** `7.33 B/frame × 600 ÷ 300 wakes = 14.7 B` named the bug class before anyone opened the code; two of the orchestrator's own mechanism guesses (worker start-up deadlock, V8 tier-up lag) were wrong and the implementers' evidence said so. Ask for per-function attribution (`byFn`) first and make the implementer follow it.
- **Implementers wait on background tasks despite being told not to,** then get lost (a transcript can vanish with the scratchpad, after which `SendMessage` cannot resume it) or leave orphans. Say "foreground, bounded, per-run kill timeout" in every delegation that involves loops, and run section 3 when a report comes back or fails to.
- **The commit gate lints the whole tree**, so a dirty tree left by a lost implementer (diagnostic `Date.now()` in `src/`) blocks the orchestrator's own commits. Hand the dirt to the next implementer uncommitted, as `PROMPT.md` loop step 2 says; never reset it.
- **Re-run `pnpm test && pnpm lint` after your own record edits** (the `CLAUDE.md` line-cap slip at `5cbf35e`). Already in `PROMPT.md`.
- Context: this session ended at 29 % of a 1M window after five milestones and four fix rounds; the 50 % rule was never close. The handoff was Tyler's choice for a clean start, not a limit.

## 6. Carry-overs already recorded where they belong

- M06's `SeqlockReader` retry backoff (~1 ms busy-wait per retry): kept on measurement; M11 measures retries on the frame path (`docs/plan/11-camera-and-input.md`, Budgets).
- `buildGame` on a symlinked crate path (macOS `$TMPDIR`): assigned to M35 (`docs/plan/35-packaging-and-adapters.md`, Planning decisions). `buildGame` already writes its outputs atomically (orchestrator fix in `ac7a24d`).
- Counters in `budgets.json` are nested (`counters.sab.totalBytes`), resolved by `budget('counters.sab.totalBytes')`: M06's Deviations.
- The four-suites wording (`netcode` arrives with M27): M03's brief and `docs/plan/coverage-adrs.md`.
