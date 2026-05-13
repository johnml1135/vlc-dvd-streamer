import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'

describe('SessionManager damaged disc handling', () => {
  it('marks the session failed when VLC cannot produce a playable HLS stream', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-damaged-session-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: { FAKE_VLC_PROFILE: 'scratched-playback' },
      drive: 'D:',
      timeoutMs: 5000,
    })
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
    })

    const session = await manager.start({
      discId: 'fake-disc-001',
      drive: 'D:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 1,
    })

    expect(session.state).toBe('failed')
    expect(session.error?.detail).toMatch(/scratched|read error|playable/i)
  })
})
