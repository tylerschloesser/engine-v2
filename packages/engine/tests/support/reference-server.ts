// Spawns the real `games/reference-server` process for the tests that need one (M38: `static-headers`, `sigterm-snapshots`; `reference-server-smoke` keeps its own).
import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

export const referenceServerDir = fileURLToPath(
  new URL('../../../../games/reference-server', import.meta.url),
)

export type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

export interface RunningServer {
  proc: ServerProcess
  port: number
  /** Resolves with the exit code. */
  exited: Promise<number>
}

/** Spawns on `PORT=0` and resolves once the one `listening:` line names the real port. */
export function spawnReferenceServer(args: string[]): Promise<RunningServer> {
  const proc = spawn(process.execPath, [referenceServerDir, ...args], {
    env: { ...process.env, PORT: '0', JOIN_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)))
  return new Promise((resolve, reject) => {
    let buf = ''
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = /listening: ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf)
      if (m?.[1]) resolve({ proc, port: Number(m[1]), exited })
    })
    proc.on('error', reject)
    void exited.then((code) =>
      reject(new Error(`reference-server exited ${code} before listening`)),
    )
  })
}
