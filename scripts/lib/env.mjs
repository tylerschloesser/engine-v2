import { existsSync } from 'node:fs'

const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools'

/**
 * Environment for every cargo spawn. On macOS native linking fails until the Xcode licence is
 * accepted, so DEVELOPER_DIR points at the CommandLineTools when nothing else set it
 * (docs/decisions/0020 §10). Returns `env` itself when nothing needs to change.
 */
export function toolEnv({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (platform !== 'darwin' || env.DEVELOPER_DIR || !exists(COMMAND_LINE_TOOLS)) return env
  return { ...env, DEVELOPER_DIR: COMMAND_LINE_TOOLS }
}
