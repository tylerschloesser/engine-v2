---
name: device-round
description: Start, read and apply a round of manual device checks (docs/plan/device-checks.md) with `pnpm device:walk` -- the local walkthrough tool that serves each page, shows its QR code and records results. Use when a milestone's device section is due, when Tyler asks to run the device checks, or when reading what a round found.
---

# device-round

`pnpm device:walk` walks Tyler through `docs/plan/device-checks.md` one item at a time, starts the right `device:serve` variant for each (tunnel for the iPhone, loopback for Mac browsers, the Fly URL for M38), shows the page as a QR code, and records every result in an append-only log, `docs/plan/device-rounds/<round>.jsonl`. It parses the checks file, so new items need no tool change. Design: `docs/plan/39e-device-walkthrough-tool.md` Deviations.

## Start a round (Tyler runs it; it needs his phone)

Give him one command. `--only` takes id prefixes (a section, or single items); without it every item is walked.

```
pnpm device:walk --round <name> [--only M03,M08,M11]
```

It opens a page in the Mac browser (QR, steps, pass criterion, result buttons, notes) and prints the QR in the terminal too. Ctrl-C stops the tool and every server it started. Re-running the same command resumes at the same item; back, redo and a changed result are always available and keep the earlier result in the history. `--no-tunnel` serves loopback only (no phone), `--no-open` skips opening the browser.

## Phone self-test (M39f, run once before the auto-runner is built on)

```
pnpm device:walk --selftest [--round <name>] [--no-tunnel]     # about 7 minutes, one QR scan
pnpm device:walk --status <name>                               # the verdict again, any session
```

Two fixture servers (two origins, one tunnel each), the phone API, and the built-in `M39f-selftest` step: Tyler scans the QR, taps Start, and the phone hops between the two origins, holds the screen awake for 6 minutes, and rides out a 20 s link cut with taps. The tool prints `M39f-selftest: PASS|FAIL` with one line per criterion and exits 0 or 1. Design and phases: `scripts/lib/device-walk/selftest.mjs`; the agent is `scripts/lib/device-walk/agent/agent.js`. Dev timers: `--hold <s> --drop-at <s> --drop <s>`.

## Read a round (any session)

```
pnpm device:walk --status <round>          # table
pnpm device:walk --status <round> --json   # counts, remaining ids, per-item notes/numbers/history
```

`remaining` empty means every item has a result. A round may be partial; read what is there.

## Apply it

```
pnpm device:walk --apply <round> --dry-run   # prints the diff, writes nothing
pnpm device:walk --apply <round>             # ticks passes, writes each section's Run on line
```

Idempotent. It never ticks an `-android` row. A `fail` on an already ticked item **unticks** it and says so in the output: check that output before committing. A second round adds its own Run on line and keeps the first. Then `pnpm acceptance:check` reads the ticks as before.

## Failures

For each `fail`: follow that item's *If it fails* in `device-checks.md` (the text is in the UI and in `--status --json` notes only as Tyler typed them, so read the file) and open the plan edit it names (`PLAN.md`, "How milestones work"). A failed check never blocks the next milestone. Record the plan edit's link on the section's Run on line by hand after applying.

## Do not

Hand-edit the `.jsonl` log; run the tool without Tyler for an item that needs a phone; tick items in `device-checks.md` by hand when a round exists for them.
