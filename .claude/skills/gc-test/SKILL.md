---
name: gc-test
description: Run and read the engine's zero-allocation ("gc") assertion for a browser page -- clean measurement plus permanent negative controls (docs/decisions/0016). Use when asked to check a page for allocation/GC regressions, add a new zero-GC test, change a budget in packages/engine/budgets.json, or debug a failing `gc-loop`-style test.
---

# gc-test

The zero-GC assertion of `docs/decisions/0016-zero-gc-definition.md` §3: per isolate, zero
`MinorGC`/`MajorGC` trace events in a stepped window (assertion A) and exact sampled allocation
bytes within a budget (assertion B), plus unchanged WASM memory. Every page that calls
`installGcPage` (`packages/engine/src/test/gc-page.ts`) and has a `gc.pages.<id>` entry in
`packages/engine/budgets.json` gets a generated suite: one `clean` test and permanent negative
controls that must fail on the named isolate and nowhere else
(`packages/engine/tests/browser/gc/suite.ts`'s `zeroGcSuite`).

## When to run it

- A change touched anything in the hot path of a measured page: the harness (`src/test/harness.ts`,
  `harness-worker.ts`), the loader (`src/loader.ts`), or a page's own per-frame/per-tick code.
- Adding a new zero-GC page (see "Adding a page" below).
- Debugging a red `gc-loop`-style test in `pnpm test browser`.

Day to day this runs as part of `pnpm test browser` (the `gc` Playwright project runs alongside
`chromium`/`webkit`/`firefox`): `pnpm test browser -t gc-loop` runs just `gc-loop`'s clean test, its
negative controls and the flat-transport parity test (the pattern also matches the spec file name).
`pnpm gc` (below) is for local iteration and the slow/environment-varying modes `pnpm test` never
runs itself.

## Reading a failure

The failure message is JSON: `control` (which negative control, if any), `mode` (`hardware` or
`software`), `bytesPerFrame`/`attributedBytesPerFrame` per isolate, `gc` (per-isolate `MinorGC`/
`MajorGC` counts), `byFn` (top 8 allocation sites by bytes, per isolate -- this is where "who
allocated" comes from), and `verdict` (`{ pass, A, B }` per isolate) next to the expected verdict
Vitest/Playwright's own diff shows. Read `byFn` for the isolate(s) the verdict named: the top
function name plus its `file:line` is almost always the fix. Artefact paths (Playwright's own trace
etc.) print under the failure block same as any other browser test; nothing gc-specific lands
outside `test-results/`.

**Usual causes**, roughly in the order they show up in `byFn`:

- A new `Uint8Array`/view created per frame or tick instead of reused from init (`.claude/rules/
  hot-paths.md`): `subarray()`, `slice()`, `new Uint8Array(...)` anywhere in the hot path.
- A closure, spread, destructure-into-object, or `Array.prototype` callback (`.filter`/`.map`/
  `.forEach`) built fresh each call instead of precomputed once. `harness.ts`'s own `byRole` was
  exactly this (`all().filter(...)` every `stepTick`/`stepFrame`) until M04 fixed it -- grep
  `byFn`'s top entry's function name in the built page bundle
  (`packages/engine/tests/browser/pages/dist/assets/*.js`, `pnpm test`'s `pages` build step) if the
  source alone doesn't make the allocation obvious.
- `engine.log` called inside the measured window (compiled out below `warn` in release, but the
  fixture crates used here are dev-profile).
- A bundler eliminating your own negative-control code, not the page under test: if a *new*
  negative control refuses to trip, check the built chunk for an empty `if`/`for` body before
  assuming the harness is broken -- Vite's production build runs real Rollup tree-shaking, and a
  write to an unread local variable is exactly the shape it removes (`src/test/controls.ts`'s own
  `sinkHolder` comment has the story; write through a `globalThis` property, not a bare `let`).

## Adding a page

1. A page under `packages/engine/tests/browser/pages/` that calls `installGcPage(harness, opts?)`
   after building its `Harness` (see `gc-loop.ts`; `opts.drive` is optional, default `stepFrame` +
   `stepTick`).
2. A `gc.pages.<pageId>` entry in `packages/engine/budgets.json`: `isolates` (one entry per isolate
   the page's `ready.isolates` lists, always including `main`), `software` (`null` until a real
   number exists for that page, per 0016 caveat b).
3. A spec file named `gc-*.spec.ts` under `packages/engine/tests/browser/` calling
   `zeroGcSuite({ pageId, path, expectAdapter? })` -- `expectAdapter: true` once the page has a real
   WebGPU adapter (0016 §1's 110 B main floor only applies then; see budgets.json's own `formula`
   strings for how `gc-loop`'s numbers were derived without one).

That's the whole registration; `zeroGcSuite` reads the isolate list and generates clean + every
negative control from the budget entry alone.

## Changing a budget

Raising a number in `budgets.json` is a reviewed change (0020 §9): never do it to make a test pass
without first re-deriving the `formula` string next to it. Measure with `pnpm gc reliability` (many
runs; below), take the observed max, add whatever margin `gc-loop`'s own entries used as precedent
(clean overhead ceiling + 8 B), and write the new formula in place of the old one so a reviewer can
re-derive it. A control that doesn't separate from clean by that margin on both sides means the page
needs fixing, not the budget (0016 §1 discussion).

## `pnpm gc [software|flat|reliability] [-t pattern]`

Local-only invocations of the `gc` project (`scripts/gc.mjs`), never run by `pnpm test`:

- No mode: the `gc` project once, same hardware/tunnel measurement `pnpm test browser` uses --
  `pnpm gc -t "gc-loop clean"` for fast iteration without the rest of the browser suite.
- `software`: `GC_MODE=software`, the software-adapter arithmetic (0016 caveat b) -- compares bytes
  attributed to a page's `attributionRoots` functions instead of total/N. Fails naming the page if
  its `budgets.json` entry has `software: null`.
- `flat`: `GC_CDP=flat`, the flattened-CDP-session transport (`cdp-flat.ts`) instead of the default
  tunnel (`Target.sendMessageToTarget`, deprecated). `gc: flat transport parity` (always run, any
  mode) is the one test that runs *both* transports and compares the worker's exact byte total.
- `reliability`: `--repeat-each` -- clean x 50, every negative control x 15, 4 workers. Minutes, not
  seconds; run it after any change to the harness, the loader, or a page's hot path, and whenever
  raising a budget.

## The `Tracing.start` stall warning

`gc-tracing-start-stall <ms>` (0016 caveat a): `Tracing.start` occasionally stalls waiting on
Chrome's spare renderer. It prints as a `warn` line under the suite (same mechanism as any other
adapter warning) and never fails the test by itself -- only a real budget/GC-event miss does.
