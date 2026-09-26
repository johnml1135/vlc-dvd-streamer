import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { ManualPlaybackTime } from '../helpers/manual-playback-time.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../../src/vlc/worker.js'

const SEGMENT_DURATION_SECONDS = 2

function slot(timeSeconds: number): number {
  return Math.floor(timeSeconds / SEGMENT_DURATION_SECONDS) + 1
}

function formatSegmentName(slotNumber: number): string {
  return `segment-${String(slotNumber).padStart(6, '0')}.ts`
}

async function writeManifest(outputDir: string, fromSlot: number, toSlot: number): Promise<void> {
  const slots: number[] = []
  for (let s = fromSlot; s <= toSlot; s += 1) {
    slots.push(s)
    await writeFile(join(outputDir, formatSegmentName(s)), Buffer.from([0x47, 0x40, 0x00, 0x10]))
  }

  const manifest = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${fromSlot}`,
    ...slots.flatMap((s) => ['#EXTINF:2,', formatSegmentName(s)]),
    '',
  ].join('\n')
  await writeFile(join(outputDir, 'index.m3u8'), manifest, 'utf8')
}

/** Handle whose VLC process is reported alive (never exited) until stopped. */
class AliveHandle implements ManagedProcessHandle {
  readonly pid = 4321
  stderr = ''
  private exited = false
  readonly completion = new Promise<CompletedProcess>(() => {})

  getStdout(): string {
    return ''
  }

  getStderr(): string {
    return this.stderr
  }

  hasExited(): boolean {
    return this.exited
  }

  async stop(): Promise<CompletedProcess> {
    this.exited = true
    return { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: this.stderr }
  }
}

/** Permanent scratch in [badStart, badEnd): restarting inside it produces nothing. */
class ScratchedDiscWorker {
  readonly starts: StartHlsSessionInput[] = []
  private active?: { outputDir: string; fromSlot: number; latest: number; maxSlot: number; handle: AliveHandle }

  constructor(
    private readonly badStartSeconds: number,
    private readonly badEndSeconds: number,
    private readonly durationSeconds: number,
  ) {}

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    this.starts.push(input)
    await mkdir(input.outputDir, { recursive: true })
    const manifestPath = join(input.outputDir, 'index.m3u8')
    const startSlot = input.initialSegmentNumber ?? slot(input.startTimeSeconds ?? 0)
    const badStartSlot = slot(this.badStartSeconds)
    const badEndSlot = slot(this.badEndSeconds)
    const lastSlot = slot(this.durationSeconds - SEGMENT_DURATION_SECONDS)
    const handle = new AliveHandle()

    if (startSlot >= badStartSlot && startSlot < badEndSlot) {
      handle.stderr = 'VLC input/output error: could not read sector from DVD'
      return { manifestPath, handle }
    }

    const maxSlot = startSlot < badStartSlot ? badStartSlot - 1 : lastSlot
    await writeManifest(input.outputDir, startSlot, startSlot)
    this.active = { outputDir: input.outputDir, fromSlot: startSlot, latest: startSlot, maxSlot, handle }

    return { manifestPath, handle }
  }

  async produceThrough(slotNumber: number): Promise<void> {
    const active = this.active
    if (!active || active.handle.hasExited()) return
    const latest = Math.min(active.maxSlot, Math.max(active.latest, slotNumber))
    if (latest === active.latest) return
    await writeManifest(active.outputDir, active.fromSlot, latest)
    active.latest = latest
  }

  async dispose(): Promise<void> {}

  resumePoints(): number[] {
    const points: number[] = []
    for (const start of this.starts) {
      const time = start.startTimeSeconds ?? 0
      if (points.at(-1) !== time) {
        points.push(time)
      }
    }
    return points
  }
}

/** Transient hiccup: the read at [badStart, badEnd) fails the first N restarts, then clears. */
class FlakeyDiscWorker {
  readonly starts: StartHlsSessionInput[] = []
  private badAttempts = 0
  private active?: { outputDir: string; fromSlot: number; latest: number; maxSlot: number; handle: AliveHandle }

  constructor(
    private readonly badStartSeconds: number,
    private readonly badEndSeconds: number,
    private readonly durationSeconds: number,
    private readonly failuresBeforeClear: number,
  ) {}

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    this.starts.push(input)
    await mkdir(input.outputDir, { recursive: true })
    const manifestPath = join(input.outputDir, 'index.m3u8')
    const startSlot = input.initialSegmentNumber ?? slot(input.startTimeSeconds ?? 0)
    const badStartSlot = slot(this.badStartSeconds)
    const badEndSlot = slot(this.badEndSeconds)
    const lastSlot = slot(this.durationSeconds - SEGMENT_DURATION_SECONDS)
    const handle = new AliveHandle()

    const insideScratch = startSlot >= badStartSlot && startSlot < badEndSlot
    if (insideScratch && this.badAttempts < this.failuresBeforeClear) {
      this.badAttempts += 1
      handle.stderr = 'VLC input/output error: could not read sector from DVD'
      return { manifestPath, handle }
    }

    // Either we never hit the scratch, or the hiccup has cleared: play forward.
    const maxSlot = (!insideScratch && startSlot < badStartSlot) ? badStartSlot - 1 : lastSlot
    await writeManifest(input.outputDir, startSlot, startSlot)
    this.active = { outputDir: input.outputDir, fromSlot: startSlot, latest: startSlot, maxSlot, handle }

    return { manifestPath, handle }
  }

  retryCount(): number {
    return this.badAttempts
  }

  async produceThrough(slotNumber: number): Promise<void> {
    const active = this.active
    if (!active || active.handle.hasExited()) return
    const latest = Math.min(active.maxSlot, Math.max(active.latest, slotNumber))
    if (latest === active.latest) return
    await writeManifest(active.outputDir, active.fromSlot, latest)
    active.latest = latest
  }

  async dispose(): Promise<void> {}
}

/** Produces the stall prefix immediately, then resumes only when the test releases it. */
class SelfHealingWorker {
  readonly starts: StartHlsSessionInput[] = []
  readonly handle = new AliveHandle()
  aliveChecks = 0
  constructor(private readonly stallSeconds: number, private readonly durationSeconds: number) {
    const hasExited = this.handle.hasExited.bind(this.handle)
    this.handle.hasExited = () => { this.aliveChecks += 1; return hasExited() }
  }
  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    this.starts.push(input)
    await mkdir(input.outputDir, { recursive: true })
    await writeManifest(input.outputDir, 1, slot(this.stallSeconds) - 1)
    return { manifestPath: join(input.outputDir, 'index.m3u8'), handle: this.handle }
  }
  async resume(): Promise<void> {
    const input = this.starts[0]
    if (!input) throw new Error('Worker has not started')
    await writeManifest(input.outputDir, 1, slot(this.durationSeconds - SEGMENT_DURATION_SECONDS))
  }
}

const FAST_RECOVERY = {
  stallTimeoutMs: 60,
  monitorIntervalMs: 15,
  restartReadinessTimeoutMs: 500,
  maxAttempts: 6,
  segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
} as const

describe('SessionManager runway-aware recovery', () => {
  it('skips immediately without retrying when the viewer has nearly caught up to the stall', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-low-buffer-'))
    const events: Array<{ type: string; payload: unknown }> = []
    const worker = new ScratchedDiscWorker(8, 14, 40)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3 },
      onSessionEvent(event) {
        events.push(event)
      },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      expect(manager.attachViewer(session.id, 'viewer-1')).toEqual({ ok: true, active: true })
      await time.waitForScheduledTask()
      await worker.produceThrough(4)
      await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
      // Viewer is right at the producing edge (slot 4 = 6s, scratch starts slot 5):
      // runway is 0, well under the 3-slot guard, so recovery must skip at once.
      manager.noteClientSegmentRequest(session.id, 4)

      for (let tick = 0; tick < 100; tick += 1) {
        await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
        const latestStart = worker.starts.at(-1)?.initialSegmentNumber
        if (latestStart === 8) await worker.produceThrough(20)
        const recovery = manager.getSession(session.id)?.recovery
        if (recovery?.status === 'idle' && recovery.skippedSeconds === 6 && (recovery.lastGoodTimeSeconds ?? 0) >= 40) break
      }
      const recovery = manager.getSession(session.id)?.recovery
      expect(recovery?.status).toBe('idle')
      expect(recovery?.skippedSeconds).toBe(6)
      expect(recovery?.lastGoodTimeSeconds).toBeGreaterThanOrEqual(40)

      // Never restarted at the stall point (8s) to retry — it skipped straight to
      // filling slot 5 and resuming at the next slot (10s).
      expect(worker.resumePoints()).toEqual([0, 10, 12, 14])
      const retried = events.some((event) => {
        const payload = event.payload as { message?: string } | undefined
        return typeof payload?.message === 'string' && payload.message.includes('Retrying read')
      })
      expect(retried).toBe(false)
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  })

  it('keeps retrying a transient hiccup past the old 3-attempt cap and recovers without losing content', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-transient-'))
    const worker = new FlakeyDiscWorker(8, 14, 40, 5)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      // Buffer depth unknown (no client requests) is treated as healthy, so
      // retries are bounded only by the cap.
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3 },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      await time.waitForScheduledTask()
      await worker.produceThrough(4)

      for (let tick = 0; tick < 100; tick += 1) {
        await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
        if (worker.retryCount() >= 5 && worker.starts.at(-1)?.initialSegmentNumber === 5) {
          await worker.produceThrough(20)
        }
        if ((manager.getSession(session.id)?.recovery?.lastGoodTimeSeconds ?? 0) >= 40) break
      }

      const recovery = manager.getSession(session.id)?.recovery
      // It retried more than the old fixed cap of 3 and never resorted to a fill.
      expect(worker.retryCount()).toBe(5)
      expect(recovery?.skippedSeconds).toBe(0)
      expect(recovery?.badRanges).toEqual([])
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  })

  it('lets a still-running VLC self-recover without a disruptive restart while buffered', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-selfheal-'))
    const worker = new SelfHealingWorker(20, 40)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3, maxStallPatienceMs: 400 },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      await time.waitForScheduledTask()
      // Viewer is far behind (slot 1), so there is plenty of runway to wait out
      // the hiccup instead of restarting.
      manager.noteClientSegmentRequest(session.id, 1)

      for (let tick = 0; tick < 20 && worker.aliveChecks === 0; tick += 1) {
        await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
      }
      expect(worker.aliveChecks).toBeGreaterThan(0)
      expect(worker.starts.length).toBe(1)
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBe(0)
      await worker.resume()

      for (let tick = 0; tick < 6 && (manager.getSession(session.id)?.recovery?.lastGoodTimeSeconds ?? 0) < 40; tick += 1) {
        await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
      }

      const recovery = manager.getSession(session.id)?.recovery
      expect(recovery?.skippedSeconds).toBe(0)
      // The single initial VLC start carried it through — recovery never restarted.
      expect(worker.starts.length).toBe(1)
    } finally {
      await manager.stopAll()
    }
  })

  it('uses a fresh current-region playback report without a segment note, then falls back after it expires', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-report-expiry-'))
    const worker = new FlakeyDiscWorker(20, 24, 40, 0)
    const time = new ManualPlaybackTime()
    let calendarNow = Date.parse('2001-01-01T00:00:00Z')
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      now: () => calendarNow,
      worker,
      time,
      playbackRecovery: {
        ...FAST_RECOVERY,
        readRetryAttempts: 0,
        skipGuardSlots: 3,
        maxStallPatienceMs: 400,
      },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      expect(manager.attachViewer(session.id, 'viewer-1')).toEqual({ ok: true, active: true })
      await time.waitForScheduledTask()
      await worker.produceThrough(10)
      await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)

      // This report is the only runway evidence; no segment request is noted.
      expect(await manager.reportPlayback(session.id, {
        manifestUrl: session.manifestUrl,
        reporterId: 'viewer-1',
        sequence: 1,
        positionSeconds: 0,
        bufferedEndSeconds: 20,
        paused: false,
        playbackRate: 1,
      }, 'viewer-1')).toBe('accepted')

      // Calendar jumps do not age the elapsed recovery evidence.
      calendarNow += 365 * 24 * 60 * 60 * 1000
      await time.advanceBy(FAST_RECOVERY.stallTimeoutMs)
      expect(worker.starts).toHaveLength(1)

      // Once the five-second elapsed freshness window expires, recovery falls
      // back to the conservative download estimate and restarts.
      await time.advanceBy(5_000)
      expect(worker.starts.length).toBeGreaterThan(1)
    } finally {
      await manager.stopAll()
    }
  })

  it('uses the report playhead against its prefetch buffer when deciding runway', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-report-playhead-'))
    const worker = new FlakeyDiscWorker(20, 24, 40, 0)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      playbackRecovery: {
        ...FAST_RECOVERY,
        readRetryAttempts: 0,
        skipGuardSlots: 3,
        maxStallPatienceMs: 400,
      },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      expect(manager.attachViewer(session.id, 'viewer-1')).toEqual({ ok: true, active: true })
      await time.waitForScheduledTask()
      await worker.produceThrough(10)
      await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)

      // A viewer at the playhead has nine slots of runway and is allowed to
      // wait out the stalled producer.
      expect(await manager.reportPlayback(session.id, {
        manifestUrl: session.manifestUrl,
        reporterId: 'viewer-1',
        sequence: 1,
        positionSeconds: 0,
        bufferedEndSeconds: 20,
        paused: false,
        playbackRate: 1,
      }, 'viewer-1')).toBe('accepted')
      await time.advanceBy(FAST_RECOVERY.stallTimeoutMs)
      expect(worker.starts).toHaveLength(1)

      // The same prefetch with a playhead at its edge has no useful runway.
      expect(await manager.reportPlayback(session.id, {
        manifestUrl: session.manifestUrl,
        reporterId: 'viewer-1',
        sequence: 2,
        positionSeconds: 18,
        bufferedEndSeconds: 20,
        paused: false,
        playbackRate: 1,
      }, 'viewer-1')).toBe('accepted')
      await time.advanceBy(FAST_RECOVERY.monitorIntervalMs)
      expect(worker.starts.length).toBeGreaterThan(1)
    } finally {
      await manager.stopAll()
    }
  })
})
