import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedProcessHandle } from '../vlc/process-supervisor.js'
import type { StartHlsSessionInput, StartHlsSessionResult } from '../vlc/worker.js'
import type { ServerLog } from '../logging/server-log.js'
import {
  buildStitchedManifest,
  createInitialTimelineRuntime,
  isTimeInRange,
  noteTimelineProgress,
  normalizeSeekPosition,
  segmentNumberForTime,
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
  skipSeconds?: number
  readRetryAttempts?: number
  maxAttempts?: number
  segmentDurationSeconds?: number
}

interface PlaybackRecoveryRuntime extends PlaybackRecoverySnapshot {
  consecutiveAttempts: number
  readRetryAttempts: number
  epochStartTimeSeconds: number
  epochInitialSegmentNumber: number | null
  lastProgressAtMs: number | null
  lastSegmentNumber: number | null
}

interface HlsProgress {
  segmentNames: string[]
  lastSegmentName: string
  lastSegmentNumber: number | null
}

interface HlsSessionWorker {
  startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult>
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

export class SessionManager {
  private readonly options: SessionManagerOptions
  private readonly sessions = new Map<string, SessionRecord>()
  private activeSessionId: string | null = null

  constructor(options: SessionManagerOptions) {
    this.options = options
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

    if (isTimeInRange(positionSeconds, session.timelineRuntime.currentRange)) {
      session.timelineRuntime.status = 'idle'
      session.timelineRuntime.lastSeekSeconds = positionSeconds
      session.timelineRuntime.message = `Title time ${positionSeconds} seconds is already available in the current HLS window.`
      return {
        ok: true,
        action: 'already-available',
        positionSeconds,
        session: this.toPlaybackSession(session),
      }
    }

    this.clearRecoveryMonitor(session)
  this.resetRecoveryRetryPolicy(session)
    const previousSegmentName = session.recoveryRuntime.lastSegmentName
    const initialSegmentNumber = segmentNumberForTime(positionSeconds, recoveryOptions.segmentDurationSeconds)

    session.timelineRuntime.status = 'seeking'
    session.timelineRuntime.lastSeekSeconds = positionSeconds
    session.timelineRuntime.message = `Seeking to ${positionSeconds} seconds.`
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
      const runtime = await this.options.worker.startHlsSession({
        drive: session.drive,
        titleNumber: session.titleNumber,
        audioTrack: session.audioTrack,
        subtitleTrack: session.subtitleTrack,
        outputDir: session.outputDir,
        baseUrl: session.baseUrl,
        startTimeSeconds: positionSeconds,
        initialSegmentNumber,
      })
      session.handle = runtime.handle
      session.manifestPath = runtime.manifestPath
      session.recoveryRuntime.epoch += 1
      session.recoveryRuntime.epochStartTimeSeconds = positionSeconds
      session.recoveryRuntime.epochInitialSegmentNumber = initialSegmentNumber

      const progress = await this.waitForRecoveryReadiness(session, previousSegmentName)
      this.notePlaybackProgress(session, progress, Date.now())
      session.timelineRuntime.status = 'idle'
      session.timelineRuntime.message = `Ready at ${positionSeconds} seconds.`
      session.lastAccessedAt = new Date().toISOString()
      this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
      this.scheduleRecoveryMonitor(session)
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
      this.publishSessionEvent({ type: 'session.updated', payload: this.toPlaybackSession(session) })
      this.scheduleRecoveryMonitor(session)
      return { ok: false, reason: 'not-ready', message: session.error.detail ?? session.error.message }
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

    const now = new Date().toISOString()
    const runtime = await this.options.worker.startHlsSession({
      drive: request.drive,
      titleNumber: request.titleNumber,
      audioTrack: request.audioTrack,
      subtitleTrack: request.subtitleTrack,
      outputDir,
      baseUrl,
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
      recoveryRuntime: createInitialRecoveryRuntime(this.getRecoveryOptions().enabled),
      timelineRuntime: createInitialTimelineRuntime(request.durationSeconds),
      recoveryInFlight: false,
    }

    this.sessions.set(id, session)
    this.activeSessionId = id
    this.options.logger?.info('session', `Session ${id} created for title ${request.titleNumber}.`)

    try {
      await this.waitForReadiness(session)
      const initialProgress = await this.readHlsProgress(session.outputDir, session.manifestPath)
      if (initialProgress) {
        this.notePlaybackProgress(session, initialProgress, Date.now())
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
      this.scheduleRecoveryMonitor(session)
    }
  }

  private async checkPlaybackProgress(session: SessionRecord): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const progress = await this.readHlsProgress(session.outputDir, session.manifestPath)
    const now = Date.now()

    if (progress && progress.lastSegmentName !== session.recoveryRuntime.lastSegmentName) {
      this.notePlaybackProgress(session, progress, now)
      if (session.recoveryRuntime.status === 'recovering') {
        session.recoveryRuntime.status = 'idle'
        session.recoveryRuntime.consecutiveAttempts = 0
        session.recoveryRuntime.readRetryAttempts = 0
        session.recoveryRuntime.message = `Recovered playback after skipping ${recoveryOptions.skipSeconds} seconds.`
        this.publishRecoveryEvent(session)
      }
      return
    }

    if (session.recoveryRuntime.lastProgressAtMs === null) {
      return
    }

    if (now - session.recoveryRuntime.lastProgressAtMs >= recoveryOptions.stallTimeoutMs) {
      await this.recoverStalledPlayback(session)
    }
  }

  private async recoverStalledPlayback(session: SessionRecord): Promise<void> {
    const recoveryOptions = this.getRecoveryOptions()
    const previousSegmentName = session.recoveryRuntime.lastSegmentName
    const previousLastGoodTimeSeconds = session.recoveryRuntime.lastGoodTimeSeconds
    const nextReadRetryAttempt = session.recoveryRuntime.readRetryAttempts + 1
    const shouldRetryRead = nextReadRetryAttempt <= recoveryOptions.readRetryAttempts
    const nextSkipAttempt = session.recoveryRuntime.consecutiveAttempts + 1

    if (!shouldRetryRead && nextSkipAttempt > recoveryOptions.maxAttempts) {
      await this.exhaustRecovery(session)
      return
    }

    const resumeTimeSeconds = shouldRetryRead
      ? previousLastGoodTimeSeconds
      : previousLastGoodTimeSeconds + recoveryOptions.skipSeconds
    const initialSegmentNumber = segmentNumberForTime(resumeTimeSeconds, recoveryOptions.segmentDurationSeconds)

    session.recoveryRuntime.status = 'recovering'
    session.recoveryRuntime.attempts += 1
    if (shouldRetryRead) {
      session.recoveryRuntime.readRetryAttempts = nextReadRetryAttempt
      session.recoveryRuntime.message = `DVD read stalled near ${previousLastGoodTimeSeconds} seconds. Retrying read ${nextReadRetryAttempt} of ${recoveryOptions.readRetryAttempts}.`
    } else {
      session.recoveryRuntime.consecutiveAttempts = nextSkipAttempt
      session.recoveryRuntime.skippedSeconds += recoveryOptions.skipSeconds
      session.recoveryRuntime.message = `Unreadable DVD area persisted after ${recoveryOptions.readRetryAttempts} retries. Skipping ahead to ${resumeTimeSeconds} seconds.`
      session.recoveryRuntime.badRanges.push({
        startSeconds: previousLastGoodTimeSeconds,
        endSeconds: resumeTimeSeconds,
        reason: 'dvd-read-stall',
      })
    }
    this.publishRecoveryEvent(session)
    this.options.logger?.warn('session', `Session ${session.id} stalled near ${previousLastGoodTimeSeconds}s; restarting VLC at ${resumeTimeSeconds}s.`)

    await this.stopHandle(session.handle, `stalled session ${session.id}`)

    try {
      const runtime = await this.options.worker.startHlsSession({
        drive: session.drive,
        titleNumber: session.titleNumber,
        audioTrack: session.audioTrack,
        subtitleTrack: session.subtitleTrack,
        outputDir: session.outputDir,
        baseUrl: session.baseUrl,
        startTimeSeconds: resumeTimeSeconds,
        initialSegmentNumber,
      })
      session.handle = runtime.handle
      session.manifestPath = runtime.manifestPath
      session.recoveryRuntime.epoch += 1
      session.recoveryRuntime.epochStartTimeSeconds = resumeTimeSeconds
      session.recoveryRuntime.epochInitialSegmentNumber = initialSegmentNumber

      const progress = await this.waitForRecoveryReadiness(session, previousSegmentName)
      this.notePlaybackProgress(session, progress, Date.now())
      session.recoveryRuntime.status = 'idle'
      if (shouldRetryRead) {
        session.recoveryRuntime.message = `Retried DVD read at ${resumeTimeSeconds} seconds.`
      } else {
        session.recoveryRuntime.consecutiveAttempts = 0
        session.recoveryRuntime.readRetryAttempts = 0
        session.recoveryRuntime.message = `Skipped ${resumeTimeSeconds - previousLastGoodTimeSeconds} seconds and resumed playback.`
      }
      this.publishRecoveryEvent(session)
    } catch (error) {
      session.recoveryRuntime.message = `Recovery attempt did not produce HLS output: ${formatError(error)}`
      this.publishRecoveryEvent(session)
      this.options.logger?.warn('session', `Session ${session.id} recovery attempt failed: ${formatError(error)}`)
    }
  }

  private async waitForRecoveryReadiness(session: SessionRecord, previousSegmentName: string | undefined): Promise<HlsProgress> {
    const recoveryOptions = this.getRecoveryOptions()
    const deadline = Date.now() + recoveryOptions.restartReadinessTimeoutMs

    while (Date.now() < deadline) {
      const progress = await this.readHlsProgress(session.outputDir, session.manifestPath)
      if (progress && progress.lastSegmentName !== previousSegmentName) {
        return progress
      }

      const status = await Promise.race([
        session.handle.completion.then(() => 'exited' as const),
        delay(100).then(() => 'pending' as const),
      ])

      if (status === 'exited') {
        const result = await session.handle.completion
        throw new Error(result.stderr || result.stdout || 'VLC exited before recovered HLS output was ready.')
      }
    }

    throw new Error('Timed out waiting for recovered HLS output.')
  }

  private async exhaustRecovery(session: SessionRecord): Promise<void> {
    this.clearRecoveryMonitor(session)
    session.recoveryRuntime.status = 'exhausted'
    session.recoveryRuntime.message = 'Playback stopped after repeated unreadable DVD sectors.'
    session.state = 'failed'
    session.error = {
      message: 'Playback stopped after repeated unreadable DVD sectors.',
      detail: `VLC could not recover after ${session.recoveryRuntime.attempts} skip attempts.`,
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
    const recoveryOptions = this.getRecoveryOptions()
    const runtime = session.recoveryRuntime
    noteTimelineProgress(session.timelineRuntime, progress.segmentNames, recoveryOptions.segmentDurationSeconds)
    if (runtime.status !== 'recovering') {
      runtime.consecutiveAttempts = 0
      runtime.readRetryAttempts = 0
    }
    runtime.lastSegmentName = progress.lastSegmentName
    runtime.lastSegmentNumber = progress.lastSegmentNumber
    runtime.lastProgressAtMs = nowMs
    runtime.lastProgressAt = new Date(nowMs).toISOString()

    if (progress.lastSegmentNumber !== null && runtime.epochInitialSegmentNumber !== null) {
      runtime.lastGoodTimeSeconds = runtime.epochStartTimeSeconds
        + Math.max(1, progress.lastSegmentNumber - runtime.epochInitialSegmentNumber + 1) * recoveryOptions.segmentDurationSeconds
      return
    }

    runtime.lastGoodTimeSeconds = Math.max(
      runtime.lastGoodTimeSeconds + recoveryOptions.segmentDurationSeconds,
      runtime.epochStartTimeSeconds + progress.segmentNames.length * recoveryOptions.segmentDurationSeconds,
    )
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

  private resetRecoveryRetryPolicy(session: SessionRecord): void {
    session.recoveryRuntime.consecutiveAttempts = 0
    session.recoveryRuntime.readRetryAttempts = 0
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
    consecutiveAttempts: 0,
    readRetryAttempts: 0,
    epoch: 0,
    skippedSeconds: 0,
    lastGoodTimeSeconds: 0,
    lastProgressAtMs: null,
    lastSegmentNumber: null,
    epochStartTimeSeconds: 0,
    epochInitialSegmentNumber: 1,
    badRanges: [],
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}