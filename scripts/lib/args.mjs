/**
 * Arguments of `pnpm test`: `[suite] [-t pattern] [--tier fast|slow] [--self-check-fail]
 * [--budget-scale <n>] [--timings-json <path>]`. Returns `{ error }` for anything else; the caller
 * prints usage, exits 2.
 */
export function parseArgs(argv, suiteNames) {
  const opts = {
    suite: undefined,
    pattern: undefined,
    tier: 'fast',
    selfCheckFail: false,
    scale: 1,
    timingsJson: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-t') {
      opts.pattern = argv[++i]
      if (opts.pattern === undefined) return { error: '-t needs a pattern' }
    } else if (arg === '--tier') {
      opts.tier = argv[++i]
      if (opts.tier !== 'fast' && opts.tier !== 'slow') return { error: '--tier is fast or slow' }
    } else if (arg === '--budget-scale') {
      opts.scale = Number(argv[++i])
      if (!(opts.scale > 0)) return { error: '--budget-scale needs a positive number' }
    } else if (arg === '--timings-json') {
      opts.timingsJson = argv[++i]
      if (opts.timingsJson === undefined) return { error: '--timings-json needs a path' }
    } else if (arg === '--self-check-fail') {
      opts.selfCheckFail = true
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag ${arg}` }
    } else if (opts.suite !== undefined) {
      return { error: `one suite at a time (got ${opts.suite} and ${arg})` }
    } else if (!suiteNames.includes(arg)) {
      return { error: `unknown suite ${arg}` }
    } else {
      opts.suite = arg
    }
  }
  return opts
}

export function usage(suiteNames) {
  return [
    'usage: pnpm test [suite] [-t pattern] [--tier fast|slow] [--self-check-fail]',
    '                 [--budget-scale <n>] [--timings-json <path>]',
    `suites: ${suiteNames.join(', ')}`,
  ].join('\n')
}
