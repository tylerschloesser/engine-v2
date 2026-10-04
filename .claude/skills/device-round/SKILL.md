---
name: device-round
description: Start, wait for, read and apply a round of device checks (docs/plan/device-checks.md) with `pnpm device:walk`. The auto runner has Tyler scan one QR code and collects the results itself; this is how an orchestrating session or a sub-agent starts it, waits without polling the phone, reads per-item evidence and applies the result. Use when a milestone's device section is due, when Tyler asks to run the device checks, or when reading what a round found.
---

# device-round

`pnpm device:walk --auto` walks the whole round. Tyler scans **one** QR code on the iPhone and taps Start; an agent script on the phone opens each check's page through the tunnel, collects everything machine-readable (user agent, adapter, `crossOriginIsolated`, HUD numbers, hashes, rAF stats, GPU errors, device loss), judges what it can against the limits in `scripts/lib/device-walk/checks.mjs`, and prompts Tyler on the phone only for what needs a person (a gesture, a visual verdict, leaving the app, Low Power Mode). The rows that are the Mac's own (desktop Safari and Firefox) are walked in tabs the tool opens itself; M34 uses a bot partner the tool starts. Results go to an append-only log, `docs/plan/device-rounds/<round>.jsonl`; raw series go to untracked `test-results/device-walk/<round>/`. Design and seams: `docs/plan/39f-device-auto-runner.md` (Deviations). The classification of every check is in `scripts/lib/device-walk/checks.mjs`; the checks themselves are `docs/plan/device-checks.md`.

You need only this file and `device-checks.md`.

## 1. Start (needs Tyler's phone)

Run it in the background (it runs until the round is done, about as long as the checks take, longer if the 10 minute items are in the set). Round names are lower-case letters, digits and dashes.

```
pnpm device:walk --auto --round <name> [--only M03,M08,M11-boot] --no-open
```

`--only` takes id prefixes (a section, or single items); without it every walked item runs. The tool prints the QR code in the terminal, writes `test-results/device-walk/<round>/qr.svg`, and prints the join URL. `--no-tunnel` serves loopback only (no phone). Re-running the same command resumes the round; Ctrl-C stops the tool and every server it started. `--manual` (or no flag) is the older one-item-at-a-time flow where Tyler types each result.

Then tell Tyler, in one message: the join URL (or the QR file), the pre-flight, and that nothing else is needed. Pre-flight he does once on the phone: Settings, Display & Brightness, **Auto-Lock: Never** (set it back afterwards), Low Power Mode off, Safari as the browser (any network: the tunnel carries it), the Mac awake and on the network. The phone page runs a 30 s idle check and then shows Start.

Do not start an auto round without Tyler: the phone is needed.

## 2. Wait without polling the phone

```
pnpm device:walk --wait <round> [--timeout <seconds>] [--json]
```

Blocks until every walked check has a result (exit 0, final status printed) or the round is `stalled` or the timeout passes (exit 2, state printed). It prints a line each time the state or the waiting-on-whom changes. Or read the state yourself:

```
pnpm device:walk --status <round> --json
```

Fields: `state` is one of `starting | waiting-for-phone | running | waiting-for-human | paused | done | stalled`, with `reason` (for `waiting-for-human` the prompt text, for `stalled` why); `joinUrl`; `phone: {connected, lastSeen}`; `current: {id, n, prompt}`; `humanPending: [ids]` (what is waiting on Tyler); `counts`, `remaining`. Act on the state:

- `waiting-for-phone`: Tyler has not scanned, or the phone went quiet. Re-send the join URL; the round resumes when the page loads.
- `waiting-for-human`: tell Tyler which check and what the prompt says (`humanPending`, `reason`). Do not answer for him.
- `stalled`: the tool process is gone. Re-run the start command (same round name): it resumes from the log.
- `paused`: advisory only (the phone's Pause button is logged; the walk does not stop).

## 3. Read the results

`--status <round> --json` per item: `result` (`pass | fail | skip`), `by` (`auto | human | mixed`), `attempts` (each with `status`, `outcome`, `criteria`, `metrics`, `evidence`, and `reason` when interrupted or reloaded), `criteria` (`{name, value, limit, ok}`, `ok: null` is a question for the person), `metrics`, `evidence` (a path to the raw series), `notes`, `history`; round-level `env` (user agent, adapter, cores, isolation: the **Run on** line needs no typing). A `skip` with `by: auto` and a note is a row that was not run (a browser without WebGPU, a check not automated, a Mac row on a phone-only round): the note says why.

Rows the auto round does not decide: the **human** rows (M38-hosted-boot, M38-socket-resume, M38-remote-motion, M39-full-game-touch, M39-two-devices, M39-sign-off) are recorded `skip` with the note "not automated yet ... walk it by hand with --manual"; Tyler walks them in a second round, `pnpm device:walk --manual --round <name>-human --only M38,M39-full,M39-two,M39-sign`, and `--apply` that round too. **M39-rerun** is a meta row, never walked, and stays open in `remaining`: a round is finished when `state` is `done`, not when `remaining` is empty. **M35-capability** is retired (recorded `skip`, covered by `capability.spec.ts`): its acceptance citation stays unticked until the orchestrator edits the table.

Read the numbers as what they are: a hitch is a **proxy** (rAF gaps over 25 ms are counted and shown to Tyler as a question, never a failure and never a measured frame time), and a number measured on a tunnel or in a headless proof is not a phone number. Do not turn a `judge` answer into a number.

## 4. Apply

```
pnpm device:walk --apply <round> --dry-run   # prints the diff, writes nothing
pnpm device:walk --apply <round>             # ticks passes, writes each section's Run on line
pnpm acceptance:check                        # the device citations read the ticks
```

Always dry-run first and read the output: a `fail` on an item that was already ticked **unticks** it and says so. Apply is idempotent, never ticks an `-android` row, and a second round adds its own Run on line. Commit the log, `device-checks.md`, and nothing under `test-results/`.

## 5. Failures

For each `fail`, the failed `criteria` are in the status; then follow that item's *If it fails* in `device-checks.md` and open the plan edit it names (`PLAN.md`, "How milestones work"). A ladder (`&scaleCap=...`, `?module=url`) is walked automatically: a rung that passes where the default failed leaves the check `fail` with a note saying which configuration passes; the plan edit is a person's. A failed check never blocks the next milestone. Record the plan edit's link on the section's Run on line by hand after applying.

## Corrections Tyler can make on the Mac

The tool serves a live monitor (the URL is in `--status` as `monitorUrl`): items turn green as readings arrive, the current prompt, the phone's last-seen time, **Redo** and **Back** per item, and a changed result (written as `by: human`). The phone's bar has **Redo previous** too.

## Phone self-test (one-off, done 2026-10-03)

`pnpm device:walk --selftest [--round <name>] [--no-tunnel]` proves the phone path itself (about 7 minutes). Only needed again if the agent or tunnel path changes.

## Do not

Hand-edit the `.jsonl` log or `test-results/`; start an auto round without Tyler; treat a proxy-judged hitch as a measured frame time; tick items in `device-checks.md` by hand when a round exists for them; leave the tool running when the round is finished (it exits by itself) or kill it with `-9` (`pnpm device:walk` reaps servers an earlier tool left, but stop it with Ctrl-C or SIGTERM).
