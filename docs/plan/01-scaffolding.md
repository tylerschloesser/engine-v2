# M01: Scaffolding

Status: not started · After: none · Tyler-dependent: no (code style answered, Q11 in `docs/plan/questions-for-tyler.md`: 2-space indent, single quotes, semicolons as needed, line width 100, rustfmt defaults)

## Goal
A fresh clone can run `pnpm install && pnpm setup:tools && pnpm test && pnpm lint` and see one quiet `pass` line per suite and per lint check. The repo has its pnpm and cargo workspaces, exact toolchain pins, an empty `engine` package and `engine` crate, a test runner that later milestones only add rows to, the Claude Code allowlist and commit gate, the `write-adr` skill, and the first nested `CLAUDE.md` files. No engine code exists yet.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0017-packaging-and-build.md` (§1 layout, §2 package fields, §6 profiles, §10 pins and the command table)
3. `docs/decisions/0020-testing-strategy.md` (§1 tools, §2 output contract, §3 suites and budgets, §4 slow tag, §10 environment note)
4. `docs/decisions/0021-context-architecture.md` (§1, §2, §4, §6, §7)

0017 and 0020 carry "Amended by 0024" in their Status lines; `docs/decisions/0024-planning-amendments.md` need not be read. Its §13 (what `[profile.dev.package."*"]` covers: in this workspace the `engine` crate builds at the dev `opt-level`; profiles stay verbatim, so `[profile.dev]` gets no `panic = "abort"`) is already reflected in Planning decisions (b), and §14 belongs to M36.

Mine from spikes: nothing. Rules that apply: none exist yet.
Verify before writing (docs/process.md "verify, don't recall"): hook and permission syntax at https://code.claude.com/docs/en/hooks.md and https://code.claude.com/docs/en/permissions (checked 2026-09-19 against Claude Code 2.1.278; the JSON below is that result); skill frontmatter at https://code.claude.com/docs/en/skills.md; start `biome.json` from `pnpm exec biome init` so the key names match the pinned release.

**Shell caution (Tyler's machine):** `cp`, `mv` and `rm` are aliased to their `-i` forms in the Bash tool's shell; a bare call waits for a prompt until the tool times out. In Bash calls use `command cp -f`, `command mv -f`, `command rm -f`. Scripts never shell out for file operations: they use `node:fs` (`copyFile`, `rename`, `rm`).

## Scope
1. Workspaces and pins: every root file in the table below.
2. Empty `packages/engine` package and `packages/engine/crates/engine` crate, each with one placeholder source file and a nested `CLAUDE.md`.
3. `pnpm test [suite] [-t pattern]`, `pnpm test:slow`, `pnpm lint`, `pnpm setup:tools`: Node scripts under `scripts/`, with the runner's own unit tests and one permanent negative control per suite.
4. `.claude/settings.json` (allowlist + commit hook), `.claude/hooks/pre-commit-check.sh`, `.claude/skills/write-adr/SKILL.md`.
5. Root `CLAUDE.md` map update.

## Non-scope
- Any engine code: no ABI, `export_game!`, loader, `buildGame`, Vite plugin, fixture game (all M02). The exports map gets only the entries that exist (below); M35 owns the final map.
- The `wasm`, `netcode` and `browser` suites, Playwright, Bun (M02, M03, M27). `packages/engine/budgets.json` (M04). CI (M10).
- The clippy ban lists of 0002 §3: M01 creates `clippy.toml` and turns the two lints on; M02, which reads 0002, fills the lists with the first sim code.
- `.claude/rules/*` (each arrives with the code it governs, 0021 §1); `games/*`; any skill other than `write-adr`.

## Files, packages and crates touched
One package, one crate, plus repo-root tooling.

| File | Essential contents |
|---|---|
| `pnpm-workspace.yaml` | `packages: [packages/*, games/*]` (0017 §1). `spikes/` stays outside. |
| `package.json` (root) | `private`, `"type": "module"`, `packageManager` and `engines.node` per 0017 §10. Scripts: `test` = `node scripts/test.mjs`, `test:slow` = `node scripts/test.mjs --tier slow`, `lint` = `node scripts/lint.mjs`, `setup:tools` = `node scripts/setup-tools.mjs`, `format` = `pnpm exec biome check --write . && cargo fmt`. devDependencies, exact (`pnpm add -w -D -E`): `@biomejs/biome`, `typescript`, `vitest`, `vite` at the 0017 §10 pins (Vite is added now so Vitest resolves the pinned release), and `@types/node@22.20.3` (the newest 22.x, `npm view`, 2026-09-19; pinned here because 0017 §10 has no row for it). Nothing in M01 consumes `@types/node` (`types: []` in the base, untyped `.mjs` scripts): it is pinned now so the lockfile is settled, for M02's Node-side TypeScript (`src/build-game.ts`, `src/server-node.ts`, `src/vite.ts`), which opts in with `types: ["node"]` in the tsconfig that checks it. Give every package as `name@<full version>`: with a bare major (`@types/node@22`) pnpm writes `^22.20.3` despite `-E` (checked). If any caret or tilde still lands in `package.json`, write the exact version by hand and re-run `pnpm install`. No `postinstall`. |
| `.node-version` | per 0017 §10 |
| `rust-toolchain.toml` | verbatim from 0017 §10 |
| `Cargo.toml` (root) | virtual workspace: `resolver = "3"`, `members = ["packages/engine/crates/*"]`, `exclude = ["spikes"]` (the spike crates have no `[workspace]` of their own and would otherwise error). `[workspace.package]`: `edition = "2024"`, `version = "0.0.0"`, `publish = false`. `[workspace.lints.clippy]`: `disallowed_methods = "deny"`, `disallowed_types = "deny"`. Profiles `dev`, `dev.package."*"` and `release` verbatim from 0017 §6. **Do not add member globs whose directory has no crate yet** (`packages/engine/fixtures/*`, `games/*/sim`): cargo 1.93 fails on a glob that matches nothing (checked). M02 and M20 add them. |
| `Cargo.lock` | generated, committed |
| `clippy.toml` | header comment naming 0002 §3 as the owner of the lists; `disallowed-methods = []`, `disallowed-types = []` |
| `.config/nextest.toml` | `[profile.default]`: `fail-fast = false`, `default-filter = "not test(/(^\|::)slow_/)"`, `[profile.default.junit] path = "junit.xml"`. `[profile.slow]`: `default-filter = "test(/(^\|::)slow_/)"`, same junit path. (`\|` is this table's markdown escaping: write a plain `|` in the TOML. Checked on the pinned nextest: the report lands at `target/nextest/<profile>/junit.xml`.) |
| `biome.json` | from `biome init`, then: `vcs.enabled` + `useIgnoreFile` true; files exclude `spikes`, `docs`, and `**/src/bindings` (generated, M16); formatter per Q11 in the header line; recommended lint preset; import sorting on. |
| `tsconfig.base.json` | `target`/`lib` es2023, `module` + `moduleResolution` nodenext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `declaration`, `sourceMap`, `skipLibCheck`, `types: []`. (Checked: TypeScript at the pin accepts all of these.) |
| `vitest.config.ts` | `test.projects` with one project: `name: 'unit'`, `environment: 'node'`, `include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.mjs']`. No globals; tests import from `vitest`. |
| `.gitignore` | already covers `node_modules`, `target`, `dist`, `test-results`; add nothing unless a tool writes elsewhere |
| `packages/engine/package.json` | the non-`exports` fields of 0017 §2 (`name`, `private`, `type`, `sideEffects`, `files`, empty `dependencies`, the optional `vite` peer); `exports` holds only `"."` and `"./package.json"`. Scripts: `build` = `tsc -p tsconfig.build.json`, `typecheck` = `tsc -p tsconfig.json --noEmit`. No devDependencies (tools live at the root; checked that package scripts resolve the root `tsc`). |
| `packages/engine/tsconfig.json` | extends the base; `rootDir: src`, `outDir: dist`, `noEmit: true`, `include: ["src"]` (tests are type-checked) |
| `packages/engine/tsconfig.build.json` | extends `./tsconfig.json`; `noEmit: false`; excludes `src/**/*.test.ts` |
| `packages/engine/src/client.ts` | a comment and `export {}` (tsc needs one input; M02 replaces it) |
| `packages/engine/crates/engine/Cargo.toml` | `name = "engine"`, `version`/`edition`/`publish` `.workspace = true`, `[lints] workspace = true`, no dependencies |
| `packages/engine/crates/engine/src/lib.rs` | crate doc comment only |
| `packages/engine/crates/engine/tests/runner_control.rs` | the Rust negative control (Tests added) |
| `scripts/*.mjs`, `scripts/lib/*.mjs` | below |
| `.claude/…`, `CLAUDE.md` ×3 | below |

## Seams
**Provides:**
- Commands: `pnpm test [suite] [-t pattern] [--tier fast|slow] [--self-check-fail] [--budget-scale <n>]`, `pnpm test:slow`, `pnpm lint`, `pnpm setup:tools`, `pnpm format`, `pnpm --filter engine build`.
- `scripts/suites.mjs`: `export const buildSteps` and `export const suites`. **This file is how every later milestone registers work.** A build step is `{ name, cmd, args, cwd? }`; steps run one after another, in order, before any suite (cargo steps would only queue on the target-dir lock). A suite is `{ name, kind, tiers, budgetMs, args?, cwd?, env? }` with `kind` one of the adapters. Suite ids are chosen in this brief, one per row of the 0020 §3 table (which names rows, "Rust native", "TS unit", …, not ids): `rust`, `unit` (this milestone), `wasm`, `netcode`, `browser` (reserved). Every later brief uses these ids. `budgetMs` values are the 0020 §3 budgets, with a comment citing that section as the owner.
- `scripts/lib/adapters.mjs`: one adapter per runner, `{ command({ suite, pattern, tier, outDir }) -> { cmd, args, env?, reportPath }, parse({ tier, reportPath, exitCode, logPath }) -> { tests, failures: [{ name, message, seed?, artefacts: [] }] } }`. `outDir` is `test-results/<suite>/`. `reportPath` is the one file the child writes its machine-readable report to, which need not be under `outDir` (`nextest`: `target/nextest/<profile>/junit.xml`, the profile following `tier`; `vitest`: `<outDir>/report.json`), or `null` for a runner with no report file. The **runner**, not the adapter, deletes `reportPath` before spawning and hands the same path back to `parse`, so an adapter is two pure functions and never touches the file system except to read in `parse`. `logPath` is `<outDir>/output.log`, the child's captured stdout and stderr (an adapter with `reportPath: null` parses this). M01 ships `nextest` and `vitest`; M02 adds `script` (the Bun leg), M03 adds `playwright`.
- `scripts/lib/report.mjs` (pure: `formatSuiteLine`, `classifyBudget`, `parseJunit`, `parseVitestJson`, `formatFailure`), `scripts/lib/run.mjs` (`run(cmd, args, opts) -> { code, ms, log }`, output captured to a file, never streamed), `scripts/lib/env.mjs` (`toolEnv()`: on macOS, when `DEVELOPER_DIR` is unset and the CommandLineTools directory exists, sets it per 0020 §10; every cargo spawn in every script uses it).
- `scripts/setup-tools.mjs`: `export const TOOLS` (name, pinned version, probe command, install command). M02 adds Bun, M03 adds the Playwright browsers.
- Conventions: the slow tag (Rust test function named `slow_*`; Vitest title containing `@slow`); test placement (Planning decisions (a)); `test-results/<suite>/` as the only artefact root.
- `.claude/settings.json`, the commit hook, `write-adr`.
- The `context-artifacts` test (`unit`): every later brief that creates a nested `CLAUDE.md`, a rule file or a skill lists it under Context artifacts and is checked by this test through `pnpm test`; a brief that creates a rule file also adds the rule's one-line invariant and link to root `CLAUDE.md` (0021 §1), which the same test requires.

**Consumes:** nothing.

## Planning decisions
**(a) Tests live per package; there is no top-level `tests/` tree.** Settles the PRE-PLAN §10 gap.
- `rust`: unit tests inline (`#[cfg(test)]`); scenario and replay tests in `packages/engine/crates/engine/tests/*.rs`; fixture games in `packages/engine/fixtures/<name>/` (0017 §1).
- `unit`: `*.test.ts` beside the source in `packages/engine/src/` (excluded from `dist` by `tsconfig.build.json`); runner tests in `scripts/`.
- `wasm`, `netcode`, `browser`: `packages/engine/tests/<suite>/` (browser pages under `tests/browser/pages/`; shared TS helpers in `tests/support/`). `tests/` and `fixtures/` are outside the package's `files`, so nothing is published.
- Golden hashes and recorded logs sit with the game they describe, because the Rust, Node/Bun and browser suites must all read the same file: `packages/engine/fixtures/<name>/golden/`, later `games/reference/golden/`. Reference-game scripted tests: `games/reference/tests/`.
- `packages/engine/budgets.json` is fixed by 0020 §9. The iOS checklist is `docs/plan/device-checks.md` for the whole of Phase 3 (`PLAN.md`); Phase 4 moves it under `docs/` when `docs/plan/` is deleted.
- Why: a nested `CLAUDE.md` loads when a file beside it is read (0021 §1), so test conventions reach a session only if tests sit inside the package; cargo already puts Rust tests in the crate; a fourth tree would be a fourth workspace package that imports `engine/test`, and would count against every milestone's three-package limit. Cross-package end-to-end tests belong to the consumer (`games/reference/tests/`), which is how a real game would test.

**(b) `packages/engine/crates/` starts as one crate named `engine`.** Settles the 0017 deferred item. One crate is what game authors path-depend on (PRE-PLAN §3), and nothing measured says the loop is slow. Split only on one of these triggers, with an ADR: (1) the runner's build line warns (edit → tests starting over the 0020 §3 compile budget) in two consecutive milestones and `cargo build --timings` shows the `engine` crate is the critical path; (2) non-sim code (client-side view, interpolation, test support) needs blanket `#[allow(clippy::disallowed_*)]` in more than three modules, which means the 0002 lint scope wants a crate boundary (sim core vs the rest); (3) a proc-macro becomes unavoidable (0017 §7), which Rust forces into its own crate. Constraints on any split: the game-facing crate is still called `engine` and re-exports the others; every crate stays under `packages/engine/crates/` so `files` ships it; `members` already globs that directory.
Related profile note (0024 §13): `[profile.dev.package."*"]` covers only non-member dependencies, so in this repo the `engine` crate builds at the dev `opt-level`, not the `"*"` one. That is kept (engine edits are this repo's hot loop). Add a `[profile.dev.package.engine]` override only if a fast-tier test is demoted for CPU time rather than scenario size.

**(c) Binary tools are installed by `pnpm setup:tools`, checked by `pnpm test`, never installed implicitly.** `scripts/setup-tools.mjs` walks `TOOLS`: for each, run the probe, compare with the pin, and if missing or different print one `install <name> <pin>` line and run the install command (a tool already at its pin prints no such line). M01 rows: `rustup` present (else print the rustup URL and fail; `rust-toolchain.toml` then installs the pinned toolchain, target and components on first cargo call), Node and pnpm versions (report only), and cargo-nextest with the install command of 0017 §10 (a source build into `~/.cargo/bin`, a few minutes once, shared by every worktree). The pin's version string lives in `TOOLS` with a comment citing 0017 §10. `scripts/test.mjs` probes nextest before the build phase and, on a miss or mismatch, prints one line (`nextest <found|missing>, need <pin>: run pnpm setup:tools`) and exits 2. Why not auto-install from `pnpm test` or `postinstall`: a multi-minute compile inside a test or install command breaks the output contract and surprises; why global and not `cargo install --root .tools`: every agent worktree would pay the compile again. M10 installs the same pin in CI with a prebuilt-binary action.

**Runner language: plain Node ESM (`.mjs`), zero dependencies, no build step.** Node at the pin still prints an experimental warning for type stripping, which would break the quiet contract; `.mjs` is checked by Biome and its pure parts are unit-tested.

**Runner behaviour** (implements 0020 §2; nothing here restates its numbers):
- Arguments: optional positional suite name; `-t <pattern>` (a plain substring of the test name; avoid regex metacharacters, since Vitest treats it as a regex); `--tier` (default `fast`). Unknown suite or flag: print the known names, exit 2.
- Phase 0: clear `test-results/<suite>/` for the selected suites (`fs.rm`), probe tools. Phase 1: run `buildSteps` in order, output captured to `test-results/build/<step>.log`; on failure print the step name, the last 40 lines of its log and the log path, exit 1, run no suite. M01 steps: `tsc` (`pnpm --filter engine build`) and `cargo nextest run --workspace --no-run`. Build time is measured apart from suite time; if it exceeds the 0020 §3 compile budget print one `build WARN <t>/<budget>` line on **stderr**, so that stdout stays contract-only and a cold build still prints exactly two stdout lines (never a failure: the runner cannot tell a cold build from a warm one).
- Phase 2: spawn every selected suite at once (`Promise.all`), each child's stdout and stderr to `test-results/<suite>/output.log`.
  - `nextest` adapter: `cargo nextest run --workspace --no-tests=pass [-P slow] [<pattern>]`; `reportPath` is `target/nextest/<profile>/junit.xml` (`default` on the fast tier, `slow` on the slow tier); parse it (totals from `<testsuites>`, failures from `<testcase>` + `<failure>`; unescape XML entities). Without `--no-tests=pass` a filter that matches nothing exits 4 (checked).
  - `vitest` adapter: `pnpm exec vitest run --project <name> --passWithNoTests --reporter=json --outputFile=test-results/<suite>/report.json -t <regex>`, where the fast tier's regex is `^(?!.*@slow).*<pattern>` and the slow tier's is `@slow` combined with the pattern; parse `numTotalTests`, `numPendingTests` and `testResults[].assertionResults[]` (`fullName`, `failureMessages`). Report passed + failed as the test count. (Checked on the pinned Vitest: an empty project exits 1 without `--passWithNoTests`.)
  - Non-zero exit with no parseable report: the suite is `FAIL`, with the last 20 log lines and the log path as its failure block.
  - Zero tests selected (a `-t` pattern that matches nothing, or a tier with no tagged test yet): the child exits 0 and the suite line is the ordinary `pass` line with `0 tests`, there are no failure blocks, and the run exits 0. The runner must not depend on a report file existing: the runner deletes each suite's `reportPath` (`junit.xml`, `report.json`; Seams) before spawning, so a stale one is never parsed, and **exit 0 with no report file means 0 tests, pass** (do not assume nextest writes `junit.xml` when nothing ran).
- Phase 3, stdout, in registration order: one line per suite, columns padded, `name pass|FAIL <n> tests <duration>/<budget>`; ` WARN over budget` appended when duration > budget; over the 0020 §2 failure multiple the status is `FAIL` with ` over budget`. Then one block per failure: test name, message (first 20 lines), seed when the adapter found one, artefact paths. Nothing else. A tier with no suites prints the single line `<tier>: no suites registered` and exits 0. That is not M01's case: `rust` and `unit` register `tiers: ['fast', 'slow']`, so that a later milestone adds a slow test by its name alone, and `pnpm test:slow` here prints two `pass 0 tests` lines. `budgetMs` is the fast-tier budget (0020 §3); a slow-tier line prints `<duration>` with no `/<budget>` and is never budget-classified (slow wall-clock gates are M36's).
- Exit codes: 0 all suites pass (warnings allowed); 1 any test, suite-budget or build failure; 2 usage or missing tool. pnpm adds its own `$ node …` banner on **stderr**, and on any non-zero exit appends one line to **stdout**, `[ELIFECYCLE] Test failed. See above for more details.` (checked on the pinned pnpm). Apart from that one trailing pnpm line on a failing run, stdout carries only the contract; the runner itself never prints it, so `node scripts/test.mjs` is contract-only.
- `--budget-scale <n>` multiplies every budget (M10 uses it so CI timings never gate; the self-check below uses it). `--self-check-fail` sets `RUNNER_SELF_CHECK=fail` in every child's environment. Both are flags rather than environment prefixes so the calls match the `Bash(pnpm *)` allow rule.

**`pnpm lint`** (`scripts/lint.mjs`): runs the four check rows of the 0017 §10 command table in parallel, with the type-check row as `pnpm -r run typecheck` (a package opts in by having that script). Output: one line per check, `biome|rustfmt|clippy|tsc pass|FAIL <duration>`; per failure the first 40 lines of the tool's output, the log path `test-results/lint/<check>.log`, and the fix command from the same table where one exists. Exit 1 on any failure. No budgets (0020 §2).

**`.claude/settings.json`** (hook syntax verified; `if` belongs to the handler, `timeout` is seconds, exec form substitutes `${CLAUDE_PROJECT_DIR}` and needs no executable bit on the script):
```json
{
  "permissions": {
    "allow": ["Bash(pnpm *)", "Bash(cargo *)", "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
              "Bash(git show *)", "Bash(git add *)", "Bash(git commit *)"],
    "deny": ["Bash(pnpm publish *)", "Bash(cargo publish *)"]
  },
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "if": "Bash(git commit *)", "command": "bash",
                  "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-commit-check.sh"], "timeout": 30 }]
    }]
  }
}
```
The lists are 0021 §7's; do not widen them. The file arrives in two parts: step 1 writes it with **only** the `permissions` block, so that the pnpm and cargo calls of steps 1–5 do not each prompt; step 6 adds `hooks`. Claude Code's file watcher normally picks up a settings edit without a restart, so both the allowlist and the gate may go live mid-session (if the step-1 prompts persist, carry on; they end at the next session start). From the moment the `hooks` block exists, commit only on a Biome-clean and rustfmt-clean tree (`pnpm format` first), and do not rely on the live hook as the test: verify the script by piping JSON to it (Exit criteria).

**`.claude/hooks/pre-commit-check.sh`** (0021 §6), bash, no dependency beyond node, pnpm and cargo:
1. Read stdin; extract `tool_input.command` and `cwd` with a `node -e` one-liner (not `jq`). Any parse problem: exit 0.
2. Exit 0 unless some shell segment of the command (split on `&&`, `||`, `;`, `|`, newlines, `$(`, backticks; leading `VAR=value` stripped) starts with `git`, optional `-c k=v` / `-C path` options, then `commit`. `git log --grep "git commit"`, `echo git commit` and `pnpm test` must exit 0: a failed check on a non-commit is a false block, which is 0021 §6's removal trigger.
3. `cd` to `git -C "$cwd" rev-parse --show-toplevel` (fallback `$CLAUDE_PROJECT_DIR`). If `node_modules/.bin/biome` is missing: stderr `run: pnpm install`, exit 2.
4. Run the two no-compile checks named in 0021 §6 concurrently on the working tree (not the index: `git add -A && git commit` has staged nothing when the hook fires). Capture output.
5. Both pass: exit 0, print nothing. Otherwise stderr gets, per failed check, its first 30 output lines and the single fix command (0021 §6), then `exit 2`.

**`write-adr` skill** (`.claude/skills/write-adr/SKILL.md`, frontmatter `name` + a `description` that says when to use it; under ~60 lines; the existing ADRs are the template, so describe and link, do not paste one): when an ADR is required (a decision changes, a Phase 2→3 deferred item is settled, a new engine-crate dependency per 0017 §7, a custom sub-agent per 0021 §5) versus a brief's Deviations note; numbering (next free `NNNN`, kebab slug); the section order the 21 ADRs share (`Status:` line with date, Context, Decision as numbered bold points, Alternatives rejected, Consequences, Sources); house rules (one owner per fact, cite `NNNN §n` instead of copying numbers, verify and list sources with the date checked); superseding (new ADR; the old one changes only its `Status:` line to `Superseded by NNNN`); the bookkeeping edits in the same commit (ADR index in `PRE-PLAN.md` §1, the "Plan-level decisions" list in `PLAN.md`, the spec Open question replaced by a link, the context-map range in root `CLAUDE.md`).

## Order of work
1. `.claude/settings.json` with only the `permissions` block (above), before any pnpm or cargo call. Root pins and workspaces, plus the `engine` crate's `Cargo.toml` and `src/lib.rs` (cargo cannot load a workspace whose `members` glob matches no crate, so `cargo check` and `Cargo.lock` need them in this commit); `pnpm install`; `cargo check`. Commit.
2. Engine package placeholders (the crate's arrived in step 1), tsconfigs, `biome.json`, `clippy.toml`; make the four check commands of the 0017 §10 table pass by hand (not the two fix rows, which write files), with the type-check row run as `pnpm --filter engine typecheck`: the root has no `tsconfig.json`, so `pnpm exec tsc --noEmit` there has nothing to check. Commit.
3. `scripts/lib/env.mjs` and `scripts/lib/run.mjs` first (`cargo install` links, so it needs `toolEnv()`), then `scripts/setup-tools.mjs`; run `pnpm setup:tools` (installs nextest). Commit.
4. `.config/nextest.toml` and `vitest.config.ts` first (no `*.test.mjs` can run before the Vitest config exists); then the rest of `scripts/lib/*` with unit tests (`report.test.mjs`, and here, not in step 3 or 7, `env.test.mjs` and `context-artifacts.test.mjs`), adapters, `suites.mjs`, `test.mjs`, the two negative controls. Commit.
5. `scripts/lint.mjs`. Commit.
6. The `hooks` block in `.claude/settings.json`, the hook script and its tests. Commit.
7. `write-adr` skill, nested `CLAUDE.md` files, root `CLAUDE.md`. Walk the exit criteria, tick `PLAN.md`, update `PROMPT.md`. Commit.

**Pre-agreed split.** The estimate is at the README sizing limit. If context passes 50 % before step 6 starts, stop after step 5 and hand steps 6–7 to a new brief `01b` (the `.claude/` hook and its test, the `write-adr` skill, the three `CLAUDE.md` files): steps 1–5 leave the repo green on their own, since nothing in them depends on the hook, the skill or the nested files. On a split, exactly four exit criteria move to `01b`: the Hook one, the `.claude/settings.json` one, the `write-adr` skill / `CLAUDE.md` files one, and the scratch 61-line `CLAUDE.md` negative check. With them go the Context artifacts section and the settings and hook verification commands (the `node -e` line, the hook pipes and the `time` line; `01b` recreates the two scratch files for the exit-2 pipe). Everything else stays in M01, including both step-4 tests and their two criteria (`pnpm test unit -t toolEnv`, `pnpm test unit -t context-artifacts`: with no nested file, rule or skill yet, the latter passes on its root `CLAUDE.md` clauses alone, and `01b` gives it files to check) and the step-1 `permissions` block. Record the split under Deviations, add the `01b` row to `PLAN.md` directly under the 01 row (After: 01; the table is in execution order, so a row appended at the end would run last), and point `PROMPT.md` at it.

## Tests added
- `packages/engine/crates/engine/tests/runner_control.rs`: `runner_negative_control` passes unless `RUNNER_SELF_CHECK=fail`, then fails with a fixed message. `scripts/lib/runner-control.test.mjs`: the same for Vitest. Both are permanent: they prove the failure path of each adapter, in the spirit of 0016's negative controls. M03 adds one for Playwright.
- `scripts/lib/report.test.mjs`: `classifyBudget` (pass, warn, fail boundaries, scale), `formatSuiteLine`, `parseJunit` on a captured passing and failing report (entities unescaped, multi-line message), `parseVitestJson` on captured reports (pass, fail, all filtered out), `formatFailure` line cap.
- `scripts/lib/pre-commit-check.test.mjs`: spawns the hook with stdin JSON for the step-2 cases; asserts exit 0 and empty output for non-commits, without running any tool.
- `scripts/lib/env.test.mjs`: `toolEnv: sets DEVELOPER_DIR on darwin only when unset` (0020 §10). `toolEnv({ platform, env, exists } = defaults)` takes its three inputs as parameters so the test needs no real CommandLineTools directory: darwin + unset + directory present sets it; already set, other platform, or directory absent leaves `env` untouched.
- `scripts/lib/context-artifacts.test.mjs`: `context-artifacts` (0021 §1, §4 and Consequences; permanent, and the only check later briefs need for the files they list under Context artifacts). Over `git ls-files --cached --others --exclude-standard`, outside `spikes/` and `docs/`: every nested `CLAUDE.md` is at most 60 lines; every `.claude/rules/*.md` has `paths:` frontmatter and each of its globs matches at least one listed file (a glob-to-regex of a dozen lines in the test: `**`, `*`, `{a,b}`; no dependency); every `.claude/skills/*/SKILL.md` has frontmatter with `name` and `description`; root `CLAUDE.md` is at most 60 lines and names every rule file as `.claude/rules/<file>.md`. With no rule files yet the rule clauses pass vacuously; M02 meets them first.

## Exit criteria
- [ ] `pnpm install --frozen-lockfile` succeeds; `pnpm-lock.yaml` and `Cargo.lock` are committed; every devDependency is an exact version (no `^` or `~`; `grep -n '[\^~]' package.json` prints nothing), matching 0017 §10 where it has a row.
- [ ] `pnpm setup:tools` exits 0, and a second run prints no `install` line (decision (c)) and exits 0; `cargo nextest --version` reports the pin.
- [ ] `pnpm test` prints exactly two stdout lines (`rust`, `unit`), both `pass` with a non-zero test count, exit 0.
- [ ] Each of these exits 0 with exactly the stdout lines named: `pnpm test unit` → one `unit pass` line; `pnpm test rust -t runner_negative_control` → one `rust pass 1 tests` line; `pnpm test -t no_such_test` → two lines, `rust pass 0 tests` and `unit pass 0 tests`; `pnpm test:slow` → the same two `pass 0 tests` lines, without a budget. `pnpm test nosuch` prints the known suite names and exits 2.
- [ ] `pnpm test --self-check-fail` prints two `FAIL` lines and two failure blocks (name + message, no raw runner output), then exactly one more stdout line, pnpm's `[ELIFECYCLE]` line (Runner behaviour, Exit codes), and nothing else; exit 1. `pnpm test --budget-scale 0.000001` fails both suites as over budget, exit 1.
- [ ] `pnpm lint` prints four `pass` lines, exit 0; with two deliberately mis-formatted scratch files, a root `scratch.mjs` and `packages/engine/crates/engine/tests/scratch_fmt.rs` (it must compile, and it must sit there: `cargo fmt --check` only sees files in some target's module tree, so a stray `.rs` elsewhere passes silently), it names `biome` and `rustfmt` with their fix commands, exit 1. Delete both afterwards with `command rm -f` (Verification commands).
- [ ] Hook, by pipe: `{"tool_name":"Bash","cwd":"<repo>","tool_input":{"command":"ls"}}` → exit 0 silently; `…"git add -A && git commit -m x"` → exit 0 on a clean tree, exit 2 with the fix command on stderr while the lint criterion's two scratch files exist; the `time` line under Verification commands shows wall time on a clean tree under the 0021 §6 target.
- [ ] The `node -e` line under Verification commands exits 0. It checks that `.claude/settings.json` parses, that its top-level keys are exactly `permissions` and `hooks`, that `permissions.allow` and `permissions.deny` equal the lists of the JSON block above (0021 §7's; order ignored), and that `Object.keys` of the hook handler are exactly `type`, `if`, `command`, `args`, `timeout` (the ones the hooks page documents). The hook criterion above passes against the committed script. Not checkable by command: note under Deviations that the next session start must be eyeballed for a settings warning (M02's session does this).
- [ ] `write-adr` skill, both nested `CLAUDE.md` files and the root map update exist; root `CLAUDE.md` is within its line cap and has no `@` import.
- [ ] `pnpm test unit -t toolEnv` prints a `unit pass` line with a non-zero test count.
- [ ] `pnpm test unit -t context-artifacts` prints a `unit pass` line with a non-zero test count.
- [ ] A scratch 61-line `packages/engine/src/CLAUDE.md` makes `pnpm test unit -t context-artifacts` fail naming the file (check, then remove it with `command rm -f`). Run this after the nested `CLAUDE.md` files and the skill exist (step 7), so the passing run above was not vacuous.
- [ ] `git status` is clean after `pnpm test && pnpm lint` (artefacts are all gitignored).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
```
pnpm install --frozen-lockfile && pnpm setup:tools
pnpm test; pnpm test unit; pnpm test rust -t runner_negative_control; pnpm test -t no_such_test; pnpm test:slow
pnpm test --self-check-fail; echo $?          # 1
pnpm test --budget-scale 0.000001; echo $?    # 1
pnpm test nosuch; echo $?                     # 2
pnpm test unit -t toolEnv; pnpm test unit -t context-artifacts
pnpm lint
node -e "const s=JSON.parse(require('node:fs').readFileSync('.claude/settings.json','utf8')),eq=(a,b)=>[...a].sort().join('|')===[...b].sort().join('|'),h=s.hooks.PreToolUse[0].hooks[0];process.exit(eq(Object.keys(s),['permissions','hooks'])&&eq(s.permissions.allow,['Bash(pnpm *)','Bash(cargo *)','Bash(git status *)','Bash(git diff *)','Bash(git log *)','Bash(git show *)','Bash(git add *)','Bash(git commit *)'])&&eq(s.permissions.deny,['Bash(pnpm publish *)','Bash(cargo publish *)'])&&eq(Object.keys(h),['type','if','command','args','timeout'])?0:1)"; echo $?   # 0 (1, or a throw, on any difference)
echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m x"}}' | bash .claude/hooks/pre-commit-check.sh; echo $?   # 0 clean tree
printf 'export const  a = {b:1}\n' > scratch.mjs; printf '#[test]\nfn   scratch( ) {}\n' > packages/engine/crates/engine/tests/scratch_fmt.rs
pnpm lint; echo $?                            # 1: biome and rustfmt FAIL, each with its fix command
echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m x"}}' | bash .claude/hooks/pre-commit-check.sh; echo $?   # 2
command rm -f scratch.mjs packages/engine/crates/engine/tests/scratch_fmt.rs
time (echo '{"tool_name":"Bash","cwd":"'$PWD'","tool_input":{"command":"git commit -m x"}}' | bash .claude/hooks/pre-commit-check.sh)   # real: under the 0021 §6 target
git status --short
```

## Budgets
PRE-PLAN §7 "Test suite" and "Dev loop" rows: M01 builds the mechanism that measures them (per-suite `budgetMs`, the warn and fail classification, the build-time warning). With two placeholder suites the numbers themselves are trivially met. The commit gate has its own target in 0021 §6, checked by the hook exit criterion.

## Context artifacts
- `.claude/settings.json`, `.claude/hooks/pre-commit-check.sh`, `.claude/skills/write-adr/SKILL.md`.
- `packages/engine/CLAUDE.md` (TS side): package commands (`build`, `typecheck`, `pnpm test unit`); `src/` → `dist/` by `tsc`, no bundler; zero runtime dependencies and tools at the root; where each suite's tests live (decision (a)); the `@slow` tag; "add an export subpath only with the file that backs it". Only what is true today; later milestones extend it.
- `packages/engine/crates/engine/CLAUDE.md` (Rust side): the crate is a workspace member (profiles, lints and `clippy.toml` are at the repo root); unit vs `tests/` placement; the `slow_` prefix; `pnpm test rust -t <name>`; dependency policy is 0017 §7 (link, no list); the split triggers are in this brief until an ADR replaces them.
- Root `CLAUDE.md`: replace "Nothing is built yet" with a Commands line (`pnpm setup:tools`, `pnpm test [suite] [-t pattern]`, `pnpm lint`, `pnpm format`); add map rows for `packages/engine/`, `scripts/` and `.claude/`; add one rule line for the `cp`/`mv`/`rm` alias caution (auto memory does not reach sub-agents, 0021 Context). No invariant lines yet: their rule files do not exist (M02 creates both and adds the two lines).

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
