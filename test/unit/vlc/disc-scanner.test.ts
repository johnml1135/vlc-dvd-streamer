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
    })

    const scan = await scanner.scanDisc({
      onProgress: (nextProgress) => progress.push(nextProgress),
    })

    expect(scan.drive).toBe('F:')
    expect(scan.discId).toMatch(/^disc-[a-f0-9]{12}$/)
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
    })

    await expect(scanner.scanDisc()).rejects.toThrow(/cannot decrypt disc title table/i)
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