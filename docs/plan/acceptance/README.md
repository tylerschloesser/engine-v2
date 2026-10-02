# Acceptance tables (M39)

Evidence for the Phase 3 exit (`docs/plan/39-acceptance.md`). One file per audit unit; `budgets.md` is the budget ledger. `pnpm acceptance:check` (`scripts/acceptance-check.mjs`) reads every coverage table here (not this file, `budgets.md`, `deferred-ledger-audit.md` or `plan-audit.md`), and fails on a cited test it cannot find, a cited device check that is not ticked, or any `gap` row.

## Row format

Each unit file holds one Markdown table with exactly these columns:

| # | Item | Evidence | Status |
|---|---|---|---|

- **#**: the item's id in its source (`R3`, `0005 §2`, `Consequences 4`), or a running number.
- **Item**: the Requirement bullet or decision, shortened to one line; enough to find it in the source.
- **Evidence**: one or more entries separated by `; `. Each entry is exactly one of:
  - `test: <suite> "<exact title>"`: a test that exists in the tree. `<suite>` is one of `rust`, `unit`, `wasm`, `netcode`, `browser`, `frame-bench`. The title is the literal string given to `test(...)`/`it(...)` (Vitest, Playwright), the id of a `test.each` row as the runner prints it, or the function name of a Rust `#[test]`. Slow-tier tests keep their `@slow` in the title. A short note in parentheses may follow the closing quote.
  - `device: <ID>`: a bold check id from `docs/plan/device-checks.md` (for example `M16-round-trip`). Never an `-android` id.
  - `guard: <what would fail>`: only together with a `test:` or `lint:` entry that is that guard ("by construction" is accepted only with a mechanical guard).
  - `lint: <check>`: one of `biome`, `rustfmt`, `clippy`, `tsc`, or a named lint rule inside one of them.
  - `adr: <NNNN> <§>`: only for `not applicable` rows, pointing at the decision that made it so.
- **Status**: one of `covered` (a cited test exercises it), `device` (only a device check can show it), `gap` (nothing does), `not applicable (<reason>)`.

A row is `covered` only if the cited test would fail if the item stopped being true. A test that merely touches the area is not evidence: say `gap`.
