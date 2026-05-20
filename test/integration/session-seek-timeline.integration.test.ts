import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput } from '../../src/vlc/worker.js'

describe('SessionManager seek timeline', () => {
  it('does not restart VLC when the requested title time is already in the current HLS window', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-seek-current-'))
    const starts: StartHlsSessionInput[] = []
    const handles: FakeHandle[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      playbackRecovery: { enabled: false, segmentDurationSeconds: 2 },
      worker: {
        async startHlsSession(input) {
          starts.push(input)
          await writeHlsWindow(input.outputDir, input.initialSegmentNumber ?? 1, 4)
          const handle = new FakeHandle()
          handles.push(handle)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
        },
      },
    })

    try {
      const session = await manager.start({
        discId: 'disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 120,
      })

      const result = await manager.seek(session.id, { positionSeconds: 4 })

      expect(result).toMatchObject({ ok: true, action: 'already-available' })
      expect(starts).toHaveLength(1)
      expect(handles[0]?.stopCalls).toBe(0)
      expect(manager.getSession(session.id)?.timeline?.currentRange).toEqual({ startSeconds: 0, endSeconds: 8 })
    } finally {
      await manager.stopAll()
    }
  })

  it('restarts VLC at an absolute segment number and stitches generated ranges', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-seek-restart-'))
    const starts: StartHlsSessionInput[] = []
    const handles: FakeHandle[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      playbackRecovery: { enabled: false, segmentDurationSeconds: 2 },
      worker: {
        async startHlsSession(input) {
          starts.push(input)
          await writeHlsWindow(input.outputDir, input.initialSegmentNumber ?? 1, 4)
          const handle = new FakeHandle()
          handles.push(handle)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
        },
      },
    })

    try {
      const session = await manager.start({
        discId: 'disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 120,
      })

      const result = await manager.seek(session.id, { positionSeconds: 20 })

      expect(result).toMatchObject({ ok: true, action: 'restarted' })
      expect(starts).toHaveLength(2)
      expect(starts[1]).toMatchObject({
        startTimeSeconds: 20,
        initialSegmentNumber: 11,
      })
      expect(handles[0]?.stopCalls).toBe(1)
      expect(manager.getSession(session.id)?.timeline).toMatchObject({
        durationSeconds: 120,
        currentRange: { startSeconds: 20, endSeconds: 28 },
        generatedRanges: [
          { startSeconds: 0, endSeconds: 8 },
          { startSeconds: 20, endSeconds: 28 },
        ],
      })

      const stitchedManifest = manager.getStitchedManifest(session.id)
      expect(stitchedManifest).toContain('segment-000001.ts')
      expect(stitchedManifest).toContain('#EXT-X-DISCONTINUITY')
      expect(stitchedManifest).toContain('segment-000011.ts')
    } finally {
      await manager.stopAll()
    }
  })

  it('restarts VLC and tracking state through consecutive multi-step seeks', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-seek-multi-'))
    const starts: StartHlsSessionInput[] = []
    const handles: FakeHandle[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      playbackRecovery: { enabled: false, segmentDurationSeconds: 2 },
      worker: {
        async startHlsSession(input) {
          starts.push(input)
          await writeHlsWindow(input.outputDir, input.initialSegmentNumber ?? 1, 4)
          const handle = new FakeHandle()
          handles.push(handle)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle }
        },
      },
    })

    try {
      const session = await manager.start({
        discId: 'disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 120,
      })

      // Step 1: seek to 20
      const result1 = await manager.seek(session.id, { positionSeconds: 20 })
      expect(result1).toMatchObject({ ok: true, action: 'restarted' })

      // Step 2: seek to 40
      const result2 = await manager.seek(session.id, { positionSeconds: 40 })
      expect(result2).toMatchObject({ ok: true, action: 'restarted' })

      // Step 3: seek to 60
      const result3 = await manager.seek(session.id, { positionSeconds: 60 })
      expect(result3).toMatchObject({ ok: true, action: 'restarted' })

      expect(starts).toHaveLength(4)
      expect(starts[3]).toMatchObject({
        startTimeSeconds: 60,
        initialSegmentNumber: 31,
      })

      expect(manager.getSession(session.id)?.timeline).toMatchObject({
        durationSeconds: 120,
        currentRange: { startSeconds: 60, endSeconds: 68 },
        generatedRanges: [
          { startSeconds: 0, endSeconds: 8 },
          { startSeconds: 20, endSeconds: 28 },
          { startSeconds: 40, endSeconds: 48 },
          { startSeconds: 60, endSeconds: 68 },
        ],
      })

      const stitchedManifest = manager.getStitchedManifest(session.id)
      expect(stitchedManifest).toContain('segment-000001.ts')
      expect(stitchedManifest).toContain('#EXT-X-DISCONTINUITY')
      expect(stitchedManifest).toContain('segment-000011.ts')
      expect(stitchedManifest).toContain('segment-000021.ts')
      expect(stitchedManifest).toContain('segment-000031.ts')
    } finally {
      await manager.stopAll()
    }
  })
})

class FakeHandle implements ManagedProcessHandle {
  readonly pid = 1234
  stopCalls = 0
  readonly completion = new Promise<CompletedProcess>(() => {})

  getStdout(): string {
    return ''
  }

  getStderr(): string {
    return ''
  }

  async stop(): Promise<CompletedProcess> {
    this.stopCalls += 1
    return {
      ok: true,
      timedOut: false,
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
    }
  }
}

async function writeHlsWindow(outputDir: string, firstSegmentNumber: number, segmentCount: number): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const segmentNumbers = Array.from({ length: segmentCount }, (_unused, index) => firstSegmentNumber + index)
  for (const segmentNumber of segmentNumbers) {
    await writeFile(join(outputDir, formatSegmentName(segmentNumber)), Buffer.from([0x47, 0x40, 0x00, 0x10]))
  }

  const manifest = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${firstSegmentNumber}`,
    ...segmentNumbers.flatMap((segmentNumber) => ['#EXTINF:2,', formatSegmentName(segmentNumber)]),
    '',
  ].join('\n')
  await writeFile(join(outputDir, 'index.m3u8'), manifest, 'utf8')
}

function formatSegmentName(segmentNumber: number): string {
  return `segment-${String(segmentNumber).padStart(6, '0')}.ts`
}