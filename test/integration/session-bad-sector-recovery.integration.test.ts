import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { ManualPlaybackTime } from '../helpers/manual-playback-time.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../../src/vlc/worker.js'

const SEGMENT_DURATION_SECONDS = 2

/**
 * Deterministic in-process VLC stand-in that models a real scratched disc:
 *  - Linear playback advances HLS segments until it reaches the scratch, then
 *    stops producing output (the read stalls).
 *  - Restarting inside the scratch produces nothing and reports a read error.
 *  - Restarting at or past the end of the scratch resumes normal playback.
 * Segment file numbers equal DVD-time slot numbers (initialSegmentNumber), which
 * is exactly what the real VLC livehttp args guarantee.
 */
class ScratchedDiscWorker {
  readonly starts: StartHlsSessionInput[] = []
  private active?: { outputDir: string; fromSlot: number; latest: number; maxSlot: number; handle: IntervalHandle }

  constructor(
    private readonly badStartSeconds: number,
    private readonly badEndSeconds: number,
    private readonly durationSeconds: number,
  ) {}

  private slot(timeSeconds: number): number {
    return Math.floor(timeSeconds / SEGMENT_DURATION_SECONDS) + 1
  }

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    this.starts.push(input)
    await mkdir(input.outputDir, { recursive: true })

    const manifestPath = join(input.outputDir, 'index.m3u8')
    const startSlot = input.initialSegmentNumber ?? this.slot(input.startTimeSeconds ?? 0)
    const badStartSlot = this.slot(this.badStartSeconds)
    const badEndSlot = this.slot(this.badEndSeconds)
    const lastSlot = this.slot(this.durationSeconds - SEGMENT_DURATION_SECONDS)
    const handle = new IntervalHandle()

    // Inside the scratch: the drive cannot read, so VLC produces no output.
    if (startSlot >= badStartSlot && startSlot < badEndSlot) {
      handle.stderr = 'VLC input/output error: could not read sector from DVD'
      return { manifestPath, handle }
    }

    // Otherwise play forward, stopping at the scratch boundary if we run into it.
    const maxSlot = startSlot < badStartSlot ? badStartSlot - 1 : lastSlot
    await this.writeManifest(input.outputDir, startSlot, startSlot)
    this.active = { outputDir: input.outputDir, fromSlot: startSlot, latest: startSlot, maxSlot, handle }

    return { manifestPath, handle }
  }

  async produceThrough(slotNumber: number): Promise<void> {
    const active = this.active
    if (!active || active.handle.hasExited()) return
    const latest = Math.min(active.maxSlot, Math.max(active.latest, slotNumber))
    if (latest === active.latest) return
    await this.writeManifest(active.outputDir, active.fromSlot, latest)
    active.latest = latest
  }

  async dispose(): Promise<void> {
  }

  /** Distinct resume points VLC was restarted at, in call order. */
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

  private async writeManifest(outputDir: string, fromSlot: number, toSlot: number): Promise<void> {
    const slots: number[] = []
    for (let slot = fromSlot; slot <= toSlot; slot += 1) {
      slots.push(slot)
      await writeFile(join(outputDir, formatSegmentName(slot)), Buffer.from([0x47, 0x40, 0x00, 0x10]))
    }

    const manifest = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      `#EXT-X-MEDIA-SEQUENCE:${fromSlot}`,
      ...slots.flatMap((slot) => ['#EXTINF:2,', formatSegmentName(slot)]),
      '',
    ].join('\n')
    await writeFile(join(outputDir, 'index.m3u8'), manifest, 'utf8')
  }
}

class IntervalHandle implements ManagedProcessHandle {
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

  async stop(): Promise<CompletedProcess> {
    this.exited = true
    return { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: this.stderr }
  }

  hasExited(): boolean { return this.exited }
}

describe('SessionManager bad-sector recovery', () => {
  it('fills an unreadable region with placeholders one slot at a time and never skips ahead', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-bad-fill-'))
    const events: Array<{ type: string; payload: unknown }> = []
    const worker = new ScratchedDiscWorker(8, 14, 40)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      playbackRecovery: {
        stallTimeoutMs: 60,
        monitorIntervalMs: 15,
        restartReadinessTimeoutMs: 500,
        readRetryAttempts: 3,
        maxAttempts: 6,
        segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
      },
      onSessionEvent(event) {
        events.push(event)
      },
    })

    try {
      const session = await manager.start({
        discId: 'fake-disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 40,
      })
      expect(session.state).toBe('ready')
      await time.waitForScheduledTask()
      await worker.produceThrough(4)

      // Drive the monitor and producer explicitly until the scratch [8s, 14s)
      // has been fully filled and playback resumes.
      for (let tick = 0; tick < 100; tick += 1) {
        await time.advanceBy(15)
        if (worker.starts.at(-1)?.initialSegmentNumber === 8) await worker.produceThrough(20)
        const recovery = manager.getSession(session.id)?.recovery
        if (recovery?.status === 'idle' && recovery.skippedSeconds === 6) break
      }

      const recovered = manager.getSession(session.id)
      expect(recovered?.state).toBe('ready')
      // Exactly the scratch length was filled — not a 30-minute leap.
      expect(recovered?.recovery?.skippedSeconds).toBe(6)
      expect(recovered?.recovery?.badRanges).toEqual([
        { startSeconds: 8, endSeconds: 14, reason: 'dvd-read-stall' },
      ])

      // Every advertised placeholder resolves through the same interface as playback.
      for (const name of ['segment-000005.ts', 'segment-000006.ts', 'segment-000007.ts']) {
        expect(await manager.readStreamAsset(session.id, name, { generation: 'placeholder' })).not.toBeNull()
      }

      // The anti-runaway invariant: after playing up to the scratch at 8s, the
      // server only ever advanced the resume point one 2s slot at a time.
      expect(worker.resumePoints()).toEqual([0, 8, 10, 12, 14])

      // The region the browser plays carries the placeholders inline and stays
      // contiguous and correctly timed across the whole scratch.
      const regionManifest = manager.getRegionManifest(session.id) ?? ''
      expect(regionManifest).toContain('segment-000004.ts')
      expect(regionManifest).toContain('segment-000005.ts')
      expect(regionManifest).toContain('segment-000007.ts')
      expect(regionManifest).toContain('segment-000008.ts')

      // The retry phase reported the disc read error VLC surfaced.
      const retryEvent = events.find((event) => {
        const payload = event.payload as { message?: string } | undefined
        return event.type === 'session.recovery'
          && typeof payload?.message === 'string'
          && payload.message.includes('Retrying read')
          && payload.message.includes('disc read error')
      })
      expect(retryEvent).toBeDefined()

      // The whole 40s title is cached and exposed as a complete VOD, total
      // duration intact despite the scratch.
      expect(recovered?.recovery?.lastGoodTimeSeconds).toBeGreaterThanOrEqual(40)
      const stitched = manager.getStitchedManifest(session.id) ?? ''
      expect(stitched).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
      expect(stitched).toContain('#EXT-X-ENDLIST')
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  })

  it('abandons an in-progress bad-sector fill when the user seeks to a clean area', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-seek-clean-'))
    const worker = new ScratchedDiscWorker(8, 14, 40)
    const time = new ManualPlaybackTime()
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      time,
      playbackRecovery: {
        stallTimeoutMs: 60,
        monitorIntervalMs: 15,
        restartReadinessTimeoutMs: 500,
        readRetryAttempts: 3,
        maxAttempts: 6,
        segmentDurationSeconds: SEGMENT_DURATION_SECONDS,
      },
    })

    try {
      const session = await manager.start({
        discId: 'fake-disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 40,
      })
      await time.waitForScheduledTask()
      await worker.produceThrough(4)

      // Let it hit the scratch and begin filling it.
      for (let tick = 0; tick < 100; tick += 1) {
        await time.advanceBy(15)
        if ((manager.getSession(session.id)?.recovery?.skippedSeconds ?? 0) >= 2) break
      }
      expect(manager.getSession(session.id)?.recovery?.skippedSeconds).toBeGreaterThanOrEqual(2)

      // Seek forward to a clean, unbuffered area (24s, past the scratch). This
      // opens a brand-new region anchored at the target and abandons the bad run.
      const seekResult = await manager.seek(session.id, { positionSeconds: 24 })
      expect(seekResult).toMatchObject({ ok: true, action: 'restarted', positionSeconds: 24 })
      expect(worker.starts.at(-1)?.startTimeSeconds).toBe(24)

      // The region is now anchored at the seek target...
      expect(manager.getSession(session.id)?.timeline?.currentRange.startSeconds).toBe(24)
      const filledAtSeek = manager.getSession(session.id)?.recovery?.skippedSeconds ?? 0
      expect(filledAtSeek).toBeGreaterThanOrEqual(2)
      expect(filledAtSeek).toBeLessThanOrEqual(6)
      await worker.produceThrough(20)
      await time.advanceBy(15)

      // ...and playback runs cleanly to the end. Because we jumped past the
      // scratch, the abandoned bad run stops growing — no further fills happen.
      const recovery = manager.getSession(session.id)?.recovery
      expect(recovery?.status).toBe('idle')
      expect(recovery?.skippedSeconds).toBe(filledAtSeek)
    } finally {
      await worker.dispose()
      await manager.stopAll()
    }
  })
})

function formatSegmentName(slotNumber: number): string {
  return `segment-${String(slotNumber).padStart(6, '0')}.ts`
}
