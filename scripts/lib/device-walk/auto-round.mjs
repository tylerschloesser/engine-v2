// The service-held step machine of an auto round (M39f step 5; docs/plan/39f-device-auto-runner.md
// "Sleep, drops, resume, idempotency"): which check the phone is on, which attempt, what to do next. It
// is a pure function of the round log plus two hooks for `createPhoneApi`:
//
//   stepFor(events, now)        what the phone is told (`kind: 'walk'`; phases idle run judge redo wait done)
//   react(event, { api })       a phone event arrived: evaluate a collected attempt, open the next one
//
// Log events it writes (all replayed by rounds.mjs, ignored by older readers): `cursor {id}`,
// `attempt {id, n, variant, page, rung}` (open), `attempt {id, n, status: 'done', outcome, criteria,
// metrics, evidence}` (an attempt's own verdict, including each ladder rung), `result {id, result, by,
// attempt, criteria, metrics, evidence, notes}` (the check's verdict). From the phone it reads `walk
// {phase: 'start'}`, `series {id, n, path}` (the collected data of an attempt, evaluated here, never on
// the phone), `answer`, `redo` and `attempt {status: 'interrupted'}`.
//
// Ladders (`plan.ladder`, the *If it fails* rungs of device-checks.md) are further attempts. The check's
// own result is the default configuration's: a rung that passes where the default failed leaves the check
// `fail` with the passing configuration in its notes (the item stays unticked; the plan edit it asks for
// is the person's), and each attempt keeps its own criteria. An attempt interrupted by `hidden` is never
// a failure: it waits for the person's "Redo this check"; a reload retries by itself, twice.
import { readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { CHECKS, evaluate, walkable } from './checks.mjs'
import { parseUa } from './env.mjs'
import { readEvents } from './rounds.mjs'

export const WALK_ID = 'walk'
export const DEFAULTS = {
  timeoutMs: 120_000,
  actTimeoutMs: 300_000,
  memoryTimeoutMs: 6 * 60_000,
  maxReloads: 2,
  // The absences a lifecycle check asks for (M16-background, M23-hidden-pause): `leaveMs` replaces each
  // one's own target (tests and dev runs only); the others are the kill-resume play time and the
  // number of tries a check gives a person to stay away for the stated time.
  playMs: 120_000,
}

/** The check's page with a ladder rung (`&scaleCap=1.5`, or `?module=url`, which replaces the query). */
export function withRung(page, rung) {
  if (!rung) return page
  if (rung.startsWith('?')) return page.split('?')[0] + rung
  return page.includes('?') ? page + rung : `${page}?${rung.slice(1)}`
}

/** The page of an attempt; `params.probeS` shortens the memory probe's two sessions, `params.benchScale` divides the large save (tests only). */
export function pageFor(entry, rung, params = {}) {
  // `plan.query`: what a lifecycle check adds to the page `device-checks.md` names (`world=walk-busy`: its own
  // world; `autopan=1`), so `plan.page` stays what the serving derivation shows.
  const base = entry.plan.query
    ? `${entry.plan.page}${entry.plan.page.includes('?') ? '&' : '?'}${entry.plan.query}`
    : entry.plan.page
  let page = withRung(base, entry.plan.ladder?.[rung - 1])
  if (entry.plan.collector === 'memory' && params.probeS) page += `&probeS=${params.probeS}`
  // Tests only (M39t): the slice page's memory-reading interval, to delay the first `engine_mem_grows`.
  if (entry.plan.collector === 'slice' && params.memEveryMs)
    page += `&memEveryMs=${params.memEveryMs}`
  // Tests only: the bench page's `scale=n` divides the large save (64: a 1/64 world a headless engine plays).
  if (entry.plan.collector === 'bench' && params.benchScale) page += `&scale=${params.benchScale}`
  return page
}

/** The browser a Mac tab id belongs to: `macsafari-3` is `safari`. */
export const browserOf = (tab) => String(tab).slice(3).split('-')[0]

/** Legs of attempt `n` of `id` already reported by a Mac browser (`reading {key: 'leg:<k>'}`). */
export const legsDone = (events, id, n) =>
  Object.keys(readingsOf(events, id, n)).filter((k) => k.startsWith('leg:')).length

/** The browser that is to walk the next leg of a Mac row. */
export function browserFor(entry, events, id, n) {
  const b = entry.plan.browsers ?? []
  return b[Math.min(legsDone(events, id, n), b.length - 1)]
}

/** One check's state from the round log. */
export function foldItem(events, id) {
  const st = { attempts: new Map(), result: null, n: 0, since: 0 }
  for (const e of events) {
    if (e.id !== id) continue
    if (e.type === 'attempt') {
      let a = st.attempts.get(e.n)
      if (!a) {
        a = { n: e.n, status: 'open', rung: 0, redone: false }
        st.attempts.set(e.n, a)
        st.n = Math.max(st.n, e.n)
      }
      if (e.rung !== undefined) a.rung = e.rung
      if (e.page) a.page = e.page
      if (e.status === 'interrupted') Object.assign(a, { status: 'interrupted', reason: e.reason })
      else if (e.status === 'done')
        Object.assign(a, {
          status: e.outcome === 'judge' ? 'judge' : 'done',
          outcome: e.outcome,
          criteria: e.criteria,
          metrics: e.metrics,
          evidence: e.evidence,
        })
    } else if (e.type === 'defer') {
      // M39j: the device person left this judge sheet for the orchestrator (a screenshot is in the log): the
      // walk goes on with the next check and the row stays open until a `--judge` result.
      const a = st.attempts.get(e.n)
      if (a?.status === 'judge') a.deferred = true
    } else if (e.type === 'answer') {
      const a = st.attempts.get(e.n)
      if (a?.status === 'judge')
        Object.assign(a, { status: 'answered', answer: e.value, note: e.note })
    } else if (e.type === 'result') st.result = e
    else if (e.type === 'redo') {
      if (st.result) {
        // "Redo previous": the check starts again from its default configuration.
        st.result = null
        st.since = st.n
      } else {
        const last = st.attempts.get(st.n)
        if (last?.status === 'interrupted') last.redone = true
      }
    }
  }
  const since = [...st.attempts.values()].filter((a) => a.n > st.since)
  st.fails = since.filter((a) => a.outcome === 'fail' || a.answer === 'fail').length
  st.reloads = since.filter((a) => a.status === 'interrupted' && a.reason === 'reload').length
  st.first = since.find((a) => a.criteria)
  st.last = st.attempts.get(st.n)
  return st
}

/**
 * What the phone has told the service during attempt `n` of `id` with `reading {id, n, key, data}`: the
 * newest value per key. A check that spans documents or tabs keeps its state here, on the service: the
 * kill-resume `before`, the second tab's `second`, the export's `import`. It is part of the step, so a
 * page that was killed and reopened (a new document, a new tab) finds it again.
 */
export function readingsOf(events, id, n) {
  const state = {}
  for (const e of events)
    if (e.type === 'reading' && e.id === id && e.n === n && typeof e.key === 'string')
      state[e.key] = e.data
  return state
}

/**
 * The drop choreographer of M29 (`plan.mode: 'drops'`), a pure function of the round log. The phone sends one
 * `reading {key: 'run', data: {scenario, ms, ...}}` per run; the **service** decides whether the run counts: its
 * absence (`ms`, timed on the phone from its own visibility and online events) must be within +-30% of the
 * scenario's stated time (`opts.scenarioMs[key]` and `opts.runsEach` replace them in tests), or the run repeats. A discarded page
 * counts (its absence cannot be timed), a scenario with no stated time counts whenever the link dropped.
 * Returns what the page shows next and what has been accepted so far.
 */
export function mpProgress(events, id, n, plan, opts = {}) {
  const each = opts.runsEach ?? plan.runsEach
  const runs = events
    .filter((e) => e.type === 'reading' && e.id === id && e.n === n && e.key === 'run')
    .map((e) => e.data)
  const accepted = []
  let lastRejected = null
  const per = {}
  for (const d of runs) {
    const sc = plan.scenarios.find((x) => x.key === d.scenario)
    if (!sc) continue
    const target = opts.scenarioMs?.[sc.key] ?? sc.ms
    const within =
      d.discarded ||
      (target === null ? d.dropped === true : d.ms >= 0.7 * target && d.ms <= 1.3 * target)
    if (within && (per[sc.key] ?? 0) < each) {
      per[sc.key] = (per[sc.key] ?? 0) + 1
      accepted.push(d)
      lastRejected = null
    } else if (!within) lastRejected = { scenario: sc.key, ms: d.ms, target }
  }
  const sc = plan.scenarios.find((x) => (per[x.key] ?? 0) < each)
  const total = plan.scenarios.length * each
  const next = sc
    ? {
        scenario: sc.key,
        kind: sc.kind,
        run: (per[sc.key] ?? 0) + 1,
        of: each,
        targetMs: opts.scenarioMs?.[sc.key] ?? sc.ms,
        text: sc.text,
      }
    : null
  return { next, accepted, lastRejected, done: accepted.length, total }
}

/**
 * `plan.inherit: { m03: 'M03-determinism' }`: a check whose Pass text says "as that item" (M16-slice-boot
 * re-runs M03's criterion) reads that item's result from this round: `{ pass: true|false|null, from }`
 * (null: not walked in this round, or no verdict yet; a criterion that says `nullIs: 'judge'` then asks).
 */
export function inherited(entry, data, events) {
  const out = { ...data }
  for (const [key, id] of Object.entries(entry.plan.inherit ?? {})) {
    const r = events.findLast((e) => e.type === 'result' && e.id === id)
    out[key] = { pass: r ? r.result === 'pass' : null, from: id }
  }
  return out
}

/**
 * What the verdict needs to know about the phone (M39z, ADR 0056): `platform` from the newest phone `env`
 * event's user agent (a Mac tab's is not the phone's), `driven` from the round's driver mode (`inspector`
 * is set on a driven round only, M39v).
 */
export function verdictContext(events, inspector) {
  const env = events.findLast(
    (e) => e.type === 'env' && !String(e.src?.tab ?? '').startsWith('mac'),
  )
  const device = parseUa(env?.ua).device
  const platform = /^(iPhone|iPad|iPod)$/.test(device)
    ? 'ios'
    : device === 'Android'
      ? 'android'
      : undefined
  return { platform, driven: !!inspector }
}

export const rel = (path, base) => (base && isAbsolute(path) ? relative(base, path) : path)

/**
 * @param {{ file: string, items: object[], origins: Record<string, string>, params?: object,
 *   evidenceBase?: string, onAttempt?: (a: { id: string, n: number, plan: object }) => void }} o
 *   `items`: parsed device-checks.md items to walk (Android rows are not walked; ids without a `checks.mjs`
 *   entry or retired are left out). `onAttempt`: an attempt was opened for the phone (the Mac bot partner of
 *   M34 starts here, `bot.mjs`).
 */
export function createAutoRound({
  file,
  items,
  origins,
  macOrigins = {},
  params = {},
  inspector,
  evidenceBase,
  onAttempt,
  onLeg,
}) {
  const clientOf = (entry) => entry.plan.device ?? 'phone'
  const walked = items.filter((i) => !i.android && walkable(i.id))
  // `client: 'both'` (the CLI): the phone walks its rows first, then the Mac's own browsers walk theirs.
  const list =
    params.client === 'both'
      ? [
          ...walked.filter((i) => clientOf(CHECKS[i.id]) !== 'mac'),
          ...walked.filter((i) => clientOf(CHECKS[i.id]) === 'mac'),
        ]
      : walked
  const byId = new Map(list.map((i) => [i.id, i]))
  const opts = { ...DEFAULTS, ...params }
  let desktop // undefined: not run yet; null: failed; number: ms
  let api = null

  const optsFor = (entry) => ({
    ...opts,
    ...(entry.plan.windowMs ? { windowMs: entry.plan.windowMs } : {}),
    ...(entry.plan.warmupMs !== undefined ? { warmupMs: entry.plan.warmupMs } : {}),
    ...(params.windowMs ? { windowMs: params.windowMs } : {}),
    ...(params.warmupMs !== undefined ? { warmupMs: params.warmupMs } : {}),
  })

  /** A judge sheet the device person deferred: not the current check, not a result either. */
  const parked = (s) => !s.result && s.last?.status === 'judge' && s.last.deferred === true
  const states = (events) => new Map(list.map((it) => [it.id, foldItem(events, it.id)]))
  const needsDesktop = (entry) => entry.plan.needs === 'desktopMedianMs' && desktop === undefined
  // `plan.assist`: a `human` row the service still collects what the page can say (M17b: the harness's probe
  // lines and errors) and asks the person only for what a browser's own tool shows.
  const automated = (entry) =>
    entry.plan.built && (entry.class !== 'human' || entry.plan.assist === true)
  // `plan.device: 'mac'` rows are walked in a Mac browser tab (`params.client: 'mac'`, delegation 5 opens one);
  // a phone is never made to walk one (it would record the phone's browser as the Mac's).
  const onThisClient = (entry) =>
    clientOf(entry) !== 'mac' || opts.client === 'mac' || opts.client === 'both'

  function resultEvent(it, a, verdict, by, extra = {}) {
    return {
      type: 'result',
      id: it.id,
      result: verdict,
      by,
      attempt: a.n,
      criteria: a.criteria,
      metrics: a.metrics,
      ...(a.evidence ? { evidence: rel(a.evidence, evidenceBase) } : {}),
      ...extra,
    }
  }

  /** Result events for attempt `a` ending with `verdict` (pass|fail|skip), or [] when a rung is next. */
  function conclude(it, st, a, verdict, by, note) {
    const ladder = CHECKS[it.id].plan.ladder ?? []
    if (verdict === 'skip') return [resultEvent(it, a, 'skip', by, note ? { notes: note } : {})]
    const base = st.first ?? a
    if (verdict === 'pass') {
      if (a.rung === 0) return [resultEvent(it, a, 'pass', by, note ? { notes: note } : {})]
      return [
        resultEvent(it, { ...base, evidence: a.evidence, n: a.n }, 'fail', by, {
          notes: `fails in its default configuration; passes with ${ladder[a.rung - 1]}`,
          metrics: { ...base.metrics, ladder_pass: ladder[a.rung - 1] },
        }),
      ]
    }
    if (a.rung < ladder.length) return []
    const tried = ladder.length
      ? `no configuration passed (tried the default, ${ladder.join(', ')})`
      : ''
    return [
      resultEvent(it, ladder.length ? { ...base, evidence: a.evidence, n: a.n } : a, 'fail', by, {
        ...(tried || note ? { notes: [tried, note].filter(Boolean).join('; ') } : {}),
      }),
    ]
  }

  /** What to append next, from the log alone. Repeat until it returns []. */
  function advance(events) {
    if (!events.some((e) => e.type === 'walk' && e.phase === 'start')) return []
    const st = states(events)
    for (const it of list) {
      const s = st.get(it.id)
      if (s.result) continue
      const last = s.last
      if (!last || last.n <= s.since) continue
      if (last.status === 'open' || (last.status === 'judge' && !last.deferred)) return []
      if (last.status === 'interrupted' && last.reason !== 'reload' && !last.redone) return []
      if (last.status === 'interrupted' && last.reason === 'reload' && s.reloads > opts.maxReloads)
        return [
          resultEvent(it, last, 'fail', 'auto', {
            criteria: [{ name: 'reloads', value: s.reloads, limit: opts.maxReloads, ok: false }],
            metrics: {},
            notes: `the page reloaded ${s.reloads} times during the attempt`,
          }),
        ]
    }
    const it = list.find((i) => !st.get(i.id).result && !parked(st.get(i.id)))
    if (!it) return []
    const entry = CHECKS[it.id]
    const s = st.get(it.id)
    if (!automated(entry))
      return [
        {
          type: 'result',
          id: it.id,
          result: 'skip',
          by: 'auto',
          notes: `not automated yet (${entry.plan.built ? entry.class : `M39f delegation ${entry.plan.delegation}`}): walk it by hand with --manual`,
        },
      ]
    if (!onThisClient(entry))
      return [
        {
          type: 'result',
          id: it.id,
          result: 'skip',
          by: 'auto',
          notes:
            'a Mac browser row: it is walked in a Mac tab, which a phone round does not open (M39f delegation 5); walk it by hand with --manual',
        },
      ]
    if (needsDesktop(entry)) return []
    const n = s.n + 1
    const rung = s.fails
    const shared = entry.plan.reuse && reused(entry, events)
    if (shared) {
      // The same runs as another check of this round (M29-play-through-drop reads M29-socket-resume's
      // 18 drops: the person is not asked to do them twice).
      const { verdict, criteria, metrics, notes } = evaluate(
        entry,
        shared.data,
        verdictContext(events, inspector),
      )
      const open = {
        type: 'attempt',
        id: it.id,
        n,
        variant: entry.plan.variant,
        page: pageFor(entry, 0, params),
        rung: 0,
      }
      const done = {
        type: 'attempt',
        id: it.id,
        n,
        status: 'done',
        outcome: verdict,
        criteria,
        metrics,
        ...(notes ? { notes } : {}),
        evidence: shared.evidence,
      }
      const st = foldItem([...events, open, done], it.id)
      const note = `the same runs as ${entry.plan.reuse}`
      return [
        { type: 'cursor', id: it.id },
        open,
        done,
        ...(verdict === 'judge' ? [] : conclude(it, st, st.attempts.get(n), verdict, 'auto', note)),
      ]
    }
    return [
      { type: 'cursor', id: it.id },
      {
        type: 'attempt',
        id: it.id,
        n,
        variant: entry.plan.variant,
        page: pageFor(entry, rung, params),
        rung,
      },
    ]
  }

  function settle() {
    for (let i = 0; i < 200 && api; i++) {
      const next = advance(readEvents(file))
      if (!next.length) return
      for (const e of next) {
        api.append(e)
        if (e.type === 'attempt' && e.status === undefined && onAttempt)
          onAttempt({ id: e.id, n: e.n, plan: CHECKS[e.id].plan })
      }
    }
  }

  /** The collected data of the finished attempt of the check `entry.plan.reuse`, when it produced some. */
  function reused(entry, events) {
    const st = foldItem(events, entry.plan.reuse)
    const a = [...st.attempts.values()].findLast((x) => x.evidence && x.status !== 'interrupted')
    if (!a) return null
    const data = readData(a.evidence)
    return data && !data.unreadable && !data.reloaded ? { data, evidence: a.evidence } : null
  }

  function readData(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }

  /** A window of the collected data says the rAF cadence was Low Power shaped (p50 over 25 ms): a note, no verdict. */
  function throttled(data) {
    const seen = (v, d) =>
      !!v &&
      typeof v === 'object' &&
      (v.cadence_throttled === true || (d < 4 && Object.values(v).some((x) => seen(x, d + 1))))
    return seen(data, 0)
  }

  function onSeries(e) {
    const it = byId.get(e.id)
    const events = readEvents(file)
    const st = foldItem(events, e.id)
    const a = st.attempts.get(e.n)
    if (!it || !a) return
    // The check already has its result (the driver ended it as NotDrivable while the page was still on its way to
    // a series): a late series is not a second verdict (it turned a skip into a fail on the iPhone).
    if (st.result) return
    const data = readData(e.path) ?? { unreadable: true }
    // A reload shows as `hidden`/`pagehide` first (the old document's own events interrupt the attempt);
    // the new document then reports `reloaded`, and for a probe that must not reload that is the result.
    const reloaded = data.reloaded === true && a.status === 'interrupted'
    if (a.status !== 'open' && !reloaded) return // stale: interrupted by a hide, or already judged
    const entry = CHECKS[it.id]
    const { verdict, criteria, metrics, notes } = evaluate(entry, inherited(entry, data, events), {
      desktopMedianMs: desktop,
      ...verdictContext(events, inspector),
    })
    const done = {
      type: 'attempt',
      id: it.id,
      n: e.n,
      status: 'done',
      outcome: verdict,
      criteria,
      metrics,
      ...(notes ? { notes } : {}),
      evidence: e.path,
      ...(inspector ? { inspector } : {}),
      ...(throttled(data) ? { cadence_throttled: true } : {}),
    }
    api.append(done)
    if (verdict === 'judge') return
    const after = foldItem(readEvents(file), it.id)
    // A browser that cannot run the check at all (Firefox without `navigator.gpu`) is recorded, not failed:
    // a clean run elsewhere (or no run anywhere: `noRun`) makes the row `skip` with that evidence; a failure
    // elsewhere stays a failure.
    const unsupported = [data.unsupported].flat().filter(Boolean)
    const final =
      unsupported.length && (verdict === 'pass' || data.noRun === true) ? 'skip' : verdict
    const note = unsupported.length ? unsupported.join('; ') : undefined
    for (const r of conclude(it, after, after.attempts.get(e.n), final, 'auto', note)) api.append(r)
  }

  function onAnswer(e) {
    const it = byId.get(e.id)
    if (!it) return
    const st = foldItem(readEvents(file), e.id)
    const a = st.attempts.get(e.n)
    if (!a || a.status !== 'answered') return
    const answered = ['pass', 'fail', 'skip'].includes(e.value) ? e.value : 'skip'
    let verdict = answered
    // A browser that could not run the check (`unsupported`, see `onSeries`): the person's pass on what did
    // run is recorded as `skip`, with that evidence.
    const data = a.evidence ? readData(a.evidence) : null
    const unsupported = [data?.unsupported].flat().filter(Boolean)
    const note = [e.note, ...unsupported].filter(Boolean).join('; ') || undefined
    if (verdict === 'pass' && unsupported.length) verdict = 'skip'
    const settled = {
      ...a,
      criteria: (a.criteria ?? []).map((c) =>
        c.ok === null ? { ...c, ok: answered === 'pass', by: 'human' } : c,
      ),
    }
    st.attempts.set(e.n, settled)
    for (const r of conclude(it, st, settled, verdict, 'mixed', note)) api.append(r)
  }

  const hooks = {
    stepFor(events, now, tab) {
      // Which kind of client is asking (`client: 'both'`): a Mac browser's tab id starts with `mac`.
      const tabClient =
        opts.client === 'both' ? (String(tab).startsWith('mac') ? 'mac' : 'phone') : null
      const base = {
        kind: 'walk',
        id: WALK_ID,
        now,
        origins,
        total: list.length,
        params: { probeMs: opts.probeMs },
      }
      if (!events.some((e) => e.type === 'walk' && e.phase === 'start'))
        return { ...base, phase: 'idle' }
      const st = states(events)
      const left = list.filter((i) => !st.get(i.id).result)
      const progress = { done: list.length - left.length, total: list.length }
      if (!left.length) return { ...base, phase: 'done', progress }
      for (const it of left) {
        const s = st.get(it.id)
        const a = s.last
        if (!a || a.n <= s.since) continue
        if (parked(s)) continue
        const entry = CHECKS[it.id]
        if (tabClient && clientOf(entry) !== tabClient)
          return { ...base, phase: 'wait', waitFor: clientOf(entry), progress }
        // A Mac row names its browser(s) (`plan.browsers`); only a tab of that browser (its id is
        // `mac<browser>-...`) is handed the row, one leg at a time.
        if (tabClient === 'mac' && entry.plan.browsers) {
          const want = browserFor(entry, events, it.id, a.n)
          if (browserOf(tab) !== want)
            return { ...base, phase: 'wait', waitFor: `mac ${want}`, progress }
        }
        const item = {
          id: it.id,
          n: a.n,
          rung: a.rung,
          variant: entry.plan.variant,
          origin:
            (tabClient === 'mac' ? macOrigins[entry.plan.variant] : null) ??
            origins[entry.plan.variant] ??
            null,
          page: a.page ?? pageFor(entry, a.rung, params),
          // The whole plan (JSON-safe by construction): collectors read `mode`, `leaves`, `scenarios`...
          plan: { ...entry.plan, ladder: undefined },
          opts: optsFor(entry),
          acts: entry.acts,
          state: {
            ...readingsOf(events, it.id, a.n),
            ...(entry.plan.mode === 'drops'
              ? { mp: mpProgress(events, it.id, a.n, entry.plan, optsFor(entry)) }
              : {}),
          },
        }
        if (a.status === 'open') return { ...base, phase: 'run', item, progress }
        if (a.status === 'judge') {
          const hint = (a.criteria ?? [])
            .filter((c) => c.ok === null)
            .map((c) => `${c.name} ${c.value}${c.limit === null ? '' : ` (limit ${c.limit})`}`)
            .join(', ')
          // M39k: no timestamp-query reading: the latency is shown, labelled, so the judge is not blind.
          const noExec = (a.criteria ?? []).some(
            (c) => c.ok === null && c.name === 'gpu_exec_p95_ms',
          )
          const lat = a.metrics?.gpu_latency_p95_ms
          const latNote = noExec
            ? `; timestamp-query unavailable, gpu_latency_p95_ms ${lat ?? 'n/a'} (informational: submit-to-done, includes the vsync wait)`
            : ''
          return {
            ...base,
            phase: 'judge',
            item,
            judge: {
              id: it.id,
              n: a.n,
              text: `${entry.judges.join('; ') || 'Judge this check'}. Measured: ${hint}${latNote}.`,
            },
            progress,
          }
        }
        if (a.status === 'interrupted' && a.reason !== 'reload' && !a.redone)
          return { ...base, phase: 'redo', item, progress }
      }
      return { ...base, phase: 'wait', progress }
    },
    react(event) {
      if (!api) return []
      if (event.type === 'series') onSeries(event)
      else if (event.type === 'answer') onAnswer(event)
      else if (event.type === 'reading' && event.key === 'leg-done') {
        // A Mac browser finished its leg of a check that runs in more than one (M39-desktop-browsers):
        // the service opens the next one.
        if (event.data && Number.isInteger(event.data.k))
          onLeg?.({ id: event.id, n: event.n, k: event.data.k + 1, plan: CHECKS[event.id]?.plan })
        return []
      } else if (event.type !== 'walk' && event.type !== 'redo' && event.type !== 'attempt')
        return []
      settle()
      return []
    },
  }

  return {
    ...hooks,
    hooks,
    list,
    attach(phoneApi) {
      api = phoneApi
    },
    settle,
    advance,
    /** The Mac-side desktop median arrived (a number) or failed (null): M08-warn-threshold can open. */
    setDesktopMedian(v) {
      desktop = v
      settle()
    },
    /** Which serving variants the walked checks need. */
    variants: () => [
      ...new Set(
        list
          .map((i) => CHECKS[i.id])
          .filter((e) => automated(e) && onThisClient(e))
          .map((e) => e.plan.variant),
      ),
    ],
    /** Every walked check is a Mac browser's (no phone is needed: the first Mac tab opens by itself). */
    macOnly: () =>
      opts.client === 'both' &&
      list.filter((i) => automated(CHECKS[i.id])).length > 0 &&
      list.filter((i) => automated(CHECKS[i.id])).every((i) => clientOf(CHECKS[i.id]) === 'mac'),
    needsDesktopMedian: () => list.some((i) => CHECKS[i.id].plan.needs === 'desktopMedianMs'),
    done: (events = readEvents(file)) => {
      const st = states(events)
      return list.length > 0 && list.every((i) => st.get(i.id).result)
    },
    /**
     * M39w: the walk is over: every check has a result or is a judge sheet the device person deferred (only
     * `--judge` can close it). A driven round ends here; `done()` is the stricter word.
     */
    walkOver: (events = readEvents(file)) => {
      const st = states(events)
      return list.length > 0 && list.every((i) => st.get(i.id).result || parked(st.get(i.id)))
    },
  }
}
