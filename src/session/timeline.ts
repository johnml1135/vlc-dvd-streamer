export interface PlaybackTimelineRange {
  startSeconds: number
  endSeconds: number
}

export type PlaybackTimelineStatus = 'idle' | 'seeking'

export interface PlaybackTimelineSnapshot {
  durationSeconds?: number
  status: PlaybackTimelineStatus
  currentRange: PlaybackTimelineRange
  generatedRanges: PlaybackTimelineRange[]
  stitchedManifestUrl: string
  lastSeekSeconds?: number
  message?: string
}

export interface PlaybackTimelineRuntime {
  durationSeconds?: number
  status: PlaybackTimelineStatus
  currentRange: PlaybackTimelineRange
  generatedSegmentNumbers: Set<number>
  lastSeekSeconds?: number
  message?: string
}

export function createInitialTimelineRuntime(durationSeconds: number | undefined): PlaybackTimelineRuntime {
  return {
    durationSeconds,
    status: 'idle',
    currentRange: { startSeconds: 0, endSeconds: 0 },
    generatedSegmentNumbers: new Set<number>(),
  }
}

export function normalizeSeekPosition(positionSeconds: number, durationSeconds: number | undefined, segmentDurationSeconds: number): number | null {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return null
  }

  if (typeof durationSeconds === 'number' && positionSeconds > durationSeconds) {
    return null
  }

  const alignedPositionSeconds = Math.floor(positionSeconds / segmentDurationSeconds) * segmentDurationSeconds
  if (typeof durationSeconds === 'number') {
    return Math.min(alignedPositionSeconds, Math.max(0, durationSeconds - segmentDurationSeconds))
  }

  return alignedPositionSeconds
}

export function isTimeInRange(positionSeconds: number, range: PlaybackTimelineRange): boolean {
  return positionSeconds >= range.startSeconds && positionSeconds < range.endSeconds
}

export function segmentNumberForTime(positionSeconds: number, segmentDurationSeconds: number): number {
  return Math.floor(positionSeconds / segmentDurationSeconds) + 1
}

export function noteTimelineProgress(runtime: PlaybackTimelineRuntime, segmentNames: string[], segmentDurationSeconds: number): void {
  const segmentNumbers = segmentNames
    .map(parseSegmentNumber)
    .filter((segmentNumber): segmentNumber is number => segmentNumber !== null)

  if (segmentNumbers.length === 0) {
    return
  }

  for (const segmentNumber of segmentNumbers) {
    runtime.generatedSegmentNumbers.add(segmentNumber)
  }

  const firstSegmentNumber = segmentNumbers[0]
  const lastSegmentNumber = segmentNumbers.at(-1)
  if (typeof firstSegmentNumber !== 'number' || typeof lastSegmentNumber !== 'number') {
    return
  }

  runtime.currentRange = {
    startSeconds: segmentStartSeconds(firstSegmentNumber, segmentDurationSeconds),
    endSeconds: capDuration(
      segmentEndSeconds(lastSegmentNumber, segmentDurationSeconds),
      runtime.durationSeconds,
    ),
  }
}

export function toTimelineSnapshot(runtime: PlaybackTimelineRuntime, baseUrl: string, segmentDurationSeconds: number): PlaybackTimelineSnapshot {
  return {
    durationSeconds: runtime.durationSeconds,
    status: runtime.status,
    currentRange: { ...runtime.currentRange },
    generatedRanges: rangesFromSegmentNumbers(runtime.generatedSegmentNumbers, segmentDurationSeconds, runtime.durationSeconds),
    stitchedManifestUrl: `${baseUrl}stitched.m3u8`,
    lastSeekSeconds: runtime.lastSeekSeconds,
    message: runtime.message,
  }
}

export function buildStitchedManifest(runtime: PlaybackTimelineRuntime, segmentDurationSeconds: number): string {
  const segmentRanges = segmentNumberRanges(runtime.generatedSegmentNumbers)
  const firstRange = segmentRanges[0]
  const isComplete = isTimelineComplete(segmentRanges, segmentDurationSeconds, runtime.durationSeconds)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDurationSeconds)}`,
    ...(isComplete ? ['#EXT-X-PLAYLIST-TYPE:VOD'] : []),
    `#EXT-X-MEDIA-SEQUENCE:${firstRange?.startSegmentNumber ?? 1}`,
  ]

  segmentRanges.forEach((range, index) => {
    if (index > 0) {
      lines.push('#EXT-X-DISCONTINUITY')
    }

    for (let segmentNumber = range.startSegmentNumber; segmentNumber <= range.endSegmentNumber; segmentNumber += 1) {
      lines.push(`#EXTINF:${segmentDurationSeconds},`, formatSegmentName(segmentNumber))
    }
  })

  if (isComplete) {
    lines.push('#EXT-X-ENDLIST')
  }

  lines.push('')
  return lines.join('\n')
}

function segmentStartSeconds(segmentNumber: number, segmentDurationSeconds: number): number {
  return Math.max(0, segmentNumber - 1) * segmentDurationSeconds
}

function segmentEndSeconds(segmentNumber: number, segmentDurationSeconds: number): number {
  return segmentNumber * segmentDurationSeconds
}

function capDuration(endSeconds: number, durationSeconds: number | undefined): number {
  return typeof durationSeconds === 'number'
    ? Math.min(endSeconds, durationSeconds)
    : endSeconds
}

function rangesFromSegmentNumbers(
  segmentNumbers: Set<number>,
  segmentDurationSeconds: number,
  durationSeconds: number | undefined,
): PlaybackTimelineRange[] {
  return segmentNumberRanges(segmentNumbers).map((range) => ({
    startSeconds: segmentStartSeconds(range.startSegmentNumber, segmentDurationSeconds),
    endSeconds: capDuration(segmentEndSeconds(range.endSegmentNumber, segmentDurationSeconds), durationSeconds),
  }))
}

function isTimelineComplete(
  ranges: Array<{ startSegmentNumber: number; endSegmentNumber: number }>,
  segmentDurationSeconds: number,
  durationSeconds: number | undefined,
): boolean {
  if (typeof durationSeconds !== 'number' || ranges.length !== 1) {
    return false
  }

  const [range] = ranges
  return range !== undefined
    && range.startSegmentNumber === 1
    && segmentEndSeconds(range.endSegmentNumber, segmentDurationSeconds) >= durationSeconds
}

function segmentNumberRanges(segmentNumbers: Set<number>): Array<{ startSegmentNumber: number; endSegmentNumber: number }> {
  const sorted = [...segmentNumbers].sort((left, right) => left - right)
  const ranges: Array<{ startSegmentNumber: number; endSegmentNumber: number }> = []

  for (const segmentNumber of sorted) {
    const lastRange = ranges.at(-1)
    if (!lastRange || segmentNumber > lastRange.endSegmentNumber + 1) {
      ranges.push({ startSegmentNumber: segmentNumber, endSegmentNumber: segmentNumber })
      continue
    }

    lastRange.endSegmentNumber = segmentNumber
  }

  return ranges
}

function formatSegmentName(segmentNumber: number): string {
  return `segment-${String(segmentNumber).padStart(6, '0')}.ts`
}

function parseSegmentNumber(segmentName: string): number | null {
  const match = /segment-(\d+)\.ts$/i.exec(segmentName)
  if (!match) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isInteger(parsed) ? parsed : null
}