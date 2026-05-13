import type { RawDiscTitle } from '../disc/types.js'

const TITLE_VARIABLE_PATTERN = /attempt to destroy nonexistent variable "title\s+(\d+)"/g
const PGC_LENGTH_PATTERN = /pgc_length=(\d+)/
const AUDIO_PHYSICAL_PATTERN = /DVDNAV_AUDIO_STREAM_CHANGE[\s\S]*?- physical=(\d+)/
const SUBTITLE_PHYSICAL_PATTERN = /DVDNAV_SPU_STREAM_CHANGE[\s\S]*?- physical_wide=(\d+)/

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
  const audioPhysical = log.match(AUDIO_PHYSICAL_PATTERN)
  const subtitlePhysical = log.match(SUBTITLE_PHYSICAL_PATTERN)

  return {
    durationSeconds,
    audioTracks: audioPhysical
      ? [{ id: Number(audioPhysical[1]) + 1, label: `Audio ${Number(audioPhysical[1]) + 1}` }]
      : [],
    subtitleTracks: subtitlePhysical && Number(subtitlePhysical[1]) < 128
      ? [{ id: Number(subtitlePhysical[1]) + 1, label: `Subtitle ${Number(subtitlePhysical[1]) + 1}` }]
      : [],
  }
}