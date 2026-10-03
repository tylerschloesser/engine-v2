# M39e: Device walkthrough tool

Status: not started · After: 39d · Tyler-dependent: no (Tyler uses it in M39's device run)

## Goal
Tyler asked for this on 2026-10-03: "The device checks are honestly really complicated, even with a dedicated page. Running through all the tests across various devices and recording results is tedious and error prone." Build a simple, **local-only** tool that walks Tyler through a round of manual checks one item at a time and records the results. It **shows a QR code automatically** for the page the current item needs, which means it runs the serving commands itself (today Tyler runs `pnpm device:serve …` by hand, copies the tunnel URL and types it into the phone). Tyler can go back, redo an item or change a result without losing anything. The same tool serves **future rounds** of manual testing, not just M39. And the orchestrating session can start a round and read its results through a documented interface, or hand that to a sub-agent.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/device-checks.md` (the checks: stable bold ids `**M<NN>-<slug>**`, steps, pass criteria, *If it fails*, **Run on** lines, the "How to serve a page to the phone" section with every serving variant)
3. `packages/engine/scripts/device-serve.mjs` (flags `--tunnel`, `--ws [<fixture>]`, `--app reference`, `--bench`; how it starts `vite preview` and `cloudflared` and prints the URL)
4. `scripts/acceptance-check.mjs` (how it reads ticked ids, which the tool's output must keep working with)

## Scope
**Design first (step 1), then build (step 2).** Step 1 is a short design note in this brief's Deviations, decided by the implementer within the constraints below. It covers the data model, the serving coordination and the UI flow. Then build it without waiting for a ruling, unless a constraint can't be met.

Constraints (fixed):
- **Local only.** No hosted service and no account. The only network exposure is what `device:serve --tunnel` already does (the Cloudflare quick tunnel, approved in Q7). Results are files in the repo.
- **One command** starts a round: `pnpm device:walk [--round <name>] [--only <id-prefix,...>]`. It opens a local UI in the Mac's browser and drives everything from there. It works with `M39` and also with any future set of ids.
- **Serving coordination.** For each item, the tool knows which serving variant the item needs (fixture app, `--app reference`, `--ws`, `--bench`, the Fly URL for M38 items, the Mac loopback URL for desktop Safari and Firefox items). It derives this from the item's section text where it can, with a small explicit override map where it can't. It starts the right `device:serve` variant as a child process, captures the printed URL, and shows the page URL (with the item's parameters) as a **QR code** in the UI, and in the terminal too. It reuses a running server when consecutive items need the same variant, and switches cleanly (kills the old child) when they don't. All children die with the tool (Ctrl-C, closing it, or a crash: no orphaned `vite preview` or `cloudflared`; `pgrep` proves it).
- **Walkthrough.** One item at a time: id, steps, pass criterion, *If it fails*, and fields for result (`pass`, `fail`, `skip`, `not run: no device` for Android), notes, and any numbers the item asks for (HUD readings) as free text. It records the device model and iOS version once per round and reuses them. Back, next, jump to any item, and redo are always available.
- **Resilient.** Every edit is persisted immediately as an append-only event log per round (for example `docs/plan/device-rounds/<round>.jsonl`), with current state = the last event per item. A changed result never erases the earlier one; the history shows both, which is the "record both runs" rule of `device-checks.md`. Killing the tool mid-round and restarting resumes at the same place.
- **Results flow back into the plan files** through an explicit, idempotent command, `pnpm device:walk --apply <round>`. It ticks passing items in `device-checks.md` (`- [x]`) and writes each section's **Run on** line (device, OS, date, result, notes). It never ticks an `-android` row and never unticks something another round ticked without saying so. A dry run (`--apply <round> --dry-run`) prints the diff first. `pnpm acceptance:check` must keep working on the result.
- **Tracker integration.** The orchestrating session must know the tool and be able to delegate to it:
  - a skill `.claude/skills/device-round/SKILL.md`: when to start a round, the command to give Tyler, how to read a round's state (`pnpm device:walk --status <round>`, machine-readable with `--json`), how to apply it, and what to do with failures (a plan edit per `device-checks.md`);
  - one line in the root `CLAUDE.md` map (keep it under 60 lines; the `unit` cap test enforces it);
  - `device-checks.md`'s header names the tool as the way to run a round;
  - the orchestrator's next step in `PROMPT.md` is mine to edit, not yours.

## Non-scope
Automating any check itself; anything that needs the phone to run something besides opening a URL; changing check content or ids in `device-checks.md` (beyond the header line and the `--apply` writes); engine changes.

## Files, packages and crates touched
`scripts/device-walk.mjs` (new) and `scripts/lib/device-walk/*` (new: parser, round log, apply, server control), `scripts/lib/*.test.mjs` (tests), root `package.json` (script and an exact-pinned devDependency only if a QR encoder is needed; prefer a small vendored or dependency-free encoder, and `repo-config` pins exact versions), `packages/engine/scripts/device-serve.mjs` only for a machine-readable URL line if it lacks one, `.claude/skills/device-round/SKILL.md` (new), `docs/plan/device-checks.md` (header line), root `CLAUDE.md` (one map line), `docs/plan/device-rounds/` (new, results).

## Seams
**Provides:** `pnpm device:walk`, `--status [--json]`, `--apply [--dry-run]`; the round log format; the `device-round` skill. **Consumes:** `device-checks.md` ids and sections, `device:serve` flags, `acceptance:check`.

## Planning decisions
- **Source of truth stays `device-checks.md`.** The tool parses it rather than keeping a second copy of the checks, so a future round picks up new items with no tool change. The override map holds only what the text can't express (serving variant, URL parameters).
- **Plain Node `.mjs`, `node:fs`, no shell file operations** (repo rule). The UI is one static page served by the tool on loopback; no framework.

## Order of work
1. Design note in Deviations. 2. Parser and round log with unit tests. 3. Server control and QR code. 4. UI. 5. `--status`, `--apply`. 6. Skill, map line, header line.

## Tests added
`unit`: parsing the real `device-checks.md` (every non-Android id found, with its section and serving variant); round log replay (redo, back, a changed result keeps history, resume after a truncated last line); `--apply` on a fixture copy (ticks, **Run on** lines, Android never ticked, idempotent on a second run, dry-run writes nothing); server control with a fake `device:serve` child (URL captured, a reused variant is not restarted, a switch kills the old child, exit kills all). Each test inject-fail-reverted.

## Exit criteria
- [ ] `pnpm device:walk --round demo --only M03` opens the UI, starts the right server and shows a QR code for the page URL. Evidence: a `playwright-cli` or Playwright screenshot of the UI and the QR decoded back to the URL (a decoder in the test, or `zbarimg` if present).
- [ ] Killing the tool leaves no `vite preview`/`cloudflared` child (`pgrep` before and after, pasted).
- [ ] Redo/back/resume and `--apply` behave as the tests above; `pnpm acceptance:check` still runs after an apply on a scratch copy.
- [ ] The skill, the `CLAUDE.md` map line and the `device-checks.md` header line exist.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm device:walk --round demo --only M03` · `pnpm device:walk --status demo --json` · `pnpm device:walk --apply demo --dry-run` · `pnpm test unit -t device-walk` · `pnpm lint`

## Budgets
Each new `unit` test under 500 ms p95 (ADR 0020 §4); `unit` stays inside 3 s.

## Context artifacts
`.claude/skills/device-round/SKILL.md`; one `CLAUDE.md` map line.

## Manual device checks
None (Tyler's first real use is M39's run).

## Deviations

### Step 1: design note

**Data model.** `device-checks.md` is parsed (never copied) into items: id, section (`M03`), heading, raw bullet text split into *Steps* / *Pass* / *If it fails*, `android` (id ends `-android`; never walked, applied as "Android: not run: no device"), ticked flag. A round is `docs/plan/device-rounds/<round>.jsonl`, append-only, one JSON event per line: `start {only}`, `device {phone, ios, mac}`, `cursor {id}`, `result {id, result, notes, numbers}`, `redo {id}`. State = replay: an item's current result is its last `result` unless a later `redo` reopened it; `history` lists every `result`/`redo`, so a changed result keeps the earlier one. A truncated or unparseable line is skipped on read, and an append first adds the missing newline. The cursor is the last `cursor` event, so a restart resumes in place; `start.only` is stored so `--status` and a restart see the same item set.

**Serving.** Each item resolves to `{device: phone|mac|none, app, ws, bench, tunnel, fly, pages}`. Derived from the section's **Open** paragraph (`--app reference`, `--ws [fixture]`, `--bench`, the first backticked `*.html` page, "Fly URL") and the item text (desktop Safari/Firefox, `-mac` ids -> device `mac`, loopback, no QR); a small explicit override map in `serving.mjs` holds only what the text cannot say (per-item page and query, the reference game's root page, the M39 variants). A running server is reused when its app/ws/bench equal the wanted ones and it has a tunnel whenever one is wanted (a tunnel server also serves loopback, so a Mac item right after a phone item does not restart). Otherwise the old child is stopped (SIGTERM, bounded wait, SIGKILL) before the new one starts. The child is `node packages/engine/scripts/device-serve.mjs <flags>`; the URL is read from two machine-readable lines added to it, `DEVICE_SERVE_URL=<loopback>` and `DEVICE_SERVE_TUNNEL_URL=<https>`. Children die on SIGINT, SIGTERM, `exit`, uncaught errors; a pid file in `test-results/` lets the next start kill children left by a SIGKILLed tool (checked against the command line). The tool's spawn is injectable, so tests use a fake child.

**UI flow.** The tool serves one static page on `127.0.0.1` (random port, opens it with `open`; `--no-open`, `--port`). POSTs need `application/json` and a loopback Host header. Top bar: "Item 7 of 31", round name, which server is running (variant, status, URL, build log tail). Main: id, steps, pass, if-fails, a big QR (server-rendered SVG, scanned from a laptop screen) with the URL as text and a copy button for phone items, a big link for Mac items, a page picker when an item has more than one page; result buttons (pass / fail / skip / not run), notes, numbers, one-time phone model and iOS fields, history of earlier results. Keys: arrows for back/next, `1`-`4` for results. A sidebar lists every item with its result for jumping and redo. The terminal prints the same QR (half blocks) and URL on each item change.

**QR.** Dependency-free encoder `qr.mjs` (byte mode, level M, versions 1-10, mask chosen by penalty). `jsqr` 1.4.0 is an exact-pinned devDependency used only by the test to decode what the encoder draws.

**Apply.** Idempotent from round state: a `pass` ticks `- [ ]`; a `fail` on an already ticked item unticks it and says so in the printed changes; `skip`/`not run`/no result never tick; `-android` never ticked. Each touched section gets a `**Run on:** <device>, <date>; **result:** <id RESULT (notes)>... [round <name>]` line: a line carrying this round's tag is replaced, a placeholder line (`<...>`) is replaced, any other earlier line is kept and the new one added after it.


### Built (steps 2-6)

- **Files:** `scripts/device-walk.mjs` (CLI: walk, `--status [--json]`, `--apply [--dry-run]`, `--round`, `--only`, `--no-open`, `--no-tunnel`, `--port`, scratch overrides `--checks`, `--rounds-dir`); `scripts/lib/device-walk/{parse,serving,rounds,servers,spawn-serve,qr,app,apply,status}.mjs` and `ui.html`; tests `scripts/lib/device-walk-{parse,serve,app,apply}.test.mjs` (28 tests, `unit` 1.7 s of 3 s). Each test group was inject-fail-reverted (round-log dedupe, GF polynomial, server reuse, Android guard, idempotence tag).
- **Seams:** `createServerControl({ spawnServe, probe, onChange, ... })` with `ensure(serving)`, `status()`, `stopAll()`; `spawnServe(args, { onLine, onExit }) -> { pid, stop() }`. `device-serve.mjs` now prints `DEVICE_SERVE_URL=<loopback origin>` and, with `--tunnel`, `DEVICE_SERVE_TUNNEL_URL=<https origin>` (nothing else changed). Round log events: `start`, `device`, `cursor`, `result`, `redo`.
- **Differences from the design note:** (1) no reachability probe in the CLI: this Mac could not resolve a fresh `trycloudflare.com` name (ENOTFOUND) for over a minute while the tunnel was up, so a probe only delayed `ready` by 60 s; the probe stays an injectable option, tested with a fake. (2) A pid file `test-results/device-walk-pids.json` reaps servers left by a SIGKILLed tool. (3) The QR/page block sits above the steps so it is visible without scrolling. (4) Sub-agent note: `device-serve` always binds 4173; the demo ran with `ENGINE_TEST_PORT=4199` because Tyler's own `pnpm device:serve --tunnel` (pids 16754/16842/16867, started before this work) held 4173. Those were never touched.
- **Measured:** the real demo run reached `ready` in about 25 s (build, preview, tunnel). QR for a tunnel URL is version 4 or 5; capacity is 213 bytes.
- **Decoded QR (demo, from the screenshot of the `<img>`):** `https://chef-causing-examine-engaging.trycloudflare.com/determinism.html`. Screenshots (outside the repo): `/private/tmp/claude-501/shots/walk-ui2.png`, `/private/tmp/claude-501/shots/walk-qr.png`.
- **Not verified:** the walk UI on the iPhone (Tyler's first use); desktop Safari and Firefox rendering of the page (Chromium only); `--apply` against a real device-checks.md beyond the dry run and the scratch-copy tests; `pnpm test`/`pnpm lint` in full (orchestrator is the gate). `pnpm acceptance:check` on the real repo exits 1 on its existing "not ticked" rows (no device run yet), which is unchanged by this work.
