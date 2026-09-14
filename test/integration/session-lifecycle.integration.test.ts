import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager, type SessionManagerOptions } from '../../src/session/session-manager.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput } from '../../src/vlc/worker.js'
import { ManualPlaybackTime } from '../helpers/manual-playback-time.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const closed: CompletedProcess = { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: '' }
class Handle implements ManagedProcessHandle {
  pid = 123
  readonly done = deferred<CompletedProcess>()
  completion = this.done.promise
  stopped = false
  holdStop = false
  async stop() {
    if (!this.holdStop) this.close()
    return this.completion
  }
  close() { this.stopped = true; this.done.resolve(closed) }
  getStdout() { return '' }
  getStderr() { return '' }
  hasExited() { return this.stopped }
}
const request = { discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 120 }
const turn = () => new Promise((resolve) => setTimeout(resolve, 30))
async function output(input: StartHlsSessionInput) {
  await mkdir(input.outputDir, { recursive: true })
  const name = `segment-${String(input.initialSegmentNumber ?? 1).padStart(6, '0')}.ts`
  await writeFile(join(input.outputDir, name), Buffer.from([0x47, 0x40, 0, 0x10]))
  const manifestPath = join(input.outputDir, 'index.m3u8')
  await writeFile(manifestPath, `#EXTM3U\n#EXTINF:2,\n${name}\n`)
  return manifestPath
}
async function setup(worker: SessionManagerOptions['worker'], recovery: SessionManagerOptions['playbackRecovery'] = {}) {
  return new SessionManager({ cacheDir: await mkdtemp(join(tmpdir(), 'session-lifecycle-')), inactivityMs: 60000,
    playbackRecovery: { enabled: false, stopTimeoutMs: 5, ...recovery }, worker })
}

describe('playback lifecycle ownership', () => {
  it('keeps recovery deadlines on elapsed time when the calendar clock jumps', async () => {
    const time = new ManualPlaybackTime()
    let calendarNow = Date.parse('2001-01-01T00:00:00Z')
    const manager = new SessionManager({
      cacheDir: await mkdtemp(join(tmpdir(), 'session-calendar-jump-')),
      inactivityMs: 60_000,
      now: () => calendarNow,
      time,
      playbackRecovery: { enabled: true, stallTimeoutMs: 10, monitorIntervalMs: 5, readRetryAttempts: 0 },
      worker: { async startHlsSession(input) { return { manifestPath: await output(input), handle: new Handle() } } },
    })
    try {
      const session = await manager.start(request)
      await time.runUntilIdle()
      calendarNow += 365 * 24 * 60 * 60 * 1000
      await time.advanceBy(5)
      await time.runUntilIdle()
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(0)
      await time.advanceBy(5)
      await time.runUntilIdle()
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(2)
    } finally { await manager.stopAll() }
  })

  it('uses the injected clock for creation, touches, reuse, seeks and inactivity', async () => {
    let now = Date.parse('2001-01-01T00:00:00Z')
    const manager = new SessionManager({
      cacheDir: await mkdtemp(join(tmpdir(), 'session-clock-')), inactivityMs: 1000,
      now: () => now, playbackRecovery: { enabled: false },
      worker: { async startHlsSession(input) { return { manifestPath: await output(input), handle: new Handle() } } },
    })
    try {
      const session = await manager.start(request)
      expect(session.startedAt).toBe(new Date(now).toISOString())
      now += 100
      manager.touch(session.id)
      expect(manager.getSession(session.id)?.lastAccessedAt).toBe(new Date(now).toISOString())
      now += 100
      expect((await manager.start(request)).lastAccessedAt).toBe(new Date(now).toISOString())
      now += 100
      await manager.seek(session.id, { positionSeconds: 20 })
      expect(manager.getSession(session.id)?.lastAccessedAt).toBe(new Date(now).toISOString())
      now += 1000
      await manager.cleanupInactive()
      expect(manager.getSession(session.id)?.state).toBe('ready')
      now += 1
      await manager.cleanupInactive()
      expect(manager.getSession(session.id)?.state).toBe('stopped')
    } finally { await manager.stopAll() }
  })

  it('serializes simultaneous starts and reuses the first matching session', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    let starts = 0
    const manager = await setup({ async startHlsSession(input) {
      starts++; entered.resolve(); await release.promise
      return { manifestPath: await output(input), handle: new Handle() }
    } })
    const first = manager.start(request)
    await entered.promise
    const second = manager.start(request)
    await turn()
    const observed = starts
    release.resolve()
    const sessions = await Promise.all([first, second])
    await manager.stopAll()
    expect(observed).toBe(1)
    expect(sessions[0].id).toBe(sessions[1].id)
  })

  it('retires a deferred seek restart before stop deletes its files', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const handles: Handle[] = []
    const manager = await setup({ async startHlsSession(input) {
      if (handles.length) { entered.resolve(); await release.promise }
      const handle = new Handle(); handles.push(handle)
      return { manifestPath: await output(input), handle }
    } })
    const session = await manager.start(request)
    const seek = manager.seek(session.id, { positionSeconds: 20 })
    await entered.promise
    let stopped = false
    const stop = manager.stop(session.id).then(() => { stopped = true })
    await turn()
    const stoppedBeforeRelease = stopped
    release.resolve()
    await Promise.all([seek, stop])
    expect(stoppedBeforeRelease).toBe(false)
    expect(handles[1].stopped).toBe(true)
    await expect(access(session.outputDir)).rejects.toThrow()
  })

  it('does not replace a writer whose stop has not completed after the timeout', async () => {
    const handles: Handle[] = []
    const manager = await setup({ async startHlsSession(input) {
      const handle = new Handle(); handles.push(handle)
      return { manifestPath: await output(input), handle }
    } })
    const first = await manager.start(request)
    handles[0].holdStop = true
    const replacing = manager.start({ ...request, titleNumber: 2 })
    await turn()
    const countWhileAlive = handles.length
    const filesWhileAlive = await access(first.outputDir).then(() => true, () => false)
    handles[0].close()
    await replacing
    await manager.stopAll()
    expect(countWhileAlive).toBe(1)
    expect(filesWhileAlive).toBe(true)
  })

  it('serializes simultaneous seeks so each previous writer is retired', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const handles: Handle[] = []
    let starts = 0
    const manager = await setup({ async startHlsSession(input) {
      starts++
      if (starts === 2) { entered.resolve(); await release.promise }
      const handle = new Handle(); handles.push(handle)
      return { manifestPath: await output(input), handle }
    } })
    const session = await manager.start(request)
    const first = manager.seek(session.id, { positionSeconds: 20 })
    await entered.promise
    const second = manager.seek(session.id, { positionSeconds: 40 })
    await turn()
    const startsWhileBlocked = starts
    release.resolve()
    await Promise.all([first, second])
    await manager.stopAll()
    expect(startsWhileBlocked).toBe(2)
    expect(handles.every((handle) => handle.stopped)).toBe(true)
  })

  it('waits for background placeholder generation before deleting the session directory', async () => {
    const release = deferred<void>(), entered = deferred<void>()
    let directory = ''
    const manager = await setup({
      async startHlsSession(input) {
        directory = input.outputDir
        return { manifestPath: await output(input), handle: new Handle() }
      },
      async generatePlaceholderSegment() {
        entered.resolve()
        await release.promise
        await writeFile(join(directory, 'placeholder.ts'), Buffer.from([0x47]))
      },
    })
    const session = await manager.start(request)
    await entered.promise
    let stopped = false
    const stop = manager.stop(session.id).then(() => { stopped = true })
    await turn()
    const prematureStop = stopped
    release.resolve()
    await stop
    expect(prematureStop).toBe(false)
    await expect(access(directory)).rejects.toThrow()
  })


  it('retires a deferred recovery restart before stop removes its files', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const handles: Handle[] = []
    const manager = await setup({ async startHlsSession(input) {
      if (handles.length) { entered.resolve(); await release.promise }
      const handle = new Handle(); handles.push(handle)
      return { manifestPath: await output(input), handle }
    } }, { enabled: true, stallTimeoutMs: 5, monitorIntervalMs: 2 })
    const session = await manager.start(request)
    await entered.promise
    let stopped = false
    const stop = manager.stop(session.id).then(() => { stopped = true })
    await turn()
    const prematureStop = stopped
    release.resolve()
    await stop
    expect(prematureStop).toBe(false)
    expect(handles[1].stopped).toBe(true)
    await expect(access(session.outputDir)).rejects.toThrow()
  })

  it('cleans a failed spawn whose completion and stop both reject after closure', async () => {
    const manager = await setup({ async startHlsSession(input) {
      const failure = Promise.reject<CompletedProcess>(new Error('spawn failed'))
      void failure.catch(() => {})
      return { manifestPath: join(input.outputDir, 'index.m3u8'), handle: {
        pid: undefined, completion: failure, stop: () => failure,
        getStdout: () => '', getStderr: () => 'spawn failed', hasExited: () => true,
      } }
    } })
    const session = await manager.start(request)
    expect(session.state).toBe('failed')
    expect(manager.getActiveSession()).toBeUndefined()
    await expect(access(session.outputDir)).rejects.toThrow()
    await manager.stopAll()
  })

  it('waits for rendered placeholder completion before publishing a bad slot', async () => {
    const release = deferred<void>(), entered = deferred<void>()
    const manager = await setup({
      async startHlsSession(input) { return { manifestPath: await output(input), handle: new Handle() } },
      async generatePlaceholderSegment({ outputDir }) {
        await writeFile(join(outputDir, 'placeholder.ts'), Buffer.from([0x47, 0x40, 0, 0x10]))
        entered.resolve()
        await release.promise
        await writeFile(join(outputDir, 'placeholder.ts'), Buffer.from([0x47, 0x40, 99, 0x10]))
      },
    }, { enabled: true, stallTimeoutMs: 5, monitorIntervalMs: 2, readRetryAttempts: 0 })
    const session = await manager.start(request)
    await entered.promise
    await turn()
    const premature = manager.getRegionManifest(session.id)?.includes('segment-000002.ts')
    release.resolve()
    await vi.waitFor(() => expect(manager.getRegionManifest(session.id)).toContain('segment-000002.ts'))
    const asset = await manager.readStreamAsset(session.id, 'segment-000002.ts', { generation: 'placeholder' })
    await manager.stopAll()
    expect(premature).toBe(false)
    expect(asset?.content).toEqual(Buffer.from([0x47, 0x40, 99, 0x10]))
  })

  it('recovers a failed backward seek after a later region reached the title end', async () => {
    const starts: StartHlsSessionInput[] = []
    const handles: Handle[] = []
    const manager = await setup({ async startHlsSession(input) {
      starts.push(input)
      const handle = new Handle()
      handles.push(handle)
      if (starts.length !== 3) {
        return { manifestPath: await output(input), handle }
      }
      return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
    } }, {
      enabled: true,
      monitorIntervalMs: 2,
      stallTimeoutMs: 5,
      restartReadinessTimeoutMs: 20,
      readRetryAttempts: 0,
    })

    const session = await manager.start({ ...request, durationSeconds: 8 })
    try {
      expect(await manager.seek(session.id, { positionSeconds: 6 })).toMatchObject({ ok: true })
      expect(manager.getSession(session.id)?.recovery?.lastGoodTimeSeconds).toBe(8)

      expect(await manager.seek(session.id, { positionSeconds: 0 })).toMatchObject({ ok: false })
      await vi.waitFor(() => expect(starts.length).toBeGreaterThanOrEqual(4))

      expect(starts[3]?.initialSegmentNumber).toBe(3)
    } finally {
      await manager.stopAll()
    }
  })

  it('cleans an inactive session after recovery is exhausted', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'session-lifecycle-'))
    let starts = 0
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 1,
      worker: { async startHlsSession(input) {
        starts += 1
        if (starts > 1) throw new Error('restart failed')
        return { manifestPath: await output(input), handle: new Handle() }
      } },
      playbackRecovery: {
        enabled: true,
        monitorIntervalMs: 2,
        stallTimeoutMs: 5,
        readRetryAttempts: 0,
        maxAttempts: 0,
      },
    })

    const session = await manager.start(request)
    await vi.waitFor(() => expect(manager.getSession(session.id)?.state).toBe('failed'))
    expect(await access(session.outputDir).then(() => true, () => false)).toBe(true)

    await turn()
    await manager.cleanupInactive()

    expect(manager.getSession(session.id)?.state).toBe('stopped')
    await expect(access(session.outputDir)).rejects.toThrow()
  })

  it('removes allocated files when the worker rejects before returning a handle', async () => {
    let sessionDir = ''
    const manager = await setup({ async startHlsSession(input) {
      sessionDir = join(input.outputDir, '..', '..')
      throw new Error('worker did not start')
    } })

    await expect(manager.start(request)).rejects.toThrow('worker did not start')
    expect(sessionDir).not.toBe('')
    await expect(access(sessionDir)).rejects.toThrow()
  })
})
