import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'

describe('SessionManager', () => {
  it('starts, reuses, replaces, and stops the active session', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      drive: 'D:',
      timeoutMs: 5000,
    })
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
    })

    const first = await manager.start({
      discId: 'fake-disc-001',
      drive: 'D:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 1,
    })

    const reused = await manager.start({
      discId: 'fake-disc-001',
      drive: 'D:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 1,
    })

    const replacement = await manager.start({
      discId: 'fake-disc-001',
      drive: 'D:',
      titleNumber: 2,
      audioTrack: 1,
      subtitleTrack: undefined,
    })

    expect(first.state).toBe('ready')
    expect(reused.id).toBe(first.id)
    expect(replacement.id).not.toBe(first.id)
    expect(await stat(replacement.outputDir)).toBeDefined()
    expect(manager.getSession(first.id)?.state).toBe('stopped')

    const stopped = await manager.stop(replacement.id)

    expect(stopped).toBe(true)
    expect(manager.getSession(replacement.id)?.state).toBe('stopped')
  })
})