import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import { VlcWorker } from '../../src/vlc/worker.js'
import type { StartHlsSessionInput } from '../../src/vlc/worker.js'

describe('SessionManager bad-sector recovery', () => {
  it('restarts a stalled VLC HLS session past the unreadable time range', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-bad-sector-recovery-'))
    const events: Array<{ type: string; payload: unknown }> = []
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: {
        FAKE_VLC_PROFILE: 'bad-sector-midplayback',
        FAKE_VLC_BAD_END_SECONDS: '12',
      },
      drive: 'D:',
      timeoutMs: 5000,
    })
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
      playbackRecovery: {
        stallTimeoutMs: 80,
        monitorIntervalMs: 20,
        restartReadinessTimeoutMs: 1000,
        skipSeconds: 10,
        maxAttempts: 2,
        segmentDurationSeconds: 2,
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
        audioTrack: 1,
        subtitleTrack: 1,
      })

      expect(session.state).toBe('ready')

      await waitFor(() => {
        const recovery = manager.getSession(session.id)?.recovery
        return recovery?.status === 'idle' && recovery.badRanges.length === 1
      }, 3000)

      const recovered = manager.getSession(session.id)
      expect(recovered?.state).toBe('ready')
      expect(recovered?.recovery).toMatchObject({
        status: 'idle',
        epoch: 4,
        skippedSeconds: 10,
      })
      expect(recovered?.recovery?.badRanges[0]).toMatchObject({
        startSeconds: 8,
        endSeconds: 18,
      })
      const recoveredEvent = events.find((event) => {
        const payload = event.payload as { status?: string; epoch?: number } | undefined
        return event.type === 'session.recovery' && payload?.status === 'idle' && payload.epoch === 4
      })
      expect(recoveredEvent?.payload).toMatchObject({
        session: {
          id: session.id,
          timeline: {
            currentRange: { startSeconds: 18 },
          },
        },
      })
      expect(recoveredEvent?.payload).not.toHaveProperty('session.outputDir')
      await access(join(recovered?.outputDir ?? '', 'segment-000010.ts'))
    } finally {
      await manager.stopAll()
    }
  }, 5000)

  it('retries stalled reads before skipping and retries again after a manual seek back', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-bad-sector-retry-policy-'))
    const starts: StartHlsSessionInput[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      playbackRecovery: {
        stallTimeoutMs: 30,
        monitorIntervalMs: 10,
        restartReadinessTimeoutMs: 300,
        skipSeconds: 10,
        maxAttempts: 2,
        segmentDurationSeconds: 2,
      },
      worker: {
        async startHlsSession(input) {
          starts.push(input)
          await writeSingleSegmentWindow(input.outputDir, input.initialSegmentNumber ?? 1)
          return { manifestPath: join(input.outputDir, 'index.m3u8'), handle: new FakeHandle() }
        },
      },
    })

    try {
      const session = await manager.start({
        discId: 'fake-disc-001',
        drive: 'D:',
        titleNumber: 1,
        durationSeconds: 120,
      })

      await waitFor(() => starts.length >= 5, 2000)

      expect(starts.slice(1, 4).map((start) => start.startTimeSeconds)).toEqual([2, 4, 6])
      expect(starts[4]).toMatchObject({
        startTimeSeconds: 18,
        initialSegmentNumber: 10,
      })
      expect(manager.getSession(session.id)?.recovery?.badRanges[0]).toMatchObject({
        startSeconds: 8,
        endSeconds: 18,
      })

      const startsBeforeManualSeek = starts.length
      const seekResult = await manager.seek(session.id, { positionSeconds: 0 })

      expect(seekResult).toMatchObject({ ok: true, action: 'restarted', positionSeconds: 0 })
      expect(starts[startsBeforeManualSeek]).toMatchObject({
        startTimeSeconds: 0,
        initialSegmentNumber: 1,
      })

      await waitFor(() => starts.length >= startsBeforeManualSeek + 2, 2000)
      expect(starts[startsBeforeManualSeek + 1]).toMatchObject({
        startTimeSeconds: 2,
        initialSegmentNumber: 2,
      })
    } finally {
      await manager.stopAll()
    }
  })
})

class FakeHandle implements ManagedProcessHandle {
  readonly pid = 1234
  readonly completion = new Promise<CompletedProcess>(() => {})

  getStdout(): string {
    return ''
  }

  getStderr(): string {
    return ''
  }

  async stop(): Promise<CompletedProcess> {
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

async function writeSingleSegmentWindow(outputDir: string, segmentNumber: number): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, formatSegmentName(segmentNumber)), Buffer.from([0x47, 0x40, 0x00, 0x10]))

  const manifest = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${segmentNumber}`,
    '#EXTINF:2,',
    formatSegmentName(segmentNumber),
    '',
  ].join('\n')
  await writeFile(join(outputDir, 'index.m3u8'), manifest, 'utf8')
}

function formatSegmentName(segmentNumber: number): string {
  return `segment-${String(segmentNumber).padStart(6, '0')}.ts`
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('Timed out waiting for condition.')
}