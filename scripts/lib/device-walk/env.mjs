// What the agent's `env` event says about the phone, as text for the **Run on** line (M39f): the device
// class, the OS and Safari versions read from the user agent, the adapter string and the core count. The
// model name is not exposed by any browser (the one-tap picker of the Mac UI still gives it), and Safari
// has no `userAgentData` and no `deviceMemory`: those stay `null` in the log and are left out here.

/** @returns {{ device: string, os: string, browser: string }} empty strings for what the UA does not say */
export function parseUa(ua) {
  const s = String(ua ?? '')
  const out = { device: '', os: '', browser: '' }
  const ios = /\b(iPhone|iPad|iPod)\b.*?\bOS (\d+)(?:_(\d+))?(?:_(\d+))?/.exec(s)
  if (ios) {
    out.device = ios[1]
    out.os = `iOS ${[ios[2], ios[3], ios[4]].filter((x) => x !== undefined).join('.')}`
  } else if (/Macintosh/.test(s)) {
    out.device = 'Mac'
    out.os = 'macOS' // the UA freezes the version at 10_15_7
  } else if (/Android/.test(s)) {
    out.device = 'Android'
    const a = /Android (\d+(?:\.\d+)*)/.exec(s)
    out.os = a ? `Android ${a[1]}` : 'Android'
  }
  const pick = (re, name) => {
    const m = re.exec(s)
    return m ? `${name} ${m[1]}` : ''
  }
  out.browser =
    pick(/\b(?:CriOS|Chrome)\/(\d+(?:\.\d+)*)/, 'Chrome') ||
    pick(/\b(?:FxiOS|Firefox)\/(\d+(?:\.\d+)*)/, 'Firefox') ||
    (/Safari\//.test(s) ? pick(/\bVersion\/(\d+(?:\.\d+)*)/, 'Safari') : '')
  return out
}

/** `apple/apple`: vendor and architecture of the WebGPU adapter, or '' when there is none. */
export function adapterString(gpu) {
  if (!gpu || typeof gpu !== 'object') return ''
  return [gpu.vendor, gpu.architecture].filter(Boolean).join('/')
}

/** `{ device, os, browser, adapter, cores, isolated }` for a replayed `env`, or null without one. */
export function describeEnv(env) {
  if (!env || typeof env !== 'object') return null
  return {
    ...parseUa(env.ua),
    adapter: adapterString(env.gpu),
    cores: typeof env.cores === 'number' ? env.cores : null,
    isolated: typeof env.crossOriginIsolated === 'boolean' ? env.crossOriginIsolated : null,
  }
}

/** One line: `iPhone, iOS 18.7, Safari 27.0, adapter apple/apple, 4 cores`. */
export function formatEnv(env) {
  const d = describeEnv(env)
  if (!d) return ''
  return [
    d.device,
    d.os,
    d.browser,
    d.adapter && `adapter ${d.adapter}`,
    d.cores !== null && `${d.cores} cores`,
  ]
    .filter(Boolean)
    .join(', ')
}
