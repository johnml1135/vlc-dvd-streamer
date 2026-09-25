import { spawn } from 'node:child_process'
import type { CommandSpec } from './command-spec.js'
import { normalizeExit } from './process-events.js'

interface ProcessEvents {
  stdout(chunk: string): void
  stderr(chunk: string): void
  error(error: Error): void
  close(code: number | null, signal: NodeJS.Signals | null): void
}

interface ProcessChild {
  pid: number | undefined
  kill(signal: NodeJS.Signals): void
}

interface ProcessRuntime {
  start(spec: CommandSpec, events: ProcessEvents): ProcessChild
  schedule(delayMs: number, task: () => void): () => void
}

const STOP_GRACE_MS = 1000
const FINAL_SETTLE_MS = 1000

const nodeProcessRuntime: ProcessRuntime = {
  start(spec, events) {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      windowsHide: spec.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout?.on('data', chunk => events.stdout(chunk.toString()))
    child.stderr?.on('data', chunk => events.stderr(chunk.toString()))
    child.on('error', events.error)
    child.on('close', (code, signal) => events.close(code, signal))

    return {
      pid: child.pid,
      kill: (signal: NodeJS.Signals) => { child.kill(signal) },
    }
  },

  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs)
    return () => clearTimeout(timer)
  },
}

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
  /**
   * Whether the process has exited, failed to start, or reached the forced-stop
   * settlement deadline. Lets recovery distinguish "VLC is alive but stalled on
   * a read" (worth waiting on) from "VLC has died" (must be restarted). Optional
   * so lightweight test fakes need not implement it; callers treat an absent
   * implementation as unknown.
   */
  hasExited?: () => boolean
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

export function spawnManagedProcess(spec: CommandSpec, runtime: ProcessRuntime = nodeProcessRuntime): ManagedProcessHandle {
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false
  let stopRequested = false
  let child: ProcessChild | undefined
  let cancelTimeout: (() => void) | undefined
  let cancelStopGrace: (() => void) | undefined
  let cancelFinalSettle: (() => void) | undefined
  let resolveCompletion!: (result: CompletedProcess) => void
  let rejectCompletion!: (error: Error) => void
  const completion = new Promise<CompletedProcess>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })

  const clearTimers = (): void => {
    cancelTimeout?.()
    cancelStopGrace?.()
    cancelFinalSettle?.()
    cancelTimeout = undefined
    cancelStopGrace = undefined
    cancelFinalSettle = undefined
  }

  const settleWithoutClose = (): void => {
    if (settled) return
    settled = true
    clearTimers()
    resolveCompletion({
      ok: false,
      timedOut,
      code: null,
      signal: null,
      stdout,
      stderr,
    })
  }

  const settleOnClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return
    settled = true
    clearTimers()
    const exit = normalizeExit({ code, signal })
    resolveCompletion({
      ok: exit.ok && !timedOut,
      timedOut,
      code: exit.code,
      signal: exit.signal,
      stdout,
      stderr,
    })
  }

  const settleOnStartError = (error: unknown): void => {
    if (settled) return
    settled = true
    clearTimers()
    rejectCompletion(new ManagedProcessError(
      `${spec.label} failed to start`,
      stdout,
      stderr,
      { cause: error },
    ))
  }

  const events: ProcessEvents = {
    stdout: chunk => { stdout += chunk },
    stderr: chunk => { stderr += chunk },
    error: settleOnStartError,
    close: settleOnClose,
  }

  try {
    child = runtime.start(spec, events)
  } catch (error) {
    settleOnStartError(error)
  }

  const stop = (): Promise<CompletedProcess> => {
    if (settled || stopRequested) return completion
    stopRequested = true

    // On Windows SIGTERM maps to TerminateProcess; it is not a catchable
    // graceful signal. The deadlines still bound completion if close is absent.
    try {
      child?.kill('SIGTERM')
    } catch {
      // Keep the forced-kill and final-settle deadlines even if kill throws.
    }

    if (!settled) {
      cancelStopGrace = runtime.schedule(STOP_GRACE_MS, () => {
        cancelStopGrace = undefined
        if (settled) return
        try {
          child?.kill('SIGKILL')
        } catch {
          // The final deadline must still settle completion.
        }
        if (!settled) {
          cancelFinalSettle = runtime.schedule(FINAL_SETTLE_MS, () => {
            cancelFinalSettle = undefined
            settleWithoutClose()
          })
        }
      })
    }
    return completion
  }

  if (!settled && spec.timeoutMs > 0) {
    cancelTimeout = runtime.schedule(spec.timeoutMs, () => {
      cancelTimeout = undefined
      if (settled) return
      timedOut = true
      void stop()
    })
  }

  return {
    pid: child?.pid,
    completion,
    stop,
    getStdout: () => stdout,
    getStderr: () => stderr,
    hasExited: () => settled,
  }
}

export async function runManagedProcess(spec: CommandSpec): Promise<CompletedProcess> {
  return spawnManagedProcess(spec).completion
}
