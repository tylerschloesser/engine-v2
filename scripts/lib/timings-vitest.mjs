/**
 * Vitest 5's default reporter footer, `Duration  727ms (transform 71%, import 24%, worker 5%)` (older
 * versions printed absolute times: `transform 1.2s, tests 500ms`), as `{ totalMs, <key>Pct | <key>Ms }`;
 * null when the log has none. Tells test time from startup overhead (36b step 1, `unit`'s WARN).
 */
export function parseVitestDuration(log) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  const plain = log.replaceAll(/\x1b\[[0-9;]*m/g, '')
  const m = /Duration\s+([\d.]+)(ms|s)\s*\(([^)]*)\)/.exec(plain)
  if (!m) return null
  const toMs = (v, unit) => Number(v) * (unit === 's' ? 1000 : 1)
  const out = { totalMs: toMs(m[1], m[2]) }
  for (const [, key, v, unit] of m[3].matchAll(/(\w+) ([\d.]+)(ms|s|%)/g)) {
    out[unit === '%' ? `${key}Pct` : `${key}Ms`] = unit === '%' ? Number(v) : toMs(v, unit)
  }
  return out
}
