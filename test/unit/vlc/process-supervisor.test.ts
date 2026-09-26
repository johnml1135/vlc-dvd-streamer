import { describe, expect, it } from 'vitest'
import { normalizeExit } from '../../../src/vlc/process-events.js'
import { runManagedProcess, spawnManagedProcess } from '../../../src/vlc/process-supervisor.js'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'

interface ProcessEvents {
  stdout(chunk: string): void
  stderr(chunk: string): void
  error(error: Error): void
  close(code: number | null, signal: NodeJS.Signals | null): void
}

interface ProcessRuntime {
  start(spec: ReturnType<typeof createCommandSpec>, events: ProcessEvents): {
    pid: number | undefined
    kill(signal: NodeJS.Signals): void
  }
  schedule(delayMs: number, task: () => void): () => void
}

class FakeProcessRuntime implements ProcessRuntime {
  readonly signals: NodeJS.Signals[] = []
  readonly delays: number[] = []
  private events?: ProcessEvents
  private readonly timers: Array<{ delayMs: number; task: () => void; cancelled: boolean; fired: boolean }> = []

  start(_spec: ReturnType<typeof createCommandSpec>, events: ProcessEvents) {
    this.events = events
    return {
      pid: 123,
      kill: (signal: NodeJS.Signals) => this.signals.push(signal),
    }
  }

  schedule(delayMs: number, task: () => void): () => void {
    const timer = { delayMs, task, cancelled: false, fired: false }
    this.timers.push(timer)
    this.delays.push(delayMs)
    return () => { timer.cancelled = true }
  }

  fireNext(): boolean {
    const timer = this.timers.find(candidate => !candidate.cancelled && !candidate.fired)
    if (!timer) return false
    timer.fired = true
    timer.task()
    return true
  }

  emitStdout(chunk: string): void { this.events?.stdout(chunk) }
  emitStderr(chunk: string): void { this.events?.stderr(chunk) }
  emitError(error: Error): void { this.events?.error(error) }
  emitClose(code: number | null, signal: NodeJS.Signals | null): void { this.events?.close(code, signal) }
}

describe('normalizeExit', () => {
  it('keeps exit handling on close-style results', () => {
    expect(normalizeExit({ code: 0, signal: null }).ok).toBe(true)
    expect(normalizeExit({ code: null, signal: 'SIGTERM' }).ok).toBe(false)
  })
})

describe('runManagedProcess', () => {
  it('captures stdout from a successful child process', async () => {
    const spec = createCommandSpec({
      executable: process.execPath,
      args: ['-e', "console.log('hello-from-child')"],
      timeoutMs: 5000,
      label: 'node-smoke',
    })

    const result = await runManagedProcess(spec)

    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('hello-from-child')
    expect(result.stderr).toBe('')
  })
})

describe('spawnManagedProcess hasExited', () => {
  it('reports liveness, flipping to exited once the child closes', async () => {
    const spec = createCommandSpec({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 5000,
      label: 'liveness-smoke',
    })

    const handle = spawnManagedProcess(spec)
    expect(handle.hasExited?.()).toBe(false)

    await handle.completion
    expect(handle.hasExited?.()).toBe(true)
  })
})

describe('spawnManagedProcess runtime', () => {
  it('marks a timed-out process and waits for its close event', async () => {
    const runtime = new FakeProcessRuntime()
    const handle = spawnManagedProcess(createCommandSpec({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 250,
      label: 'fake-timeout',
    }), runtime)

    let settled = false
    void handle.completion.then(() => { settled = true })

    expect(runtime.fireNext()).toBe(true)
    expect(runtime.signals).toEqual(['SIGTERM'])
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.emitStderr('stalled child')
    runtime.emitClose(null, 'SIGTERM')

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      timedOut: true,
      code: null,
      signal: 'SIGTERM',
      stderr: 'stalled child',
    })
    expect(handle.hasExited?.()).toBe(true)
    expect(runtime.fireNext()).toBe(false)
  })

  it('settles after a Windows-style terminate and forced kill even without close', async () => {
    const runtime = new FakeProcessRuntime()
    const handle = spawnManagedProcess(createCommandSpec({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 0,
      label: 'fake-unresponsive-child',
    }), runtime)

    const stopped = handle.stop()
    expect(runtime.signals).toEqual(['SIGTERM'])
    expect(runtime.delays).toEqual([1000])

    expect(runtime.fireNext()).toBe(true) // Escalation deadline; sends SIGKILL.
    expect(runtime.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(runtime.delays).toEqual([1000, 1000])

    let settled = false
    void handle.completion.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    expect(runtime.fireNext()).toBe(true) // Final settle deadline after SIGKILL.
    await expect(stopped).resolves.toMatchObject({
      ok: false,
      timedOut: false,
      code: null,
      signal: null,
    })
    expect(handle.hasExited?.()).toBe(true)
  })

  it('cancels escalation when a timed-out process closes after SIGTERM', async () => {
    const runtime = new FakeProcessRuntime()
    const handle = spawnManagedProcess(createCommandSpec({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 250,
      label: 'fake-close-before-escalation',
    }), runtime)

    expect(runtime.fireNext()).toBe(true)
    expect(runtime.signals).toEqual(['SIGTERM'])
    runtime.emitClose(null, 'SIGTERM')

    await expect(handle.completion).resolves.toMatchObject({ timedOut: true, signal: 'SIGTERM' })
    expect(runtime.fireNext()).toBe(false)
    expect(runtime.signals).toEqual(['SIGTERM'])
  })

  it('rejects spawn errors with output captured before the error', async () => {
    const runtime = new FakeProcessRuntime()
    const handle = spawnManagedProcess(createCommandSpec({
      executable: 'unused',
      args: [],
      timeoutMs: 0,
      label: 'fake-spawn-error',
    }), runtime)

    runtime.emitStdout('partial stdout')
    runtime.emitStderr('partial stderr')
    runtime.emitError(new Error('spawn failed'))

    await expect(handle.completion).rejects.toMatchObject({
      name: 'ManagedProcessError',
      message: 'fake-spawn-error failed to start',
      stdout: 'partial stdout',
      stderr: 'partial stderr',
    })
    expect(handle.hasExited?.()).toBe(true)
  })

  it('sends only one termination sequence when stop is called repeatedly', async () => {
    const runtime = new FakeProcessRuntime()
    const handle = spawnManagedProcess(createCommandSpec({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 0,
      label: 'fake-repeated-stop',
    }), runtime)

    const firstStop = handle.stop()
    const secondStop = handle.stop()
    expect(runtime.signals).toEqual(['SIGTERM'])

    expect(runtime.fireNext()).toBe(true)
    expect(runtime.fireNext()).toBe(true)
    const [firstResult, secondResult] = await Promise.all([firstStop, secondStop])
    expect(firstResult).toMatchObject({ ok: false, code: null, signal: null })
    expect(secondResult).toEqual(firstResult)
    expect(runtime.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
