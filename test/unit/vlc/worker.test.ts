import { describe, expect, it } from 'vitest'
import { VlcWorker } from '../../../src/vlc/worker.js'

describe('VlcWorker scan args', () => {
  it('prefers English audio and subtitle languages during metadata probes', () => {
    const worker = new VlcWorker({
      executable: 'vlc',
      drive: 'D:',
      timeoutMs: 1000,
    })

    const args = (worker as unknown as { buildScanArgs: (mrl: string) => string[] }).buildScanArgs('dvd:///D:/#1')

    expect(args).toContain('--audio-language=en')
    expect(args).toContain('--sub-language=en')
  })
})