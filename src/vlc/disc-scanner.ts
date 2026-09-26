import { createCommandSpec, type CommandSpec } from './command-spec.js'
import type { RawDiscScan, RawDiscTitle } from '../disc/types.js'
import { computeDiscIdentity } from '../disc/disc-identity.js'
import { DRIVE_BUSY_MESSAGE, isDriveBusyMessage } from '../disc/drive-errors.js'
import type { ServerLog } from '../logging/server-log.js'
import { applyInferredTrackLabels, enrichTrackLabels, extractPlayableTitleNumbers, extractSelectedAudioTrackId, extractSelectedSubtitleTrackId, mergeTitleProbeMetadata, parseTitleProbeLog, type InferredTrackLabels, type RuntimeTrackMetadata } from './scan-parser.js'
import { runManagedProcess, type CompletedProcess } from './process-supervisor.js'
import { FALLBACK_AUDIO_LANGUAGE, PRIMARY_AUDIO_LANGUAGE, buildDiscProbeCommand, buildLanguageProbeCommand, buildTitleProbeCommand, buildTrackMetadataCommand } from './probe-commands.js'
import { readDvdTitlesFromIfoDetailed, type IfoReadResult } from '../disc/ifo-reader.js'

export type IfoTitleReader = (videoTsDir: string) => Promise<IfoReadResult>

const LANGUAGE_LABEL_PROBES = [
  { code: 'spa', label: 'Spanish' },
  { code: 'fre', label: 'French' },
] as const
const DEFAULT_SCAN_DEADLINE_MS = 5 * 60 * 1000

interface ParsedTitleProbe {
  parsed: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>
  log: string
}

export interface DiscScanProgress {
  scannedTitles: number
  totalTitles: number | null
  currentTitleNumber: number | null
}

export type ProcessRunner = (spec: CommandSpec) => Promise<CompletedProcess>
export type DiscIdentityReader = (videoTsDir: string) => Promise<string>

export interface VlcDiscScannerOptions {
  executable: string
  drive: string
  timeoutMs: number
  shimScript?: string
  trackMetadataScript?: string
  shimEnv?: NodeJS.ProcessEnv
  logger?: Pick<ServerLog, 'info' | 'warn' | 'error'>
  runProcess?: ProcessRunner
  readIfoTitles?: IfoTitleReader
  readDiscIdentity?: DiscIdentityReader
  scanDeadlineMs?: number
  now?: () => number
}

export class VlcDiscScanner {
  private readonly options: VlcDiscScannerOptions
  private readonly runProcess: ProcessRunner
  private readonly readIfoTitles: IfoTitleReader
  private readonly readDiscIdentity: DiscIdentityReader

  constructor(options: VlcDiscScannerOptions) {
    this.options = options
    this.runProcess = options.runProcess ?? runManagedProcess
    this.readIfoTitles = options.readIfoTitles ?? readDvdTitlesFromIfoDetailed
    this.readDiscIdentity = options.readDiscIdentity ?? computeDiscIdentity
  }

  identifyDisc(drive = this.options.drive): Promise<string> {
    return this.readDiscIdentity(getVideoTsDir(drive))
  }

  async scanDisc(input: { drive?: string; onProgress?: (progress: DiscScanProgress) => void } = {}): Promise<RawDiscScan> {
    const drive = input.drive ?? this.options.drive
    this.options.logger?.info('catalog', `Starting DVD scan for ${drive}.`)

    try {
      // Fast path: read titles/durations/tracks straight from the unencrypted
      // IFO files (milliseconds). Fall back to per-title VLC probes only if the
      // disc does not expose a readable VIDEO_TS (e.g. unusual media).
      if (!this.options.shimScript) {
        const ifoScan = await this.scanDiscFromIfo(drive, input.onProgress)
        if (ifoScan) {
          this.options.logger?.info('catalog', `DVD scan finished with ${ifoScan.titles.length} titles (IFO).`)
          return ifoScan
        }
      }

      const scan = this.options.shimScript
        ? await this.scanDiscWithShim(drive)
        : await this.scanDiscWithRealVlc(drive, input.onProgress)

      this.options.logger?.info('catalog', `DVD scan finished with ${scan.titles.length} titles.`)
      return scan
    } catch (error) {
      this.options.logger?.error('catalog', `DVD scan failed: ${error instanceof Error ? error.message : 'Unknown scan error.'}`)
      throw error
    }
  }

  private async scanDiscFromIfo(drive: string, onProgress?: (progress: DiscScanProgress) => void): Promise<RawDiscScan | null> {
    const videoTsDir = getVideoTsDir(drive)
    try {
      const ifoResult = await this.readIfoTitles(videoTsDir)
      if (ifoResult.skippedTitleNumbers.length > 0 || ifoResult.titles.length !== ifoResult.expectedTitleCount) {
        this.options.logger?.warn(
          'catalog',
          `IFO title data is incomplete for ${videoTsDir}; skipped title(s) ${ifoResult.skippedTitleNumbers.join(', ') || 'unknown'}, falling back to VLC probes.`,
        )
        return null
      }

      const titles: RawDiscTitle[] = ifoResult.titles.map((title) => ({
        titleNumber: title.titleNumber,
        durationSeconds: title.durationSeconds,
        audioTracks: title.audioTracks,
        subtitleTracks: title.subtitleTracks,
      }))

      if (titles.length === 0) {
        this.options.logger?.warn('catalog', `IFO read for ${videoTsDir} produced no titles; falling back to VLC probes.`)
        return null
      }

      onProgress?.({ scannedTitles: titles.length, totalTitles: titles.length, currentTitleNumber: null })
      return { discId: await this.identifyDisc(drive), drive, titles }
    } catch (error) {
      if (isDriveBusyMessage(formatError(error))) throw new Error(DRIVE_BUSY_MESSAGE, { cause: error })
      this.options.logger?.warn('catalog', `IFO read for ${videoTsDir} failed; falling back to VLC probes: ${formatError(error)}`)
      return null
    }
  }

  private async scanDiscWithShim(drive: string): Promise<RawDiscScan> {
    const result = await this.runProcess(this.buildShimCommand('vlc-scan', ['--mode=scan', `--drive=${drive}`]))
    const payload = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)

    if (!result.ok || !payload) {
      throw new Error(result.stderr || 'VLC scan did not return disc metadata.')
    }

    return parseRawDiscScanPayload(payload)
  }

  private async scanDiscWithRealVlc(drive: string, onProgress?: (progress: DiscScanProgress) => void): Promise<RawDiscScan> {
    const deadlineMs = this.options.scanDeadlineMs ?? DEFAULT_SCAN_DEADLINE_MS
    const deadlineAt = this.now() + deadlineMs
    this.options.logger?.info('catalog', `Running VLC disc probe for ${drive}.`)
    const discProbe = await this.runProcessWithinDeadline(buildDiscProbeCommand({
      executable: this.options.executable,
      drive,
      timeoutMs: this.options.timeoutMs,
    }), deadlineAt, deadlineMs, 0, 0)

    const discLog = joinProcessOutput(discProbe)
    const titleNumbers = extractPlayableTitleNumbers(discLog)
    if (titleNumbers.length === 0) {
      throw new Error(`VLC did not expose any playable DVD title numbers in the probe log. ${formatProcessDetail(discProbe)}`)
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
        const parsed = await this.probeTitleMetadata(drive, titleNumber, {
          deadlineAt,
          deadlineMs,
          scannedTitles,
          totalTitles: titleNumbers.length,
        })
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
      } catch (error) {
        if (error instanceof DiscScanDeadlineError) throw error
        this.options.logger?.warn('catalog', `Skipping title ${titleNumber} because VLC did not produce stable duration metadata: ${formatError(error)}`)
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

    return {
      discId: await this.identifyDisc(drive),
      drive,
      titles,
    }
  }

  private async probeTitleMetadata(drive: string, titleNumber: number, budget: ScanBudget) {
    const englishProbe = await this.runTitleProbe(drive, titleNumber, PRIMARY_AUDIO_LANGUAGE, budget)
    const parsedProbes = [englishProbe.parsed]

    if (englishProbe.parsed.audioTracks.length <= 1) {
      try {
        const fallbackProbe = await this.runTitleProbe(drive, titleNumber, FALLBACK_AUDIO_LANGUAGE, budget)
        parsedProbes.push(fallbackProbe.parsed)
      } catch (error) {
        if (error instanceof DiscScanDeadlineError) throw error
        this.options.logger?.warn('catalog', `French fallback probe did not produce additional metadata for title ${titleNumber}.`)
      }
    }

    let parsedMetadata = mergeTitleProbeMetadata(parsedProbes)
    if (this.options.trackMetadataScript && hasGenericTrackLabels(parsedMetadata)) {
      try {
        const runtimeMetadata = await this.queryTrackMetadata(drive, titleNumber, budget)
        if (runtimeMetadata) {
          parsedMetadata = enrichTrackLabels(parsedMetadata, runtimeMetadata)
        }
      } catch (error) {
        if (error instanceof DiscScanDeadlineError) throw error
        this.options.logger?.warn(
          'catalog',
          `Runtime libVLC metadata enrichment failed for title ${titleNumber}: ${formatError(error)}`,
        )
      }
    }

    if (hasGenericTrackLabels(parsedMetadata)) {
      const inferredLabels = await this.inferTrackLabelsFromLanguageProbes(drive, titleNumber, englishProbe.log, parsedMetadata, budget)
      parsedMetadata = applyInferredTrackLabels(parsedMetadata, inferredLabels)
    }

    return parsedMetadata
  }

  private async runTitleProbe(drive: string, titleNumber: number, audioLanguage: string, budget: ScanBudget) {
    const titleProbe = await this.runProcessWithinDeadline(buildTitleProbeCommand({
      executable: this.options.executable,
      drive,
      titleNumber,
      audioLanguage,
      timeoutMs: this.options.timeoutMs,
    }), budget.deadlineAt, budget.deadlineMs, budget.scannedTitles, budget.totalTitles)

    return {
      parsed: parseTitleProbeLog(joinProcessOutput(titleProbe)),
      log: joinProcessOutput(titleProbe),
    } satisfies ParsedTitleProbe
  }

  private async queryTrackMetadata(drive: string, titleNumber: number, budget: ScanBudget): Promise<RuntimeTrackMetadata | null> {
    if (!this.options.trackMetadataScript) {
      return null
    }

    const result = await this.runProcessWithinDeadline(buildTrackMetadataCommand({
      drive,
      titleNumber,
      timeoutMs: this.options.timeoutMs,
      trackMetadataScript: this.options.trackMetadataScript,
    }), budget.deadlineAt, budget.deadlineMs, budget.scannedTitles, budget.totalTitles)
    const payload = parseTrackMetadataPayload(result.stdout)

    if (hasUsableRuntimeTrackMetadata(payload)) {
      return payload
    }

    if (!result.ok && !payload) {
      throw new Error(result.stderr || result.stdout || 'The runtime libVLC track metadata helper failed.')
    }

    return null
  }

  private async inferTrackLabelsFromLanguageProbes(
    drive: string,
    titleNumber: number,
    englishProbeLog: string,
    parsedMetadata: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>,
    budget: ScanBudget,
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
        const log = await this.runLanguageSelectionProbe(drive, titleNumber, probe.code, budget)
        const audioTrackId = extractSelectedAudioTrackId(log)
        const subtitleTrackId = extractSelectedSubtitleTrackId(log)

        if (audioTrackId !== null && audioTrackId !== englishAudioTrackId) {
          addInferredLabel(inferredAudioLabels, audioTrackId, probe.label)
        }

        if (subtitleTrackId !== null && subtitleTrackId !== englishSubtitleTrackId) {
          addInferredLabel(inferredSubtitleLabels, subtitleTrackId, probe.label)
        }
      } catch (error) {
        if (error instanceof DiscScanDeadlineError) throw error
        this.options.logger?.warn('catalog', `${probe.label} language probe did not produce stable metadata for title ${titleNumber}.`)
      }
    }

    return {
      audio: materializeInferredLabels(inferredAudioLabels),
      subtitles: materializeInferredLabels(inferredSubtitleLabels),
    }
  }

  private async runLanguageSelectionProbe(drive: string, titleNumber: number, languageCode: string, budget: ScanBudget) {
    const probe = await this.runProcessWithinDeadline(buildLanguageProbeCommand({
      executable: this.options.executable,
      drive,
      titleNumber,
      languageCode,
      timeoutMs: this.options.timeoutMs,
    }), budget.deadlineAt, budget.deadlineMs, budget.scannedTitles, budget.totalTitles)

    return joinProcessOutput(probe)
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

  private async runProcessWithinDeadline(
    spec: CommandSpec,
    deadlineAt: number,
    deadlineMs: number,
    scannedTitles: number,
    totalTitles: number,
  ): Promise<CompletedProcess> {
    const remainingMs = deadlineAt - this.now()
    if (remainingMs <= 0) throw this.createDeadlineError(deadlineMs, scannedTitles, totalTitles)

    const timeoutMs = Math.max(1, Math.min(spec.timeoutMs > 0 ? spec.timeoutMs : remainingMs, remainingMs))
    const result = await this.runProcess({ ...spec, timeoutMs })
    if (this.now() >= deadlineAt || (result.timedOut && timeoutMs < spec.timeoutMs)) {
      throw this.createDeadlineError(deadlineMs, scannedTitles, totalTitles)
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    if (isDriveBusyMessage(output)) throw new Error(DRIVE_BUSY_MESSAGE)
    return result
  }

  private createDeadlineError(deadlineMs: number, scannedTitles: number, totalTitles: number): DiscScanDeadlineError {
    const label = deadlineMs >= 60000
      ? `${deadlineMs / 60000}-minute`
      : deadlineMs >= 1000 ? `${deadlineMs / 1000}-second` : `${deadlineMs} ms`
    return new DiscScanDeadlineError(`DVD scan exceeded its overall ${label} deadline after probing ${scannedTitles} of ${totalTitles} titles.`)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

interface ScanBudget {
  deadlineAt: number
  deadlineMs: number
  scannedTitles: number
  totalTitles: number
}

class DiscScanDeadlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscScanDeadlineError'
  }
}

function parseTrackMetadataPayload(output: string): RuntimeTrackMetadata | null {
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    return null
  }

  const jsonStart = trimmed.indexOf('{')
  const jsonEnd = trimmed.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error('The runtime libVLC metadata helper did not return JSON.')
  }

  const payload: unknown = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1))
  const record = isRecord(payload) ? payload : {}

  return {
    mediaTracks: Array.isArray(record.mediaTracks) ? record.mediaTracks.map((track) => ({
      id: isRecord(track) && typeof track.id === 'number' ? track.id : -1,
      type: isRecord(track) && typeof track.type === 'number' ? track.type : -1,
      language: isRecord(track) && typeof track.language === 'string' ? track.language : null,
      description: isRecord(track) && typeof track.description === 'string' ? track.description : null,
    })) : [],
    audio: Array.isArray(record.audio) ? record.audio.map((track) => ({
      id: isRecord(track) && typeof track.id === 'number' ? track.id : -1,
      name: isRecord(track) && typeof track.name === 'string' ? track.name : null,
    })) : [],
    subtitles: Array.isArray(record.subtitles) ? record.subtitles.map((track) => ({
      id: isRecord(track) && typeof track.id === 'number' ? track.id : -1,
      name: isRecord(track) && typeof track.name === 'string' ? track.name : null,
    })) : [],
  }
}

function parseRawDiscScanPayload(payload: string): RawDiscScan {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new Error(`VLC scan did not return valid disc metadata JSON: ${formatError(error)}`)
  }

  if (!isRecord(parsed) || typeof parsed.discId !== 'string' || typeof parsed.drive !== 'string' || !Array.isArray(parsed.titles)) {
    throw new Error('VLC scan did not return valid disc metadata.')
  }

  const titles: RawDiscTitle[] = []
  for (const title of parsed.titles) {
    const parsedTitle = parseRawDiscTitle(title)
    if (!parsedTitle) {
      throw new Error('VLC scan did not return valid disc metadata.')
    }

    titles.push(parsedTitle)
  }

  return {
    discId: parsed.discId,
    drive: parsed.drive,
    titles,
  }
}

function parseRawDiscTitle(value: unknown): RawDiscTitle | null {
  if (!isRecord(value)) {
    return null
  }

  const titleNumber = value.titleNumber
  const durationSeconds = value.durationSeconds
  if (typeof titleNumber !== 'number'
    || !Number.isInteger(titleNumber)
    || titleNumber <= 0
    || typeof durationSeconds !== 'number'
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || !Array.isArray(value.audioTracks)
    || !Array.isArray(value.subtitleTracks)) {
    return null
  }

  const audioTracks = parseTrackOptions(value.audioTracks)
  const subtitleTracks = parseTrackOptions(value.subtitleTracks)
  if (!audioTracks || !subtitleTracks) {
    return null
  }

  return {
    titleNumber,
    durationSeconds,
    audioTracks,
    subtitleTracks,
  }
}

function parseTrackOptions(values: unknown[]): Array<{ id: number; label: string }> | null {
  const tracks: Array<{ id: number; label: string }> = []
  for (const value of values) {
    if (!isRecord(value)) {
      return null
    }

    const id = value.id
    const label = value.label
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || typeof label !== 'string') {
      return null
    }

    tracks.push({ id, label })
  }

  return tracks
}

function getVideoTsDir(drive: string): string {
  return `${drive.replace(/[/\\]+$/, '')}/VIDEO_TS`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function joinProcessOutput(process: CompletedProcess): string {
  return [process.stdout, process.stderr].filter(Boolean).join('\n')
}

function formatProcessDetail(process: CompletedProcess): string {
  const lines = [
    `ok=${process.ok}`,
    `timedOut=${process.timedOut}`,
    `code=${process.code ?? 'null'}`,
    `signal=${process.signal ?? 'null'}`,
  ]
  const output = joinProcessOutput(process).trim()
  if (output) {
    lines.push(`output=${truncate(output, 1200)}`)
  }

  return lines.join('; ')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.'
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`
}
