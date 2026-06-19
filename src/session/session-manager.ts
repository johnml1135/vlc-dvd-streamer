import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedProcessHandle } from '../vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../vlc/worker.js'
import type { ServerLog } from '../logging/server-log.js'
import {
  buildRegionManifest,
  buildStitchedManifest,
  createInitialTimelineRuntime,
  getCurrentRange,
  isTimeInRange,
  markBadSlot,
  nextExpectedSlot,
  noteGeneratedSlots,
  normalizeSeekPosition,
  segmentNumberForTime,
  setRegionStart,
  slotEndSeconds,
  slotStartSeconds,
  toTimelineSnapshot,
  type PlaybackTimelineRuntime,
  type PlaybackTimelineSnapshot,
} from './timeline.js'

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

interface SessionRecord extends PlaybackSession {
  handle: ManagedProcessHandle
  baseUrl: string
  recoveryRuntime: PlaybackRecoveryRuntime
  timelineRuntime: PlaybackTimelineRuntime
  recoveryTimer?: NodeJS.Timeout
  recoveryInFlight: boolean
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
  readRetryAttempts?: number
  /** Maximum consecutive failed VLC restarts before declaring the disc unreadable. */
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

export interface SessionManagerOptions {
  cacheDir: string
  inactivityMs: number
  worker: HlsSessionWorker
  readinessTimeoutMs?: number
  playbackRecovery?: PlaybackRecoveryOptions
  onSessionEvent?: (event: SessionManagerEvent) => void
  logger?: ServerLog
  /** Injectable clock so stall/recovery timing is deterministic in tests. */
  now?: () => number
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
  readRetryAttempts: 3,
  maxAttempts: 6,
  segmentDurationSeconds: 2,
} satisfies Required<PlaybackRecoveryOptions>

// A single MPEG-TS null packet: enough to be a structurally valid, non-empty
// segment. The host can supply a nicer rendered "bad sector" clip via
// writePlaceholderSegment; this default just keeps the timeline honest.
const PLACEHOLDER_TS_PACKET = (() => {
  const packet = Buffer.alloc(188, 0xff)
  packet[0] = 0x47
  packet[1] = 0x1f
  packet[2] = 0xff
  packet[3] = 0x10
  return packet
})()

export class SessionManager {
  private readonly options: SessionManagerOptions
  private readonly sessions = new Map<string, SessionRecord>()
  private activeSessionId: string | null = null
  private readonly now: () => number

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  getSession(sessionId: string): PlaybackSession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return undefined
    }

    return this.toPlaybackSession(session)
  }

  getActiveSession(): PlaybackSession | undefined {
    if (!this.activeSessionId) {
      return undefined
    }

    return this.getSession(this.activeSessionId)
  }

  /** Manifest the browser plays: the contiguous region from the current edit point, placeholders inline. */
  getRegionManifest(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    return buildRegionManifest(session.timelineRuntime, this.getRecoveryOptions().segmentDurationSeconds)
  }

  getStitchedManifest(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return null
    }

    return buildStitchedManifest(session.timelineRuntime, this.getRecoveryOptions().segmentDurationSeconds)
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.state === 'stopped' || session.state === 'failed') {
      return
    }

    session.lastAccessedAt = new Date().toISOString()
  }

  async seek(sessionId: string, input: { positionSeconds: number }): Promise<PlaybackSeekResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { ok: false, reason: 'not-found', message: 'Session not found.' }
    }

    if (session.state !== 'ready') {
      return { ok: false, reason: 'not-ready', message: 'Session is not ready for seeking.' }
    }

    const recoveryOptions = this.getRecoveryOptions()
    const positionSeconds = normalizeSeekPosition(input.positionSeconds, session.timelineRuntime.durationSeconds, recoveryOptions.segmentDurationSeconds)
    if (positionSeconds === null) {
      return { ok: false, reason: 'invalid-position', message: 'Seek position must be a finite non-negative number within the title duration.' }
    }

    session.lastAccessedAt = new Date().toISOString()

    if (isTimeInRange(positionSeconds, getCurrentRange(session.timelineRuntime))) {
      session.timelineRuntime.status = 'idle'
      session.timelineRuntime.lastSeekSeconds = positionSeconds
      session.timelineRuntime.message = `Title time ${positionSeconds} seconds is already available in the current region.`
      return {
        ok: true,
        action: 'already-available',
        positionSeconds,
        session: this.toPlaybackSession(session),
      }
    }

    // Take exclusive control away from the recovery monitor: stop scheduling new
    // ticks and wait for any in-flight tick to finish before mutating state, so
    // a concurrent recovery step cannot race the seek.
    this.clearRecoveryMonitor(session)
    await this.waitForRecoveryIdle(session)
    session.recoveryInFlight = true
    try {
      this.resetRecoveryRegionState(session)
      const initialSegmentNumber = segmentNumberForTime(positionSeconds, recoveryOptions.segmentDurationSeconds)

      session.timelineRuntime.status = 'seeking'
      session.timelineRuntime.lastSeekSeconds = positionSeconds
      session.timelineRuntime.message = `Seeking to ${positionSeconds} seconds.`
      // A user seek opens a brand-new contiguous region anchored at the target.
      setRegionStart(session.timelineRuntime, initialSegmentNumber)
      this.publishSessionEvent({
        type: 'session.seek',
        payload: {
          sessionId: session.id,
          status: session.timelineRuntime.status,
          positionSeconds,
        },
      })

      await this.stopHandle(session.handle, `seek session ${session.id}`)

      try {
        await this.restartWorker(session, positionSeconds, initialSegmentNumber)
        const progress = await this.waitForFreshSegment(session, initialSegmentNumber)
        this.notePlaybackProgress(session, progress, this.now())
        session.timelineRuntime.status = 'idle'
        session.timelineRuntime.message = `Ready at ${positionSeconds} seconds.`
        session.lastAccessedAt = new Date().toISOString()
        this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
        return {
          ok: true,
          action: 'restarted',
          positionSeconds,
          session: this.toPlaybackSession(session),
        }
      } catch (error) {
        session.timelineRuntime.status = 'idle'
        session.timelineRuntime.message = `Seek did not produce HLS output: ${formatError(error)}`
        session.error = {
          message: 'Playback seek failed.',
          detail: formatError(error),
        }
        // Let the recovery monitor take over from the seek target so an unreadable
        // landing zone is bad-filled rather than left hanging.
        session.recoveryRuntime.lastProgressAtMs = this.now()
        this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
        return { ok: false, reason: 'not-ready', message: session.error.detail ?? session.error.message }
      }
    } finally {
      session.recoveryInFlight = false
      this.scheduleRecoveryMonitor(session)
    }
  }

  private async waitForRecoveryIdle(session: SessionRecord): Promise<void> {
    const deadline = Date.now() + this.getRecoveryOptions().stopTimeoutMs
    while (session.recoveryInFlight && Date.now() < deadline) {
      await delay(10)
    }
  }

  async start(request: SessionRequest): Promise<PlaybackSession> {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
    if (active && this.isSameRequest(active, request) && active.state === 'ready') {
      active.lastAccessedAt = new Date().toISOString()
      this.options.logger?.info('session', `Reusing active session ${active.id} for title ${active.titleNumber}.`)
      return this.toPlaybackSession(active)
    }

    if (active && active.state !== 'stopped') {
      this.options.logger?.info('session', `Replacing active session ${active.id} with title ${request.titleNumber}.`)
      await this.stop(active.id)
    }

    const id = randomUUID()
    const outputDir = join(this.options.cacheDir, 'sessions', id)
    const baseUrl = `/streams/${id}/`
    await mkdir(outputDir, { recursive: true })

    const recoveryOptions = this.getRecoveryOptions()
    const now = new Date().toISOString()
    // Always anchor the first epoch to slot 1 / DVD time 0 so segment file
    // numbers equal slot numbers from the very start.
    const runtime = await this.options.worker.startHlsSession({
      drive: request.drive,
      titleNumber: request.titleNumber,
      audioTrack: request.audioTrack,
      subtitleTrack: request.subtitleTrack,
      outputDir,
      baseUrl,
      startTimeSeconds: 0,
      initialSegmentNumber: 1,
    })

    const session: SessionRecord = {
      ...request,
      id,
      state: 'starting',
      outputDir,
      manifestPath: runtime.manifestPath,
      manifestUrl: `/streams/${id}/index.m3u8`,
      startedAt: now,
      lastAccessedAt: now,
      handle: runtime.handle,
      baseUrl,
      recoveryRuntime: createInitialRecoveryRuntime(recoveryOptions.enabled),
      timelineRuntime: createInitialTimelineRuntime(request.durationSeconds, recoveryOptions.segmentDurationSeconds),
      recoveryInFlight: false,
    }

    this.sessions.set(id, session)
    this.activeSessionId = id
    this.options.logger?.info('session', `Session ${id} created for title ${request.titleNumber}.`)

    // Render the reusable bad-sector placeholder in the background so it is ready
    // by the time (if ever) an unreadable sector is hit. Non-fatal on failure.
    if (this.options.worker.generatePlaceholderSegment) {
      void this.options.worker
        .generatePlaceholderSegment({ outputDir, durationSeconds: recoveryOptions.segmentDurationSeconds })
        .catch((error) => {
          this.options.logger?.warn('session', `Bad-sector placeholder render failed for session ${id}: ${formatError(error)}`)
        })
    }

    try {
      await this.waitForReadiness(session)
      const initialProgress = await this.readHlsProgress(session.outputDir, session.manifestPath)
      if (initialProgress) {
        this.notePlaybackProgress(session, initialProgress, this.now())
      }
      session.state = 'ready'
      session.recovery = this.toRecoverySnapshot(session.recoveryRuntime)
      session.lastAccessedAt = new Date().toISOString()
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
      this.activeSessionId = null
      this.options.logger?.error('session', `Session ${session.id} failed: ${session.error.detail ?? session.error.message}`)
      return this.toPlaybackSession(session)
    }
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.state === 'stopped') {
      return false
    }

    session.state = 'stopping'
    this.clearRecoveryMonitor(session)
    this.options.logger?.info('session', `Stopping session ${session.id}.`)
    await this.stopHandle(session.handle, `session ${session.id}`)
    await rm(session.outputDir, { force: true, recursive: true })
    session.state = 'stopped'

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }

    return true
  }

  async stopAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()]
    for (const sessionId of sessionIds) {
      await this.stop(sessionId)
    }
  }

  async cleanupInactive(): Promise<void> {
    const now = Date.now()
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.state === 'stopped' || session.state === 'failed') {
        continue
      }

      const lastAccessedAt = Date.parse(session.lastAccessedAt)
      if (now - lastAccessedAt > this.options.inactivityMs) {
        this.options.logger?.info('session', `Stopping inactive session ${session.id}.`)
        await this.stop(sessionId)
      }
    }
  }

  private async waitForReadiness(session: SessionRecord): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 120000)

    while (Date.now() < deadline) {
      if (await this.hasReadyFiles(session.outputDir, session.manifestPath)) {
        return
      }

      const status = await Promise.race([
        session.handle.completion.then(() => 'exited' as const),
        delay(100).then(() => 'pending' as const),
      ])

      if (status === 'exited') {
        const result = await session.handle.completion
        throw new Error(result.stderr || result.stdout || 'VLC exited before HLS output was ready.')
      }
    }

    throw new Error('Timed out waiting for HLS manifest and first segment.')
  }

  private async hasReadyFiles(outputDir: string, manifestPath: string): Promise<boolean> {
    try {
      await access(manifestPath)
      const manifest = await readFile(manifestPath, 'utf8')
      const segmentName = getSegmentNames(manifest)[0]
      if (!segmentName) {
        return false
      }

      const segment = await readFile(join(outputDir, segmentName))
      return segment.length > 0 && segment[0] === 0x47
    } catch {
      return false
    }
  }

  private async cleanupFailedStartup(session: SessionRecord): Promise<void> {
    try {
      await this.stopHandle(session.handle, `failed startup session ${session.id}`)
    } catch (error) {
      this.options.logger?.warn('session', `Failed to stop session ${session.id} after startup failure: ${formatError(error)}`)
    }

    try {
      await rm(session.outputDir, { force: true, recursive: true })
    } catch (error) {
      this.options.logger?.warn('session', `Failed to remove session ${session.id} output after startup failure: ${formatError(error)}`)
    }
  }

  private isSameRequest(session: SessionRecord, request: SessionRequest): boolean {
    return session.discId === request.discId
      && session.drive === request.drive
      && session.titleNumber === request.titleNumber
      && session.audioTrack === request.audioTrack
      && session.subtitleTrack === request.subtitleTrack
  }

  private toPlaybackSession(session: SessionRecord): PlaybackSession {
    session.recovery = this.toRecoverySnapshot(session.recoveryRuntime)
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
      manifestUrl: session.manifestUrl,
      startedAt: session.startedAt,
      lastAccessedAt: session.lastAccessedAt,
      error: session.error,
      recovery: session.recovery,
      timeline: toTimelineSnapshot(session.timelineRuntime, session.baseUrl, this.getRecoveryOptions().segmentDurationSeconds),
    }
  }

  private scheduleRecoveryMonitor(session: SessionRecord): void {
    const recoveryOptions = this.getRecoveryOptions()
    if (!recoveryOptions.enabled || session.state !== 'ready') {
      return
    }

    this.clearRecoveryMonitor(session)
    session.recoveryTimer = setTimeout(() => {
      void this.runRecoveryMonitorTick(session)
    }, recoveryOptions.monitorIntervalMs)
  }

  private clearRecoveryMonitor(session: SessionRecord): void {
    if (session.recoveryTimer) {
      clearTimeout(session.recoveryTimer)
      session.recoveryTimer = undefined
    }
  }

  private async runRecoveryMonitorTick(session: SessionRecord): Promise<void> {
    if (session.recoveryInFlight || session.state !== 'ready') {
      this.scheduleRecoveryMonitor(session)
      return
    }

    session.recoveryInFlight = true
    try {
      await this.checkPlaybackProgress(session)
    } catch (error) {
      this.options.logger?.warn('session', `Recovery monitor for session ${session.id} failed: ${formatError(error)}`)
    } finally {
      session.recoveryInFlight = false
      if (session.state === 'ready') {
        this.scheduleRecoveryMonitor(session)
      }
    }
  }

  private async checkPlaybackProgress(session: SessionRecord): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const runtime = session.recoveryRuntime
    const progress = await this.readHlsProgress(session.outputDir, session.manifestPath)
    const now = this.now()

    if (progress && progress.lastSegmentName !== runtime.lastSegmentName) {
      const previousGoodTimeSeconds = runtime.lastGoodTimeSeconds
      this.notePlaybackProgress(session, progress, now)
      const advanced = runtime.lastGoodTimeSeconds > previousGoodTimeSeconds
      if (advanced) {
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
      this.clearRecoveryMonitor(session)
      return
    }

    if (now - runtime.lastProgressAtMs >= recoveryOptions.stallTimeoutMs) {
      await this.performRecoveryStep(session)
    }
  }

  private hasReachedEndOfTitle(session: SessionRecord): boolean {
    const duration = session.timelineRuntime.durationSeconds
    return typeof duration === 'number' && session.recoveryRuntime.lastGoodTimeSeconds >= duration
  }

  private async performRecoveryStep(session: SessionRecord): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const segmentDurationSeconds = recoveryOptions.segmentDurationSeconds
    const runtime = session.recoveryRuntime
    const stallSlot = nextExpectedSlot(session.timelineRuntime)
    const stallTimeSeconds = slotStartSeconds(stallSlot, segmentDurationSeconds)

    if (this.hasReachedEndOfTitle(session)) {
      this.clearRecoveryMonitor(session)
      return
    }

    // Counters are anchored to the exact DVD slot we are stuck on, so a single
    // segment squeaking out elsewhere can never reset the escalation.
    if (runtime.retryAnchorSlot !== stallSlot) {
      runtime.retryAnchorSlot = stallSlot
      runtime.consecutiveReadRetries = 0
    }

    const readReason = describeReadError(session.handle.getStderr())
    const shouldRetryRead = !runtime.inBadRun && runtime.consecutiveReadRetries < recoveryOptions.readRetryAttempts

    let resumeTimeSeconds: number
    if (shouldRetryRead) {
      runtime.consecutiveReadRetries += 1
      resumeTimeSeconds = stallTimeSeconds
      runtime.message = `DVD read stalled at ${formatClock(stallTimeSeconds)}${readReason ? ` (${readReason})` : ''}. Retrying read ${runtime.consecutiveReadRetries} of ${recoveryOptions.readRetryAttempts}.`
    } else {
      // Confirmed unreadable: fill exactly this one slot with a bad-sector
      // marker and advance by a single slot. Time stays exact to the DVD.
      markBadSlot(session.timelineRuntime, stallSlot)
      await this.writePlaceholderSlot(session, stallSlot)
      runtime.skippedSeconds += segmentDurationSeconds
      runtime.consecutiveBadSlots += 1
      runtime.inBadRun = true
      this.recordBadRange(runtime, stallTimeSeconds, slotEndSeconds(stallSlot, segmentDurationSeconds))
      runtime.lastGoodTimeSeconds = getCurrentRange(session.timelineRuntime).endSeconds
      runtime.consecutiveReadRetries = 0
      runtime.retryAnchorSlot = stallSlot + 1
      resumeTimeSeconds = slotStartSeconds(stallSlot + 1, segmentDurationSeconds)
      runtime.message = `Unreadable DVD sector at ${formatClock(stallTimeSeconds)}; inserted a bad-sector marker and continued (${formatClock(runtime.skippedSeconds)} filled so far).`
    }

    runtime.status = 'recovering'
    runtime.attempts += 1
    this.publishRecoveryEvent(session)
    this.options.logger?.warn('session', `Session ${session.id}: ${runtime.message}`)

    await this.stopHandle(session.handle, `stalled session ${session.id}`)

    try {
      await this.restartWorker(session, resumeTimeSeconds, segmentNumberForTime(resumeTimeSeconds, segmentDurationSeconds))
      runtime.restartFailures = 0
      // Give the freshly started process a full stall window to produce output
      // before the next tick can act.
      runtime.lastProgressAtMs = this.now()
    } catch (error) {
      runtime.restartFailures += 1
      runtime.message = `Recovery restart failed: ${formatError(error)}`
      this.publishRecoveryEvent(session)
      this.options.logger?.warn('session', `Session ${session.id} recovery restart failed (${runtime.restartFailures}/${recoveryOptions.maxAttempts}): ${formatError(error)}`)
      if (runtime.restartFailures > recoveryOptions.maxAttempts) {
        await this.exhaustRecovery(session)
      }
    }
  }

  private async restartWorker(session: SessionRecord, startTimeSeconds: number, initialSegmentNumber: number): Promise<void> {
    const runtime = await this.options.worker.startHlsSession({
      drive: session.drive,
      titleNumber: session.titleNumber,
      audioTrack: session.audioTrack,
      subtitleTrack: session.subtitleTrack,
      outputDir: session.outputDir,
      baseUrl: session.baseUrl,
      startTimeSeconds,
      initialSegmentNumber,
    })
    session.handle = runtime.handle
    session.manifestPath = runtime.manifestPath
    // Each VLC (re)start is a new discontinuity group so the composed manifest
    // marks the timestamp reset.
    session.recoveryRuntime.epoch += 1
  }

  private async waitForFreshSegment(session: SessionRecord, minSlotNumber: number): Promise<HlsProgress> {
    const recoveryOptions = this.getRecoveryOptions()
    const deadline = Date.now() + recoveryOptions.restartReadinessTimeoutMs

    while (Date.now() < deadline) {
      const progress = await this.readHlsProgress(session.outputDir, session.manifestPath)
      if (progress && progress.lastSegmentNumber !== null && progress.lastSegmentNumber >= minSlotNumber) {
        return progress
      }

      const status = await Promise.race([
        session.handle.completion.then(() => 'exited' as const),
        delay(100).then(() => 'pending' as const),
      ])

      if (status === 'exited') {
        const result = await session.handle.completion
        throw new Error(result.stderr || result.stdout || 'VLC exited before fresh HLS output was ready.')
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

  private async writePlaceholderSlot(session: SessionRecord, slotNumber: number): Promise<void> {
    const filePath = join(session.outputDir, formatSegmentName(slotNumber))
    if (this.options.writePlaceholderSegment) {
      try {
        await this.options.writePlaceholderSegment(filePath, slotNumber)
        return
      } catch (error) {
        this.options.logger?.warn('session', `Custom bad-sector placeholder failed for slot ${slotNumber}: ${formatError(error)}`)
      }
    }

    // Best-effort nicety: reuse a host-rendered placeholder.ts if one exists.
    const sessionPlaceholder = join(session.outputDir, 'placeholder.ts')
    try {
      await copyFile(sessionPlaceholder, filePath)
      return
    } catch {
      // Fall back to the minimal valid packet below.
    }

    await writeFile(filePath, PLACEHOLDER_TS_PACKET)
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
    if (this.activeSessionId === session.id) {
      this.activeSessionId = null
    }
    await this.stopHandle(session.handle, `exhausted recovery session ${session.id}`)
    this.publishRecoveryEvent(session)
    this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
  }

  private async readHlsProgress(outputDir: string, manifestPath: string): Promise<HlsProgress | null> {
    try {
      const manifest = await readFile(manifestPath, 'utf8')
      const segmentNames = getSegmentNames(manifest)
      const lastSegmentName = segmentNames.at(-1)
      if (!lastSegmentName) {
        return null
      }

      const segment = await readFile(join(outputDir, lastSegmentName))
      if (segment.length === 0 || segment[0] !== 0x47) {
        return null
      }

      return {
        segmentNames,
        lastSegmentName,
        lastSegmentNumber: parseSegmentNumber(lastSegmentName),
      }
    } catch {
      return null
    }
  }

  private notePlaybackProgress(session: SessionRecord, progress: HlsProgress, nowMs: number): void {
    const runtime = session.recoveryRuntime
    noteGeneratedSlots(session.timelineRuntime, progress.segmentNames, runtime.epoch)
    runtime.lastSegmentName = progress.lastSegmentName
    runtime.lastProgressAtMs = nowMs
    runtime.lastProgressAt = new Date(nowMs).toISOString()
    runtime.lastGoodTimeSeconds = getCurrentRange(session.timelineRuntime).endSeconds
  }

  private async stopHandle(handle: ManagedProcessHandle, label: string): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const stopPromise = handle.stop()
    stopPromise.catch((error) => {
      this.options.logger?.warn('session', `Failed to stop ${label}: ${formatError(error)}`)
    })

    const stopped = await Promise.race([
      stopPromise.then(() => true),
      delay(recoveryOptions.stopTimeoutMs).then(() => false),
    ])

    if (!stopped) {
      this.options.logger?.warn('session', `Timed out while stopping ${label}; continuing recovery without blocking the app.`)
    }
  }

  private publishRecoveryEvent(session: SessionRecord): void {
    session.recovery = this.toRecoverySnapshot(session.recoveryRuntime)
    const playbackSession = this.toPlaybackSession(session)
    this.publishSessionEvent({
      type: 'session.recovery',
      payload: {
        sessionId: session.id,
        session: {
          id: playbackSession.id,
          state: playbackSession.state,
          manifestUrl: playbackSession.manifestUrl,
          recovery: playbackSession.recovery,
          timeline: playbackSession.timeline,
        },
        ...session.recovery,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function getSegmentNames(manifest: string): string[] {
  if (!manifest.trimStart().startsWith('#EXTM3U')) {
    return []
  }

  return manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('?')[0]?.split('/').filter(Boolean).at(-1))
    .filter((segmentName): segmentName is string => Boolean(segmentName?.endsWith('.ts')))
}

function parseSegmentNumber(segmentName: string): number | null {
  const match = /segment-(\d+)\.ts$/i.exec(segmentName)
  if (!match) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isInteger(parsed) ? parsed : null
}

function formatSegmentName(slotNumber: number): string {
  return `segment-${String(slotNumber).padStart(6, '0')}.ts`
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

function formatClock(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
