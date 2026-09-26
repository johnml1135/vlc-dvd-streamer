import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCommandSpec } from './command-spec.js'
import { buildHlsArgs, buildPlaceholderArgs, buildThumbnailArgs, getPlaceholderAssetPath } from './args.js'
import { runManagedProcess, spawnManagedProcess, type ManagedProcessHandle } from './process-supervisor.js'
import type { RawDiscScan } from '../disc/types.js'
import type { ServerLog } from '../logging/server-log.js'
import { VlcDiscScanner, type DiscScanProgress } from './disc-scanner.js'
import { createVlcScratchDir, removeVlcScratchDir } from './scratch.js'

const require = createRequire(import.meta.url)
const tsxLoaderUrl = pathToFileURL(require.resolve('tsx')).href

export type { DiscScanProgress }

export interface StartHlsSessionInput {
  drive: string
  titleNumber: number
  outputDir: string
  baseUrl: string
  audioTrack?: number
  subtitleTrack?: number
  startTimeSeconds?: number
  initialSegmentNumber?: number
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
  cacheDir?: string
}

export class VlcWorker {
  private readonly options: VlcWorkerOptions
  private readonly scanner: VlcDiscScanner

  constructor(options: VlcWorkerOptions) {
    this.options = options
    this.scanner = new VlcDiscScanner({ ...options, cacheDir: options.cacheDir ?? join(process.cwd(), '.cache') })
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
    const outputDir = resolve(input.outputDir)
    const outputPath = join(outputDir, 'thumbnail.jpg')

    await mkdir(outputDir, { recursive: true })
    const cwd = await createVlcScratchDir(outputDir)
    const args = buildThumbnailArgs({
      drive: input.drive,
      titleNumber: input.titleNumber,
      snapshotDir: outputDir,
      snapshotPrefix: 'thumbnail',
      startTimeSeconds: input.startTimeSeconds,
      runTimeSeconds: input.runTimeSeconds,
    })
    const command = this.options.shimScript
      ? this.buildShimCommand('vlc-thumbnail', args, cwd)
      : createCommandSpec({
        executable: this.options.executable,
        args,
        timeoutMs: this.options.timeoutMs,
        label: 'vlc-thumbnail',
        cwd,
      })

    try {
      const result = await runManagedProcess(command)
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || 'VLC thumbnail generation failed.')
      }
    } finally {
      await removeVlcScratchDir(cwd)
    }

    return { outputPath }
  }

  async startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult> {
    const outputDir = resolve(input.outputDir)
    this.options.logger?.info(
      'session',
      `Starting HLS session for title ${input.titleNumber}${typeof input.audioTrack === 'number' ? `, audio ${input.audioTrack}` : ''}${typeof input.subtitleTrack === 'number' ? `, subtitle ${input.subtitleTrack}` : ''}${typeof input.startTimeSeconds === 'number' && input.startTimeSeconds > 0 ? `, from ${input.startTimeSeconds}s` : ''}.`,
    )

    await mkdir(outputDir, { recursive: true })
    const cwd = await createVlcScratchDir(outputDir)
    const args = buildHlsArgs({
      drive: input.drive,
      titleNumber: input.titleNumber,
      audioTrack: input.audioTrack,
      subtitleTrack: input.subtitleTrack,
      outputDir,
      baseUrl: input.baseUrl,
      startTimeSeconds: input.startTimeSeconds,
      initialSegmentNumber: input.initialSegmentNumber,
    })
    const command = this.options.shimScript
      ? this.buildShimCommand('vlc-hls', args, cwd, 0)
      : createCommandSpec({
        executable: this.options.executable,
        args,
        timeoutMs: 0,
        label: 'vlc-hls',
        cwd,
      })

    this.options.logger?.info('session', `HLS session for title ${input.titleNumber} will stay alive until playback stops or a replacement session starts.`)

    const handle = spawnManagedProcess(command)
    const cleanup = () => removeVlcScratchDir(cwd)
    void handle.completion.then(cleanup, cleanup)

    return {
      handle,
      manifestPath: join(outputDir, 'index.m3u8'),
    }
  }

  /**
   * Best-effort render of a reusable "bad sector" placeholder clip into
   * outputDir/placeholder.ts. The session copies it into any unreadable slot so
   * the viewer sees an explicit screen with the timeline staying accurate.
   * Failures are non-fatal; the session falls back to a minimal placeholder.
   */
  async generatePlaceholderSegment(input: { outputDir: string; durationSeconds?: number }): Promise<void> {
    const outputDir = resolve(input.outputDir)
    await mkdir(outputDir, { recursive: true })
    const outputPath = join(outputDir, 'placeholder.ts')
    if (!this.options.shimScript) {
      await copyFile(getPlaceholderAssetPath(), outputPath)
      return
    }

    const cwd = await createVlcScratchDir(outputDir)
    const command = createCommandSpec({
      ...this.buildShimCommand('vlc-placeholder', buildPlaceholderArgs({ outputPath, durationSeconds: input.durationSeconds }), cwd),
    })

    try {
      const result = await runManagedProcess(command)
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || 'VLC placeholder generation failed.')
      }
    } finally {
      await removeVlcScratchDir(cwd)
    }
  }

  private buildShimCommand(label: string, args: string[], cwd: string, timeoutMs = this.options.timeoutMs) {
    if (!this.options.shimScript) {
      throw new Error('A VLC shim script is required for shim commands.')
    }

    return createCommandSpec({
      executable: this.options.executable,
      args: ['--import', tsxLoaderUrl, resolve(this.options.shimScript), ...args],
      timeoutMs,
      label,
      cwd,
      env: this.options.shimEnv
        ? { ...process.env, ...this.options.shimEnv }
        : undefined,
    })
  }
}
