import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'

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
        return recovery?.epoch === 1 && recovery.status === 'idle'
      }, 2500)

      const recovered = manager.getSession(session.id)
      expect(recovered?.state).toBe('ready')
      expect(recovered?.recovery).toMatchObject({
        status: 'idle',
        epoch: 1,
        skippedSeconds: 10,
      })
      expect(recovered?.recovery?.badRanges[0]).toMatchObject({
        startSeconds: 2,
        endSeconds: 12,
      })
      const recoveredEvent = events.find((event) => {
        const payload = event.payload as { status?: string; epoch?: number } | undefined
        return event.type === 'session.recovery' && payload?.status === 'idle' && payload.epoch === 1
      })
      expect(recoveredEvent?.payload).toMatchObject({
        session: {
          id: session.id,
          timeline: {
            currentRange: { startSeconds: 12 },
          },
        },
      })
      expect(recoveredEvent?.payload).not.toHaveProperty('session.outputDir')
      await access(join(recovered?.outputDir ?? '', 'segment-000007.ts'))
    } finally {
      await manager.stopAll()
    }
  }, 5000)
})

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