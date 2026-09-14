export interface RunwayRange {
  startSeconds: number
  endSeconds: number
}

export interface RunwayReport {
  manifestUrl: string
  reporterId: string
  sequence: number
  positionSeconds: number
  bufferedEndSeconds: number
  paused: boolean
  playbackRate: number
}

interface StoredReport extends RunwayReport {
  receivedAtMs: number
  durationSeconds?: number
}

const MAX_REPORTERS = 64
const FRESHNESS_MS = 5_000
const TRANSPORT_UNCERTAINTY_SECONDS = 2

/**
 * Keeps the small amount of browser evidence the recovery controller needs.
 * Region and reporter sequence identity are deliberately owned here so callers
 * cannot accidentally turn an old browser response into recovery credit.
 */
export class RunwayEvidence {
  private currentManifestUrl: string | undefined
  private readonly highWaterSequences = new Map<string, number>()
  private readonly reports = new Map<string, StoredReport>()
  private highestDownloadedSlot: number | null = null

  constructor(
    private readonly now: () => number,
    private readonly segmentDurationSeconds: number,
  ) {
    if (!Number.isFinite(segmentDurationSeconds) || segmentDurationSeconds <= 0) {
      throw new Error('Segment duration must be a finite positive number.')
    }
  }

  setRegion(manifestUrl: string): void {
    if (manifestUrl === this.currentManifestUrl) return
    this.currentManifestUrl = manifestUrl
    this.reports.clear()
    this.highestDownloadedSlot = null
  }

  report(value: unknown, range: RunwayRange, durationSeconds?: number): 'accepted' | 'stale' | 'invalid' {
    const report = parseReport(value)
    if (!report || !isValidRange(range) || !isValidDuration(durationSeconds)) {
      return 'invalid'
    }

    if (this.currentManifestUrl === undefined || report.manifestUrl !== this.currentManifestUrl) {
      return 'stale'
    }

    if (report.positionSeconds < range.startSeconds) {
      return 'invalid'
    }

    if (durationSeconds !== undefined) {
      // A browser can briefly report a playhead just beyond the title edge while
      // a final segment drains. Accept two slots of tolerance, then reject it.
      const upperBound = durationSeconds + this.segmentDurationSeconds * 2
      if (report.positionSeconds > upperBound) {
        return 'invalid'
      }
    }

    const previousSequence = this.highWaterSequences.get(report.reporterId)
    if (previousSequence !== undefined && report.sequence <= previousSequence) {
      return 'stale'
    }

    if (previousSequence === undefined && this.highWaterSequences.size >= MAX_REPORTERS) {
      return 'stale'
    }

    const receivedAtMs = finiteNow(this.now)
    this.highWaterSequences.set(report.reporterId, report.sequence)
    this.reports.set(report.reporterId, {
      ...report,
      receivedAtMs,
      durationSeconds,
    })
    return 'accepted'
  }

  noteDownload(manifestUrl: string, slot: number): void {
    if (manifestUrl !== this.currentManifestUrl || !Number.isSafeInteger(slot) || slot < 1) return
    this.highestDownloadedSlot = this.highestDownloadedSlot === null
      ? slot
      : Math.max(this.highestDownloadedSlot, slot)
  }

  runwaySlots(producedSlot: number): number | null {
    if (!Number.isSafeInteger(producedSlot) || producedSlot < 1) return null

    const nowMs = finiteNow(this.now)
    const freshReports = [...this.reports.values()].filter((report) => {
      return report.manifestUrl === this.currentManifestUrl && nowMs - report.receivedAtMs < FRESHNESS_MS
    })

    const activeRunways: number[] = []
    for (const report of freshReports) {
      if (report.paused || report.playbackRate === 0) continue

      const producedEndSeconds = Math.min(
        producedSlot * this.segmentDurationSeconds,
        report.durationSeconds ?? Number.POSITIVE_INFINITY,
      )
      const bufferedEndSeconds = Math.min(report.bufferedEndSeconds, producedEndSeconds)
      const ageSeconds = Math.max(0, nowMs - report.receivedAtMs) / 1000
      const wallSeconds = Math.max(
        0,
        (bufferedEndSeconds - report.positionSeconds) / report.playbackRate
          - ageSeconds
          - TRANSPORT_UNCERTAINTY_SECONDS,
      )
      activeRunways.push(wallSeconds)
    }

    if (activeRunways.length > 0) {
      return Math.min(...activeRunways) / this.segmentDurationSeconds
    }

    if (freshReports.length > 0) return Number.POSITIVE_INFINITY
    if (this.highestDownloadedSlot === null) return null
    return Math.max(0, producedSlot - this.highestDownloadedSlot)
  }
}

function parseReport(value: unknown): RunwayReport | null {
  if (!isRecord(value)) return null
  const manifestUrl = value.manifestUrl
  const reporterId = value.reporterId
  const sequence = value.sequence
  const positionSeconds = value.positionSeconds
  const bufferedEndSeconds = value.bufferedEndSeconds
  const paused = value.paused
  const playbackRate = value.playbackRate
  if (typeof manifestUrl !== 'string' || manifestUrl.trim() === ''
    || typeof reporterId !== 'string' || reporterId.trim() === '' || reporterId.length > 128
    || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
    || !isFiniteNonNegative(positionSeconds)
    || !isFiniteNonNegative(bufferedEndSeconds)
    || bufferedEndSeconds < positionSeconds
    || typeof paused !== 'boolean'
    || !isFiniteNonNegative(playbackRate) || playbackRate > 16) {
    return null
  }

  return {
    manifestUrl,
    reporterId,
    sequence,
    positionSeconds,
    bufferedEndSeconds,
    paused,
    playbackRate,
  }
}

function isValidRange(value: unknown): value is RunwayRange {
  return isRecord(value)
    && isFiniteNonNegative(value.startSeconds)
    && isFiniteNonNegative(value.endSeconds)
    && value.endSeconds >= value.startSeconds
}

function isValidDuration(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNonNegative(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNow(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value)) throw new Error('Runway evidence clock must return a finite number.')
  return value
}
