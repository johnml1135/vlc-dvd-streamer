import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { ManualPlaybackTime } from '../helpers/manual-playback-time.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../../src/vlc/worker.js'

const closed: CompletedProcess = { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: '' }

function segment(slot: number, marker: number): string {
  return `segment-${String(slot).padStart(6, '0')}.ts`
}

class StopPublishesFinalSegment implements ManagedProcessHandle {
  readonly pid = 100
  readonly completion = new Promise<CompletedProcess>(() => {})
  stopStarted = false
  constructor(private readonly outputDir: string) {}
  getStdout() { return '' }
  getStderr() { return '' }
  hasExited() { return this.stopStarted }
  async stop() {
    this.stopStarted = true
    await writeFile(join(this.outputDir, segment(2, 0x99)), Buffer.from([0x47, 0x40, 0x99, 0x10]))
    await writeFile(join(this.outputDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000001.ts\n#EXTINF:2,\nsegment-000002.ts\n')
    return closed
  }
}

class DeferredStopHandle implements ManagedProcessHandle {
  readonly pid = 101
  readonly completion = new Promise<CompletedProcess>(() => {})
  stopStarted = false
  readonly stopStartedPromise: Promise<void>
  private resolveStopStarted!: () => void
  exited = false
  private releasePromise: Promise<void>
  private release!: () => void
  constructor(private readonly outputDir: string, private readonly rejectFirst = false) {
    this.releasePromise = new Promise(resolve => { this.release = resolve })
    this.stopStartedPromise = new Promise(resolve => { this.resolveStopStarted = resolve })
  }
  getStdout() { return '' }
  getStderr() { return '' }
  hasExited() { return this.exited }
  releaseStop() { this.release() }
  async stop() {
    this.stopStarted = true
    this.resolveStopStarted()
    if (this.exited) return closed
    if (this.rejectFirst) {
      this.exited = false
      throw new Error('stop failed')
    }
    await this.releasePromise
    this.exited = true
    return closed
  }
}

async function writeInitialOutput(input: StartHlsSessionInput): Promise<void> {
  await mkdir(input.outputDir, { recursive: true })
  const slotNumber = input.initialSegmentNumber ?? 1
  await writeFile(join(input.outputDir, segment(slotNumber, 0x11)), Buffer.from([0x47, 0x40, 0x11, 0x10]))
  await writeFile(join(input.outputDir, 'index.m3u8'), `#EXTM3U\n#EXTINF:2,\n${segment(slotNumber, 0)}\n`)
}

describe('serialized recovery ownership', () => {
  it('publishes valid bytes emitted while stopping before filling the stalled slot', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-recovery-ordering-'))
    const time = new ManualPlaybackTime()
    let handle: StopPublishesFinalSegment | undefined
    let starts = 0
    const events: unknown[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      time,
      playbackRecovery: { stallTimeoutMs: 5, monitorIntervalMs: 2, readRetryAttempts: 0, restartReadinessTimeoutMs: 50 },
      onSessionEvent: event => events.push(event),
      worker: {
        async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
          starts += 1
          await mkdir(input.outputDir, { recursive: true })
          if (starts === 1) {
            await writeFile(join(input.outputDir, segment(1, 0x11)), Buffer.from([0x47, 0x40, 0x11, 0x10]))
            await writeFile(join(input.outputDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000001.ts\n')
            handle = new StopPublishesFinalSegment(input.outputDir)
            return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
          }
          await writeFile(join(input.outputDir, segment(3, 0x33)), Buffer.from([0x47, 0x40, 0x33, 0x10]))
          await writeFile(join(input.outputDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000003.ts\n')
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle: new StopPublishesFinalSegment(input.outputDir) }
        },
      },
    })

    try {
      const session = await manager.start({ discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 8 })
      await time.waitForScheduledTask()
      await time.advanceBy(6)
      expect(handle?.stopStarted).toBe(true)
      expect(starts).toBeGreaterThanOrEqual(2)
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(0)
      const asset = await manager.readStreamAsset(session.id, segment(2, 0), { generation: '0' })
      expect(asset?.content).toEqual(Buffer.from([0x47, 0x40, 0x99, 0x10]))
      expect(manager.getSession(session.id)?.recovery?.badRanges).toEqual([])
    } finally {
      await manager.stopAll()
    }
  })

  it('does not restart or fill after a queued seek invalidates an in-flight recovery', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-recovery-seek-fence-'))
    const time = new ManualPlaybackTime()
    let starts = 0
    let handle: DeferredStopHandle | undefined
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      time,
      playbackRecovery: { stallTimeoutMs: 5, monitorIntervalMs: 2, readRetryAttempts: 0 },
      worker: {
        async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
          starts += 1
          await writeInitialOutput(input)
          handle = new DeferredStopHandle(input.outputDir)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
        },
      },
    })

    try {
      const session = await manager.start({ discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      await time.waitForScheduledTask()
      const recoveryTick = time.advanceBy(6)
      await handle!.stopStartedPromise
      const seek = manager.seek(session.id, { positionSeconds: 20 })
      handle?.releaseStop()
      await Promise.all([recoveryTick, seek])
      expect(manager.getSession(session.id)?.recovery?.badRanges).toEqual([])
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(0)
      expect(starts).toBe(2)
    } finally {
      handle?.releaseStop()
      await manager.stopAll()
    }
  })

  it('does not commit a placeholder or recovery counters when worker stop fails', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-recovery-stop-failure-'))
    const time = new ManualPlaybackTime()
    let handle: DeferredStopHandle | undefined
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      time,
      playbackRecovery: { stallTimeoutMs: 5, monitorIntervalMs: 2, readRetryAttempts: 0 },
      worker: {
        async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
          await writeInitialOutput(input)
          handle = new DeferredStopHandle(input.outputDir, true)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
        },
      },
    })

    try {
      const session = await manager.start({ discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      await time.waitForScheduledTask()
      await time.advanceBy(6)
      expect(handle?.stopStarted).toBe(true)
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(0)
      expect(manager.getSession(session.id)?.recovery?.badRanges).toEqual([])
    } finally {
      if (handle) {
        handle.exited = true
      }
      await manager.stopAll()
    }
  })
})
