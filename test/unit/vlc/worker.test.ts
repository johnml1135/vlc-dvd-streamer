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

  it('builds a PowerShell libVLC helper command for runtime track metadata enrichment', () => {
    const worker = new VlcWorker({
      executable: 'vlc',
      drive: 'D:',
      timeoutMs: 12000,
      trackMetadataScript: 'scripts/windows/query-vlc-track-descriptions.ps1',
    })

    const command = (worker as unknown as {
      buildTrackMetadataCommand: (drive: string, titleNumber: number) => {
        executable: string
        args: string[]
        timeoutMs: number
        label: string
      }
    }).buildTrackMetadataCommand('D:', 3)

    expect(command.executable.toLowerCase()).toContain('powershell')
    expect(command.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/windows/query-vlc-track-descriptions.ps1',
      '-Mrl',
      'dvd:///D:/#3',
      '-WaitSeconds',
      '12',
    ])
    expect(command.timeoutMs).toBe(24000)
    expect(command.label).toBe('vlc-track-metadata-3')
  })

  it('uses an extended timeout for base disc probes so CSS key retrieval can finish', () => {
    const worker = new VlcWorker({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
    })

    const command = (worker as unknown as {
      buildDiscProbeCommand: (drive: string) => {
        executable: string
        args: string[]
        timeoutMs: number
        label: string
      }
    }).buildDiscProbeCommand('F:')

    expect(command.executable).toBe('vlc')
    expect(command.args).toContain('dvd:///F:/')
    expect(command.timeoutMs).toBe(120000)
    expect(command.label).toBe('vlc-disc-probe')
  })

  it('uses an extended timeout for per-title probes so duration metadata is captured reliably', () => {
    const worker = new VlcWorker({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
    })

    const command = (worker as unknown as {
      buildTitleProbeCommand: (drive: string, titleNumber: number, audioLanguage: string) => {
        executable: string
        args: string[]
        timeoutMs: number
        label: string
      }
    }).buildTitleProbeCommand('F:', 1, 'en')

    expect(command.executable).toBe('vlc')
    expect(command.args).toContain('dvd:///F:/#1')
    expect(command.timeoutMs).toBe(60000)
    expect(command.label).toBe('vlc-title-probe-1-en')
  })
})