export interface PlaybackTimelineRange {
  startSeconds: number
  endSeconds: number
}

export type PlaybackTimelineStatus = 'idle' | 'seeking'

export type SlotSource = 'generated' | 'bad'

/**
 * The DVD title is modelled as a fixed grid of fixed-length slots. Slot K
 * (1-indexed) always represents DVD time [(K-1) * segmentDurationSeconds,
 * K * segmentDurationSeconds). Because the slot index is a pure function of DVD
 * time, the timeline stays accurate no matter how many times VLC is restarted
 * for seeks or bad-sector recovery. Unreadable slots are filled with a
 * placeholder rather than collapsing the timeline.
 */
const BAD_SLOT_GROUP = -1

interface SlotInfo {
  source: SlotSource
  /** Discontinuity group: the VLC epoch that produced a generated slot, or BAD_SLOT_GROUP. */
  group: number
  assetUri?: string
  durationSeconds?: number
}

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
  segmentDurationSeconds: number
  status: PlaybackTimelineStatus
  /** First slot of the current contiguous playback region; only a user seek moves it. */
  regionStartSlot: number
  slots: Map<number, SlotInfo>
  lastSeekSeconds?: number
  message?: string
}

export function createInitialTimelineRuntime(
  durationSeconds: number | undefined,
  segmentDurationSeconds: number,
): PlaybackTimelineRuntime {
  return {
    durationSeconds,
    segmentDurationSeconds,
    status: 'idle',
    regionStartSlot: 1,
    slots: new Map<number, SlotInfo>(),
  }
}

export function slotForTime(positionSeconds: number, segmentDurationSeconds: number): number {
  return Math.floor(positionSeconds / segmentDurationSeconds) + 1
}

/** Retained alias: the slot index and the HLS segment number are the same value. */
export const segmentNumberForTime = slotForTime

export function slotStartSeconds(slotNumber: number, segmentDurationSeconds: number): number {
  return Math.max(0, slotNumber - 1) * segmentDurationSeconds
}

export function slotEndSeconds(slotNumber: number, segmentDurationSeconds: number): number {
  return slotNumber * segmentDurationSeconds
}

export function normalizeSeekPosition(
  positionSeconds: number,
  durationSeconds: number | undefined,
  segmentDurationSeconds: number,
): number | null {
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

export function setRegionStart(runtime: PlaybackTimelineRuntime, slotNumber: number): void {
  runtime.regionStartSlot = Math.max(1, Math.floor(slotNumber))
}

export function noteGeneratedSlots(runtime: PlaybackTimelineRuntime, segmentNames: string[], group: number): void {
  for (const segmentName of segmentNames) {
    const slotNumber = parseSegmentNumber(segmentName)
    if (slotNumber !== null) {
      runtime.slots.set(slotNumber, { source: 'generated', group })
    }
  }
}

export function markBadSlot(runtime: PlaybackTimelineRuntime, slotNumber: number): void {
  if (Number.isInteger(slotNumber) && slotNumber >= 1) {
    runtime.slots.set(slotNumber, { source: 'bad', group: BAD_SLOT_GROUP })
  }
}

/** Publication records only complete, immutable assets. */
export function publishSlot(runtime: PlaybackTimelineRuntime, slotNumber: number, info: SlotInfo): void {
  runtime.slots.set(slotNumber, { ...info })
}

/** Slots of the current contiguous region, starting at regionStartSlot. */
function regionSlots(runtime: PlaybackTimelineRuntime): number[] {
  const slots: number[] = []
  let slotNumber = runtime.regionStartSlot
  while (runtime.slots.has(slotNumber)) {
    slots.push(slotNumber)
    slotNumber += 1
  }

  return slots
}

function currentRange(runtime: PlaybackTimelineRuntime): PlaybackTimelineRange {
  const slots = regionSlots(runtime)
  const startSeconds = slotStartSeconds(runtime.regionStartSlot, runtime.segmentDurationSeconds)
  const lastSlot = slots.at(-1)
  if (lastSlot === undefined) {
    return { startSeconds, endSeconds: startSeconds }
  }

  return {
    startSeconds,
    endSeconds: capDuration(slotEndSeconds(lastSlot, runtime.segmentDurationSeconds), runtime.durationSeconds),
  }
}

/** The contiguous DVD-time range currently buffered for the active region. */
export function getCurrentRange(runtime: PlaybackTimelineRuntime): PlaybackTimelineRange {
  return currentRange(runtime)
}

/** The next slot the live edge expects VLC to produce (or fill) for the region. */
export function nextExpectedSlot(runtime: PlaybackTimelineRuntime): number {
  return slotForTime(currentRange(runtime).endSeconds, runtime.segmentDurationSeconds)
}

export function toTimelineSnapshot(
  runtime: PlaybackTimelineRuntime,
  baseUrl: string,
  segmentDurationSeconds: number,
): PlaybackTimelineSnapshot {
  return {
    durationSeconds: runtime.durationSeconds,
    status: runtime.status,
    currentRange: currentRange(runtime),
    generatedRanges: rangesFromSlots(runtime, segmentDurationSeconds, 'generated'),
    stitchedManifestUrl: `${baseUrl}stitched.m3u8`,
    lastSeekSeconds: runtime.lastSeekSeconds,
    message: runtime.message,
  }
}

/** Manifest the browser plays: the contiguous region from regionStartSlot, placeholders inline. */
export function buildRegionManifest(runtime: PlaybackTimelineRuntime, segmentDurationSeconds: number): string {
  const slots = regionSlots(runtime)
  const lastSlot = slots.at(-1)
  const total = totalSlots(runtime)
  const complete = total !== null && lastSlot !== undefined && lastSlot >= total
  return buildManifest(slots, runtime, segmentDurationSeconds, {
    mediaSequence: runtime.regionStartSlot,
    playlistType: complete ? 'VOD' : 'EVENT',
    endlist: complete,
  })
}

/** Whole-title cache view: every known slot, joined with discontinuities across gaps. */
export function buildStitchedManifest(runtime: PlaybackTimelineRuntime, segmentDurationSeconds: number): string {
  const slots = [...runtime.slots.keys()].sort((left, right) => left - right)
  const total = totalSlots(runtime)
  const complete = total !== null && slots.length === total && slots[0] === 1 && slots.at(-1) === total
  return buildManifest(slots, runtime, segmentDurationSeconds, {
    mediaSequence: slots[0] ?? 1,
    playlistType: complete ? 'VOD' : undefined,
    endlist: complete,
  })
}

function buildManifest(
  slots: number[],
  runtime: PlaybackTimelineRuntime,
  segmentDurationSeconds: number,
  options: { mediaSequence: number; playlistType?: 'VOD' | 'EVENT'; endlist: boolean },
): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDurationSeconds)}`,
    ...(options.playlistType ? [`#EXT-X-PLAYLIST-TYPE:${options.playlistType}`] : []),
    `#EXT-X-MEDIA-SEQUENCE:${options.mediaSequence}`,
  ]

  slots.forEach((slotNumber, index) => {
    const previousSlot = slots[index - 1]
    if (index > 0 && previousSlot !== undefined) {
      const gap = slotNumber !== previousSlot + 1
      const groupChanged = groupOf(runtime, slotNumber) !== groupOf(runtime, previousSlot)
      if (gap || groupChanged) {
        lines.push('#EXT-X-DISCONTINUITY')
      }
    }

    const info = runtime.slots.get(slotNumber)
    lines.push(`#EXTINF:${info?.durationSeconds ?? segmentDurationSeconds},`, info?.assetUri ?? formatSegmentName(slotNumber))
  })

  if (options.endlist) {
    lines.push('#EXT-X-ENDLIST')
  }

  lines.push('')
  return lines.join('\n')
}

function groupOf(runtime: PlaybackTimelineRuntime, slotNumber: number): number {
  return runtime.slots.get(slotNumber)?.group ?? BAD_SLOT_GROUP
}

function totalSlots(runtime: PlaybackTimelineRuntime): number | null {
  if (typeof runtime.durationSeconds !== 'number' || runtime.durationSeconds <= 0) {
    return null
  }

  return Math.ceil(runtime.durationSeconds / runtime.segmentDurationSeconds)
}

function capDuration(endSeconds: number, durationSeconds: number | undefined): number {
  return typeof durationSeconds === 'number' ? Math.min(endSeconds, durationSeconds) : endSeconds
}

function rangesFromSlots(
  runtime: PlaybackTimelineRuntime,
  segmentDurationSeconds: number,
  source: SlotSource,
): PlaybackTimelineRange[] {
  const slots = [...runtime.slots.entries()]
    .filter(([, info]) => info.source === source)
    .map(([slotNumber]) => slotNumber)
    .sort((left, right) => left - right)

  const ranges: PlaybackTimelineRange[] = []
  for (const slotNumber of slots) {
    const lastRange = ranges.at(-1)
    const startSeconds = slotStartSeconds(slotNumber, segmentDurationSeconds)
    const endSeconds = capDuration(slotEndSeconds(slotNumber, segmentDurationSeconds), runtime.durationSeconds)
    if (lastRange && Math.abs(lastRange.endSeconds - startSeconds) < 1e-9) {
      lastRange.endSeconds = endSeconds
      continue
    }

    ranges.push({ startSeconds, endSeconds })
  }

  return ranges
}

function formatSegmentName(slotNumber: number): string {
  return `segment-${String(slotNumber).padStart(6, '0')}.ts`
}

function parseSegmentNumber(segmentName: string): number | null {
  const match = /segment-(\d+)\.ts$/i.exec(segmentName)
  if (!match) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isInteger(parsed) ? parsed : null
}
