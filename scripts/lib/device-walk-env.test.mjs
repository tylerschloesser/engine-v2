// M39f step 4-6: what the phone's own `env` says (env.mjs) in the **Run on** line, the Mac-side desktop
// median (desktop-median.mjs), and a whole auto round's log through `--apply` on a scratch copy.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyRound } from './device-walk/apply.mjs'
import { desktopMedian, medianOf } from './device-walk/desktop-median.mjs'
import { adapterString, describeEnv, formatEnv, parseUa } from './device-walk/env.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { replay } from './device-walk/rounds.mjs'
import { readPristineChecks } from './device-walk/test-checks.mjs'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'
const CHECKS = join(new URL('../..', import.meta.url).pathname, 'docs/plan/device-checks.md')

describe('device-walk env', () => {
  test('device-walk env: the iPhone self-test user agent gives device, iOS and Safari versions', () => {
    expect(parseUa(IPHONE_UA)).toEqual({ device: 'iPhone', os: 'iOS 18.7', browser: 'Safari 27.0' })
  })

  test('device-walk env: other agents (Mac Safari, Chrome, Firefox, Android, iPad, nothing)', () => {
    expect(
      parseUa(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      ),
    ).toEqual({ device: 'Mac', os: 'macOS', browser: 'Safari 26.0' })
    expect(
      parseUa(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      ).browser,
    ).toBe('Chrome 141.0.0.0')
    expect(
      parseUa(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
      ).browser,
    ).toBe('Firefox 140.0')
    expect(
      parseUa('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36'),
    ).toMatchObject({
      device: 'Android',
      os: 'Android 15',
    })
    expect(
      parseUa(
        'Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1',
      ),
    ).toMatchObject({
      device: 'iPad',
      os: 'iOS 17.4.1',
    })
    expect(parseUa(undefined)).toEqual({ device: '', os: '', browser: '' })
  })

  test('device-walk env: the real self-test env event gives the Run on line facts', () => {
    const env = {
      ua: IPHONE_UA,
      cores: 4,
      deviceMemory: null,
      uaData: null,
      crossOriginIsolated: false,
      gpu: { vendor: 'apple', architecture: 'apple', device: 'apple', description: 'apple' },
    }
    expect(adapterString(env.gpu)).toBe('apple/apple')
    expect(adapterString({ adapter: null })).toBe('')
    expect(describeEnv(env)).toMatchObject({
      device: 'iPhone',
      adapter: 'apple/apple',
      cores: 4,
      isolated: false,
    })
    expect(formatEnv(env)).toBe('iPhone, iOS 18.7, Safari 27.0, adapter apple/apple, 4 cores')
    expect(describeEnv(null)).toBeNull()
    expect(formatEnv(null)).toBe('')
  })

  test('device-walk env: --apply writes Run on from the auto round: device facts from env, numbers from metrics, no typing', () => {
    const text = readPristineChecks(CHECKS)
    const { items } = parseChecks(text)
    const ids = ['M03-determinism', 'M08-worldgen-ms-per-chunk']
    const sel = items.filter((i) => ids.includes(i.id))
    const events = [
      { t: '2026-10-03T10:00:00Z', type: 'start', only: ids, mode: 'auto' },
      {
        t: '2026-10-03T10:00:01Z',
        type: 'env',
        ua: IPHONE_UA,
        cores: 4,
        gpu: { vendor: 'apple', architecture: 'apple' },
      },
      {
        t: '2026-10-03T10:00:05Z',
        type: 'result',
        id: 'M03-determinism',
        result: 'pass',
        by: 'auto',
        metrics: { fixtures: 3 },
      },
      {
        t: '2026-10-03T10:00:09Z',
        type: 'result',
        id: 'M08-worldgen-ms-per-chunk',
        result: 'pass',
        by: 'auto',
        metrics: { median_ms: 0.31, cores: 4 },
      },
    ]
    const state = replay(events, sel)
    const { text: out, changes } = applyRound(text, state, { round: 'demo', overrides: {} })
    expect(changes).toEqual(
      expect.arrayContaining(['tick M03-determinism', 'tick M08-worldgen-ms-per-chunk']),
    )
    const run = (id) =>
      out.split('\n').find((l) => l.startsWith('**Run on:**') && l.includes(`${id} PASS`))
    expect(run('M03-determinism')).toBe(
      '**Run on:** iPhone, iOS 18.7, Safari 27.0, adapter apple/apple, 4 cores, 2026-10-03; **result:** M03-determinism PASS (numbers: fixtures=3); Android: not run: no device [round demo]',
    )
    expect(run('M08-worldgen-ms-per-chunk')).toContain(
      'M08-worldgen-ms-per-chunk PASS (numbers: median_ms=0.31, cores=4)',
    )
    // A device typed in the Mac UI still wins; only what it leaves out comes from env.
    const typed = replay([{ type: 'device', phone: 'iPhone 15', ios: '26.0' }, ...events], sel)
    expect(applyRound(text, typed, { round: 'demo', overrides: {} }).text).toContain(
      '**Run on:** iPhone 15 iOS 26.0, Safari 27.0, adapter apple/apple, 4 cores, 2026-10-03;',
    )
  })
})

describe('device-walk desktop median', () => {
  test('device-walk desktop median: the median of the runs that worked, null when none did', async () => {
    expect(medianOf([0.3, 0.1, 0.2])).toBe(0.2)
    expect(medianOf([0.4, 0.2])).toBe(0.2)
    expect(medianOf([])).toBeNull()
    expect(medianOf([Number.NaN, 0.5])).toBe(0.5)
    const seen = []
    const ok = await desktopMedian({
      url: 'http://x',
      runs: 3,
      measure: async (u) => {
        seen.push(u)
        return [0.3, 0.1, 0.2][seen.length - 1]
      },
    })
    expect(ok).toBe(0.2)
    expect(seen).toEqual(['http://x', 'http://x', 'http://x'])
    let n = 0
    const flaky = await desktopMedian({
      url: 'u',
      runs: 3,
      measure: async () => {
        if (n++ === 1) throw new Error('chromium missing')
        return 0.25
      },
    })
    expect(flaky).toBe(0.25)
    expect(
      await desktopMedian({
        url: 'u',
        runs: 2,
        measure: async () => {
          throw new Error('no browser')
        },
      }),
    ).toBeNull()
  })
})
