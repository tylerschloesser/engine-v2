# Context Architecture Research Findings

**Research Date**: 2026-09-19  
**Researcher**: Claude Haiku 4.5  
**Sources**: Official Claude Code documentation (verified against code.claude.com v2.1.248+)

## 1. CLAUDE.md Loading Behavior and Sub-agent Inheritance

### Findings

**Loading Behavior:**
- **Root `CLAUDE.md`**: Loaded eagerly at every session launch. Applies universally.
- **Nested `CLAUDE.md` files** (e.g., `packages/api/CLAUDE.md`): Loaded on-demand when Claude reads files in that directory subtree. A session started from `packages/api/` loads both the root and `packages/api/CLAUDE.md` at launch; nested files in other directories load when first accessed.
- **`CLAUDE.local.md`**: Loaded at session start alongside root CLAUDE.md. Not inherited by sub-agents unless explicitly added to the hierarchy.
- **`@path` imports**: The documentation (memory.md) does not mention explicit `@path` include syntax in CLAUDE.md files. Path-based loading is automatic based on directory traversal, not manual imports. This suggests no depth limits or special cost.

**Sub-agent Inheritance:**
Sub-agents inherit the complete CLAUDE.md hierarchy:
- User-level `~/.claude/CLAUDE.md`
- Project-level CLAUDE.md files (root + nested, as if the sub-agent started from that directory)
- Local `CLAUDE.local.md`
- Managed policy files (organization-wide, cannot be opted out)

**Exception**: Built-in **Explore** and **Plan** agents skip CLAUDE.md files entirely for performance. Custom sub-agents can opt out with `omitClaudeMd: true` frontmatter.

**What Sub-agents DON'T inherit**:
- Conversation history
- Main session's auto memory
- Output style preferences
- Context window size (determined by sub-agent model)

**Skills in Sub-agents:**
Skills can be preloaded into a sub-agent's startup context via the `skills` frontmatter field. This avoids discovery overhead and injects domain knowledge immediately.

**Source**: https://code.claude.com/docs/en/sub-agents.md (accessed 2026-09-19)

---

## 2. Path-Scoped Rules vs. Nested CLAUDE.md

### Comparison

| Dimension | Per-directory CLAUDE.md | Path-scoped `.claude/rules/*.md` |
|---|---|---|
| **File location** | Inside the directory, alongside code | Central `.claude/rules/` at repo root |
| **When it loads** | At launch (if started there), or on-demand (if Claude reads there) | When Claude works with files matching the rule's `paths:` glob |
| **Ownership** | Directory owners maintain their own file | All conventions in one place; centralized maintenance |
| **Versioning** | Checked in alongside code; tracks with changes | Separate from code; must be manually kept current |
| **Best for** | Directory-specific conventions; stack choices differ per area | Cross-cutting invariants (e.g., "no allocation in hot paths") that span many directories |

### Recommendation

**Use per-directory CLAUDE.md when:**
- Each directory or package has its own owner who maintains conventions
- Conventions are tightly coupled to that area's code and should version together
- You want clear ownership and avoid central bottlenecks

**Use path-scoped rules when:**
- The same invariant applies across many scattered directories (renderer, sim, utils, etc.)
- You want all project rules in one discoverable place
- Teams prefer centralized governance over distributed ownership

For the engine-v2 project with Rust and TypeScript split across `crates/` and `packages/`, **recommend hybrid**: root `CLAUDE.md` for global rules (commit message conventions, test budget), per-directory CLAUDE.md for package/crate-specific tech stacks (Cargo/npm commands, testing patterns), and path-scoped rules for cross-cutting invariants like "no allocation in hot paths" scoped to `crates/renderer/**` and `crates/sim/**`.

**Source**: https://code.claude.com/docs/en/large-codebases.md, https://code.claude.com/docs/en/memory.md (accessed 2026-09-19)

---

## 3. Project Skills and Sub-agent Definitions

### Project Skills Format and Capabilities

**File structure:**
```
.claude/skills/<skill-name>/
├── SKILL.md (required)
├── supporting-file.md (optional)
└── scripts/
    └── helper.sh (optional)
```

**SKILL.md frontmatter** (YAML, optional):
- `name`: Unique identifier (lowercase, hyphens)
- `description`: When Claude should use this skill (keywords matter for triggering)
- `disable-model-invocation`: `true` to prevent Claude from auto-invoking (e.g., for manual-only skills)
- `allowed-tools`: Specify tools the skill can use; ${CLAUDE_SKILL_DIR} substitution supported for bundled scripts

**Markdown body**: Plain instructions Claude follows.

**Loading:**
- Automatically load in sessions started in the repository
- Load in subdirectories when Claude works on files in nested `.claude/skills/` directories
- Load from parent directories up to repo root (monorepo-aware)
- Persist in context once invoked; available for the rest of the session

**Script bundling:** 
Yes. Skills can include executable scripts and reference them with `${CLAUDE_SKILL_DIR}/scripts/name.sh` regardless of working directory. Pre-approve execution with `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/*)`.

**Recommended skills for engine-v2:**
1. **run-test-suites** (or integrate into `/run`): instructions for running pnpm, cargo test, playwright tests, with exit criteria
2. **run-gc-test**: specific test harness for GC regression detection
3. **add-action-type**: procedure for adding a new action to the game (which files, which patterns)
4. **profile-frame**: instructions for using profiler (wasm-pack profile mode, sampler setup)
5. **run-spike**: template for ephemeral exploration (branch naming, cleanup, hypothesis)
6. **write-adr**: template for ADR frontmatter and structure

**Source**: https://code.claude.com/docs/en/skills.md (accessed 2026-09-19)

### Custom Sub-agent Definitions

**Format:** `.claude/agents/<name>.md` with frontmatter:

```yaml
---
name: unique-id
description: When Claude should delegate to this agent
model: sonnet (or inherit, opus, haiku, fable, full model ID)
tools: Read, Bash, Grep (optional; inherits all if omitted)
disallowedTools: [tool names to deny]
permissionMode: auto|default|acceptEdits|dontAsk|bypassPermissions|plan|manual
skills: [preloaded skill names]
mcpServers: [MCP server names]
hooks: [scoped lifecycle hooks]
memory: user|project|local (persistent memory scope)
background: true (keep in background)
omitClaudeMd: true (skip CLAUDE.md files)
effort: low|medium|high|xhigh|max
isolation: worktree (run in temporary git worktree)
color: red|blue|green|yellow|purple|orange|pink|cyan
---
```

**Worth defining for engine-v2?**
- **determinism-reviewer**: a low-effort agent scoped to `crates/sim/` with Bash, Read, Grep to verify determinism post-changes. Moderate value; alternative is a test.
- **gc-regression-checker**: scoped to `crates/runtime/` with the `run-gc-test` skill pre-loaded. Medium value; detects regressions early but adds context overhead.
- **architecture-verifier**: reads recent ADRs + architecture docs, verifies code aligns with decisions. Low confidence this adds value over manual review.

**Recommendation:** Start without custom agents. Define them if a Phase 3 milestone explicitly calls for it (e.g., "verify GC budget before commit"). They are useful but add context cost. Skills are a lighter-weight alternative.

**Source**: https://code.claude.com/docs/en/sub-agents.md (accessed 2026-09-19)

---

## 4. Hooks for Mechanical Enforcement

### Event Names and Configuration

**In `.claude/settings.json` or `.claude/settings.local.json`:**

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "pattern",
        "hooks": [
          {
            "type": "command",
            "command": "shell command",
            "if": "optional tool rule",
            "timeout": "seconds"
          }
        ]
      }
    ]
  }
}
```

**Key events for enforcing project rules:**

| Event | When it fires | Enforcement use |
|---|---|---|
| `PreToolUse` | Before any tool executes | Block dangerous commands (e.g., `rm -rf`, unvetted SQL) |
| `PostToolUse` | After tool succeeds | Auto-format files (Prettier), run linters |
| `Stop` | When Claude finishes responding | Verify tests pass, check no uncommitted changes |
| `SessionStart` | At session launch or resume | Re-inject critical context (e.g., current sprint), load env vars |
| `UserPromptSubmit` | Before Claude sees user input | Log prompts, inject branch state |
| `PreCompact` / `PostCompact` | Around context compaction | Track compaction rate, reinject context after summary |
| `CwdChanged` | When working directory changes | Reload environment (direnv, .envrc) |
| `FileChanged` | When watched files change on disk | Invalidate caches, reload config |

**Complete event list**: https://code.claude.com/docs/en/hooks-guide.md (line 483)

### Should Hooks Enforce Things Mechanically?

**YES, with tradeoffs:**

**For:**
- Deterministic compliance (rules apply regardless of LLM judgment)
- Audit trail (every hook run is recorded)
- No false negatives (if the rule applies, it always fires)

**Against:**
- **Latency**: Hooks have timeouts (default 10 min for command/http, 30s for UserPromptSubmit, 10s for MessageDisplay). Long-running checks block the session.
- **False blocks**: A `Stop` hook that checks test pass can block too many times; Claude Code overrides after 8 consecutive blocks without progress.
- **Fragility**: A hook that fails non-blocking still shows an error notice. Overly strict hooks can be frustrating.

### Recommended Hooks for engine-v2

**Bootstrap phase (Phases 1–3):**

1. **`PostToolUse` → `Bash`**: Auto-format Rust/TS on edits
   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Bash",
           "if": "Bash(cargo fmt *|pnpm prettier *)",
           "hooks": [
             {
               "type": "command",
               "command": "echo 'Auto-format hooks can run here but are optional during bootstrap'"
             }
           ]
         }
       ]
     }
   }
   ```

2. **`SessionStart` → `compact` matcher**: Re-inject architecture after compaction
   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "compact",
           "hooks": [
             {
               "type": "command",
               "command": "echo 'Current phase milestone: $(grep \"^##\" /Users/tyler/repos/engine-v2/PROMPT.md | head -1)'"
             }
           ]
         }
       ]
     }
   }
   ```

3. **`PreToolUse` → `Bash`**: Block dangerous patterns (optional, low latency)
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "if": "Bash(rm -rf *|git reset --hard *)",
           "hooks": [
             {
               "type": "command",
               "command": "exit 2  # Deny dangerous destructive commands"
             }
           ]
         }
       ]
     }
   }
   ```

**Post-bootstrap (Phase 4+):**

4. **`Stop` hook** (low confidence): Verify test suite passes before allowing stop (only if test suite is fast < 10s)
   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "prompt",
               "prompt": "Check if all unit tests pass. If not, respond with {\"ok\": false, \"reason\": \"tests failing\"}."
             }
           ]
         }
       ]
     }
   }
   ```

**Source**: https://code.claude.com/docs/en/hooks-guide.md (accessed 2026-09-19)

---

## 5. Multi-session Progress Tracking (Phase 3)

### Mechanisms Compared

| Mechanism | Scope | Restored on Resume | Ideal For |
|---|---|---|---|
| **`PROMPT.md` status block** | Session-scoped, human-readable | Manual (user edits) | Session context, current milestone, clear handoff |
| **`PLAN.md` details** | Persistent, checked in | Yes (in git) | Milestone breakdown, commands to verify, what's done |
| **Session resume** (`--resume`) | Conversation + task state | Yes, most state | Picking up work in-progress; asks for permission first |
| **Auto memory** | User preferences + learnings | Yes, across sessions | Claude's corrections, model preferences (NOT task progress) |
| **`/loop`** (fixed interval) | Session-scoped cron task | Yes if created with `CronCreate`, expires in 7 days | Polling deployment, babysitting PR, periodic checks |
| **Routines** (cloud-hosted) | Independent of session | Yes, durable | Running unattended, no machine required |
| **`/goal`** | Active goal in a session | Yes, turn count resets | Keeping Claude oriented turn-after-turn toward a condition |

### Recommended for Phase 3

**Status tracking:**
1. **Status block at top of `PROMPT.md`** (human-editable):
   ```markdown
   ## Status
   
   **Phase**: 3 (Execute)  
   **Session**: Tyler's Apex Desktop, session #abc123  
   **Milestone**: M3 – Client event loop and latency budget  
   **Next step**: Run initial latency profile, create budget spreadsheet  
   **Blockers**: None  
   
   Last updated: 2026-09-19 14:30
   ```

2. **Execution details in `PLAN.md`** (or per-milestone split):
   ```markdown
   ## M3 – Client event loop and latency budget
   
   **Scope**: Render loop, input sampling, tick timing  
   **Files touched**: `packages/client/src/{render,input,tick}/*.ts`  
   **Exit criteria**:
   - [ ] Profiler shows < 16ms per frame at 2k draws
   - [ ] Input latency < 8ms (sampled at 120 Hz)
   - [ ] Test suite passes
   
   **Verify with**: `pnpm test -i client.latency` + `profiler sample run`
   
   **Status**: In progress  
   **Session notes**: ...
   ```

3. **Session resume workflow**:
   - At end of each session: manually update status block in `PROMPT.md` with exact next step
   - To continue: `claude --resume <session-name>` picks up conversation, restores tasks/goals
   - Sub-milestones as sub-agents (optional): brief them with `docs/spec/overview.md` + relevant milestone from `PLAN.md`

4. **Complementary: `/goal`** (new to v2.1.248+):
   - Run at start of session: `/goal finish M3 client latency and pass tests`
   - Keeps Claude working turn-by-turn toward condition; not a hard stop (Claude still decides when done)
   - Resets turn count on resume; active goal carries over

5. **Permissions for Phase 3 workflow** (reduce prompts):
   ```json
   {
     "permissions": {
       "allow": [
         "Bash(pnpm *)",
         "Bash(cargo *)",
         "Bash(git commit -m *)",
         "Edit(./**/*.rs)",
         "Edit(./**/*.ts)"
       ]
     }
   }
   ```
   Add to `.claude/settings.json` (project-scoped, checked in so all Phase 3 sessions inherit).

### Alternative: Scheduled Reminder Loop

If tracking across many unrelated milestones, consider `/loop` to re-run a "what's next?" prompt at session start:

```
/loop 1d read PLAN.md and tell me what the current milestone is, then ask if I want to start
```

This is lower-confidence; manual `--resume` + manual status editing is clearer and more explicit.

**Source**: https://code.claude.com/docs/en/sessions.md, https://code.claude.com/docs/en/scheduled-tasks.md, https://code.claude.com/docs/en/goal.md (accessed 2026-09-19)

---

## Proposed Final Bootstrap Layout

Revise `docs/context-architecture.md` after Phase 1:

```
Root CLAUDE.md              map, global rules, Phase 3 commands
PROMPT.md                   current phase + status block
PRE-PLAN.md                 Phase 1 final decisions + tech choices
PLAN.md                     Phase 2+ milestones, one per session
docs/
  process.md                phases, shared session rules
  context-architecture.md   this file, now with findings integrated
  spec/
    *.md                    (unchanged)
  research/
    *.md                    Phase 1 findings (deleted in Phase 4)
  decisions/
    NNNN-*.md               ADRs
.claude/
  settings.json             permissions allow-list, hooks for Phase 3
  skills/
    run-test-suites/
      SKILL.md              how to run pnpm + cargo + playwright
    run-gc-test/
      SKILL.md              GC regression harness
    add-action-type/
      SKILL.md              procedure for extending game actions
    write-adr/
      SKILL.md              ADR template + structure
  rules/
    (optional) hot-paths.md scoped to crates/{renderer,sim}/**
    (optional) determinism.md scoped to crates/sim/**
  agents/
    (skip for now; define if Phase 3 calls for it)
```

---

## Key Changes from Current docs/context-architecture.md

1. **Nested CLAUDE.md is on-demand, not eager**: Clarify that they load when Claude reads files there, not at session start for the whole tree.

2. **Path-scoped rules recommended for cross-cutting invariants**: Add concrete recommendation (hot-paths, determinism) scoped to specific directory globs.

3. **Skills are the preferred way to encode procedures**: Update principle #7 to note that repeatable how-tos should become skills in `.claude/skills/`, not paragraphs.

4. **Sub-agents are optional**: Clarify that custom agents add context overhead; prefer skills for lightweight procedures, reserve agents for specialized roles (GC-regression-checker, etc.).

5. **Hooks can enforce mechanically**: Add section on when/how to use PreToolUse, PostToolUse, Stop hooks, with tradeoff warnings.

6. **Phase 3 tracking: status block + PLAN.md + session resume**: Concrete recommendation for multi-session work without bloating PROMPT.md.

7. **Permission allow-list in `.claude/settings.json`**: Reduce prompts in Phase 3 by pre-approving pnpm, cargo, safe git/edit patterns.

---

## Confidence Levels

| Finding | Confidence | Rationale |
|---|---|---|
| CLAUDE.md on-demand loading | **High** | Explicitly documented in large-codebases.md |
| Path-scoped rules for cross-cutting invariants | **High** | Documented comparison table in large-codebases.md |
| Skills format and bundling | **High** | skills.md section "Can they bundle scripts?" is clear |
| Hooks event names and PreToolUse blocking | **High** | Comprehensive hooks-guide.md with working examples |
| Session resume restores state, _loop expires in 7 days | **High** | sessions.md and scheduled-tasks.md are explicit |
| Sub-agent inheritance of CLAUDE.md hierarchy | **High** | sub-agents.md "What Subagents Inherit" section is definitive |
| `/goal` orientation (new in v2.1.248+) | **Medium** | Documented but optional; interaction with session resume needs testing |
| Multi-session Phase 3 tracking best practice | **Medium** | Derived from mechanisms above; not a single "official" pattern documented |

