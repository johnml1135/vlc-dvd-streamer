import { createCommandSpec } from './command-spec.js'
import { createHash } from 'node:crypto'
import { buildHlsArgs, buildThumbnailArgs } from './args.js'
import { runManagedProcess, spawnManagedProcess, type ManagedProcessHandle } from './process-supervisor.js'
import type { RawDiscScan, RawDiscTitle } from '../disc/types.js'
import { buildDvdDiscMrl, buildDvdTitleMrl } from './mrl.js'
import { extractPlayableTitleNumbers, parseTitleProbeLog } from './scan-parser.js'

export interface StartHlsSessionInput {
  drive: string
  titleNumber: number
  outputDir: string
  baseUrl: string
  audioTrack?: number
  subtitleTrack?: number
}

export interface StartHlsSessionResult {
  handle: ManagedProcessHandle
  manifestPath: string
}

export interface ThumbnailResult {
  outputPath: string
}

export interface VlcWorkerOptions {
  executable: string
  drive: string
  timeoutMs: number
  shimScript?: string
}

export class VlcWorker {
  private readonly options: VlcWorkerOptions

  constructor(options: VlcWorkerOptions) {
    this.options = options
  }

  async scanDisc(input: { drive?: string } = {}): Promise<RawDiscScan> {
    const drive = input.drive ?? this.options.drive

    if (!this.options.shimScript) {
      return this.scanDiscWithRealVlc(drive)
    }

    const result = await runManagedProcess(this.buildShimCommand('vlc-scan', ['--mode=scan', `--drive=${drive}`]))

    const payload = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)

    if (!result.ok || !payload) {
      throw new Error(result.stderr || 'VLC scan did not return disc metadata.')
    }

    return JSON.parse(payload) as RawDiscScan
  }

  private async scanDiscWithRealVlc(drive: string): Promise<RawDiscScan> {
    const discProbe = await runManagedProcess(
      createCommandSpec({
        executable: this.options.executable,
        args: this.buildScanArgs(buildDvdDiscMrl({ drive })),
        timeoutMs: this.options.timeoutMs,
        label: 'vlc-disc-probe',
      }),
    )

    const discLog = [discProbe.stdout, discProbe.stderr].filter(Boolean).join('\n')
    const titleNumbers = extractPlayableTitleNumbers(discLog)
    if (titleNumbers.length === 0) {
      throw new Error('VLC did not expose any playable DVD title numbers in the probe log.')
    }

    const titles: RawDiscTitle[] = []
    for (const titleNumber of titleNumbers) {
      const titleProbe = await runManagedProcess(
        createCommandSpec({
          executable: this.options.executable,
          args: this.buildScanArgs(buildDvdTitleMrl({ drive, titleNumber })),
          timeoutMs: this.options.timeoutMs,
          label: `vlc-title-probe-${titleNumber}`,
        }),
      )

      const titleLog = [titleProbe.stdout, titleProbe.stderr].filter(Boolean).join('\n')
      try {
        const parsed = parseTitleProbeLog(titleLog)
        titles.push({
          titleNumber,
          durationSeconds: parsed.durationSeconds,
          audioTracks: parsed.audioTracks,
          subtitleTracks: parsed.subtitleTracks,
        })
      } catch {
        // Skip titles that do not yield stable timing metadata.
      }
    }

    if (titles.length === 0) {
      throw new Error('VLC opened the DVD but no title probe produced usable duration metadata.')
    }

    const discId = createHash('sha1')
      .update(`${drive}|${titles.map((title) => `${title.titleNumber}:${title.durationSeconds}`).join('|')}`)
      .digest('hex')
      .slice(0, 12)

    return {
      discId: `disc-${discId}`,
      drive,
      titles,
    }
  }

  async generateThumbnail(input: {
    drive: string
    titleNumber: number
    outputDir: string
    startTimeSeconds: number
    runTimeSeconds: number
  }): Promise<ThumbnailResult> {
    const outputPath = `${input.outputDir}/thumbnail.jpg`

    const command = this.options.shimScript
      ? this.buildShimCommand('vlc-thumbnail', ['--mode=thumbnail', `--drive=${input.drive}`, `--outDir=${input.outputDir}`])
      : createCommandSpec({
        executable: this.options.executable,
        args: buildThumbnailArgs({
          drive: input.drive,
          titleNumber: input.titleNumber,
          snapshotDir: input.outputDir,
          snapshotPrefix: 'thumbnail',
          startTimeSeconds: input.startTimeSeconds,
          runTimeSeconds: input.runTimeSeconds,
        }),
        timeoutMs: this.options.timeoutMs,
        label: 'vlc-thumbnail',
      })

    const result = await runManagedProcess(command)
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || 'VLC thumbnail generation failed.')
    }

    return { outputPath }
  }

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    const command = this.options.shimScript
      ? this.buildShimCommand('vlc-hls', [
        '--mode=hls-server',
        `--drive=${input.drive}`,
        `--titleNumber=${input.titleNumber}`,
        `--outDir=${input.outputDir}`,
      ])
      : createCommandSpec({
        executable: this.options.executable,
        args: buildHlsArgs({
          drive: input.drive,
          titleNumber: input.titleNumber,
          audioTrack: input.audioTrack,
          subtitleTrack: input.subtitleTrack,
          outputDir: input.outputDir,
          baseUrl: input.baseUrl,
        }),
        timeoutMs: this.options.timeoutMs,
        label: 'vlc-hls',
      })

    return {
      handle: spawnManagedProcess(command),
      manifestPath: `${input.outputDir}/index.m3u8`,
    }
  }

  private buildShimCommand(label: string, args: string[]) {
    return createCommandSpec({
      executable: this.options.executable,
      args: ['--import', 'tsx', this.options.shimScript!, ...args],
      timeoutMs: this.options.timeoutMs,
      label,
    })
  }

  private buildScanArgs(mrl: string): string[] {
    return [
      '--intf',
      'dummy',
      '--no-video',
      '--vout',
      'dummy',
      '--aout',
      'dummy',
      '--play-and-exit',
      '--run-time',
      '1',
      '--verbose=2',
      mrl,
    ]
  }
}