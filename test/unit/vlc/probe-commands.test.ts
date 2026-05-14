import { describe, expect, it } from 'vitest'
import { buildDiscProbeCommand, buildScanArgs, buildTitleProbeCommand, buildTrackMetadataCommand } from '../../../src/vlc/probe-commands.js'

describe('VLC probe commands', () => {
  it('prefers English audio and subtitle languages during metadata probes', () => {
    const args = buildScanArgs('dvd:///D:/#1')

    expect(args).toContain('--audio-language=en')
    expect(args).toContain('--sub-language=en')
  })

  it('builds a PowerShell libVLC helper command for runtime track metadata enrichment', () => {
    const command = buildTrackMetadataCommand({
      drive: 'D:',
      titleNumber: 3,
      timeoutMs: 12000,
      trackMetadataScript: 'scripts/windows/query-vlc-track-descriptions.ps1',
    })

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
    const command = buildDiscProbeCommand({
      executable: 'vlc',
      drive: 'F:',
      timeoutMs: 30000,
    })

    expect(command.executable).toBe('vlc')
    expect(command.args).toContain('dvd:///F:/')
    expect(command.timeoutMs).toBe(120000)
    expect(command.label).toBe('vlc-disc-probe')
  })

  it('uses an extended timeout for per-title probes so duration metadata is captured reliably', () => {
    const command = buildTitleProbeCommand({
      executable: 'vlc',
      drive: 'F:',
      titleNumber: 1,
      audioLanguage: 'en',
      timeoutMs: 30000,
    })

    expect(command.executable).toBe('vlc')
    expect(command.args).toContain('dvd:///F:/#1')
    expect(command.timeoutMs).toBe(60000)
    expect(command.label).toBe('vlc-title-probe-1-en')
  })
})