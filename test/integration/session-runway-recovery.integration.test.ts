import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
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
  timer?: NodeJS.Timeout
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
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    return { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: this.stderr }
  }
}

/** Permanent scratch in [badStart, badEnd): restarting inside it produces nothing. */
class ScratchedDiscWorker {
  readonly starts: StartHlsSessionInput[] = []
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly badStartSeconds: number,
    private readonly badEndSeconds: number,
    private readonly durationSeconds: number,
    private readonly advanceMs = 8,
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
    let latest = startSlot
    await writeManifest(input.outputDir, startSlot, latest)
    if (latest < maxSlot) {
      const timer = setInterval(() => {
        latest += 1
        void writeManifest(input.outputDir, startSlot, latest)
        if (latest >= maxSlot) {
          clearInterval(timer)
          this.timers.delete(timer)
          handle.timer = undefined
        }
      }, this.advanceMs)
      handle.timer = timer
      this.timers.add(timer)
    }

    return { manifestPath, handle }
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

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
  private readonly timers = new Set<NodeJS.Timeout>()
  private badAttempts = 0

  constructor(
    private readonly badStartSeconds: number,
    private readonly badEndSeconds: number,
    private readonly durationSeconds: number,
    private readonly failuresBeforeClear: number,
    private readonly advanceMs = 8,
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
    let latest = startSlot
    await writeManifest(input.outputDir, startSlot, latest)
    if (latest < maxSlot) {
      const timer = setInterval(() => {
        latest += 1
        void writeManifest(input.outputDir, startSlot, latest)
        if (latest >= maxSlot) {
          clearInterval(timer)
          this.timers.delete(timer)
          handle.timer = undefined
        }
      }, this.advanceMs)
      handle.timer = timer
      this.timers.add(timer)
    }

    return { manifestPath, handle }
  }

  retryCount(): number {
    return this.badAttempts
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers.clear()
  }
}

/**
 * One VLC instance that plays to the stall point, pauses output, then resumes on
 * the SAME handle after selfHealMs — modelling a transient drive hiccup the
 * running process clears itself, with no restart.
 */
class SelfHealingWorker {
  readonly starts: StartHlsSessionInput[] = []
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly stallSeconds: number,
    private readonly durationSeconds: number,
    private readonly selfHealMs: number,
    private readonly advanceMs = 8,
  ) {}

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    this.starts.push(input)
    await mkdir(input.outputDir, { recursive: true })
    const manifestPath = join(input.outputDir, 'index.m3u8')
    const startSlot = input.initialSegmentNumber ?? slot(input.startTimeSeconds ?? 0)
    const stallSlot = slot(this.stallSeconds)
    const lastSlot = slot(this.durationSeconds - SEGMENT_DURATION_SECONDS)
    const handle = new AliveHandle()

    let latest = startSlot
    await writeManifest(input.outputDir, startSlot, latest)

    const advance = (target: number, onDone?: () => void) => {
      const timer = setInterval(() => {
        latest += 1
        void writeManifest(input.outputDir, startSlot, latest)
        if (latest >= target) {
          clearInterval(timer)
          this.timers.delete(timer)
          handle.timer = undefined
          onDone?.()
        }
      }, this.advanceMs)
      handle.timer = timer
      this.timers.add(timer)
    }

    // Play up to the stall, pause, then (if not stopped) resume to the end.
    advance(stallSlot - 1, () => {
      const healTimer = setTimeout(() => {
        this.timers.delete(healTimer)
        if (!handle.hasExited()) {
          advance(lastSlot)
        }
      }, this.selfHealMs)
      this.timers.add(healTimer)
    })

    return { manifestPath, handle }
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer)
      clearTimeout(timer)
    }
    this.timers.clear()
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
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3 },
      onSessionEvent(event) {
        events.push(event)
      },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      // Viewer is right at the producing edge (slot 4 = 6s, scratch starts slot 5):
      // runway is 0, well under the 3-slot guard, so recovery must skip at once.
      manager.noteClientSegmentRequest(session.id, 4)

      // Wait for the scratch to be filled and the title to finish (so the worker's
      // write timers have settled before teardown removes the session dir).
      await waitFor(() => {
        const recovery = manager.getSession(session.id)?.recovery
        return recovery?.status === 'idle'
          && recovery.skippedSeconds === 6
          && (recovery.lastGoodTimeSeconds ?? 0) >= 40
      }, 6000)

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
  }, 15_000)

  it('keeps retrying a transient hiccup past the old 3-attempt cap and recovers without losing content', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-transient-'))
    const worker = new FlakeyDiscWorker(8, 14, 40, 5)
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      // Buffer depth unknown (no client requests) is treated as healthy, so
      // retries are bounded only by the cap.
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3 },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })

      await waitFor(() => (manager.getSession(session.id)?.recovery?.lastGoodTimeSeconds ?? 0) >= 40, 8000)

      const recovery = manager.getSession(session.id)?.recovery
      // It retried more than the old fixed cap of 3 and never resorted to a fill.
      expect(worker.retryCount()).toBe(5)
      expect(recovery?.skippedSeconds).toBe(0)
      expect(recovery?.badRanges).toEqual([])
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  }, 15_000)

  it('lets a still-running VLC self-recover without a disruptive restart while buffered', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-runway-selfheal-'))
    const worker = new SelfHealingWorker(20, 40, 90)
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      playbackRecovery: { ...FAST_RECOVERY, readRetryAttempts: 12, skipGuardSlots: 3, maxStallPatienceMs: 400 },
    })

    try {
      const session = await manager.start({ discId: 'd', drive: 'D:', titleNumber: 1, durationSeconds: 40 })
      // Viewer is far behind (slot 1), so there is plenty of runway to wait out
      // the hiccup instead of restarting.
      manager.noteClientSegmentRequest(session.id, 1)

      await waitFor(() => (manager.getSession(session.id)?.recovery?.lastGoodTimeSeconds ?? 0) >= 40, 8000)

      const recovery = manager.getSession(session.id)?.recovery
      expect(recovery?.skippedSeconds).toBe(0)
      // The single initial VLC start carried it through — recovery never restarted.
      expect(worker.starts.length).toBe(1)
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  }, 15_000)
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }

  throw new Error('Timed out waiting for condition.')
}
