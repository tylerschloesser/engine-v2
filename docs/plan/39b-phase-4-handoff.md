# M39b: Hand-off to Phase 4

Status: not started · After: 39 · Tyler-dependent: no (it carries forward, without waiting on, whatever M39 listed as unanswered)

Split out of M39 (one session each: M39 audits and may block on Tyler; this one sweeps roughly seventy soon-to-be-deleted files and writes the last ADRs and the Phase 4 prompt).

## Goal
Run by the orchestrating session itself, not by a `milestone-implementer` (0025 §1): the work is delegation and judgement, and a sub-agent cannot launch sub-agents. Its sub-agents are `general-purpose` with `model: sonnet`.

Nothing that Phase 4 deletes is the only home of a fact a future session needs. Every such fact is in an ADR. `PROMPT.md` is rewritten for Phase 4 so that a fresh session can start the clean-up with nothing else explained, `CLAUDE.md`'s map matches, and Phase 3 is declared complete.

## Read first
1. `docs/spec/overview.md`
2. `docs/process.md` ("Rules for every session"; "Phase 4: Clean up")
3. `docs/context-architecture.md` (Principles 3–5; "Target layout after bootstrap"; the "Deleted in Phase 4" paragraph, which is the sweep list and states the capture rule)
4. `docs/decisions/0021-context-architecture.md` (§1 nested `CLAUDE.md` and rules, §3 sub-agent briefs, §4 skills, §8 where progress lives)

Plan files (do not count): `PLAN.md`, `docs/plan/acceptance/budgets.md`, M39's list of open Tyler items. Skills: `write-adr`. Rules that apply: none.

## Scope
- **Sweep, delegated.** Sub-agents (briefed per 0021 §3) each read one slice of what Phase 4 deletes and write candidates to `docs/plan/handoff/<slice>.md`, returning a ten-line summary. Slices: `PRE-PLAN.md`; the briefs in four groups of about fifteen files, `01`–`09b`, `10`–`20b`, `21`–`29`, `30`–`39b` (each brief's **Planning decisions** and **Deviations** are the dense parts); `docs/plan/` side files (device checks, deferred ledger, questions, acceptance); `docs/research/*` with `spikes/*/RESULT.md`; `docs/process.md` with `PROMPT.md`. A candidate is a statement that passes all three tests: (1) no ADR already says it; (2) it cannot be read off code, tests, `budgets.json`, `baselines/*.json`, config, a skill or a nested `CLAUDE.md`; (3) a future session that did not know it could plausibly undo or re-litigate it. Each candidate cites its source line and proposes a home: new ADR, a line in an existing nested `CLAUDE.md` or rule file, or "drop" with a reason.
- **Capture.** The main session reviews the candidates and writes ADRs with the `write-adr` skill, grouped by subsystem rather than one per item (expect five to eight, for example "Phase 3 planning decisions: world and simulation"), each entry being the decision and its why. Conventions go to the nested `CLAUDE.md` or rule file they belong to (0021 §1). Existing ADRs are never edited; a changed decision is a superseding ADR.
- **Measured budgets ADR.** "Budgets as measured at Phase 3 exit": the content of `docs/plan/acceptance/budgets.md`, reduced to number, owner ADR, measured value, how to re-measure (command or device check). It supersedes nothing; it is the permanent record PRE-PLAN §7 cannot be after deletion. Derived budgets that were confirmed or changed (tick time, frame time) are stated as such.
- **Device checklist survives.** The manual checklist is a procedure Phase 4 must not lose (0020 §10 calls it "checked-in"). Move its final form to the place Phase 4's layout allows: a `device-check` skill (`.claude/skills/device-check/SKILL.md`, which is now a real, performed procedure, so 0021 §4 is satisfied) holding the entries and the pass criteria. `docs/plan/device-checks.md` stays until Phase 4 deletes `docs/plan/`.
- **ADR index.** PRE-PLAN §1's ADR index disappears with it. Add `docs/decisions/README.md`: number, title, one-line decision, superseded-by. One line per ADR; no content.
- **Dangling-link inventory for Phase 4.** ADR "Sources" sections link into `docs/research/`, `spikes/` and `docs/spec/`. ADRs are not rewritten, so list the affected ADRs in the Phase 4 prompt and state the policy there: links into deleted evidence stay as historical references resolvable through git history; the new `docs/decisions/README.md` says so once.
- **Rewrite `PROMPT.md` for Phase 4** (replace the file; process.md: every phase ends by rewriting it). It contains: a status block (phase 4 of 4, not started, work on `main`); the job in one paragraph; "Read first" (`docs/process.md` Phase 4, `docs/context-architecture.md` target layout, 0021, `docs/decisions/README.md`); the work list: write `docs/architecture/<subsystem>.md` from the code as it is (one per subsystem, describing the present), fold each `docs/spec/` Requirement into architecture docs or the reference game's docs, re-cut root `CLAUDE.md` to the target (map, commands, one line per global invariant), review every nested `CLAUDE.md`, rule glob and skill against the final layout, decide whether `scripts/acceptance-check.mjs` and the timing scripts stay, then delete the list in `docs/context-architecture.md`, update that file, and delete `PROMPT.md` last; Phase 4 exit criteria (fresh-session check on the new `CLAUDE.md`: a sub-agent given only `CLAUDE.md` can find how to run tests, add an action type, and locate the determinism and hot-path rules; `pnpm test` and `pnpm lint` green after the deletions; no link in a living doc points at a deleted path); the open Tyler items from M39 with their defaults, and the open items carried forward (next bullet).
- **Open items carried forward.** Known now, whatever M39 adds: **the COOP/COEP header listings of 0015 §3 were never verified on a real static host, nor was its sentence about a cross-origin `wss`.** Tyler did not approve the Cloudflare Pages deploy (Q6), so M38 served the client from the Fly machine with headers set by `games/reference-server --static`, which proves that handler only. Write it into the Phase 4 `PROMPT.md` open-items list and into the capture ADR for hosting as "unverified; the README listings come from documentation", with the way to close it: deploy `games/reference`'s `vite build` to one static host with its listing, run `node games/reference/scripts/check-coi.mjs <url>` and `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` against a server on another origin.
- **Fresh-session check of the new prompt.** A sub-agent reads only the new `PROMPT.md` and what it links to, and lists what it would still need to know to begin. Fix what it finds.
- **`CLAUDE.md` map.** Update the context-map table for Phase 4 (rows for `docs/decisions/README.md`, the new skill; lifetimes adjusted). Stay under its line cap.
- **Declare Phase 3 done.** Tick M39b in `PLAN.md`; commit on `main`; `git tag -a phase-3-complete -m …`; tell Tyler that `main` and the tag are ready to push (0025 §4).

## Non-scope
Any Phase 4 work: writing `docs/architecture/`, deleting files, folding the spec. Editing existing ADRs or spec Requirements. Code changes of any kind (if the sweep finds a behaviour bug, it is a plan edit and this milestone waits).

## Files, packages and crates touched
`docs/decisions/` (new ADRs, `README.md`), `docs/plan/handoff/*.md` (scratch, deleted in Phase 4), `.claude/skills/device-check/SKILL.md`, nested `CLAUDE.md` / `.claude/rules/*.md` lines where a candidate belongs there, `PROMPT.md`, `CLAUDE.md`, `PLAN.md`. No package or crate source.

## Seams
**Provides:** `docs/decisions/README.md` (ADR index); the capture ADRs; ADR "Budgets as measured at Phase 3 exit"; `device-check` skill; the Phase 4 `PROMPT.md`.
**Consumes:** M39's `docs/plan/acceptance/*` and open-items list; every brief's Planning decisions and Deviations; ADRs written during Phases 2–3 (among them M35 "Build profiles, measured", M36b "Fast-tier budgets, dev loop and wire measurements", M37 "Engine failure surface", 0024 "Planning amendments", and the rest listed under `PLAN.md` "Plan-level decisions").

## Planning decisions
- **Grouped capture ADRs, not fifty small ones.** A Planning-decisions paragraph is already a decision with a rationale; most are implementation-level and become visible in code (names, layouts, record formats), so they fail test (2) and are dropped. What remains (rules chosen over alternatives, thresholds, "we measured and did not build X") is cheaper to find later in a handful of subsystem ADRs than in one file each. Anything that *reverses* an accepted ADR still gets its own superseding ADR.
- **Research and spike results are not re-captured.** `docs/context-architecture.md` calls them evidence, disposable once distilled; the ADRs distilled them in Phase 1. The sweep of that slice looks only for a measured number an ADR relies on but does not state.
- **The device checklist becomes a skill, not an architecture doc,** because it is a repeatable procedure with pass criteria (Principle 9), and skills survive Phase 4 by layout.
- **The Phase 4 prompt states exit criteria this brief invents,** since `docs/process.md` gives Phase 4 a purpose but no checklist. They are listed under Scope so Tyler can amend them when reviewing this brief.

## Order of work
1. Launch the sweep sub-agents in parallel. 2. While they run: `docs/decisions/README.md`, the measured-budgets ADR, the `device-check` skill. 3. Review candidates; write capture ADRs and nested-file lines; mark each candidate `captured in <path>` or `dropped: <reason>` in its handoff file. 4. Draft the Phase 4 `PROMPT.md` in a scratch file; run the fresh-session check; fix; replace `PROMPT.md`. 5. Update `CLAUDE.md`. 6. Tick `PLAN.md`, commit, report to Tyler.

## Tests added
None.

## Exit criteria
- [ ] Every candidate line in `docs/plan/handoff/*.md` ends in `captured in <path>` or `dropped: <reason>` (`grep -L` finds no unresolved candidate).
- [ ] `docs/decisions/README.md` lists every file in `docs/decisions/` (checked by a one-line shell comparison of counts and numbers).
- [ ] The ADR "Budgets as measured at Phase 3 exit" has one entry per PRE-PLAN §7 row with a re-measure command or device check.
- [ ] `.claude/skills/device-check/SKILL.md` exists and contains every entry of `docs/plan/device-checks.md`.
- [ ] `PROMPT.md` is the Phase 4 prompt; the fresh-session sub-agent's remaining-questions list is empty or answered in the file; `CLAUDE.md`'s map matches the files that exist and is within its line cap.
- [ ] `grep -n "static host" PROMPT.md` finds the carried-forward COOP/COEP item, and the hosting capture ADR states it as unverified.
- [ ] `PLAN.md` is fully ticked; the working tree is clean; the tag `phase-3-complete` exists on the final commit; Tyler has been told `main` is ready to push.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `grep -c "^| \[" docs/decisions/README.md` against `ls docs/decisions/0*.md | wc -l` · `grep -rL "captured in\|dropped:" docs/plan/handoff/` (expect no candidate file left unresolved) · `wc -l CLAUDE.md` · `git status --short`

## Budgets
None to meet. It makes PRE-PLAN §7's measured values permanent (the measured-budgets ADR).

## Context artifacts
Creates the `device-check` skill and `docs/decisions/README.md`; adds captured conventions to existing nested `CLAUDE.md` and `.claude/rules/` files; rewrites `PROMPT.md`; updates root `CLAUDE.md`'s map.

## Manual device checks
none (M39 ran them)

## Deviations
(filled in during Phase 3)
