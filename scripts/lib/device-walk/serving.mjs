// Which serving variant an item needs (M39e): derived from the section's **Open** paragraph and the
// item's own words; OVERRIDES holds only what the text cannot express.

export const FLY_URL = 'https://engine-v2-ref.fly.dev'

/**
 * Per-item overrides (win over the derived fields). `page` is the path + query after the origin
 * (`''` is the root, the reference game's own page); `pages` lists alternatives, the first is
 * shown. `device`: phone | mac | none.
 */
export const OVERRIDES = {
  'M11-memory': { page: 'device.html?probe=memory' },
  'M16-slice-boot': { pages: ['slice.html', 'determinism.html'] },
  'M23-opfs-latency': { page: 'opfs-latency.html' },
  'M23-kill-resume': { page: 'world.html' },
  'M23-world-busy': { page: 'world.html' },
  'M23-private': { page: 'world.html' },
  'M23-hidden-pause': { page: 'world.html' },
  'M23-export-import': { page: 'world.html' },
  'M29-socket-resume': { page: 'mp.html?linklog=1' },
  'M29-play-through-drop': { page: 'mp.html?linklog=1' },
  'M29-net-heap': { page: 'mp.html?linklog=1' },
  'M35-capability': { device: 'mac' },
  'M38-socket-resume': { page: '?linklog=1' },
  'M39-rerun': { device: 'none' },
  'M39-large-save': { page: '?bench=large-save', bench: true, ws: false },
  'M39-frame-shares': { page: '?bench=large-save&pan=2&zoom=max', bench: true, ws: false },
  'M39-full-game-touch': { ws: false },
  'M39-two-devices': { ws: true },
  'M39-sign-off': { ws: true },
}

const MAC_WORDS = /desktop-(?:safari|firefox)|-mac\b|desktop Safari|\bFirefox\b/

/**
 * @returns {{ device: 'phone'|'mac'|'none', app: 'fixture'|'reference', ws: string|false,
 *   bench: boolean, fly: boolean, tunnel: boolean, pages: string[] }}
 */
export function servingFor(item, overrides = OVERRIDES) {
  const o = overrides[item.id] ?? {}
  const open = item.open
  const own = `${item.id} ${item.lead ?? ''} ${item.steps ?? ''}`.split('*Pass')[0]
  const fly = /Fly URL/.test(open)
  const app = /--app reference|reference game/i.test(open) ? 'reference' : 'fixture'
  const wsMatch = /--ws(?: (\w[\w-]*))?/.exec(open)
  const ws = wsMatch ? (wsMatch[1] ?? true) : false
  const bench = false // only the explicit M39 overrides serve the bench build
  let page = fly ? '' : (/`([\w.-]+\.html[^`\s]*)`/.exec(open)?.[1] ?? '')
  if (app === 'reference' && !fly) page = ''
  const mp = /\b(mp\.html\?[^\s`]+)/.exec(open)
  if (mp) page = mp[1]
  const device = o.device ?? (MAC_WORDS.test(own) ? 'mac' : 'phone')
  const out = {
    device,
    app,
    ws: ws === true ? 'default' : ws,
    bench,
    fly,
    ...o,
  }
  out.ws = out.ws === true ? 'default' : out.ws
  out.pages = o.pages ?? [o.page ?? page]
  out.tunnel = out.device === 'phone' && !out.fly
  delete out.page
  return out
}

/** The `device-serve.mjs` flags for a serving record, and a stable key for reuse. */
export function serveArgs(s) {
  const args = []
  if (s.tunnel) args.push('--tunnel')
  if (s.ws) args.push('--ws', ...(s.ws === 'default' ? [] : [s.ws]))
  if (s.app === 'reference') args.push('--app', 'reference')
  if (s.bench) args.push('--bench')
  return args
}

/** Does a running server (`have`) satisfy the wanted record (`want`)? */
export function compatible(have, want) {
  return (
    have.app === want.app &&
    have.ws === want.ws &&
    have.bench === want.bench &&
    (have.tunnel || !want.tunnel)
  )
}

/** The origin and full URL list an item should show given a running server's URLs. */
export function pageUrl(s, urls, page) {
  if (s.device === 'none') return null
  const origin = s.fly ? FLY_URL : s.tunnel ? urls?.tunnel : urls?.loopback
  if (!origin) return null
  return `${origin}/${page}`
}
