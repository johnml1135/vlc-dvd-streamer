import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VlcWorker } from '../../../src/vlc/worker.js'

describe('VlcWorker HLS session lifetime', () => {
  it('does not apply the probe timeout to a long-lived HLS session', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-hls-lifetime-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      drive: 'D:',
      timeoutMs: 50,
    })

    const runtime = await worker.startHlsSession({
      drive: 'D:',
      titleNumber: 1,
      outputDir,
      baseUrl: '/streams/test/',
      audioTrack: 1,
    })

    const status = await Promise.race([
      runtime.handle.completion.then(() => 'exited' as const),
      delay(250).then(() => 'pending' as const),
    ])

    expect(status).toBe('pending')

    await runtime.handle.stop()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}