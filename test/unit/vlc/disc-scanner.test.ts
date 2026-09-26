import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VlcDiscScanner } from '../../../src/vlc/disc-scanner.js'
import type { CommandSpec } from '../../../src/vlc/command-spec.js'
import type { CompletedProcess } from '../../../src/vlc/process-supervisor.js'

describe('VlcDiscScanner', () => {
  it('scans title metadata through an injected process runner and reports progress', async () => {
    const progress: Array<{ scannedTitles: number; totalTitles: number | null; currentTitleNumber: number | null }> = []
    const runProcess = vi.fn(async (command: CommandSpec) => {
      if (command.label === 'vlc-disc-probe') {
        return completed({
          stderr: [
            'main input debug: attempt to destroy nonexistent variable "title  1"',
            'main input debug: attempt to destroy nonexistent variable "title  2"',
          ].join('\n'),
        })
      }

      if (command.label.startsWith('vlc-title-probe-')) {
        const titleNumber = command.label.includes('-2-') ? 2 : 1
        return completed({
          stderr: [
            `main input debug: \`dvd:///F:/#${titleNumber}\' successfully opened`,
            `dvdnav demux debug:      - pgc_length=${titleNumber === 1 ? 649107000 : 59400000}`,
            'dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
            'dvdnav demux debug:      - physical=0',
          ].join('\n'),
        })
      }

      if (command.label.startsWith('vlc-track-metadata-')) {
        return completed({
          stdout: JSON.stringify({
            mediaTracks: [{ id: 0, type: 0, language: 'en', description: null }],
            audio: [],
            subtitles: [],
          }),
        })
      }

      throw new Error(`Unexpected command ${command.label}`)
    })
    const scanner = new VlcDiscScanner({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
      trackMetadataScript: 'scripts/windows/query-vlc-track-descriptions.ps1',
      runProcess,
      // Force the VLC-probe fallback path for this test.
      readIfoTitles: async () => {
        throw new Error('no IFO available')
      },
      readDiscIdentity: async () => `disc-${'a'.repeat(64)}`,
    })

    const scan = await scanner.scanDisc({
      onProgress: (nextProgress) => progress.push(nextProgress),
    })

    expect(scan.drive).toBe('F:')
    expect(scan.discId).toMatch(/^disc-[a-f0-9]{64}$/)
    expect(scan.titles).toEqual([
      {
        titleNumber: 1,
        durationSeconds: 7212,
        audioTracks: [{ id: 0, label: 'English' }],
        subtitleTracks: [],
      },
      {
        titleNumber: 2,
        durationSeconds: 660,
        audioTracks: [{ id: 0, label: 'English' }],
        subtitleTracks: [],
      },
    ])
    expect(progress).toEqual([
      { scannedTitles: 0, totalTitles: 2, currentTitleNumber: 1 },
      { scannedTitles: 1, totalTitles: 2, currentTitleNumber: 2 },
      { scannedTitles: 2, totalTitles: 2, currentTitleNumber: null },
    ])
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ label: 'vlc-disc-probe' }))
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ label: 'vlc-title-probe-1-en' }))
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ label: 'vlc-track-metadata-1' }))
  })

  it('includes disc probe output when VLC exposes no playable title numbers', async () => {
    const scanner = new VlcDiscScanner({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
      runProcess: async () => completed({
        stderr: 'dvdnav warning: cannot decrypt disc title table',
      }),
      readIfoTitles: async () => {
        throw new Error('no IFO available')
      },
      readDiscIdentity: async () => `disc-${'a'.repeat(64)}`,
    })

    await expect(scanner.scanDisc()).rejects.toThrow(/cannot decrypt disc title table/i)
  })

  it('reads titles from IFO files without launching VLC when VIDEO_TS is readable', async () => {
    const runProcess = vi.fn(async () => completed({}))
    const scanner = new VlcDiscScanner({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
      runProcess,
      readIfoTitles: async (videoTsDir) => {
        expect(videoTsDir).toBe('F:/VIDEO_TS')
        return {
          titles: [

          { titleNumber: 1, durationSeconds: 8340, angleCount: 1, chapterCount: 52, audioTracks: [{ id: 0, label: 'English' }], subtitleTracks: [{ id: 0, label: 'English' }] },
          { titleNumber: 2, durationSeconds: 153, angleCount: 1, chapterCount: 2, audioTracks: [{ id: 0, label: 'English' }], subtitleTracks: [] },
          ],
          expectedTitleCount: 2,
          skippedTitleNumbers: [],
        }
      },
      readDiscIdentity: async () => `disc-${'b'.repeat(64)}`,
    })

    const scan = await scanner.scanDisc()

    expect(runProcess).not.toHaveBeenCalled()
    expect(scan.drive).toBe('F:')
    expect(scan.discId).toMatch(/^disc-[a-f0-9]{64}$/)
    expect(scan.titles).toEqual([
      { titleNumber: 1, durationSeconds: 8340, audioTracks: [{ id: 0, label: 'English' }], subtitleTracks: [{ id: 0, label: 'English' }] },
      { titleNumber: 2, durationSeconds: 153, audioTracks: [{ id: 0, label: 'English' }], subtitleTracks: [] },
    ])
  })

  it('rejects shim scan payloads that do not match the disc metadata shape', async () => {
    const scanner = new VlcDiscScanner({
      executable: 'node',
      drive: 'D:',
      timeoutMs: 5000,
      shimScript: 'test/fixtures/fake-vlc.ts',
      runProcess: async () => completed({
        stdout: '{"discId":123,"drive":"D:","titles":"nope"}',
      }),
    })

    await expect(scanner.scanDisc()).rejects.toThrow(/valid disc metadata/i)
  })
})

function completed(overrides: Partial<CompletedProcess> = {}): CompletedProcess {
  return {
    ok: true,
    timedOut: false,
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}
describe('VlcDiscScanner incomplete IFO fallback', () => {
  it('falls back to VLC when the IFO reader skips a title-table entry', async () => {
    const runProcess = vi.fn(async (command: CommandSpec) => {
      if (command.label === 'vlc-disc-probe') {
        return completed({ stderr: 'main input debug: attempt to destroy nonexistent variable "title  1"' })
      }
      if (command.label.startsWith('vlc-title-probe-')) {
        return completed({ stderr: [
          'main input debug: `dvd:///D:/#1\' successfully opened',
          'dvdnav demux debug:      - pgc_length=649107000',
          'dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
          'dvdnav demux debug:      - physical=0',
        ].join('\n') })
      }
      throw new Error(`Unexpected command ${command.label}`)
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const scanner = new VlcDiscScanner({
      executable: 'vlc.exe',
      drive: 'D:',
      timeoutMs: 30000,
      runProcess,
      logger,
      readDiscIdentity: async () => `disc-${'c'.repeat(64)}`,
      readIfoTitles: async () => ({
        titles: [{ titleNumber: 1, durationSeconds: 10, angleCount: 1, chapterCount: 1, audioTracks: [], subtitleTracks: [] }],
        expectedTitleCount: 2,
        skippedTitleNumbers: [2],
      }),
    })

    const scan = await scanner.scanDisc()

    expect(logger.warn).toHaveBeenCalledWith('catalog', expect.stringContaining('incomplete'))
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ label: 'vlc-disc-probe' }))
    expect(scan.titles.map((title) => title.titleNumber)).toEqual([1])
  })
})

describe('VlcDiscScanner disc identity', () => {
  it('recognizes the same IFO contents across paths and distinguishes different IFO contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-disc-identity-'))
    const firstDrive = join(root, 'drive-a')
    const secondDrive = join(root, 'drive-b')
    await writeSyntheticDvd(firstDrive, 7)
    await writeSyntheticDvd(secondDrive, 7)

    const firstScan = await scanIfoDisc(firstDrive)
    const movedScan = await scanIfoDisc(secondDrive)
    expect(movedScan.discId).toBe(firstScan.discId)

    await writeSyntheticDvd(firstDrive, 9)
    const differentDisc = await scanIfoDisc(firstDrive)
    expect(differentDisc.titles).toEqual(firstScan.titles)
    expect(differentDisc.discId).not.toBe(firstScan.discId)
  })
})

describe('VlcDiscScanner scan deadline', () => {
  it('stops launching title probes when the fallback scan-wide deadline expires', async () => {
    let now = 0
    const runProcess = vi.fn(async (command: CommandSpec) => {
      if (command.label === 'vlc-disc-probe') {
        now += 2
        const titles = Array.from({ length: 50 }, (_, index) => index + 1)
          .map((title) => `main input debug: attempt to destroy nonexistent variable "title  ${title}"`)
          .join('\n')
        return completed({ stderr: titles })
      }
      if (command.label.startsWith('vlc-title-probe-')) {
        now += 5
        const titleNumber = Number(command.label.match(/vlc-title-probe-(\d+)-/)?.[1] ?? 1)
        return completed({ stderr: [
          `main input debug: \`dvd:///D:/#${titleNumber}' successfully opened`,
          'dvdnav demux debug:      - pgc_length=60000000',
        ].join('\n') })
      }
      throw new Error(`Unexpected command ${command.label}`)
    })
    const scanner = new VlcDiscScanner({
      executable: 'vlc.exe',
      drive: 'D:',
      timeoutMs: 30000,
      scanDeadlineMs: 5,
      now: () => now,
      runProcess,
      readIfoTitles: async () => { throw new Error('force VLC fallback') },
      readDiscIdentity: async () => `disc-${'d'.repeat(64)}`,
    })

    await expect(scanner.scanDisc()).rejects.toThrow(/DVD scan exceeded its overall 5 ms deadline/i)
    expect(runProcess.mock.calls.map(([command]) => command.label)).toEqual(['vlc-disc-probe', 'vlc-title-probe-1-en'])
    expect(runProcess.mock.calls[1]?.[0].timeoutMs).toBe(3)
  })

  it('fails immediately with an actionable message when VLC reports a drive lock', async () => {
    const runProcess = vi.fn(async () => completed({ stderr: 'dvdnav error: Device is busy because another program owns the DVD drive.' }))
    const scanner = new VlcDiscScanner({
      executable: 'vlc.exe',
      drive: 'D:',
      timeoutMs: 30000,
      runProcess,
      readIfoTitles: async () => { throw new Error('no readable IFO') },
      readDiscIdentity: async () => `disc-${'e'.repeat(64)}`,
    })

    await expect(scanner.scanDisc()).rejects.toThrow('The DVD drive is in use by another program')
    expect(runProcess).toHaveBeenCalledOnce()
  })
})

async function scanIfoDisc(drive: string) {
  const scanner = new VlcDiscScanner({
    executable: 'vlc',
    drive,
    timeoutMs: 30000,
    runProcess: async () => { throw new Error('IFO scan must not launch VLC') },
  })
  return scanner.scanDisc()
}

async function writeSyntheticDvd(drive: string, identityByte: number): Promise<void> {
  const videoTs = join(drive, 'VIDEO_TS')
  await mkdir(videoTs, { recursive: true })

  const vmgi = Buffer.alloc(4096)
  vmgi.write('DVDVIDEO-VMG', 0, 'latin1')
  vmgi.writeUInt32BE(1, 0xc4)
  vmgi.writeUInt16BE(1, 2048)
  vmgi.writeUInt8(1, 2048 + 9)
  vmgi.writeUInt16BE(1, 2048 + 10)
  vmgi.writeUInt8(1, 2048 + 14)
  vmgi.writeUInt8(1, 2048 + 15)
  await writeFile(join(videoTs, 'VIDEO_TS.IFO'), vmgi)

  const vtsi = Buffer.alloc(8192)
  vtsi.write('DVDVIDEO-VTS', 0, 'latin1')
  vtsi.writeUInt32BE(1, 0xc8)
  vtsi.writeUInt16BE(1, 2048)
  vtsi.writeUInt32BE(12, 2048 + 8)
  vtsi.writeUInt16BE(1, 2048 + 12)
  vtsi.writeUInt32BE(2, 0xcc)
  vtsi.writeUInt16BE(1, 4096)
  vtsi.writeUInt32BE(28, 4096 + 8 + 4)
  vtsi.writeUInt8(0, 4096 + 32)
  vtsi.writeUInt8(1, 4096 + 33)
  vtsi.writeUInt8(0, 4096 + 34)
  vtsi.writeUInt8(identityByte, vtsi.length - 1)
  await writeFile(join(videoTs, 'VTS_01_0.IFO'), vtsi)
}
