import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runManagedProcess } from '../../../src/vlc/process-supervisor.js'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'

describe('fake VLC integration', () => {
  it('writes a deterministic manifest and segment for HLS mode', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-fake-vlc-'))

    const spec = createCommandSpec({
      executable: process.execPath,
      args: ['--import', 'tsx', 'test/fixtures/fake-vlc.ts', '--mode=hls', `--outDir=${outDir}`],
      timeoutMs: 5000,
      label: 'fake-vlc-hls',
    })

    const result = await runManagedProcess(spec)
    const manifest = await readFile(join(outDir, 'index.m3u8'), 'utf8')
    const segment = await readFile(join(outDir, 'segment-000.ts'))

    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('FAKE_VLC_DONE')
    expect(manifest).toContain('#EXTM3U')
    expect(segment[0]).toBe(0x47)
  })
})