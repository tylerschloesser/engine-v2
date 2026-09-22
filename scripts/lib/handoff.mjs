// Pure logic behind `pnpm handoff` (scripts/handoff.mjs) and the always-on structural checks that
// run inside `pnpm test`'s `unit` suite (scripts/lib/handoff.test.mjs). Nothing here touches the
// file system or git; every function takes already-read text and returns data or strings. Contract:
// docs/plan/15g-handoff-checks.md. Split rationale (docs/plan/15g, Planning decisions): the four
// structural checks hold at *every* commit, so they run in `unit`; the suite-count check is only
// meaningful once a milestone's `done` commit has re-run `pnpm test`, so it lives in `pnpm handoff`
// alone.

/** One row of `PLAN.md`'s table: `{ id, ticked, brief }`. Non-data rows (header, separator, rows
 * with no brief filename) are skipped. */
export function parsePlanRows(planText) {
  const rows = []
  const re = /^\|\s*\[([ x])\]\s*\|\s*([0-9]{2}[a-z]?)\s*\|\s*`([^`]+\.md)`/gm
  for (const m of planText.matchAll(re)) {
    rows.push({ ticked: m[1] === 'x', id: m[2], brief: m[3] })
  }
  return rows
}

// The phrasings that mean "this milestone is upcoming or in flight right now", drawn from the
// actual PROMPT.md wordings that produced defect 2 (docs/plan/15g-handoff-checks.md, Why). This
// list is a heuristic, not a spec: PROMPT.md's status block is free prose and will coin new ways to
// say "next" that these four phrases do not cover. Extend it when one is found, rather than trying
// to make it exhaustive up front — a phrase list can only ever be a lower bound on defect 2's class.
// `M<NN> on the ledger`/similar historical narrative ("M15b landed...") deliberately does not match:
// only phrases that name a milestone as the *next thing to happen* are upcoming/current context.
const UPCOMING_PHRASES = ['next', 'in flight', 'is ready', 'on current order']
const UPCOMING_RE = new RegExp(
  `\\bM([0-9]{2}[a-z]?)\\s+(?:${UPCOMING_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'g',
)

/** Milestone ids `PROMPT.md` names in an upcoming/current-order context, each `{ id, phrase }`. */
export function findUpcomingRefs(promptText) {
  const found = []
  for (const m of promptText.matchAll(UPCOMING_RE)) found.push({ id: m[1], phrase: m[0] })
  return found
}

/**
 * Defect 2: a milestone `PROMPT.md` names as upcoming/current while `PLAN.md` already has it
 * ticked. Cross-checks `findUpcomingRefs` against `parsePlanRows`'s ticked ids; a ref to an id
 * `PLAN.md` does not have at all is not this check's problem (nothing to cross-check against).
 */
export function findStaleUpcomingRefs(rows, promptText) {
  const ticked = new Set(rows.filter((r) => r.ticked).map((r) => r.id))
  const seen = new Set()
  const stale = []
  for (const ref of findUpcomingRefs(promptText)) {
    if (!ticked.has(ref.id) || seen.has(ref.id)) continue
    seen.add(ref.id)
    stale.push(ref)
  }
  return stale
}

/** Defect 3: `(` and `)` counted over the whole file. A plain count, not a nesting check -- a
 * string-replace edit that drops or duplicates one close paren changes this count even when the
 * result still parses as "matched" some other way. */
export function countParens(text) {
  const open = (text.match(/\(/g) ?? []).length
  const close = (text.match(/\)/g) ?? []).length
  return { open, close }
}

export function parensAreBalanced(text) {
  const { open, close } = countParens(text)
  return open === close
}

/** `PLAN.md` rows whose brief `existingBriefs` (a `Set` of filenames under `docs/plan/`) does not
 * contain. */
export function findMissingBriefs(rows, existingBriefs) {
  return rows.filter((r) => !existingBriefs.has(r.brief))
}

/** A brief's `Status:` line starts with `done` (with or without a trailing parenthetical, e.g.
 * `Status: done (2026-09-19) ...`) -- never any other status text. */
export function isStatusDone(briefText) {
  return /^Status:\s*done\b/m.test(briefText)
}

/**
 * Rows whose ticked state in `PLAN.md` disagrees with their brief's `Status:` line. `doneByBrief`
 * maps a brief filename to `isStatusDone`'s result for it (or `undefined` if the brief could not be
 * read, e.g. `findMissingBriefs` already flagged it -- skipped here rather than double-reported).
 */
export function findStatusMismatches(rows, doneByBrief) {
  const mismatches = []
  for (const row of rows) {
    const done = doneByBrief.get(row.brief)
    if (done === undefined) continue
    if (row.ticked !== done) mismatches.push({ ...row, done })
  }
  return mismatches
}

// Defect 1's fix: State's "current ground" sentence carries a machine-readable marker instead of
// prose-only numbers, so `pnpm handoff` can compare it to a fresh `pnpm test` run without parsing
// prose. Shape (docs/plan/15g-handoff-checks.md Deviations has the exact rationale): one HTML
// comment, invisible in a rendered Markdown view, immediately after the "current ground" sentence:
//   <!-- handoff:ground rust=275 unit=157 wasm=43 browser=110 -->
const GROUND_MARKER_RE =
  /<!--\s*handoff:ground\s+rust=(\d+)\s+unit=(\d+)\s+wasm=(\d+)\s+browser=(\d+)\s*-->/

/** The ground marker's counts, or `null` if `PROMPT.md` carries none (or a malformed one). */
export function parseGroundMarker(promptText) {
  const m = GROUND_MARKER_RE.exec(promptText)
  if (!m) return null
  const [, rust, unit, wasm, browser] = m
  return { rust: Number(rust), unit: Number(unit), wasm: Number(wasm), browser: Number(browser) }
}

/** Renders the marker `PROMPT.md` should carry for a given ground -- so the command that updates
 * it and the check that reads it agree on the one string format. */
export function formatGroundMarker({ rust, unit, wasm, browser }) {
  return `<!-- handoff:ground rust=${rust} unit=${unit} wasm=${wasm} browser=${browser} -->`
}

/** Suite names whose marker count disagrees with the actual count just measured, each
 * `{ suite, marker, actual }`. */
export function compareGround(marker, actual) {
  const mismatches = []
  for (const suite of ['rust', 'unit', 'wasm', 'browser']) {
    if (marker[suite] !== actual[suite]) {
      mismatches.push({ suite, marker: marker[suite], actual: actual[suite] })
    }
  }
  return mismatches
}

/** nextest's plain-text summary line (`test-results/rust/output.log`, not JSON -- nextest's own
 * JUnit report lives under `target/nextest/`, outside `test-results/`): `Summary [...] N tests
 * run: ...`. */
export function parseRustSummary(logText) {
  const m = /Summary\s*\[[^\]]*\]\s*(\d+)\s*tests run/.exec(logText)
  return m ? Number(m[1]) : null
}

/** The `wasm` suite's Bun leg (`scripts/lib/adapters.mjs`'s `script` adapter): the last line of its
 * log is one JSON object with a `tests` array. */
export function parseBunLegCount(logText) {
  const lines = logText.trimEnd().split('\n')
  const last = lines.at(-1)
  if (last === undefined) return null
  try {
    const parsed = JSON.parse(last)
    return Array.isArray(parsed.tests) ? parsed.tests.length : null
  } catch {
    return null
  }
}
