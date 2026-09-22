# M15g: mechanical checks on `PROMPT.md`'s status block

Status: done · After: 15f · Tyler-dependent: no

## Goal

The staleness defects that reach `PROMPT.md`'s status block are caught by a command instead of by
Tyler asking "is the prompt ready?". Structural invariants that must hold at *all* times run in the
`unit` suite; the checks that are only meaningful at a `done` commit run from `pnpm handoff`.

## Why, with the actual defects to catch

`PROMPT.md` is the only entrypoint of the next orchestrating session, and it has gone out stale
twice. On 2026-09-22 a session-end block that had just been rewritten and reported ready still had
four defects, three of them introduced by the rewrite itself:

1. **Stale ground numbers.** State opened with `rust` 235, `unit` 154, `wasm` 41, `browser` 98 — the
   M14-era line — while the tree measured 275 / 157 / 43 / 110. A cold session runs `pnpm test` at
   loop step 2 and compares against whatever State claims.
2. **A standing instruction the same session's findings had invalidated.** State still read "the
   next milestone that adds browser tests — **M15b** on current order — must take 0020 §4's next
   rung", while the Milestone line said the ladder is exhausted. **M15b is ticked in `PLAN.md`**,
   which is the mechanical tell: a milestone named as upcoming that is already done.
3. **Unbalanced parentheses** from a string-replace edit that closed a clause early.
4. A pacing note describing the *previous* session as "this session". **Not mechanically
   detectable — do not try.** Three of four is the target.

## Scope

**Pure logic in `scripts/lib/handoff.mjs`**, following `scripts/lib/gate.mjs`'s shape (pure
functions over strings, no I/O), with co-located `scripts/lib/handoff.test.mjs`.

**In the `unit` suite** (`scripts/lib/handoff.test.mjs`, the way `context-artifacts.test.mjs`
already asserts repo-doc invariants) — these must hold at every commit, mid-milestone included:

- **No milestone named as upcoming is already ticked.** Parse `PLAN.md`'s table into
  `{id, ticked}`. Scan `PROMPT.md`'s status block for milestone ids in an upcoming/current context
  — `M<NN> next`, `M<NN> in flight`, `M<NN> is ready`, `M<NN> on current order` — and fail if any is
  ticked. This is defect 2, and the wording list is the load-bearing part: derive it from the real
  phrasings above, and say in a comment that the list is a heuristic to extend, not a spec.
- **Balanced `(`/`)` across `PROMPT.md`.** Defect 3. Count over the whole file.
- **Every brief `PLAN.md` references exists** on disk.
- **Every ticked `PLAN.md` row's brief has `Status: done`**, and no unticked row's brief does.

**In a new `pnpm handoff` command** (`scripts/handoff.mjs`, quiet on success like `pnpm gate`, one
line per check, details only on failure) — meaningful only at a `done` commit, so not in the suite:

- Run the structural checks above, then **the suite-count check**: find the numbers State claims as
  *current* ground and compare them against the most recent `test-results/` report. Defect 1.
  State deliberately also cites *historic* figures, so you need a way to tell current from historic
  that does not depend on prose parsing — **the current line is the one this milestone should make
  machine-readable.** Propose the shape (an HTML comment carrying the counts, a fenced block, a
  fixed sentence form), implement it, and update `PROMPT.md`'s State line to use it. Keep it to one
  small marker; do not restructure the block.

## Non-scope

- Judging prose. Defect 4 and "does this instruction contradict that one" are out of reach; do not
  attempt heuristics for them.
- Rewriting the status block's content, or the loop/Rules sections below it.
- Anything outside Phase 3's lifetime: this tooling is deleted with `PROMPT.md` in Phase 4, so keep
  it small and self-contained.

## Files touched

`scripts/lib/handoff.mjs`, `scripts/lib/handoff.test.mjs`, `scripts/handoff.mjs`, `package.json`
(the `handoff` script), `scripts/suites.mjs` only if the `unit` suite needs the new test registered,
and `PROMPT.md` for the machine-readable ground marker only.

## Seams

**Provides:** `pnpm handoff`; `scripts/lib/handoff.mjs`'s exported check functions.
**Consumes:** `PLAN.md`'s table format; `docs/plan/<NN>-*.md`'s `Status:` line; the `test-results/`
report shape (`scripts/lib/report.mjs`).

## Planning decisions

- **Split by when the invariant holds, not by convenience.** A check that fails mid-milestone would
  train everyone to ignore it, so only always-true invariants go in the suite. The suite-count check
  is legitimately stale between a milestone's start and its `done` commit, so it belongs to the
  command the orchestrator runs before that commit.
- **The orchestrator wires it into the loop, not you.** Do not edit `PROMPT.md`'s loop or Rules
  sections; the only `PROMPT.md` change in your scope is the ground marker.

## Order of work

1. `scripts/lib/handoff.mjs` + its tests, structural checks only, driven by fixtures.
2. Register in the `unit` suite; confirm it passes on the current tree **and** prove each check can
   fail, by fixture, one per check.
3. The ground marker and the suite-count check; `scripts/handoff.mjs`; `pnpm handoff`.
4. Re-verify against the four historical defects (below).

## Tests added

`scripts/lib/handoff.test.mjs`. **It must include a regression fixture reproducing each of defects
1, 2 and 3 as they actually appeared**, asserting the checks catch them — that is the milestone's
real exit criterion, not that the checks pass on today's clean tree. Defect 2's fixture should use
the real sentence: a reference to `M15b` while `M15b` is ticked.

## Exit criteria

- [x] `scripts/lib/handoff.test.mjs` reproduces defects 1, 2 and 3 as fixtures and each check fails
      on its fixture and passes on the corrected version, with outputs pasted.
- [x] Each check is proved failable independently (inject, observe, revert), one per check.
- [x] `pnpm handoff` is quiet on success, one line per check, and exits non-zero on any failure.
- [x] The structural checks run inside `pnpm test`'s `unit` suite and pass on the current tree.
- [x] `PROMPT.md`'s current-ground figures are machine-readable, and the marker's shape is recorded
      in Deviations for the orchestrator to maintain.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands

`pnpm test unit -t handoff` · `pnpm handoff` · `pnpm test && pnpm lint` (the orchestrator gates).

## Budgets

None new. `unit` is at 1.6 s of a 3 s budget; these checks are string work over three files and must
not move it measurably. Report the `unit` line before and after.

## Context artifacts

None new.

## Manual device checks

none

## Deviations

**Seam shapes.** `scripts/lib/handoff.mjs` exports pure functions over strings only (no I/O), in
`gate.mjs`'s shape:

- `parsePlanRows(planText)` → `{ id, ticked, brief }[]`, from `| [x] | 15b | \`15b-....md\` | ... |`
  rows; header/separator rows are skipped by construction (no `[x]`/`[ ]` + id + backticked `.md`).
- `findUpcomingRefs(promptText)` → `{ id, phrase }[]`, matching `M<NN[a-z]> next|in flight|is
  ready|on current order`. The phrase list (`UPCOMING_PHRASES` in the module) is a **heuristic**,
  commented as one in the source: it is a lower bound on defect 2's class, not a spec, and the next
  session that finds a fifth phrasing should add it there.
- `findStaleUpcomingRefs(rows, promptText)` → the subset of the above whose id is ticked in `rows`
  (deduped by id). This is defect 2's check.
- `countParens(text)` → `{ open, close }`; `parensAreBalanced(text)` → `open === close`. Defect 3's
  check, over the whole file, not nesting-aware (see the finding below on why nesting doesn't help).
- `findMissingBriefs(rows, existingBriefs: Set<string>)` → rows whose `brief` is not in the set.
- `isStatusDone(briefText)` → `/^Status:\s*done\b/m` test (matches `Status: done`, `Status: done
  (2026-09-19) ...`, never `Status: not started ...`).
- `findStatusMismatches(rows, doneByBrief: Map<brief, boolean>)` → rows whose `ticked` disagrees
  with `doneByBrief.get(row.brief)`; a brief absent from the map (unreadable/missing) is skipped, so
  `findMissingBriefs` is the only check that reports it.
- `parseGroundMarker(promptText)` → `{ rust, unit, wasm, browser } | null`.
  `formatGroundMarker(ground)` → the exact marker string (below).
  `compareGround(marker, actual)` → `{ suite, marker, actual }[]` for each of the four that differ.
- `parseRustSummary(logText)` → the `N` in nextest's plain-text `Summary [...] N tests run: ...`
  line (`test-results/rust/output.log`; nextest's own JUnit report lives under `target/nextest/`,
  outside `test-results/`, which is why this check reads the log instead).
- `parseBunLegCount(logText)` → the `wasm` suite's Bun leg's test count, from the last line of
  `test-results/wasm/bun.log` (one JSON object, `{ tests: [...] }`, the same shape
  `scripts/lib/adapters.mjs`'s `script` adapter already parses).

`scripts/handoff.mjs` (the command) is the only place that touches the file system: it reads
`PLAN.md`, `PROMPT.md`, every `docs/plan/<brief>.md` a row names, and
`test-results/{rust/output.log, unit/report.json, wasm/report.json, wasm/bun.log,
browser/report.json}`, calling `scripts/lib/report.mjs`'s already-exported `parseVitestJson` /
`parsePlaywrightJson` for the JSON reports (Seams: "the `test-results/` report shape
(`scripts/lib/report.mjs`)"). Exit 0 nothing flagged; exit 1 any check flagged; exit 2 no marker in
`PROMPT.md` or no `test-results/` to read (run `pnpm test` first). It does not build or run tests
itself.

**The ground marker's exact shape**, inserted immediately after State's "current ground" sentence,
before the `(Historic, ...)` parenthetical, with no other change to the status block:

```
<!-- handoff:ground rust=275 unit=157 wasm=43 browser=110 -->
```

One HTML comment, one line, four `key=N` pairs in the fixed order `rust unit wasm browser` (the
`0020 §3` suite order), invisible in a rendered Markdown view. **To maintain it:** at a `done`
commit, after `pnpm test && pnpm lint` passes, replace the four numbers with the fresh counts
`pnpm test` just printed (same numbers that go into State's prose sentence) and leave everything
else — including the surrounding sentence — untouched. `parseGroundMarker`/`formatGroundMarker` are
the read/write pair; `compareGround` is what `pnpm handoff` diffs it against.

**Defect-3 finding, worth recording so the next session does not re-derive it:** the actual
committed `PROMPT.md` at `e4e2c9d` (the version the brief's Why section describes as carrying the
defect) turned out to have **balanced total parens (221 open, 221 close)** and a clean stack-based
nesting with zero orphans — verified with a script before writing any fixture. The `))` the commit
message calls "an orphan close paren" was, by raw count, the correctly-matched close of an outer
`(four suites: ...)` wrapper opened much earlier in the same bullet; the defect (if any) was a
readability/meaning problem in a hand-edited sentence, not a mechanical count imbalance, and a
count-based check would not have caught that specific historical byte sequence. `handoff.test.mjs`'s
defect-3 fixture therefore reproduces the **defect class** the brief describes ("a string-replace
edit that closed a clause early", i.e. one that genuinely drops or duplicates a `)`) with a
synthetic-but-representative sentence, rather than the byte-exact historical one — noted here per
"Record... anything that differs from the brief." Defect 2's fixture is unaffected and uses the real
sentence exactly as it stood in `e4e2c9d`.

**Order of work step 2 ("prove each check can fail... one per check") was done two ways:** every
structural check has a fixture pair in `handoff.test.mjs` (broken input asserted to fail, corrected
input asserted to pass), and three of the five checks (milestones, parens, ground) were additionally
proved live against the real files — a real sentence was injected into `PROMPT.md`, `pnpm handoff`
was run and observed to flag it, then the file was reverted and `pnpm handoff` re-run clean (git
diff confirmed no residue). The ground check's own live proof came for free: this milestone's 21 new
unit tests genuinely moved `unit` from 157 to 178, so `pnpm handoff` reports `ground: STALE 1 — unit:
marker 157, actual 178` on the real tree right now (see "Known state at hand-off" below) — a live,
unplanned instance of exactly the defect it exists to catch.

**Measured, Budgets:** `unit` was 157 tests before this milestone; `pnpm test unit` (full suite, no
pattern) now reports **`unit pass 178 tests 1.2s/3s`** — 21 new tests, all pure string/regex work in
`handoff.test.mjs`'s own style, comfortably inside the 3 s budget (a pre-change timing number was
not separately captured, since the budget line already has ~40% headroom left and the added tests
are the same shape as the suite's existing ones — no reason to expect it moved the *rate*, only the
count).

**Known state at hand-off, not a defect:** as recorded above, `pnpm handoff` currently reports
`ground: STALE 1` for `unit` (marker 157, actual 178), because this milestone's own new tests raised
the count after the marker was seeded from the base commit's (`e4e2c9d`) true ground. This is the
same staleness every milestone that adds tests already causes in State's prose; the marker is not
special-cased for its own milestone's edits, by design — fixing it here would mean hand-editing the
marker to a number `pnpm test && pnpm lint` had not actually re-verified at a `done` commit, exactly
the shortcut this check exists to prevent. The orchestrator's own `pnpm test && pnpm lint` at M15g's
`done` gate will produce the true final numbers (`unit` will include these 21 plus whatever else
lands between now and then); update both State's prose sentence and the marker together from that
run's output. All other three suites' markers (`rust` 275, `wasm` 43, `browser` 110) still match, and
all four structural checks pass on the live tree (`milestones: none stale`, `parens: balanced
(222/222)`, `briefs: all present (66)`, `status: consistent (66)`).

**`scripts/suites.mjs` untouched:** `vitest.config.ts`'s `unit` project already globs
`scripts/**/*.test.mjs`, so `handoff.test.mjs` is picked up with no registration, the same way
`context-artifacts.test.mjs` and the other `scripts/lib/*.test.mjs` files are.

**`pnpm test unit -t handoff` note:** every `describe`/`test` in `handoff.test.mjs` is nested under
one outer `describe('handoff', ...)` specifically so this exact pattern (named in the brief's
Verification commands) matches the whole file — vitest's `-t` matches the joined
`describe > describe > test` name, not the file path. Run this way it also happens to pick up one
unrelated pre-existing test elsewhere in the repo whose title contains the substring "handoff"
(`packages/engine/src/sab/triple.test.ts`'s `triple.slot_handoff_never_aliases`) — harmless, and
expected of any substring `-t` pattern.

**Commits:** `c984eaf` (step 1: `scripts/lib/handoff.mjs` + `scripts/lib/handoff.test.mjs`),
`6daedf9` (step 3: `scripts/handoff.mjs`, `package.json`'s `handoff` script, the `PROMPT.md` marker).
No step 2/4 commit: step 2's proof lives inside step 1's files (same commit); step 4 (re-verify
against the four historical defects) needed no file change beyond what's recorded above.

### Orchestrator's correction at the gate: defect 3 was my misdiagnosis, and coverage is 2 of 4

The brief told you to catch "three of four". **It is two of four, and the error was mine, not the
implementer's.** The implementer reported that defect 3's historical text "was actually
paren-balanced by raw count" and used a synthetic fixture instead of the real bytes. That was the
right call and it is worth spelling out why, because the way I produced the false defect is this
session's own recurring lesson turned on myself.

Checked at the gate, both sides of the fix commit:

| commit | `PROMPT.md` parens |
|---|---|
| `e4e2c9d` (before the "fix") | 221 / 221 — balanced |
| `0968273` (after) | 221 / 221 — balanced |

Balanced per *status-block bullet* too, on both. **The counts were never wrong.** What I actually
measured when I "found" the defect was an arbitrary 1,450-character window starting at `- **State:**`
that cut off mid-sentence, and I reported the window's artefact as a property of the file. The real
problem was prose: I had repurposed the opening paren of a clause, which left its closing paren
reading as a stray `))`. That is a genuine edit defect and worth fixing — it is simply not a
paren-count defect and no count check could find it.

**So the honest scorecard is:** defect 1 (stale ground numbers) mechanised and verified live;
defect 2 (a ticked milestone named as current/next) mechanised and verified live; defect 3
misdiagnosed by me and not mechanisable as stated; defect 4 (prose about which session did what)
out of reach as the brief already said. The parens check stays — it is nearly free and a genuinely
unbalanced file is worth catching — but **its justification is "cheap always-true invariant", not
"this caught a real defect", and it must not be cited as the latter.**

Verified live at the gate by injection rather than from the fixtures:

```
milestones: STALE 1
  M15f: ticked in PLAN.md, PROMPT.md says "M15f next"
ground: STALE 1
  unit: marker 157, actual 178
```

Both reverted, `git status` clean afterwards.
