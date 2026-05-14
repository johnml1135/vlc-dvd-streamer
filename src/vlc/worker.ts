import { createCommandSpec } from './command-spec.js'
import { createHash } from 'node:crypto'
import { buildHlsArgs, buildThumbnailArgs } from './args.js'
import { runManagedProcess, spawnManagedProcess, type ManagedProcessHandle } from './process-supervisor.js'
import type { RawDiscScan, RawDiscTitle } from '../disc/types.js'
import { buildDvdDiscMrl, buildDvdTitleMrl } from './mrl.js'
import { applyInferredTrackLabels, enrichTrackLabels, extractPlayableTitleNumbers, extractSelectedAudioTrackId, extractSelectedSubtitleTrackId, mergeTitleProbeMetadata, parseTitleProbeLog, type InferredTrackLabels, type RuntimeTrackMetadata } from './scan-parser.js'
import type { ServerLog } from '../logging/server-log.js'

const PRIMARY_AUDIO_LANGUAGE = 'en'
const FALLBACK_AUDIO_LANGUAGE = 'fr'
const LANGUAGE_LABEL_PROBES = [
  { code: 'spa', label: 'Spanish' },
  { code: 'fre', label: 'French' },
] as const

interface ParsedTitleProbe {
  parsed: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>
  log: string
}

export interface DiscScanProgress {
  scannedTitles: number
  totalTitles: number
  currentTitleNumber: number | null
}

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

  constructor(options: VlcWorkerOptions) {
    this.options = options
  }

  async scanDisc(input: { drive?: string; onProgress?: (progress: DiscScanProgress) => void } = {}): Promise<RawDiscScan> {
    const drive = input.drive ?? this.options.drive
    this.options.logger?.info('catalog', `Starting DVD scan for ${drive}.`)

    try {
      let scan: RawDiscScan

      if (!this.options.shimScript) {
        scan = await this.scanDiscWithRealVlc(drive, input.onProgress)
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

  private async scanDiscWithRealVlc(drive: string, onProgress?: (progress: DiscScanProgress) => void): Promise<RawDiscScan> {
    this.options.logger?.info('catalog', `Running VLC disc probe for ${drive}.`)
    const discProbe = await runManagedProcess(this.buildDiscProbeCommand(drive))

    const discLog = [discProbe.stdout, discProbe.stderr].filter(Boolean).join('\n')
    const titleNumbers = extractPlayableTitleNumbers(discLog)
    if (titleNumbers.length === 0) {
      throw new Error('VLC did not expose any playable DVD title numbers in the probe log.')
    }

    this.options.logger?.info('catalog', `Disc probe discovered ${titleNumbers.length} playable titles (${titleNumbers.join(', ')}).`)
    onProgress?.({
      scannedTitles: 0,
      totalTitles: titleNumbers.length,
      currentTitleNumber: titleNumbers[0] ?? null,
    })

    const titles: RawDiscTitle[] = []
    let scannedTitles = 0
    for (const [index, titleNumber] of titleNumbers.entries()) {
      this.options.logger?.info('catalog', `Probing metadata for title ${titleNumber}.`)
      try {
        const parsed = await this.probeTitleMetadata(drive, titleNumber)
        titles.push({
          titleNumber,
          durationSeconds: parsed.durationSeconds,
          audioTracks: parsed.audioTracks,
          subtitleTracks: parsed.subtitleTracks,
        })
        this.options.logger?.info(
          'catalog',
          `Found title ${titleNumber}: ${parsed.durationSeconds}s, ${parsed.audioTracks.length} audio track(s), ${parsed.subtitleTracks.length} subtitle track(s).`,
        )
      } catch {
        // Skip titles that do not yield stable timing metadata.
        this.options.logger?.warn('catalog', `Skipping title ${titleNumber} because VLC did not produce stable duration metadata.`)
      } finally {
        scannedTitles += 1
        onProgress?.({
          scannedTitles,
          totalTitles: titleNumbers.length,
          currentTitleNumber: titleNumbers[index + 1] ?? null,
        })
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
    return createCommandSpec({
      executable: this.options.executable,
      args: ['--import', 'tsx', this.options.shimScript!, ...args],
      timeoutMs,
      label,
      env: this.options.shimEnv
        ? { ...process.env, ...this.options.shimEnv }
        : undefined,
    })
  }

  private async probeTitleMetadata(drive: string, titleNumber: number) {
    const englishProbe = await this.runTitleProbe(drive, titleNumber, PRIMARY_AUDIO_LANGUAGE)
    const parsedProbes = [englishProbe.parsed]

    if (englishProbe.parsed.audioTracks.length <= 1) {
      try {
        const fallbackProbe = await this.runTitleProbe(drive, titleNumber, FALLBACK_AUDIO_LANGUAGE)
        parsedProbes.push(fallbackProbe.parsed)
      } catch {
        this.options.logger?.warn('catalog', `French fallback probe did not produce additional metadata for title ${titleNumber}.`)
      }
    }

    let parsedMetadata = mergeTitleProbeMetadata(parsedProbes)
    if (this.options.trackMetadataScript && hasGenericTrackLabels(parsedMetadata)) {
      try {
        const runtimeMetadata = await this.queryTrackMetadata(drive, titleNumber)
        if (runtimeMetadata) {
          parsedMetadata = enrichTrackLabels(parsedMetadata, runtimeMetadata)
        }
      } catch (error) {
        this.options.logger?.warn(
          'catalog',
          `Runtime libVLC metadata enrichment failed for title ${titleNumber}: ${error instanceof Error ? error.message : 'Unknown runtime metadata error.'}`,
        )
      }
    }

    if (hasGenericTrackLabels(parsedMetadata)) {
      const inferredLabels = await this.inferTrackLabelsFromLanguageProbes(drive, titleNumber, englishProbe.log, parsedMetadata)
      parsedMetadata = applyInferredTrackLabels(parsedMetadata, inferredLabels)
    }

    return parsedMetadata
  }

  private async runTitleProbe(drive: string, titleNumber: number, audioLanguage: string) {
    const titleProbe = await runManagedProcess(this.buildTitleProbeCommand(drive, titleNumber, audioLanguage))

    const titleLog = [titleProbe.stdout, titleProbe.stderr].filter(Boolean).join('\n')
    return {
      parsed: parseTitleProbeLog(titleLog),
      log: titleLog,
    } satisfies ParsedTitleProbe
  }

  private buildScanArgs(mrl: string, options: { audioLanguage?: string; subLanguage?: string } = {}): string[] {
    return [
      '--intf',
      'dummy',
      '--no-video',
      '--vout',
      'dummy',
      '--aout',
      'dummy',
      `--audio-language=${options.audioLanguage ?? PRIMARY_AUDIO_LANGUAGE}`,
      `--sub-language=${options.subLanguage ?? 'en'}`,
      '--play-and-exit',
      '--run-time',
      '1',
      '--verbose=2',
      mrl,
    ]
  }

  private buildDiscProbeCommand(drive: string) {
    return createCommandSpec({
      executable: this.options.executable,
      args: this.buildScanArgs(buildDvdDiscMrl({ drive })),
      timeoutMs: Math.max(this.options.timeoutMs, 120000),
      label: 'vlc-disc-probe',
    })
  }

  private buildTitleProbeCommand(drive: string, titleNumber: number, audioLanguage: string) {
    return createCommandSpec({
      executable: this.options.executable,
      args: this.buildScanArgs(buildDvdTitleMrl({ drive, titleNumber }), { audioLanguage }),
      timeoutMs: Math.max(this.options.timeoutMs, 60000),
      label: `vlc-title-probe-${titleNumber}-${audioLanguage}`,
    })
  }

  private async queryTrackMetadata(drive: string, titleNumber: number): Promise<RuntimeTrackMetadata | null> {
    const command = this.buildTrackMetadataCommand(drive, titleNumber)
    const result = await runManagedProcess(command)
    const payload = this.parseTrackMetadataPayload(result.stdout)

    if (hasUsableRuntimeTrackMetadata(payload)) {
      return payload
    }

    if (!result.ok && !payload) {
      throw new Error(result.stderr || result.stdout || 'The runtime libVLC track metadata helper failed.')
    }

    return null
  }

  private buildTrackMetadataCommand(drive: string, titleNumber: number) {
    const waitSeconds = Math.max(1, Math.ceil(this.options.timeoutMs / 1000))

    return createCommandSpec({
      executable: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.options.trackMetadataScript!,
        '-Mrl',
        buildDvdTitleMrl({ drive, titleNumber }),
        '-WaitSeconds',
        String(waitSeconds),
      ],
      timeoutMs: waitSeconds * 2000,
      label: `vlc-track-metadata-${titleNumber}`,
    })
  }

  private parseTrackMetadataPayload(output: string): RuntimeTrackMetadata | null {
    const trimmed = output.trim()
    if (trimmed.length === 0) {
      return null
    }

    const jsonStart = trimmed.indexOf('{')
    const jsonEnd = trimmed.lastIndexOf('}')
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      throw new Error('The runtime libVLC metadata helper did not return JSON.')
    }

    const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Partial<RuntimeTrackMetadata>

    return {
      mediaTracks: Array.isArray(payload.mediaTracks) ? payload.mediaTracks.map((track) => ({
        id: typeof track?.id === 'number' ? track.id : -1,
        type: typeof track?.type === 'number' ? track.type : -1,
        language: typeof track?.language === 'string' ? track.language : null,
        description: typeof track?.description === 'string' ? track.description : null,
      })) : [],
      audio: Array.isArray(payload.audio) ? payload.audio.map((track) => ({
        id: typeof track?.id === 'number' ? track.id : -1,
        name: typeof track?.name === 'string' ? track.name : null,
      })) : [],
      subtitles: Array.isArray(payload.subtitles) ? payload.subtitles.map((track) => ({
        id: typeof track?.id === 'number' ? track.id : -1,
        name: typeof track?.name === 'string' ? track.name : null,
      })) : [],
    }
  }

  private async inferTrackLabelsFromLanguageProbes(
    drive: string,
    titleNumber: number,
    englishProbeLog: string,
    parsedMetadata: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>,
  ): Promise<InferredTrackLabels> {
    const inferredAudioLabels = new Map<number, Set<string>>()
    const inferredSubtitleLabels = new Map<number, Set<string>>()
    const englishAudioTrackId = extractSelectedAudioTrackId(englishProbeLog)
    const englishSubtitleTrackId = extractSelectedSubtitleTrackId(englishProbeLog)

    if (englishAudioTrackId !== null) {
      addInferredLabel(inferredAudioLabels, englishAudioTrackId, 'English')
    }

    if (englishSubtitleTrackId !== null) {
      addInferredLabel(inferredSubtitleLabels, englishSubtitleTrackId, 'English')
    }

    for (const probe of LANGUAGE_LABEL_PROBES) {
      if (probe.label === 'French' && parsedMetadata.audioTracks.length <= 1) {
        continue
      }

      if (probe.label === 'Spanish' && parsedMetadata.subtitleTracks.length === 0 && parsedMetadata.audioTracks.length <= 1) {
        continue
      }

      try {
        const log = await this.runLanguageSelectionProbe(drive, titleNumber, probe.code)
        const audioTrackId = extractSelectedAudioTrackId(log)
        const subtitleTrackId = extractSelectedSubtitleTrackId(log)

        if (audioTrackId !== null && audioTrackId !== englishAudioTrackId) {
          addInferredLabel(inferredAudioLabels, audioTrackId, probe.label)
        }

        if (subtitleTrackId !== null && subtitleTrackId !== englishSubtitleTrackId) {
          addInferredLabel(inferredSubtitleLabels, subtitleTrackId, probe.label)
        }
      } catch {
        this.options.logger?.warn('catalog', `${probe.label} language probe did not produce stable metadata for title ${titleNumber}.`)
      }
    }

    return {
      audio: materializeInferredLabels(inferredAudioLabels),
      subtitles: materializeInferredLabels(inferredSubtitleLabels),
    }
  }

  private async runLanguageSelectionProbe(drive: string, titleNumber: number, languageCode: string) {
    const probe = await runManagedProcess(
      createCommandSpec({
        executable: this.options.executable,
        args: this.buildScanArgs(buildDvdTitleMrl({ drive, titleNumber }), {
          audioLanguage: `${languageCode},none`,
          subLanguage: `${languageCode},none`,
        }),
        timeoutMs: Math.max(this.options.timeoutMs, 60000),
        label: `vlc-language-probe-${titleNumber}-${languageCode}`,
      }),
    )

    return [probe.stdout, probe.stderr].filter(Boolean).join('\n')
  }
}

function hasGenericTrackLabels(metadata: Pick<RawDiscTitle, 'audioTracks' | 'subtitleTracks'>): boolean {
  return metadata.audioTracks.some((track) => /^Audio\s+\d+$/i.test(track.label))
    || metadata.subtitleTracks.some((track) => /^Subtitle\s+\d+$/i.test(track.label))
}

function hasUsableRuntimeTrackMetadata(payload: RuntimeTrackMetadata | null): payload is RuntimeTrackMetadata {
  return payload !== null && (payload.mediaTracks.length > 0 || payload.audio.length > 0 || payload.subtitles.length > 0)
}

function addInferredLabel(labelsByTrackId: Map<number, Set<string>>, trackId: number, label: string) {
  const existing = labelsByTrackId.get(trackId) ?? new Set<string>()
  existing.add(label)
  labelsByTrackId.set(trackId, existing)
}

function materializeInferredLabels(labelsByTrackId: Map<number, Set<string>>) {
  return [...labelsByTrackId.entries()]
    .filter(([, labels]) => labels.size === 1)
    .map(([id, labels]) => ({
      id,
      label: [...labels][0]!,
    }))
}