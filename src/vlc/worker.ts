import { createCommandSpec } from './command-spec.js'
import { createHash } from 'node:crypto'
import { buildHlsArgs, buildThumbnailArgs } from './args.js'
import { runManagedProcess, spawnManagedProcess, type ManagedProcessHandle } from './process-supervisor.js'
import type { RawDiscScan, RawDiscTitle } from '../disc/types.js'
import { buildDvdDiscMrl, buildDvdTitleMrl } from './mrl.js'
import { extractPlayableTitleNumbers, parseTitleProbeLog } from './scan-parser.js'
import type { ServerLog } from '../logging/server-log.js'

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
  shimEnv?: NodeJS.ProcessEnv
  logger?: ServerLog
}

export class VlcWorker {
  private readonly options: VlcWorkerOptions

  constructor(options: VlcWorkerOptions) {
    this.options = options
  }

  async scanDisc(input: { drive?: string } = {}): Promise<RawDiscScan> {
    const drive = input.drive ?? this.options.drive
    this.options.logger?.info('catalog', `Starting DVD scan for ${drive}.`)

    try {
      let scan: RawDiscScan

      if (!this.options.shimScript) {
        scan = await this.scanDiscWithRealVlc(drive)
      } else {
        const result = await runManagedProcess(this.buildShimCommand('vlc-scan', ['--mode=scan', `--drive=${drive}`]))

        const payload = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1)

        if (!result.ok || !payload) {
          throw new Error(result.stderr || 'VLC scan did not return disc metadata.')
        }

        scan = JSON.parse(payload) as RawDiscScan
      }

      this.options.logger?.info('catalog', `DVD scan finished with ${scan.titles.length} titles.`)
      return scan
    } catch (error) {
      this.options.logger?.error('catalog', `DVD scan failed: ${error instanceof Error ? error.message : 'Unknown scan error.'}`)
      throw error
    }
  }

  private async scanDiscWithRealVlc(drive: string): Promise<RawDiscScan> {
    this.options.logger?.info('catalog', `Running VLC disc probe for ${drive}.`)
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

    this.options.logger?.info('catalog', `Disc probe discovered ${titleNumbers.length} playable titles (${titleNumbers.join(', ')}).`)

    const titles: RawDiscTitle[] = []
    for (const titleNumber of titleNumbers) {
      this.options.logger?.info('catalog', `Probing metadata for title ${titleNumber}.`)
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
        this.options.logger?.info('catalog', `Title ${titleNumber} metadata ready (${parsed.durationSeconds}s).`)
      } catch {
        // Skip titles that do not yield stable timing metadata.
        this.options.logger?.warn('catalog', `Skipping title ${titleNumber} because VLC did not produce stable duration metadata.`)
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
    this.options.logger?.info(
      'session',
      `Starting HLS session for title ${input.titleNumber}${input.audioTrack ? `, audio ${input.audioTrack}` : ''}${input.subtitleTrack ? `, subtitle ${input.subtitleTrack}` : ''}.`,
    )

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
      env: this.options.shimEnv
        ? { ...process.env, ...this.options.shimEnv }
        : undefined,
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