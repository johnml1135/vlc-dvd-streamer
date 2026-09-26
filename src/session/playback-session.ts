import { formatClock } from '../shared/format-clock.js'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedProcessHandle } from '../vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../vlc/worker.js'
import type { ServerLog } from '../logging/server-log.js'
import { segmentNumberForTime, slotEndSeconds, slotStartSeconds, type PlaybackTimelineSnapshot } from './timeline.js'
import { HlsPublication, type PublicationEpoch, type AssetOptions, type PublishedAsset } from './hls-publication.js'
import { systemPlaybackTime, type PlaybackTime } from './playback-time.js'
import { RunwayEvidence } from './runway-evidence.js'

export type SessionState = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'

export interface SessionRequest {
  discId: string
  drive: string
  titleNumber: number
  durationSeconds?: number
  audioTrack?: number
  subtitleTrack?: number
}

export interface PlaybackSession extends SessionRequest {
  id: string
  state: SessionState
  outputDir: string
  manifestPath: string
  manifestUrl: string
  startedAt: string
  lastAccessedAt: string
  error?: {
    message: string
    detail?: string
  }
  recovery?: PlaybackRecoverySnapshot
  timeline?: PlaybackTimelineSnapshot
}

interface SessionRecord extends Omit<PlaybackSession, 'manifestUrl' | 'recovery' | 'timeline'> {
  handle: ManagedProcessHandle
  baseUrl: string
  recoveryRuntime: PlaybackRecoveryRuntime
  publication: HlsPublication
  publicationEpoch: PublicationEpoch
  recoveryTimer?: () => void
  workerStoppedForRecovery?: boolean
  workerCleanupPending?: boolean
}

export type PlaybackSeekAction = 'already-available' | 'restarted'

export type PlaybackSeekResult = {
  ok: true
  action: PlaybackSeekAction
  positionSeconds: number
  session: PlaybackSession
} | {
  ok: false
  reason: 'not-found' | 'not-ready' | 'not-seekable' | 'invalid-position'
  message: string
}

export type PlaybackReportResult = 'accepted' | 'stale' | 'invalid' | 'not-found'

export interface PlaybackRecoveryRange {
  startSeconds: number
  endSeconds: number
  reason: string
}

export type PlaybackRecoveryStatus = 'idle' | 'recovering' | 'exhausted'

export interface PlaybackRecoverySnapshot {
  enabled: boolean
  status: PlaybackRecoveryStatus
  attempts: number
  epoch: number
  skippedSeconds: number
  lastGoodTimeSeconds: number
  lastProgressAt?: string
  lastSegmentName?: string
  message?: string
  badRanges: PlaybackRecoveryRange[]
}

export interface PlaybackRecoveryOptions {
  enabled?: boolean
  stallTimeoutMs?: number
  monitorIntervalMs?: number
  restartReadinessTimeoutMs?: number
  stopTimeoutMs?: number
  /** Retired: bad sectors are now filled one slot at a time, never skipped in bulk. Accepted for config compatibility. */
  skipSeconds?: number
  /** Max VLC read-retries on a single stalled slot before giving up and marking it bad. */
  readRetryAttempts?: number
  /**
   * Buffer floor, in 2s slots, of already-produced content the viewer has not
   * yet fetched. While runway exceeds this we keep retrying a stalled read;
   * once it drains to this we skip just-in-time so the viewer never stalls.
   */
  skipGuardSlots?: number
  /**
   * How long a stalled-but-still-running VLC may be left to clear a transient
   * read hiccup on its own (no disruptive restart) while the viewer has a
   * healthy buffer. Capped per-tick by the actual runway.
   */
  maxStallPatienceMs?: number
  /** Maximum failed VLC restarts since the last readable output before declaring the disc unreadable. */
  maxAttempts?: number
  segmentDurationSeconds?: number
}

interface PlaybackRecoveryRuntime {
  enabled: boolean
  status: PlaybackRecoveryStatus
  attempts: number
  epoch: number
  skippedSeconds: number
  lastGoodTimeSeconds: number
  lastProgressAt?: string
  lastSegmentName?: string
  message?: string
  badRanges: PlaybackRecoveryRange[]
  // Internal control state — never surfaced in the public snapshot.
  lastProgressAtMs: number | null
  consecutiveReadRetries: number
  retryAnchorSlot: number | null
  consecutiveBadSlots: number
  restartFailures: number
  inBadRun: boolean
  /** Highest segment slot the browser has fetched; the leading edge of playback. Null until the client requests its first segment. */
}

interface HlsProgress {
  segmentNames: string[]
  lastSegmentName: string
  lastSegmentNumber: number | null
}

interface HlsSessionWorker {
  startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult>
  generatePlaceholderSegment?(input: { outputDir: string; durationSeconds?: number }): Promise<void>
}

export interface SessionManagerEvent {
  type: string
  payload: unknown
}

export interface PlaybackSessionControllerOptions {
  cacheDir: string
  worker: HlsSessionWorker
  readinessTimeoutMs?: number
  playbackRecovery?: PlaybackRecoveryOptions
  onSessionEvent?: (event: SessionManagerEvent) => void
  logger?: ServerLog
  /** Injectable calendar clock for session timestamps, activity and inactivity cleanup. */
  now?: () => number
  /** Injectable monotonic elapsed clock and scheduler for readiness and recovery. */
  time?: PlaybackTime
  /** Writes the bad-sector placeholder for a slot. Defaults to a minimal valid TS packet. */
  writePlaceholderSegment?: (filePath: string, slotNumber: number) => Promise<void>
}

const DEFAULT_RECOVERY_OPTIONS = {
  enabled: true,
  stallTimeoutMs: 10000,
  monitorIntervalMs: 1000,
  restartReadinessTimeoutMs: 30000,
  stopTimeoutMs: 5000,
  skipSeconds: 10,
  readRetryAttempts: 12,
  skipGuardSlots: 3,
  maxStallPatienceMs: 20000,
  maxAttempts: 6,
  segmentDurationSeconds: 2,
} satisfies Required<PlaybackRecoveryOptions>

export class PlaybackSessionController {
  private readonly options: PlaybackSessionControllerOptions
  private session?: SessionRecord
  private operations: Promise<unknown> = Promise.resolve()
  private stoppingRequested = false
  private placeholderGeneration: Promise<void> = Promise.resolve()
  private readonly calendarNow: () => number
  private readonly time: PlaybackTime
  private readonly runwayEvidence: RunwayEvidence
  private readonly intentWaiters = new Set<(status: 'cancelled') => void>()
  private intentVersion = 0

  constructor(options: PlaybackSessionControllerOptions, private readonly onCreated: (id: string) => void) {
    this.options = options
    this.calendarNow = options.now ?? Date.now
    this.time = options.time ?? systemPlaybackTime
    this.runwayEvidence = new RunwayEvidence(() => this.time.now(), this.getRecoveryOptions().segmentDurationSeconds)
  }

  getSession(): PlaybackSession | undefined {
    const session = this.session
    if (!session) {
      return undefined
    }

    return this.toPlaybackSession(session)
  }

  async readAsset(name: string, options: AssetOptions): Promise<PublishedAsset | null> {
    const session = this.session
    if (!session || session.state === 'stopped' || session.state === 'stopping' || this.stoppingRequested) return null
    const manifestUrl = session.publication.manifestUrl
    const asset = await session.publication.readAsset(name, options)
    if (asset) {
      this.touch()
      if (asset.slotNumber !== undefined && session.publication.manifestUrl === manifestUrl
        && session.publication.isCurrentRegion(options.region)) {
        this.noteClientSegmentRequest(asset.slotNumber)
      }
    }
    return asset
  }

  /** Manifest the browser plays: the contiguous region from the current edit point, placeholders inline. */
  getRegionManifest(): string | null {
    const session = this.session
    if (!session) {
      return null
    }

    this.runwayEvidence.setRegion(session.publication.manifestUrl)
    return session.publication.regionManifest()
  }

  getStitchedManifest(): string | null {
    const session = this.session
    if (!session) {
      return null
    }

    return session.publication.stitchedManifest()
  }

  touch(): void {
    const session = this.session
    if (!session || session.state === 'stopped' || session.state === 'failed') {
      return
    }

    session.lastAccessedAt = new Date(this.calendarNow()).toISOString()
  }

  /**
   * Record a current-region segment download for the legacy client path.
   * Recovery uses it as a conservative fallback when richer playback evidence
   * has not arrived yet.
   */
  noteClientSegmentRequest(slotNumber: number): void {
    const session = this.session
    if (!session || session.state === 'stopped' || session.state === 'failed') {
      return
    }

    if (!Number.isInteger(slotNumber) || slotNumber < 1) {
      return
    }

    const currentRange = session.publication.currentRange
    const slotDuration = this.getRecoveryOptions().segmentDurationSeconds
    const slotStart = slotStartSeconds(slotNumber, slotDuration)
    if (slotStart < currentRange.startSeconds || slotStart >= currentRange.endSeconds) return
    this.runwayEvidence.setRegion(session.publication.manifestUrl)
    this.runwayEvidence.noteDownload(session.publication.manifestUrl, slotNumber)
  }

  reportPlayback(value: unknown): PlaybackReportResult {
    const session = this.session
    if (!session || session.state === 'stopped' || session.state === 'failed' || session.state === 'stopping' || this.stoppingRequested) return 'not-found'
    this.runwayEvidence.setRegion(session.publication.manifestUrl)
    const result = this.runwayEvidence.report(value, session.publication.currentRange, session.durationSeconds)
    if (result === 'accepted') this.touch()
    return result
  }

  seek(input: { positionSeconds: number }): Promise<PlaybackSeekResult> {
    this.invalidateIntent()
    const expectedIntentVersion = this.intentVersion
    return this.enqueue(() => this.seekOwned(input, expectedIntentVersion))
  }

  private async seekOwned(input: { positionSeconds: number }, expectedIntentVersion: number): Promise<PlaybackSeekResult> {
    const session = this.session
    if (!session) {
      return { ok: false, reason: 'not-found', message: 'Session not found.' }
    }

    if (!this.intentIsCurrent(session, expectedIntentVersion)) {
      return { ok: false, reason: 'not-ready', message: 'Session is not ready for seeking.' }
    }

    let cleanedPendingWorker = false
    if (session.workerCleanupPending) {
      this.clearRecoveryMonitor(session)
      try {
        await this.stopHandle(session.handle, `cancelled recovery worker for session ${session.id}`)
      } catch (error) {
        this.options.logger?.warn('session', `Cancelled recovery worker for ${session.id} is still owned after stop failure: ${formatError(error)}`)
        this.scheduleRecoveryMonitor(session)
        return { ok: false, reason: 'not-ready', message: formatError(error) }
      }
      session.workerCleanupPending = false
      session.workerStoppedForRecovery = true
      cleanedPendingWorker = true
    }

    const recoveryOptions = this.getRecoveryOptions()
    const positionSeconds = session.publication.normalizeSeek(input.positionSeconds)
    if (positionSeconds === null) {
      if (cleanedPendingWorker) this.scheduleRecoveryMonitor(session)
      return { ok: false, reason: 'invalid-position', message: 'Seek position must be a finite non-negative number within the title duration.' }
    }

    session.lastAccessedAt = new Date(this.calendarNow()).toISOString()

    if (session.publication.contains(positionSeconds) && !session.workerStoppedForRecovery) {
      session.publication.finishSeek(`Title time ${positionSeconds} seconds is already available in the current region.`, positionSeconds)
      return {
        ok: true,
        action: 'already-available',
        positionSeconds,
        session: this.toPlaybackSession(session),
      }
    }

    if (session.publication.contains(positionSeconds) && session.workerStoppedForRecovery) {
      this.clearRecoveryMonitor(session)
      try {
        if (this.hasReachedEndOfTitle(session)) {
          session.workerStoppedForRecovery = false
          session.publication.finishSeek(`Title time ${positionSeconds} seconds is already available in the current region.`, positionSeconds)
          return {
            ok: true,
            action: 'already-available',
            positionSeconds,
            session: this.toPlaybackSession(session),
          }
        }
        const resumeSlot = session.publication.nextSlot
        await this.restartWorker(session, slotStartSeconds(resumeSlot, recoveryOptions.segmentDurationSeconds), resumeSlot, expectedIntentVersion)
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        const progress = await this.waitForFreshSegment(session, resumeSlot, expectedIntentVersion)
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        this.notePlaybackProgress(session, progress, this.time.now())
        session.error = undefined
        session.publication.finishSeek(`Title time ${positionSeconds} seconds is already available in the current region.`, positionSeconds)
        return {
          ok: true,
          action: 'already-available',
          positionSeconds,
          session: this.toPlaybackSession(session),
        }
      } catch (error) {
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        session.error = { message: 'Playback resume failed.', detail: formatError(error) }
        return { ok: false, reason: 'not-ready', message: session.error.detail ?? session.error.message }
      } finally {
        this.scheduleRecoveryMonitor(session)
      }
    }

    // The operation queue has drained earlier recovery work. Keep the timer
    // paused until this seek completes; stop requests prevent rescheduling.
    this.clearRecoveryMonitor(session)
    try {
      this.resetRecoveryRegionState(session)
      const initialSegmentNumber = segmentNumberForTime(positionSeconds, recoveryOptions.segmentDurationSeconds)

      session.publication.seekTo(positionSeconds)
      this.runwayEvidence.setRegion(session.publication.manifestUrl)
      this.publishSessionEvent({
        type: 'session.seek',
        payload: {
          sessionId: session.id,
          status: session.publication.snapshot().status,
          positionSeconds,
        },
      })

      if (!session.workerStoppedForRecovery) {
        await this.stopHandle(session.handle, `seek session ${session.id}`)
      }
      if (!this.intentIsCurrent(session, expectedIntentVersion)) {
        return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
      }

      try {
        await this.restartWorker(session, positionSeconds, initialSegmentNumber, expectedIntentVersion)
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        const progress = await this.waitForFreshSegment(session, initialSegmentNumber, expectedIntentVersion)
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        this.notePlaybackProgress(session, progress, this.time.now())
        session.error = undefined
        session.publication.finishSeek(`Ready at ${positionSeconds} seconds.`)
        session.lastAccessedAt = new Date(this.calendarNow()).toISOString()
        this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
        return {
          ok: true,
          action: 'restarted',
          positionSeconds,
          session: this.toPlaybackSession(session),
        }
      } catch (error) {
        if (!this.intentIsCurrent(session, expectedIntentVersion)) {
          return { ok: false, reason: 'not-ready', message: 'Seek was cancelled.' }
        }
        session.publication.finishSeek(`Seek did not produce HLS output: ${formatError(error)}`)
        session.error = {
          message: 'Playback seek failed.',
          detail: formatError(error),
        }
        // Let the recovery monitor take over from the seek target so an unreadable
        // landing zone is bad-filled rather than left hanging.
        session.recoveryRuntime.lastProgressAtMs = this.time.now()
        this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
        return { ok: false, reason: 'not-ready', message: session.error.detail ?? session.error.message }
      }
    } finally {
      this.scheduleRecoveryMonitor(session)
    }
  }

  start(request: SessionRequest): Promise<PlaybackSession> {
    return this.enqueue(() => this.startOwned(request))
  }

  private async startOwned(request: SessionRequest): Promise<PlaybackSession> {
    const id = randomUUID()
    const outputDir = join(this.options.cacheDir, 'sessions', id)
    const baseUrl = `/streams/${id}/`
    await mkdir(outputDir, { recursive: true })

    const recoveryOptions = this.getRecoveryOptions()
    const now = new Date(this.calendarNow()).toISOString()
    const publication = new HlsPublication({
      outputDir, baseUrl, durationSeconds: request.durationSeconds,
      segmentDurationSeconds: recoveryOptions.segmentDurationSeconds,
      writePlaceholderSegment: this.options.writePlaceholderSegment,
      warn: message => this.options.logger?.warn('session', message),
    })
    this.runwayEvidence.setRegion(publication.manifestUrl)
    const publicationEpoch = await publication.beginEpoch()
    // Always anchor the first epoch to slot 1 / DVD time 0 so segment file
    // numbers equal slot numbers from the very start.
    let runtime: StartHlsSessionResult
    try {
      runtime = await this.options.worker.startHlsSession({
        drive: request.drive,
        titleNumber: request.titleNumber,
        audioTrack: request.audioTrack,
        subtitleTrack: request.subtitleTrack,
        outputDir: publicationEpoch.outputDir,
        baseUrl,
        startTimeSeconds: 0,
        initialSegmentNumber: 1,
      })
    } catch (error) {
      publication.retire()
      try {
        await rm(outputDir, { force: true, recursive: true })
      } catch (cleanupError) {
        this.options.logger?.warn('session', `Failed to remove session ${id} after worker startup failed: ${formatError(cleanupError)}`)
      }
      throw error
    }

    const session: SessionRecord = {
      ...request,
      id,
      state: 'starting',
      outputDir,
      manifestPath: runtime.manifestPath,
      startedAt: now,
      lastAccessedAt: now,
      handle: runtime.handle,
      baseUrl,
      recoveryRuntime: createInitialRecoveryRuntime(recoveryOptions.enabled),
      publication,
      publicationEpoch,
    }

    this.session = session
    this.onCreated(id)
    this.options.logger?.info('session', `Session ${id} created for title ${request.titleNumber}.`)

    // Render the reusable bad-sector placeholder in the background so it is ready
    // by the time (if ever) an unreadable sector is hit. Non-fatal on failure.
    if (this.options.worker.generatePlaceholderSegment) {
      this.placeholderGeneration = this.options.worker
        .generatePlaceholderSegment({ outputDir, durationSeconds: recoveryOptions.segmentDurationSeconds })
        .catch((error) => {
          this.options.logger?.warn('session', `Bad-sector placeholder render failed for session ${id}: ${formatError(error)}`)
        })
    }

    try {
      const startupIntentVersion = this.intentVersion
      const initialProgress = await this.waitForReadiness(session)
      if (this.stoppingRequested || this.intentVersion !== startupIntentVersion) {
        throw new Error('Playback startup was cancelled.')
      }
      this.notePlaybackProgress(session, initialProgress, this.time.now())
      session.state = 'ready'
      session.lastAccessedAt = new Date(this.calendarNow()).toISOString()
      this.options.logger?.info('session', `Session ${session.id} is ready.`)
      this.scheduleRecoveryMonitor(session)
      return this.toPlaybackSession(session)
    } catch (error) {
      await this.cleanupFailedStartup(session)
      session.state = 'failed'
      session.error = {
        message: 'Playback session failed to become ready.',
        detail: error instanceof Error ? error.message : 'Unknown playback startup error.',
      }
      this.options.logger?.error('session', `Session ${session.id} failed: ${session.error.detail ?? session.error.message}`)
      return this.toPlaybackSession(session)
    }
  }

  /** Invalidate recovery immediately; cleanup still runs through the owner queue. */
  requestStop(): void {
    if (!this.stoppingRequested) this.invalidateIntent()
    this.stoppingRequested = true
    if (this.session) this.clearRecoveryMonitor(this.session)
  }

  stop(): Promise<boolean> {
    this.requestStop()
    return this.enqueue(async () => {
      const session = this.session
      if (!session || session.state === 'stopped') return false
      session.state = 'stopping'
      this.clearRecoveryMonitor(session)
      await this.stopHandle(session.handle, 'session ' + session.id)
      await this.placeholderGeneration
      session.publication.retire()
      await rm(session.outputDir, { force: true, recursive: true })
      session.state = 'stopped'
      return true
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.catch(() => {})
    return result
  }

  private async waitForReadiness(session: SessionRecord): Promise<HlsProgress> {
    const expectedIntentVersion = this.intentVersion
    const deadline = this.time.now() + (this.options.readinessTimeoutMs ?? 120000)

    while (this.time.now() < deadline) {
      const progress = await session.publication.observe(session.publicationEpoch, session.manifestPath)
      if (this.intentVersion !== expectedIntentVersion || this.stoppingRequested) {
        throw new Error('Playback startup was cancelled.')
      }
      if (progress) {
        return progress
      }

      const recoveryOptions = this.getRecoveryOptions()
      const unreadableFirstSlot = session.publication.nextSlot === 1
        && recoveryOptions.enabled && describeReadError(session.handle.getStderr()) !== null
      if (unreadableFirstSlot) {
        const runtime = session.recoveryRuntime
        if (runtime.lastProgressAtMs === null) {
          runtime.lastProgressAtMs = this.time.now()
          runtime.retryAnchorSlot = 1
        }
        if (this.time.now() - runtime.lastProgressAtMs >= recoveryOptions.stallTimeoutMs) {
          await this.performRecoveryStep(session, expectedIntentVersion)
          if (session.state === 'failed') {
            throw new Error(session.error?.detail ?? 'Playback recovery failed before the first HLS segment was ready.')
          }
          continue
        }
      }

      const status = await this.waitForWake(session, Math.min(100, Math.max(0, deadline - this.time.now())))

      if (status === 'exited') {
        const result = await session.handle.completion
        if (session.publication.nextSlot === 1 && recoveryOptions.enabled
          && describeReadError(result.stderr || session.handle.getStderr())) {
          const runtime = session.recoveryRuntime
          runtime.lastProgressAtMs = this.time.now() - recoveryOptions.stallTimeoutMs
          runtime.retryAnchorSlot = 1
          await this.performRecoveryStep(session, expectedIntentVersion)
          if (session.state === 'failed') {
            throw new Error(session.error?.detail ?? 'Playback recovery failed before the first HLS segment was ready.')
          }
          continue
        }
        // Always surface the exit code/signal: on Windows a VLC crash often
        // produces no stderr, so the code is the only diagnostic available.
        const exit = `VLC exited before HLS output was ready (code ${result.code ?? 'null'}, signal ${result.signal ?? 'null'}).`
        const output = result.stderr || result.stdout
        throw new Error(output ? `${exit}\n${output}` : exit)
      }
      if (status === 'cancelled') {
        throw new Error('Playback startup was cancelled.')
      }
    }

    throw new Error('Timed out waiting for HLS manifest and first segment.')
  }

  private async waitForWake(session: SessionRecord, delayMs: number): Promise<'exited' | 'pending' | 'cancelled'> {
    let cancel = () => {}
    let cancelIntent = () => {}
    const scheduled = new Promise<'pending'>((resolve) => {
      cancel = this.time.schedule(delayMs, () => resolve('pending'))
    })
    const intent = new Promise<'cancelled'>((resolve) => {
      const waiter = (status: 'cancelled') => resolve(status)
      this.intentWaiters.add(waiter)
      cancelIntent = () => this.intentWaiters.delete(waiter)
    })
    try {
      return await Promise.race([
        session.handle.completion.then(() => 'exited' as const),
        scheduled,
        intent,
      ])
    } finally {
      cancel()
      cancelIntent()
    }
  }

  private async cleanupFailedStartup(session: SessionRecord): Promise<void> {
    // A failed stop retains ownership of files the worker may still use.
    await this.stopHandle(session.handle, 'failed startup session ' + session.id)
    await this.placeholderGeneration
    session.publication.retire()
    await rm(session.outputDir, { force: true, recursive: true })
  }

  private toPlaybackSession(session: SessionRecord): PlaybackSession {
    const recovery = this.toRecoverySnapshot(session.recoveryRuntime)
    return {
      discId: session.discId,
      drive: session.drive,
      titleNumber: session.titleNumber,
      durationSeconds: session.durationSeconds,
      audioTrack: session.audioTrack,
      subtitleTrack: session.subtitleTrack,
      id: session.id,
      state: session.state,
      outputDir: session.outputDir,
      manifestPath: session.manifestPath,
      manifestUrl: session.publication.manifestUrl,
      startedAt: session.startedAt,
      lastAccessedAt: session.lastAccessedAt,
      error: session.error,
      recovery,
      timeline: session.publication.snapshot(),
    }
  }

  private scheduleRecoveryMonitor(session: SessionRecord): void {
    const recoveryOptions = this.getRecoveryOptions()
    if (this.stoppingRequested || !recoveryOptions.enabled || session.state !== 'ready') {
      return
    }

    this.clearRecoveryMonitor(session)
    const expectedIntentVersion = this.intentVersion
    session.recoveryTimer = this.time.schedule(recoveryOptions.monitorIntervalMs, () => {
      return this.enqueue(() => this.runRecoveryMonitorTick(session, expectedIntentVersion))
    })
  }

  private clearRecoveryMonitor(session: SessionRecord): void {
    if (session.recoveryTimer) {
      session.recoveryTimer()
      session.recoveryTimer = undefined
    }
  }

  private async runRecoveryMonitorTick(session: SessionRecord, expectedIntentVersion: number): Promise<void> {
    if (this.stoppingRequested || session.state !== 'ready' || this.intentVersion !== expectedIntentVersion) {
      this.scheduleRecoveryMonitor(session)
      return
    }

    try {
      if (session.workerCleanupPending) {
        try {
          await this.stopHandle(session.handle, `cancelled recovery worker for session ${session.id}`)
          session.workerCleanupPending = false
          session.workerStoppedForRecovery = true
        } catch (error) {
          this.options.logger?.warn('session', `Cancelled recovery worker for ${session.id} is still owned after stop failure: ${formatError(error)}`)
          return
        }
      }
      await this.checkPlaybackProgress(session, expectedIntentVersion)
    } catch (error) {
      this.options.logger?.warn('session', `Recovery monitor for session ${session.id} failed: ${formatError(error)}`)
    } finally {
      if (session.state === 'ready') {
        this.scheduleRecoveryMonitor(session)
      }
    }
  }

  private async checkPlaybackProgress(session: SessionRecord, expectedIntentVersion: number): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const runtime = session.recoveryRuntime
    const intentVersion = expectedIntentVersion
    const observedEpoch = session.publicationEpoch
    const progress = await session.publication.observe(session.publicationEpoch, session.manifestPath)
    if (!this.recoveryIntentIsCurrent(session, intentVersion, observedEpoch)) return
    const now = this.time.now()

    if (progress && (progress.lastSegmentName !== runtime.lastSegmentName || session.publication.currentRange.endSeconds > runtime.lastGoodTimeSeconds)) {
      const previousGoodTimeSeconds = runtime.lastGoodTimeSeconds
      this.notePlaybackProgress(session, progress, now)
      const advanced = runtime.lastGoodTimeSeconds > previousGoodTimeSeconds
      if (advanced) {
        runtime.restartFailures = 0
        runtime.consecutiveReadRetries = 0
        runtime.retryAnchorSlot = null
        runtime.consecutiveBadSlots = 0
        runtime.inBadRun = false
        if (runtime.status === 'recovering') {
          runtime.status = 'idle'
          runtime.message = 'Recovered DVD playback at the next readable sector.'
          this.publishRecoveryEvent(session)
        }
      }
      return
    }

    if (runtime.lastProgressAtMs === null) {
      return
    }

    // Reached the end of the title — nothing more to read.
    if (this.hasReachedEndOfTitle(session)) {
      session.workerStoppedForRecovery = false
      this.clearRecoveryMonitor(session)
      return
    }

    if (now - runtime.lastProgressAtMs >= recoveryOptions.stallTimeoutMs) {
      // A still-running VLC with a healthy buffer ahead of the viewer is usually
      // working through a transient read hiccup. Restarting it would force a
      // discontinuity for no reason, so leave it be until either the buffer
      // drains toward the viewer or our patience runs out.
      if (this.shouldWaitForSelfRecovery(session, now)) {
        return
      }
      await this.performRecoveryStep(session, intentVersion)
    }
  }

  /**
   * Runway between VLC's produced edge and the viewer, in 2s slots: how many
   * already-produced slots the viewer has not yet fetched. Null when the client
   * has not requested anything yet (buffer depth unknown).
   */
  private computeRunwaySlots(session: SessionRecord): number | null {
    return this.runwayEvidence.runwaySlots(session.publication.nextSlot - 1)
  }

  private shouldWaitForSelfRecovery(session: SessionRecord, nowMs: number): boolean {
    const recoveryOptions = this.getRecoveryOptions()
    const runtime = session.recoveryRuntime

    // A process that has already exited will never self-recover — restart it now.
    if (session.handle.hasExited?.() ?? true) {
      return false
    }

    const runwaySlots = this.computeRunwaySlots(session)
    if (runwaySlots === null || runwaySlots <= recoveryOptions.skipGuardSlots) {
      // Unknown buffer, or the viewer is about to catch up — act immediately.
      return false
    }

    const stalledMs = nowMs - (runtime.lastProgressAtMs ?? nowMs)
    return stalledMs < recoveryOptions.maxStallPatienceMs
  }

  private hasReachedEndOfTitle(session: SessionRecord): boolean {
    const duration = session.publication.durationSeconds
    return typeof duration === 'number' && session.publication.currentRange.endSeconds >= duration
  }

  private async performRecoveryStep(session: SessionRecord, intentVersion: number): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const segmentDurationSeconds = recoveryOptions.segmentDurationSeconds
    const runtime = session.recoveryRuntime
    const previousEpoch = session.publicationEpoch
    const previousManifestPath = session.manifestPath
    const previousHandle = session.handle

    if (this.hasReachedEndOfTitle(session)) {
      session.workerStoppedForRecovery = false
      this.clearRecoveryMonitor(session)
      return
    }

    // Stop and close the old producer before deciding whether its last output
    // made the stalled slot readable. No recovery counters or bad ranges are
    // committed before this ownership boundary succeeds.
    try {
      await this.stopHandle(previousHandle, `stalled session ${session.id}`)
    } catch (error) {
      this.options.logger?.warn('session', `Recovery stop failed for ${session.id}: ${formatError(error)}`)
      return
    }
    session.workerStoppedForRecovery = true

    if (!this.recoveryIntentIsCurrent(session, intentVersion, previousEpoch)) return

    let finalProgress: HlsProgress | null = null
    let observationError: unknown
    try {
      finalProgress = await session.publication.observe(previousEpoch, previousManifestPath)
    } catch (error) {
      observationError = error
      this.options.logger?.warn('session', `Final HLS observation failed for ${session.id}: ${formatError(error)}`)
    }

    if (!this.recoveryIntentIsCurrent(session, intentVersion, previousEpoch)) return

    const finalOutputAdvanced = Boolean(finalProgress && (
      finalProgress.lastSegmentName !== runtime.lastSegmentName
      || session.publication.currentRange.endSeconds > runtime.lastGoodTimeSeconds
    ))
    if (finalOutputAdvanced && finalProgress) {
      this.notePlaybackProgress(session, finalProgress, this.time.now())
      runtime.consecutiveReadRetries = 0
      runtime.retryAnchorSlot = null
      runtime.consecutiveBadSlots = 0
      runtime.inBadRun = false
    }

    if (this.hasReachedEndOfTitle(session)) {
      session.workerStoppedForRecovery = false
      this.clearRecoveryMonitor(session)
      return
    }

    if (finalOutputAdvanced) {
      const resumeSlot = session.publication.nextSlot
      const restarted = await this.restartRecoveryWorker(
        session,
        intentVersion,
        slotStartSeconds(resumeSlot, segmentDurationSeconds),
        resumeSlot,
      )
      if (!restarted) return
      if (!this.intentIsCurrent(session, intentVersion)) return
      runtime.restartFailures = 0
      runtime.lastProgressAtMs = this.time.now()
      return
    }

    // An observation error means only that the evidence is unavailable. Keep
    // the exact retry anchor and restart at it, without declaring a bad slot.
    if (observationError !== undefined) {
      const restarted = await this.restartRecoveryWorker(session, intentVersion,
        slotStartSeconds(session.publication.nextSlot, segmentDurationSeconds), session.publication.nextSlot)
      if (restarted && this.intentIsCurrent(session, intentVersion)) {
        runtime.lastProgressAtMs = this.time.now()
      }
      return
    }

    // Recompute the exact stalled slot after final observation. A segment
    // emitted during stop advances this anchor and must never be replaced.
    const stallSlot = session.publication.nextSlot
    const stallTimeSeconds = slotStartSeconds(stallSlot, segmentDurationSeconds)
    const anchorRetries = runtime.retryAnchorSlot === stallSlot ? runtime.consecutiveReadRetries : 0
    const readReason = describeReadError(previousHandle.getStderr())
    const runwaySlots = this.computeRunwaySlots(session)
    const runwayHealthy = runwaySlots === null || runwaySlots > recoveryOptions.skipGuardSlots
    const shouldRetryRead = observationError !== undefined
      || (!runtime.inBadRun && anchorRetries < recoveryOptions.readRetryAttempts && runwayHealthy)

    let resumeTimeSeconds = stallTimeSeconds
    let retryCount = anchorRetries + 1
    let filled = false
    if (shouldRetryRead) {
      const reason = observationError ? ' (HLS output could not be verified)' : ''
      const message = `DVD read stalled at ${formatClock(stallTimeSeconds)}${readReason ? ` (${readReason})` : ''}${reason}. Retrying read ${retryCount} of ${recoveryOptions.readRetryAttempts}.`
      const restarted = await this.restartRecoveryWorker(session, intentVersion, resumeTimeSeconds, stallSlot)
      if (!restarted) return
      if (!this.intentIsCurrent(session, intentVersion)) return
      runtime.consecutiveReadRetries = retryCount
      runtime.retryAnchorSlot = stallSlot
      runtime.message = message
    } else {
      await this.placeholderGeneration
      if (!this.intentIsCurrent(session, intentVersion)) return

      const published = await session.publication.publishPlaceholder(
        stallSlot,
        () => this.recoveryIntentIsCurrent(session, intentVersion, previousEpoch),
      )
      if (published === false) return
      if (session.publication.nextSlot <= stallSlot) return

      filled = true
      runtime.skippedSeconds += segmentDurationSeconds
      runtime.consecutiveBadSlots += 1
      runtime.inBadRun = true
      this.recordBadRange(runtime, stallTimeSeconds, slotEndSeconds(stallSlot, segmentDurationSeconds))
      runtime.lastGoodTimeSeconds = session.publication.currentRange.endSeconds
      runtime.consecutiveReadRetries = 0
      runtime.retryAnchorSlot = stallSlot + 1
      resumeTimeSeconds = slotStartSeconds(stallSlot + 1, segmentDurationSeconds)
      runtime.message = `Unreadable DVD sector at ${formatClock(stallTimeSeconds)}; inserted a bad-sector marker and continued (${formatClock(runtime.skippedSeconds)} filled so far).`

      if (!this.recoveryIntentIsCurrent(session, intentVersion, previousEpoch)) return
      const restarted = await this.restartRecoveryWorker(session, intentVersion, resumeTimeSeconds, segmentNumberForTime(resumeTimeSeconds, segmentDurationSeconds))
      if (!restarted) return
      if (!this.intentIsCurrent(session, intentVersion)) return
    }

    runtime.status = 'recovering'
    runtime.attempts += 1
    runtime.lastProgressAtMs = this.time.now()
    this.publishRecoveryEvent(session)
    this.options.logger?.warn('session', `Session ${session.id}: ${runtime.message ?? (filled ? 'filled a bad sector' : 'retrying playback')}`)
  }

  private recoveryIntentIsCurrent(session: SessionRecord, intentVersion: number, epoch: PublicationEpoch): boolean {
    return this.intentIsCurrent(session, intentVersion) && session.publicationEpoch === epoch
  }

  private intentIsCurrent(session: SessionRecord, intentVersion: number): boolean {
    return !this.stoppingRequested && (session.state === 'ready' || session.state === 'starting')
      && this.intentVersion === intentVersion
  }

  private invalidateIntent(): void {
    this.intentVersion += 1
    const waiters = [...this.intentWaiters]
    this.intentWaiters.clear()
    for (const waiter of waiters) waiter('cancelled')
  }

  private async restartRecoveryWorker(
    session: SessionRecord,
    intentVersion: number,
    startTimeSeconds: number,
    initialSegmentNumber: number,
  ): Promise<boolean> {
    try {
      return await this.restartWorker(session, startTimeSeconds, initialSegmentNumber, intentVersion)
    } catch (error) {
      if (!this.intentIsCurrent(session, intentVersion)) return false
      const recoveryOptions = this.getRecoveryOptions()
      const runtime = session.recoveryRuntime
      runtime.restartFailures += 1
      runtime.message = `Recovery restart failed: ${formatError(error)}`
      this.publishRecoveryEvent(session)
      this.options.logger?.warn('session', `Session ${session.id} recovery restart failed (${runtime.restartFailures}/${recoveryOptions.maxAttempts}): ${formatError(error)}`)
      if (runtime.restartFailures >= recoveryOptions.maxAttempts && this.intentVersion === intentVersion) {
        await this.exhaustRecovery(session)
      }
      return false
    }
  }

  private async restartWorker(
    session: SessionRecord,
    startTimeSeconds: number,
    initialSegmentNumber: number,
    expectedIntentVersion?: number,
  ): Promise<boolean> {
    const publicationEpoch = await session.publication.beginEpoch()
    if (expectedIntentVersion !== undefined && !this.recoveryIntentIsCurrent(session, expectedIntentVersion, session.publicationEpoch)) {
      return false
    }
    const runtime = await this.options.worker.startHlsSession({
      drive: session.drive,
      titleNumber: session.titleNumber,
      audioTrack: session.audioTrack,
      subtitleTrack: session.subtitleTrack,
      outputDir: publicationEpoch.outputDir,
      baseUrl: session.baseUrl,
      startTimeSeconds,
      initialSegmentNumber,
    })
    if (expectedIntentVersion !== undefined && !this.intentIsCurrent(session, expectedIntentVersion)) {
      try {
        await this.stopHandle(runtime.handle, `cancelled recovery restart for session ${session.id}`)
      } catch (error) {
        // Keep ownership of a candidate whose stop failed. The queued seek or
        // stop can retry closure through the normal serialized owner.
        this.installWorker(session, publicationEpoch, runtime)
        session.workerCleanupPending = true
        this.options.logger?.warn('session', `Cancelled recovery worker for ${session.id} did not stop cleanly: ${formatError(error)}`)
      }
      return false
    }
    this.installWorker(session, publicationEpoch, runtime)
    return true
  }

  private installWorker(session: SessionRecord, publicationEpoch: PublicationEpoch, runtime: StartHlsSessionResult): void {
    session.handle = runtime.handle
    session.publicationEpoch = publicationEpoch
    session.manifestPath = runtime.manifestPath
    session.workerStoppedForRecovery = false
    session.workerCleanupPending = false
    // Each VLC (re)start is a new discontinuity group so the composed manifest
    // marks the timestamp reset.
    session.recoveryRuntime.epoch += 1
  }

  private async waitForFreshSegment(session: SessionRecord, minSlotNumber: number, expectedIntentVersion = this.intentVersion): Promise<HlsProgress> {
    const recoveryOptions = this.getRecoveryOptions()
    const deadline = this.time.now() + recoveryOptions.restartReadinessTimeoutMs

    while (this.time.now() < deadline) {
      const progress = await session.publication.observe(session.publicationEpoch, session.manifestPath)
      if (!this.intentIsCurrent(session, expectedIntentVersion)) {
        throw new Error('Fresh HLS output wait was cancelled.')
      }
      if (progress && progress.lastSegmentNumber !== null && progress.lastSegmentNumber >= minSlotNumber) {
        return progress
      }

      const status = await this.waitForWake(session, Math.min(100, Math.max(0, deadline - this.time.now())))

      if (status === 'exited') {
        const result = await session.handle.completion
        throw new Error(result.stderr || result.stdout || 'VLC exited before fresh HLS output was ready.')
      }
      if (status === 'cancelled') {
        throw new Error('Fresh HLS output wait was cancelled.')
      }
    }

    throw new Error('Timed out waiting for fresh HLS output.')
  }

  private recordBadRange(runtime: PlaybackRecoveryRuntime, startSeconds: number, endSeconds: number): void {
    const lastRange = runtime.badRanges.at(-1)
    if (lastRange && Math.abs(lastRange.endSeconds - startSeconds) < 1e-9) {
      lastRange.endSeconds = endSeconds
      return
    }

    runtime.badRanges.push({ startSeconds, endSeconds, reason: 'dvd-read-stall' })
  }

  private async exhaustRecovery(session: SessionRecord): Promise<void> {
    this.clearRecoveryMonitor(session)
    session.recoveryRuntime.status = 'exhausted'
    session.recoveryRuntime.message = 'Playback stopped: the DVD drive could not restart playback after repeated attempts.'
    session.state = 'failed'
    session.error = {
      message: 'Playback stopped after repeated unreadable DVD sectors.',
      detail: `VLC could not restart after ${session.recoveryRuntime.restartFailures} attempts.`,
    }
    await this.stopHandle(session.handle, `exhausted recovery session ${session.id}`)
    this.publishRecoveryEvent(session)
    this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
  }

  private notePlaybackProgress(session: SessionRecord, progress: HlsProgress, nowMs: number): void {
    const runtime = session.recoveryRuntime
    runtime.lastSegmentName = progress.lastSegmentName
    runtime.lastProgressAtMs = nowMs
    runtime.lastProgressAt = new Date(this.calendarNow()).toISOString()
    runtime.lastGoodTimeSeconds = session.publication.currentRange.endSeconds
  }

  private async stopHandle(handle: ManagedProcessHandle, label: string): Promise<void> {
    const cancelWarning = this.time.schedule(this.getRecoveryOptions().stopTimeoutMs, () => {
      this.options.logger?.warn('session', 'Still waiting for ' + label + ' to stop; retaining its files and worker ownership.')
    })
    try {
      await handle.stop()
    } catch (error) {
      if (handle.hasExited?.() !== true) throw error
      this.options.logger?.warn('session', `Worker already exited while stopping ${label}: ${formatError(error)}`)
    } finally {
      cancelWarning()
    }
  }

  private publishRecoveryEvent(session: SessionRecord): void {
    const recovery = this.toRecoverySnapshot(session.recoveryRuntime)
    const playbackSession = this.toPlaybackSession(session)
    this.publishSessionEvent({
      type: 'session.recovery',
      payload: {
        sessionId: session.id,
        session: {
          id: playbackSession.id,
          state: playbackSession.state,
          manifestUrl: playbackSession.manifestUrl,
          recovery,
          timeline: playbackSession.timeline,
        },
        ...recovery,
      },
    })
  }

  private publishSessionEvent(event: SessionManagerEvent): void {
    this.options.onSessionEvent?.(event)
  }

  private resetRecoveryRegionState(session: SessionRecord): void {
    const runtime = session.recoveryRuntime
    runtime.consecutiveReadRetries = 0
    runtime.retryAnchorSlot = null
    runtime.consecutiveBadSlots = 0
    runtime.inBadRun = false
    runtime.restartFailures = 0
    // A seek jumps the playhead; the old high-water mark would otherwise make
    // the new region look fully buffered. Repopulated as the client refetches.
    if (runtime.status === 'recovering') {
      runtime.status = 'idle'
    }
  }

  private toRecoverySnapshot(runtime: PlaybackRecoveryRuntime): PlaybackRecoverySnapshot {
    return {
      enabled: runtime.enabled,
      status: runtime.status,
      attempts: runtime.attempts,
      epoch: runtime.epoch,
      skippedSeconds: runtime.skippedSeconds,
      lastGoodTimeSeconds: runtime.lastGoodTimeSeconds,
      lastProgressAt: runtime.lastProgressAt,
      lastSegmentName: runtime.lastSegmentName,
      message: runtime.message,
      badRanges: runtime.badRanges.map((range) => ({ ...range })),
    }
  }

  private getRecoveryOptions(): Required<PlaybackRecoveryOptions> {
    return {
      ...DEFAULT_RECOVERY_OPTIONS,
      ...this.options.playbackRecovery,
    }
  }
}

function createInitialRecoveryRuntime(enabled: boolean): PlaybackRecoveryRuntime {
  return {
    enabled,
    status: 'idle',
    attempts: 0,
    epoch: 0,
    skippedSeconds: 0,
    lastGoodTimeSeconds: 0,
    badRanges: [],
    lastProgressAtMs: null,
    consecutiveReadRetries: 0,
    retryAnchorSlot: null,
    consecutiveBadSlots: 0,
    restartFailures: 0,
    inBadRun: false,
  }
}

const READ_ERROR_PATTERNS = [
  /input\/output error/i,
  /could not read/i,
  /read error/i,
  /failed to read/i,
  /cannot read/i,
  /unreadable/i,
  /sector/i,
]

function describeReadError(stderr: string): string | null {
  if (!stderr) {
    return null
  }

  const matched = READ_ERROR_PATTERNS.some((pattern) => pattern.test(stderr))
  return matched ? 'disc read error reported by VLC' : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
