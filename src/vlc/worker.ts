import { createCommandSpec } from './command-spec.js'
import { buildHlsArgs, buildThumbnailArgs } from './args.js'
import { runManagedProcess, spawnManagedProcess, type ManagedProcessHandle } from './process-supervisor.js'
import type { RawDiscScan } from '../disc/types.js'
import type { ServerLog } from '../logging/server-log.js'
import { VlcDiscScanner, type DiscScanProgress } from './disc-scanner.js'

export type { DiscScanProgress }

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
  trackMetadataScript?: string
  shimEnv?: NodeJS.ProcessEnv
  logger?: ServerLog
}

export class VlcWorker {
  private readonly options: VlcWorkerOptions
  private readonly scanner: VlcDiscScanner

  constructor(options: VlcWorkerOptions) {
    this.options = options
    this.scanner = new VlcDiscScanner(options)
  }

  async scanDisc(input: { drive?: string; onProgress?: (progress: DiscScanProgress) => void } = {}): Promise<RawDiscScan> {
    return this.scanner.scanDisc(input)
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
      ], 0)
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
        timeoutMs: 0,
        label: 'vlc-hls',
      })

    this.options.logger?.info('session', `HLS session for title ${input.titleNumber} will stay alive until playback stops or a replacement session starts.`)

    return {
      handle: spawnManagedProcess(command),
      manifestPath: `${input.outputDir}/index.m3u8`,
    }
  }

  private buildShimCommand(label: string, args: string[], timeoutMs = this.options.timeoutMs) {
    if (!this.options.shimScript) {
      throw new Error('A VLC shim script is required for shim commands.')
    }

    return createCommandSpec({
      executable: this.options.executable,
      args: ['--import', 'tsx', this.options.shimScript, ...args],
      timeoutMs,
      label,
      env: this.options.shimEnv
        ? { ...process.env, ...this.options.shimEnv }
        : undefined,
    })
  }
}