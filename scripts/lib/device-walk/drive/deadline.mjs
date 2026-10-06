// A promise with a deadline: the shutdown of a driven round must finish in about 10 s even when a call to a
// phone (an Appium command, a CDP evaluate) never answers, so each cleanup step is raced against a timer and
// the rest of the shutdown goes on.

/** Resolves or rejects as `p` does, or rejects after `ms` (the work itself is not cancelled). */
export function withDeadline(p, ms, label = 'step') {
  let t
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
      t.unref?.()
    }),
  ]).finally(() => clearTimeout(t))
}

/** `withDeadline` that never rejects: a step that failed or ran out of time is logged and skipped. */
export async function bestEffort(p, ms, label, log = () => {}) {
  try {
    return await withDeadline(p, ms, label)
  } catch (e) {
    log(`${label}: ${String(e.message).split('\n')[0]}`)
    return undefined
  }
}
