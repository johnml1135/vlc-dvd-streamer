import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHlsArgs, buildPlaceholderArgs, buildThumbnailArgs } from '../../../src/vlc/args.js'
import { buildDiscProbeCommand, buildLanguageProbeCommand, buildScanArgs, buildTitleProbeCommand } from '../../../src/vlc/probe-commands.js'

function getDocumentedOptions(): Set<string> {
  const help = readFileSync(resolve(process.cwd(), 'test/fixtures/vlc/vlc-help-3.0.23.txt'), 'utf8')
  const options = new Set<string>()

  for (const line of help.split(/\r?\n/)) {
    if (!/^\s{2,}(?:-[a-z],\s+)?--[a-z]/i.test(line)) {
      continue
    }

    for (const match of line.matchAll(/--(?:no-)?([a-z][a-z0-9-]*)/gi)) {
      options.add(match[1]!.toLowerCase())
    }
  }

  return options
}

function getOptions(args: string[]): string[] {
  return args
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => arg.slice(2).split('=', 1)[0]!.replace(/^no-/, '').toLowerCase())
}

function getUndocumentedOptions(args: string[], documented: Set<string>): string[] {
  return [...new Set(getOptions(args))].filter((name) => !documented.has(name))
}

describe('VLC option contract', () => {
  it('uses only options documented by the committed VLC help across every command builder', () => {
    const commands = [
      buildHlsArgs({ drive: 'D:', titleNumber: 1, outputDir: 'out', baseUrl: '/stream/' }),
      buildHlsArgs({ drive: 'D:', titleNumber: 1, audioTrack: 0, outputDir: 'out', baseUrl: '/stream/' }),
      buildHlsArgs({ drive: 'D:', titleNumber: 1, subtitleTrack: 1, outputDir: 'out', baseUrl: '/stream/' }),
      buildHlsArgs({ drive: 'D:', titleNumber: 1, startTimeSeconds: 12, initialSegmentNumber: 8, outputDir: 'out', baseUrl: '/stream/' }),
      buildThumbnailArgs({ drive: 'D:', titleNumber: 1, snapshotDir: 'out', snapshotPrefix: 'shot', startTimeSeconds: 0, runTimeSeconds: 2 }),
      buildPlaceholderArgs({ outputPath: 'out/placeholder.ts' }),
      buildScanArgs('dvd:///D:/'),
      buildDiscProbeCommand({ executable: 'vlc', drive: 'D:', timeoutMs: 1 }).args,
      buildTitleProbeCommand({ executable: 'vlc', drive: 'D:', titleNumber: 1, audioLanguage: 'en', timeoutMs: 1 }).args,
      buildLanguageProbeCommand({ executable: 'vlc', drive: 'D:', titleNumber: 1, languageCode: 'fr', timeoutMs: 1 }).args,
    ]
    const documented = getDocumentedOptions()
    const undocumented = getUndocumentedOptions(commands.flat(), documented)

    expect(undocumented).toEqual([])
    for (const args of commands) {
      expect(args).toContain('--no-interact')
      expect(args).toContain('--no-qt-error-dialogs')
    }
    expect(getUndocumentedOptions(['--fake-duration=2000'], documented)).toEqual(['fake-duration'])
  })

  it('uses the committed two-second MPEG-TS fixture for placeholders', () => {
    const args = buildPlaceholderArgs({ outputPath: 'out/placeholder.ts' })
    const sourcePath = args.find((arg) => arg.endsWith('placeholder.ts'))

    expect(sourcePath).toBeDefined()
    expect(existsSync(sourcePath!)).toBe(true)
    const transportStream = readFileSync(sourcePath!)
    expect(transportStream.length).toBeGreaterThan(188)
    expect(transportStream[0]).toBe(0x47)
    for (let offset = 188; offset < transportStream.length; offset += 188) {
      expect(transportStream[offset]).toBe(0x47)
    }
    expect(args).toContain('--run-time=2')
    expect(args.some((arg) => arg.includes('vcodec=h264') && arg.includes('aenc=avcodec') && arg.includes('acodec=mp4a'))).toBe(true)
  })
})
