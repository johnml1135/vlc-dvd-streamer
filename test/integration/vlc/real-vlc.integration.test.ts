import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ServerLog } from '../../../src/logging/server-log.js'
import { SessionManager } from '../../../src/session/session-manager.js'
import { VlcDiscScanner } from '../../../src/vlc/disc-scanner.js'
import { runManagedProcess, type ManagedProcessHandle } from '../../../src/vlc/process-supervisor.js'
import { VlcWorker } from '../../../src/vlc/worker.js'

const root = process.cwd()
const fixtureDir = resolve(root, 'test/fixtures/dvd')
const fixtureVideoTsDir = join(fixtureDir, 'VIDEO_TS')
const vlcPath = [
  process.env.VLC_PATH,
  'C:/Program Files/VideoLAN/VLC/vlc.exe',
  'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe',
].find((candidate) => candidate && existsSync(candidate))

if (!vlcPath) {
  console.info('SKIP real-VLC suite: VLC_PATH and the default VLC.exe locations were not found.')
}

describe.skipIf(!vlcPath)('real VLC with the synthetic DVD folder', () => {
  it('scans fixture IFO tracks and creates a valid placeholder TS and thumbnail', async () => {
    const cacheDir = await makeCacheDir('real-vlc-assets-')
    const worker = createWorker(cacheDir)
    try {
      const scan = await worker.scanDisc({ drive: fixtureDir })
      expect(scan.drive).toBe(fixtureDir)
      expect(scan.titles.map((title) => title.durationSeconds)).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]))
      expect(scan.titles).toHaveLength(2)
      expect(scan.titles[0]?.durationSeconds).toBeGreaterThanOrEqual(18)
      expect(scan.titles[0]?.durationSeconds).toBeLessThanOrEqual(20)
      expect(scan.titles[0]?.audioTracks.map((track) => track.label)).toEqual(['English', 'French'])
      expect(scan.titles[0]?.subtitleTracks).toEqual([{ id: 0, label: 'English' }])

      const placeholderDir = join(cacheDir, 'placeholder')
      await worker.generatePlaceholderSegment({ outputDir: placeholderDir })
      const placeholder = await readFile(join(placeholderDir, 'placeholder.ts'))
      expect(placeholder.length).toBeGreaterThan(188)
      for (let offset = 0; offset < placeholder.length; offset += 188) expect(placeholder[offset]).toBe(0x47)

      const thumbnailDir = join(cacheDir, 'thumbnail')
      const thumbnail = await worker.generateThumbnail({
        drive: fixtureDir,
        titleNumber: 1,
        outputDir: thumbnailDir,
        startTimeSeconds: 2,
        runTimeSeconds: 2,
      })
      await expect(access(thumbnail.outputPath)).resolves.toBeUndefined()
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 30000)

  it('starts HLS on the two-second slot grid, seeks, selects tracks, and stops VLC', async () => {
    const cacheDir = await makeCacheDir('real-vlc-session-')
    const handles: ManagedProcessHandle[] = []
    const worker = createWorker(cacheDir)
    const trackingWorker = {
      startHlsSession: async (input: Parameters<VlcWorker['startHlsSession']>[0]) => {
        const result = await worker.startHlsSession(input)
        handles.push(result.handle)
        return result
      },
      generatePlaceholderSegment: (input: Parameters<VlcWorker['generatePlaceholderSegment']>[0]) => worker.generatePlaceholderSegment(input),
    }
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60000,
      readinessTimeoutMs: 30000,
      playbackRecovery: { enabled: false },
      worker: trackingWorker,
    })
    let session: Awaited<ReturnType<typeof manager.start>> | undefined
    try {
      session = await manager.start({
        discId: 'synthetic-dvd-fixture',
        drive: fixtureDir,
        titleNumber: 1,
        durationSeconds: 19,
        audioTrack: 1,
        subtitleTrack: 0,
      })
      expect(session.state, session.error?.detail).toBe('ready')
      expect(session.audioTrack).toBe(1)
      expect(session.subtitleTrack).toBe(0)
      assertTwoSecondGrid(await readFile(session.manifestPath, 'utf8'), 1)

      const seek = await manager.seek(session.id, { positionSeconds: 10 })
      expect(seek.ok, seek.ok ? '' : seek.message).toBe(true)
      if (!seek.ok) return
      session = seek.session
      expect(seek.action).toBe('restarted')
      assertTwoSecondGrid(await readFile(session.manifestPath, 'utf8'), 6)
      expect(handles[0]?.hasExited?.()).toBe(true)
    } finally {
      await manager.stopAll()
      expect(handles.length).toBeGreaterThan(0)
      expect(handles.every((handle) => handle.hasExited?.() === true)).toBe(true)
      if (session) await expect(access(session.outputDir)).rejects.toThrow()
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 90000)

  it('fails quickly and logs a missing folder source without leaving VLC open', async () => {
    const cacheDir = await makeCacheDir('real-vlc-missing-')
    const missingSource = join(cacheDir, 'missing-synthetic-dvd')
    const logger = new ServerLog()
    const scanner = new VlcDiscScanner({
      executable: vlcPath!,
      drive: missingSource,
      timeoutMs: 10000,
      cacheDir,
      logger,
      runProcess: (spec) => runManagedProcess({ ...spec, timeoutMs: 7000 }),
    })
    const startedAt = Date.now()
    try {
      await expect(scanner.scanDisc()).rejects.toThrow()
      expect(Date.now() - startedAt).toBeLessThan(10000)
      expect(logger.list().some((entry) => /DVD scan failed/i.test(entry.message))).toBe(true)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 15000)
})

function createWorker(cacheDir: string): VlcWorker {
  if (!vlcPath) throw new Error('The real VLC executable is unavailable.')
  return new VlcWorker({ executable: vlcPath, drive: fixtureDir, timeoutMs: 15000, cacheDir })
}

async function makeCacheDir(prefix: string): Promise<string> {
  const cacheRoot = join(root, '.cache')
  return mkdtemp(join(cacheRoot, prefix))
}

function assertTwoSecondGrid(manifest: string, firstSegment: number): void {
  const durations = [...manifest.matchAll(/#EXTINF:([0-9.]+)/g)].map((match) => Number(match[1]))
  const segmentNumbers = [...manifest.matchAll(/segment-(\d+)\.ts/g)].map((match) => Number(match[1]))
  expect(durations.length).toBeGreaterThan(0)
  expect(durations.every((duration) => duration >= 1.8 && duration <= 2.2)).toBe(true)
  expect(segmentNumbers).toContain(firstSegment)
  expect(segmentNumbers[0]).toBe(firstSegment)
}
