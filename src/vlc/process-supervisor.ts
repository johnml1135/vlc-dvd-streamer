import { spawn } from 'node:child_process'
import type { CommandSpec } from './command-spec.js'
import { normalizeExit } from './process-events.js'

export interface CompletedProcess {
  ok: boolean
  timedOut: boolean
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface ManagedProcessHandle {
  pid: number | undefined
  completion: Promise<CompletedProcess>
  stop: () => Promise<CompletedProcess>
  getStdout: () => string
  getStderr: () => string
}

export class ManagedProcessError extends Error {
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, stdout: string, stderr: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ManagedProcessError'
    this.stdout = stdout
    this.stderr = stderr
  }
}

export function spawnManagedProcess(spec: CommandSpec): ManagedProcessHandle {
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: spec.shell,
    windowsHide: spec.windowsHide,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false
  let hardKillTimer: NodeJS.Timeout | undefined

  const timeout = setTimeout(() => {
    timedOut = true
    void stop()
  }, spec.timeoutMs)

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })

  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const completion = new Promise<CompletedProcess>((resolve, reject) => {
    child.on('error', (error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      if (hardKillTimer) {
        clearTimeout(hardKillTimer)
      }

      reject(new ManagedProcessError(`${spec.label} failed to start`, stdout, stderr, { cause: error }))
    })

    child.on('close', (code, signal) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      if (hardKillTimer) {
        clearTimeout(hardKillTimer)
      }

      const exit = normalizeExit({ code, signal })
      resolve({
        ok: exit.ok && !timedOut,
        timedOut,
        code: exit.code,
        signal: exit.signal,
        stdout,
        stderr,
      })
    })
  })

  const stop = async (): Promise<CompletedProcess> => {
    if (settled) {
      return completion
    }

    child.kill('SIGTERM')
    hardKillTimer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
      }
    }, 1000)

    return completion
  }

  return {
    pid: child.pid,
    completion,
    stop,
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

export async function runManagedProcess(spec: CommandSpec): Promise<CompletedProcess> {
  return spawnManagedProcess(spec).completion
}