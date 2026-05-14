import type { RawDiscTitle } from '../disc/types.js'

const TITLE_VARIABLE_PATTERN = /attempt to destroy nonexistent variable "title\s+(\d+)"/g
const PGC_LENGTH_PATTERN = /pgc_length=(\d+)/
const AUDIO_PHYSICAL_PATTERN = /DVDNAV_AUDIO_STREAM_CHANGE[\s\S]*?- physical=(\d+)/g
const SUBTITLE_PHYSICAL_PATTERN = /DVDNAV_SPU_STREAM_CHANGE[\s\S]*?- physical_wide=(\d+)/g
const SUBTITLE_ES_PATTERN = /ES 0xbd([0-9a-f]{2})/gi

export interface RuntimeMediaTrackMetadata {
  id: number
  type: number
  language: string | null
  description: string | null
}

export interface RuntimeTrackDescription {
  id: number
  name: string | null
}

export interface RuntimeTrackMetadata {
  mediaTracks: RuntimeMediaTrackMetadata[]
  audio: RuntimeTrackDescription[]
  subtitles: RuntimeTrackDescription[]
}

export interface InferredTrackLabels {
  audio: Array<{ id: number; label: string }>
  subtitles: Array<{ id: number; label: string }>
}

export function extractPlayableTitleNumbers(log: string): number[] {
  const discovered = new Set<number>()

  for (const match of log.matchAll(TITLE_VARIABLE_PATTERN)) {
    const titleIndex = Number(match[1])
    if (Number.isInteger(titleIndex) && titleIndex > 0) {
      discovered.add(titleIndex)
    }
  }

  return [...discovered].sort((left, right) => left - right)
}

export function parseTitleProbeLog(log: string): Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'> {
  const pgcLengthMatch = log.match(PGC_LENGTH_PATTERN)
  if (!pgcLengthMatch) {
    throw new Error('Could not find pgc_length in VLC probe log.')
  }

  const durationSeconds = Math.round(Number(pgcLengthMatch[1]) / 90000)
  const audioTrackIds = collectTrackIds(log, AUDIO_PHYSICAL_PATTERN)
  const subtitleTrackIds = new Set<number>([
    ...collectTrackIds(log, SUBTITLE_PHYSICAL_PATTERN, (physicalId) => physicalId < 128 ? physicalId : null),
    ...collectSubtitleEsIds(log),
  ])

  return {
    durationSeconds,
    audioTracks: createTrackOptions('Audio', audioTrackIds),
    subtitleTracks: createTrackOptions('Subtitle', [...subtitleTrackIds].sort((left, right) => left - right)),
  }
}

export function mergeTitleProbeMetadata(
  probes: Array<Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>>,
): Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'> {
  if (probes.length === 0) {
    throw new Error('At least one parsed VLC title probe is required.')
  }

  const durationSeconds = probes[0].durationSeconds
  const audioTrackIds = new Set<number>()
  const subtitleTrackIds = new Set<number>()

  for (const probe of probes) {
    for (const track of probe.audioTracks) {
      audioTrackIds.add(track.id)
    }

    for (const track of probe.subtitleTracks) {
      subtitleTrackIds.add(track.id)
    }
  }

  return {
    durationSeconds,
    audioTracks: createTrackOptions('Audio', [...audioTrackIds].sort((left, right) => left - right)),
    subtitleTracks: createTrackOptions('Subtitle', [...subtitleTrackIds].sort((left, right) => left - right)),
  }
}

export function enrichTrackLabels(
  parsed: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>,
  runtime: RuntimeTrackMetadata,
): Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'> {
  const inferred: InferredTrackLabels = {
    audio: [],
    subtitles: [],
  }
  const knownAudioTrackIds = new Set(parsed.audioTracks.map((track) => track.id))
  const audioDescriptionLabels: Array<{ id: number; label: string }> = []

  for (const track of runtime.audio) {
    const audioTrackId = normalizeRuntimeAudioTrackId(track.id)
    if (audioTrackId === null) {
      continue
    }

    const label = normalizeRuntimeTrackName(track.name)
    if (label) {
      knownAudioTrackIds.add(audioTrackId)
      audioDescriptionLabels.push({ id: audioTrackId, label })
    }
  }

  for (const track of runtime.mediaTracks) {
    if (track.type !== 0) {
      continue
    }

    const audioTrackId = normalizeRuntimeAudioTrackId(track.id)
    if (audioTrackId === null || !knownAudioTrackIds.has(audioTrackId)) {
      continue
    }

    const label = normalizeRuntimeTrackName(track.description) ?? getLanguageDisplayName(track.language)
    if (label) {
      inferred.audio.push({ id: audioTrackId, label })
    }
  }

  inferred.audio.push(...audioDescriptionLabels)

  for (const track of runtime.subtitles) {
    const subtitleTrackId = normalizeSubtitleTrackId(track.id)
    if (subtitleTrackId === null) {
      continue
    }

    const label = normalizeRuntimeTrackName(track.name)
    if (!label) {
      continue
    }

    inferred.subtitles.push({ id: subtitleTrackId, label })
  }

  return applyInferredTrackLabels(parsed, inferred)
}

export function extractSelectedAudioTrackId(log: string): number | null {
  return extractLastTrackId(log, AUDIO_PHYSICAL_PATTERN)
}

export function extractSelectedSubtitleTrackId(log: string): number | null {
  const rawTrackId = extractLastTrackId(log, SUBTITLE_PHYSICAL_PATTERN)
  if (rawTrackId !== null) {
    if (rawTrackId >= 128 && rawTrackId <= 159) {
      return rawTrackId - 128
    }

    if (rawTrackId >= 0 && rawTrackId <= 31) {
      return rawTrackId
    }
  }

  const subtitleEsIds = collectSubtitleEsIds(log)
  return subtitleEsIds.length > 0 ? subtitleEsIds[subtitleEsIds.length - 1]! : null
}

export function applyInferredTrackLabels(
  parsed: Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'>,
  inferred: InferredTrackLabels,
): Pick<RawDiscTitle, 'durationSeconds' | 'audioTracks' | 'subtitleTracks'> {
  return {
    durationSeconds: parsed.durationSeconds,
    audioTracks: applyTrackLabels(parsed.audioTracks, inferred.audio, 'Audio'),
    subtitleTracks: applyTrackLabels(parsed.subtitleTracks, inferred.subtitles, 'Subtitle'),
  }
}

function collectTrackIds(
  log: string,
  pattern: RegExp,
  transform: (trackId: number) => number | null = (trackId) => trackId,
): number[] {
  const trackIds = new Set<number>()

  for (const match of log.matchAll(pattern)) {
    const rawTrackId = Number(match[1])
    if (!Number.isInteger(rawTrackId)) {
      continue
    }

    const trackId = transform(rawTrackId)
    if (trackId === null || !Number.isInteger(trackId) || trackId < 0) {
      continue
    }

    trackIds.add(trackId)
  }

  return [...trackIds].sort((left, right) => left - right)
}

function extractLastTrackId(log: string, pattern: RegExp): number | null {
  let selectedTrackId: number | null = null

  for (const match of log.matchAll(pattern)) {
    const rawTrackId = Number(match[1])
    if (Number.isInteger(rawTrackId)) {
      selectedTrackId = rawTrackId
    }
  }

  return selectedTrackId
}

function collectSubtitleEsIds(log: string): number[] {
  const trackIds = new Set<number>()

  for (const match of log.matchAll(SUBTITLE_ES_PATTERN)) {
    const packetId = Number.parseInt(match[1], 16)
    if (!Number.isInteger(packetId)) {
      continue
    }

    const trackId = packetId - 0x20
    if (trackId >= 0 && trackId <= 0x1f) {
      trackIds.add(trackId)
    }
  }

  return [...trackIds].sort((left, right) => left - right)
}

function normalizeSubtitleTrackId(trackId: number): number | null {
  if (!Number.isInteger(trackId) || trackId < 0) {
    return null
  }

  if (trackId <= 0x1f) {
    return trackId
  }

  const packetId = trackId & 0xff
  const normalizedTrackId = packetId - 0x20
  return normalizedTrackId >= 0 && normalizedTrackId <= 0x1f ? normalizedTrackId : null
}

function normalizeRuntimeAudioTrackId(trackId: number): number | null {
  if (!Number.isInteger(trackId) || trackId < 0) {
    return null
  }

  if (trackId <= 0x1f) {
    return trackId
  }

  const packetId = trackId & 0xff
  const normalizedTrackId = packetId - 0x80
  return normalizedTrackId >= 0 && normalizedTrackId <= 0x1f ? normalizedTrackId : null
}

function normalizeRuntimeTrackName(name: string | null): string | null {
  if (!name) {
    return null
  }

  const trimmed = name.trim()
  if (trimmed.length === 0 || /^disable$/i.test(trimmed)) {
    return null
  }

  const bracketMatch = trimmed.match(/\[([^\]]+)\]\s*$/)
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim()
  }

  return trimmed
}

function getLanguageDisplayName(language: string | null): string | null {
  if (!language) {
    return null
  }

  const normalizedLanguage = language.trim().replace(/_/g, '-')
  if (normalizedLanguage.length === 0) {
    return null
  }

  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
    const displayName = displayNames.of(normalizedLanguage)
    return displayName ? displayName.trim() : normalizedLanguage
  } catch {
    return normalizedLanguage
  }
}

function applyTrackLabels(
  parsedTracks: Array<{ id: number; label: string }>,
  inferredTracks: Array<{ id: number; label: string }>,
  kind: 'Audio' | 'Subtitle',
) {
  const inferredLabels = new Map<number, string>()
  const trackIds = new Set<number>(parsedTracks.map((track) => track.id))

  for (const track of inferredTracks) {
    if (!Number.isInteger(track.id) || track.id < 0 || !track.label) {
      continue
    }

    inferredLabels.set(track.id, track.label)
    trackIds.add(track.id)
  }

  return [...trackIds]
    .sort((left, right) => left - right)
    .map((trackId) => ({
      id: trackId,
      label:
        inferredLabels.get(trackId)
        ?? parsedTracks.find((track) => track.id === trackId)?.label
        ?? `${kind} ${trackId + 1}`,
    }))
}

function createTrackOptions(kind: 'Audio' | 'Subtitle', trackIds: number[]) {
  return trackIds.map((trackId) => ({
    id: trackId,
    label: `${kind} ${trackId + 1}`,
  }))
}