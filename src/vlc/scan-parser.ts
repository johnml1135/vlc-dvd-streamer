import type { RawDiscTitle } from '../disc/types.js'

const TITLE_VARIABLE_PATTERN = /attempt to destroy nonexistent variable "title\s+(\d+)"/g
const PGC_LENGTH_PATTERN = /pgc_length=(\d+)/
const AUDIO_PHYSICAL_PATTERN = /DVDNAV_AUDIO_STREAM_CHANGE[\s\S]*?- physical=(\d+)/g
const SUBTITLE_PHYSICAL_PATTERN = /DVDNAV_SPU_STREAM_CHANGE[\s\S]*?- physical_wide=(\d+)/g
const SUBTITLE_ES_PATTERN = /ES 0xbd([0-9a-f]{2})/gi

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

function createTrackOptions(kind: 'Audio' | 'Subtitle', trackIds: number[]) {
  return trackIds.map((trackId) => ({
    id: trackId,
    label: `${kind} ${trackId + 1}`,
  }))
}