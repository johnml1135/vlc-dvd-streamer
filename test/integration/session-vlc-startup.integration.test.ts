import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'
import type { ServerLog } from '../../src/logging/server-log.js'

describe('VLC startup diagnostics', () => {
  it('logs silent startup progress and fails a hung VLC within the readiness timeout', async () => {
    const cacheDir = await mkdtemp(join(process.cwd(), '.cache', 'session-hang-silent-'))
    const lines: string[] = []
    const logger = {
      info: (_area: string, message: string) => lines.push(message),
      warn: (_area: string, message: string) => lines.push(message),
      error: (_area: string, message: string) => lines.push(message),
    } as unknown as ServerLog
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      readinessTimeoutMs: 250,
      startupProgressIntervalMs: 40,
      logger,
      worker: new VlcWorker({
        executable: process.execPath,
        drive: 'D:',
        timeoutMs: 5000,
        cacheDir,
        shimScript: 'test/fixtures/fake-vlc.ts',
        shimEnv: { FAKE_VLC_PROFILE: 'hang-silent' },
      }),
    })

    try {
      const session = await manager.start({ discId: 'fake-disc', drive: 'D:', titleNumber: 1 })
      const progress = lines.find((line) => /still waiting for first HLS segment/i.test(line))

      expect(session.state).toBe('failed')
      expect(session.error?.detail).toMatch(/still running/i)
      expect(session.error?.detail).toMatch(/stderr tail/i)
      expect(session.error?.detail).toMatch(/pid \d+/i)
      expect(progress).toMatch(/VLC pid \d+/i)
      expect(progress).toMatch(/stderr tail/i)
    } finally {
      await manager.stopAll()
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
