import { describe, expect, test } from 'vitest'
import { toolEnv } from './env.mjs'

const CLT = '/Library/Developer/CommandLineTools'

describe('toolEnv', () => {
  test('sets DEVELOPER_DIR on darwin only when unset', () => {
    const env = { PATH: '/bin' }
    const out = toolEnv({ platform: 'darwin', env, exists: (p) => p === CLT })
    expect(out).toEqual({ PATH: '/bin', DEVELOPER_DIR: CLT })
    expect(env).toEqual({ PATH: '/bin' })
  })

  test('leaves env untouched when already set, off darwin, or without the directory', () => {
    const set = { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
    expect(toolEnv({ platform: 'darwin', env: set, exists: () => true })).toBe(set)
    const env = { PATH: '/bin' }
    expect(toolEnv({ platform: 'linux', env, exists: () => true })).toBe(env)
    expect(toolEnv({ platform: 'darwin', env, exists: () => false })).toBe(env)
  })
})
