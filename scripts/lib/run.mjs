import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Spawn `cmd`, sending its stdout and stderr to the file `opts.log` (never streamed to the
 * terminal). Resolves, never rejects: a command that cannot start gets code 127 and the reason in
 * the log.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ log: string, cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ code: number, ms: number, log: string }>}
 */
export function run(cmd, args, { log, cwd, env }) {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  const start = performance.now()
  return new Promise((resolve) => {
    const done = (code) => {
      closeSync(fd)
      resolve({ code, ms: performance.now() - start, log })
    }
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] })
    child.on('error', (err) => {
      writeSync(fd, `cannot run ${cmd}: ${err.message}\n`)
      done(127)
    })
    child.on('close', (code, signal) => {
      if (signal) writeSync(fd, `${cmd} killed by ${signal}\n`)
      done(code ?? 1)
    })
  })
}

/** Whole log as text; empty when the file is missing. */
export function readLog(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function firstLines(text, n) {
  return text.trimEnd().split('\n').slice(0, n).join('\n')
}

export function lastLines(text, n) {
  return text.trimEnd().split('\n').slice(-n).join('\n')
}
