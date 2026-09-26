import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VlcWorker } from '../../../src/vlc/worker.js'
import { buildHlsArgs, buildPlaceholderArgs, buildThumbnailArgs } from '../../../src/vlc/args.js'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'
import { runManagedProcess } from '../../../src/vlc/process-supervisor.js'
import { createVlcScratchDir, removeVlcScratchDir } from '../../../src/vlc/scratch.js'

describe('fake VLC integration', () => {
  it('receives the production HLS arguments and writes a live manifest', async () => {
    const outDir = await makeOutputDir('fake-hls-')
    const relativeOutDir = relative(process.cwd(), outDir)
    const argvPath = join(outDir, 'argv.json')
    const cwdPath = join(outDir, 'cwd.txt')
    const worker = new VlcWorker({
      executable: process.execPath,
      drive: 'D:',
      timeoutMs: 5000,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: { FAKE_VLC_ARGV_FILE: argvPath, FAKE_VLC_CWD_FILE: cwdPath },
    })

    const session = await worker.startHlsSession({
      drive: 'D:', titleNumber: 1, outputDir: relativeOutDir, baseUrl: '/stream/',
    })
    try {
      await waitForFile(join(outDir, 'index.m3u8'))
      const received = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
      const manifest = await readFile(join(outDir, 'index.m3u8'), 'utf8')

      expect(received).toEqual(buildHlsArgs({ drive: 'D:', titleNumber: 1, outputDir: resolve(relativeOutDir), baseUrl: '/stream/' }))
      expect((await readFile(cwdPath, 'utf8')).startsWith(outDir)).toBe(true)
      expect(manifest).toContain('#EXTINF:2,')
      expect(manifest).toContain('segment-000001.ts')
    } finally {
      await session.handle.stop()
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('receives the production thumbnail arguments', async () => {
    const outDir = await makeOutputDir('fake-thumbnail-')
    const relativeOutDir = relative(process.cwd(), outDir)
    const argvPath = join(outDir, 'argv.json')
    const worker = new VlcWorker({
      executable: process.execPath,
      drive: 'D:',
      timeoutMs: 5000,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: { FAKE_VLC_ARGV_FILE: argvPath },
    })

    try {
      const thumbnail = await worker.generateThumbnail({ drive: 'D:', titleNumber: 1, outputDir: relativeOutDir, startTimeSeconds: 2, runTimeSeconds: 2 })
      const received = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
      expect(received).toEqual(buildThumbnailArgs({
        drive: 'D:', titleNumber: 1, snapshotDir: resolve(relativeOutDir), snapshotPrefix: 'thumbnail', startTimeSeconds: 2, runTimeSeconds: 2,
      }))
      expect(thumbnail.outputPath).toBe(join(resolve(relativeOutDir), 'thumbnail.jpg'))
      expect((await readFile(join(outDir, 'thumbnail.jpg'))).byteLength).toBeGreaterThan(0)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('runs placeholder generation through the shim with production arguments', async () => {
    const outDir = await makeOutputDir('fake-placeholder-')
    const relativeOutDir = relative(process.cwd(), outDir)
    const argvPath = join(outDir, 'argv.json')
    const worker = new VlcWorker({
      executable: process.execPath,
      drive: 'D:',
      timeoutMs: 5000,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: { FAKE_VLC_ARGV_FILE: argvPath },
    })

    try {
      await worker.generatePlaceholderSegment({ outputDir: relativeOutDir })
      const received = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
      expect(received).toEqual(buildPlaceholderArgs({ outputPath: join(resolve(relativeOutDir), 'placeholder.ts') }))
      const transportStream = await readFile(join(outDir, 'placeholder.ts'))
      expect(transportStream[0]).toBe(0x47)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('rejects an undocumented option with VLC-style exit status and message', async () => {
    const cwd = await createVlcScratchDir(join(process.cwd(), '.cache'))
    try {
      const result = await runManagedProcess(createCommandSpec({
        executable: process.execPath,
        args: ['--import', 'tsx', resolve('test/fixtures/fake-vlc.ts'), '--fake-duration=2000'],
        cwd,
        timeoutMs: 5000,
        label: 'fake-vlc-unknown-option',
      }))
      expect(result.ok).toBe(false)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("unknown option or missing mandatory argument '--fake-duration'")
    } finally {
      await removeVlcScratchDir(cwd)
    }
  })
})

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function makeOutputDir(prefix: string): Promise<string> {
  const cacheDir = join(process.cwd(), '.cache')
  await mkdir(cacheDir, { recursive: true })
  return mkdtemp(join(cacheDir, prefix))
}
