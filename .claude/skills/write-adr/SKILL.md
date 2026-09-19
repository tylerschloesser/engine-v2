---
name: write-adr
description: Write, amend or supersede an architecture decision record in docs/decisions/. Use when a milestone changes an accepted decision, settles a deferred item or an open question, adds an engine-crate dependency, or proposes a custom sub-agent; also to decide whether a change needs an ADR at all or only a Deviations note.
---

# Write an ADR

ADRs live in `docs/decisions/NNNN-<slug>.md`. They record what was chosen and the *why* that cannot be read from code. The existing files are the template: open a recent short one (`0022`, `0023`) for the shape, and `0024` for an ADR that amends several others.

## ADR or Deviations note?

Write an ADR when:
- a decision in an accepted ADR changes, or two ADRs turn out to contradict each other;
- an item marked deferred to Phase 3 (`PRE-PLAN.md` §10, `docs/plan/deferred-ledger.md`) or an Open question in `docs/spec/` gets settled;
- the engine crate gains a runtime dependency (the evidence `docs/decisions/0017-packaging-and-build.md` §7 demands goes in the ADR);
- a custom sub-agent is proposed (`docs/decisions/0021-context-architecture.md` §5).

A small correction that changes no decision (a wrong file name, a flag, a step order, a split milestone) goes in the brief's **Deviations** section instead; fix any later brief it affects. Scope, taste, cost, or a change to a spec Requirements section is Tyler's call: batch it in `docs/plan/questions-for-tyler.md` with a recommended default.

## Steps

1. **Number and name.** Next free `NNNN` (`ls docs/decisions`), kebab-case slug. Title line: `# NNNN: <Title>`.
2. **Sections, in this order:**
   - `Status: Accepted (YYYY-MM-DD).` then, in the same line, what it amends or supersedes (with links) and the milestone that implements it.
   - `## Context`: the forces, what earlier ADRs fixed, what was measured.
   - `## Decision`: numbered bold points (`**1. Name.** …`), so others can cite `NNNN §n`.
   - `## Alternatives rejected`: one bullet each, with the reason.
   - `## Consequences`: including what is deferred, and the trigger to revisit.
   - `## Sources`: spikes, research files, URLs, each with the date checked.
3. **House rules.** Every fact has one owner: cite `NNNN §n` instead of copying a number or list from another ADR. Verify, don't recall: check current docs for any tool or browser behaviour and list the source. Link ADRs relatively (`[0017](0017-packaging-and-build.md)`). Keep it as short as the decision allows.
4. **Never rewrite an accepted ADR.**
   - Superseding: write the new ADR; in the old one change only the `Status:` line to `Superseded by [NNNN](…)`.
   - Amending part of one: the new ADR says which section it amends; the old one gets `Amended by [NNNN](…) §n.` appended to its `Status:` line, nothing else.
5. **Bookkeeping, in the same commit:**
   - the ADR index table in `PRE-PLAN.md` §1;
   - a line under "Plan-level decisions" in `PLAN.md`;
   - if it settles a spec Open question, replace the question in `docs/spec/<domain>.md` with a link to the ADR (never touch a Requirements section);
   - the ADR range in the `docs/decisions/` row of the root `CLAUDE.md` context map;
   - `grep -rn "<old fact>" docs/plan/` and update every brief that relied on the changed decision.
6. **Check.** `pnpm lint` does not cover `docs/`, so re-read the links by eye; commit with a message naming the ADR number.
