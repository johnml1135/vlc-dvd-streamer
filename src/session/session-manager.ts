import { PlaybackSessionController } from './playback-session.js'
import type { AssetOptions, PublishedAsset } from './hls-publication.js'
import type {
  PlaybackReportResult, PlaybackSession, PlaybackSeekResult, PlaybackSessionControllerOptions, SessionRequest,
} from './playback-session.js'
import { ActiveViewerRegistry } from './viewer-ownership.js'

export interface SessionManagerOptions extends PlaybackSessionControllerOptions {
  inactivityMs: number
}

export type {
  SessionState, SessionRequest, PlaybackSession, PlaybackSeekAction, PlaybackSeekResult,
  PlaybackRecoveryRange, PlaybackRecoveryStatus, PlaybackRecoverySnapshot,
  PlaybackRecoveryOptions, SessionManagerEvent, PlaybackSessionControllerOptions, PlaybackReportResult,
} from './playback-session.js'

export type ViewerOwnershipResult = { ok: true; active: boolean } | {
  ok: false
  reason: 'not-found' | 'not-ready'
}

/** Selects the single active title. Each playback module owns its worker and files. */
export class SessionManager {
  private readonly sessions = new Map<string, PlaybackSessionController>()
  private readonly tombstones = new Map<string, PlaybackSession>()
  private readonly tombstoneLimit = 10
  private activeSessionId: string | null = null
  private selections: Promise<unknown> = Promise.resolve()
  private latestStart?: { request: SessionRequest; promise: Promise<PlaybackSession> }
  private inFlightStart?: { request: SessionRequest; controller: PlaybackSessionController }
  private readonly now: () => number
  private readonly viewers: ActiveViewerRegistry

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? Date.now
    this.viewers = new ActiveViewerRegistry({
      now: this.now,
      onChange: (payload) => this.options.onSessionEvent?.({ type: 'session.viewer', payload }),
    })
  }

  getSession(sessionId: string): PlaybackSession | undefined {
    return this.sessions.get(sessionId)?.getSession() ?? this.tombstones.get(sessionId)
  }

  async readStreamAsset(sessionId: string, name: string, options: AssetOptions = {}): Promise<PublishedAsset | null> {
    return this.sessions.get(sessionId)?.readAsset(name, options) ?? null
  }

  async reportPlayback(sessionId: string, body: unknown, viewerToken: string): Promise<PlaybackReportResult> {
    const playback = this.sessions.get(sessionId)
    if (!playback) return 'not-found'
    if (!this.viewers.isActiveViewer(sessionId, viewerToken)) return 'stale'
    const result = playback.reportPlayback(body)
    if (result === 'accepted') this.viewers.recordFeedback(sessionId, viewerToken)
    return result
  }

  attachViewer(sessionId: string, viewerToken: string): ViewerOwnershipResult {
    const session = this.sessions.get(sessionId)?.getSession()
    if (!session) return { ok: false, reason: 'not-found' }
    if (session.state !== 'ready') return { ok: false, reason: 'not-ready' }
    return { ok: true, active: this.viewers.attach(sessionId, viewerToken) }
  }

  takeOverViewer(sessionId: string, viewerToken: string): ViewerOwnershipResult {
    const session = this.sessions.get(sessionId)?.getSession()
    if (!session) return { ok: false, reason: 'not-found' }
    if (session.state !== 'ready') return { ok: false, reason: 'not-ready' }
    return { ok: true, active: this.viewers.takeOver(sessionId, viewerToken) }
  }

  releaseViewer(sessionId: string, viewerToken: string): boolean {
    if (!this.sessions.has(sessionId)) return false
    return this.viewers.release(sessionId, viewerToken)
  }

  getActiveSession(): PlaybackSession | undefined {
    const session = this.activeSessionId ? this.getSession(this.activeSessionId) : undefined
    return session?.state === 'failed' || session?.state === 'stopped' ? undefined : session
  }

  getRegionManifest(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.getRegionManifest() ?? null
  }

  getStitchedManifest(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.getStitchedManifest() ?? null
  }

  touch(sessionId: string): void { this.sessions.get(sessionId)?.touch() }

  noteClientSegmentRequest(sessionId: string, slotNumber: number): void {
    this.sessions.get(sessionId)?.noteClientSegmentRequest(slotNumber)
  }

  async seek(sessionId: string, input: { positionSeconds: number }): Promise<PlaybackSeekResult> {
    const playback = this.sessions.get(sessionId)
    return playback ? playback.seek(input) : { ok: false, reason: 'not-found', message: 'Session not found.' }
  }

  start(request: SessionRequest): Promise<PlaybackSession> {
    if (this.latestStart) {
      if (this.isSameRequest(this.latestStart.request, request)) return this.latestStart.promise
      if (this.inFlightStart && !this.isSameRequest(this.inFlightStart.request, request)) {
        this.inFlightStart.controller.requestStop()
      }
    }

    const startIntent: { request: SessionRequest; promise: Promise<PlaybackSession> } = {
      request: { ...request },
      promise: undefined as unknown as Promise<PlaybackSession>,
    }
    const operation = this.select(async () => {
      const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
      const snapshot = active?.getSession()
      if (active && snapshot?.state === 'ready' && this.isSameRequest(snapshot, request)) {
        active.touch()
        if (this.latestStart === startIntent) this.latestStart = undefined
        return active.getSession() ?? snapshot
      }
      if (active) {
        const previousId = this.activeSessionId
        await active.stop()
        if (previousId) this.retire(previousId, active)
      }
      const playback = new PlaybackSessionController(this.options, (id) => {
        // Register as soon as the worker is owned, including during readiness.
        // Failed shutdown must never orphan a writer outside this selection queue.
        this.sessions.set(id, playback)
        this.tombstones.delete(id)
        this.activeSessionId = id
      })
      const inFlightStart = { request: { ...request }, controller: playback }
      this.inFlightStart = inFlightStart
      if (this.latestStart !== startIntent) playback.requestStop()
      try {
        const started = await playback.start(request)
        if (started.state === 'failed') this.retire(started.id, playback)
        return started
      } finally {
        if (this.inFlightStart === inFlightStart) this.inFlightStart = undefined
      }
    })
    const promise = operation.finally(() => {
      if (this.latestStart === startIntent) this.latestStart = undefined
    })
    startIntent.promise = promise
    this.latestStart = startIntent
    return promise
  }

  stop(sessionId: string): Promise<boolean> {
    this.sessions.get(sessionId)?.requestStop()
    return this.select(async () => {
      const playback = this.sessions.get(sessionId)
      const stopped = await playback?.stop() ?? false
      if (playback?.getSession()?.state === 'stopped') this.retire(sessionId, playback)
      if (this.activeSessionId === sessionId) this.activeSessionId = null
      return stopped
    })
  }

  stopAll(): Promise<void> {
    for (const playback of this.sessions.values()) playback.requestStop()
    return this.select(async () => {
      for (const [id, playback] of [...this.sessions]) {
        await playback.stop()
        if (playback.getSession()?.state === 'stopped') this.retire(id, playback)
      }
      this.activeSessionId = null
    })
  }

  cleanupInactive(): Promise<void> {
    return this.select(async () => {
      const now = this.now()
      for (const [id, playback] of [...this.sessions]) {
        const session = playback.getSession()
        if (!session || session.state === 'stopped') continue
        if (now - Date.parse(session.lastAccessedAt) > this.options.inactivityMs) {
          await playback.stop()
          if (playback.getSession()?.state === 'stopped') this.retire(id, playback)
          if (this.activeSessionId === id) this.activeSessionId = null
        }
      }
    })
  }

  private select<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.selections.then(operation)
    this.selections = result.catch(() => {})
    return result
  }

  private isSameRequest(session: SessionRequest, request: SessionRequest): boolean {
    return session.discId === request.discId && session.drive === request.drive
      && session.titleNumber === request.titleNumber && session.audioTrack === request.audioTrack
      && session.subtitleTrack === request.subtitleTrack
  }

  private retire(id: string, playback: PlaybackSessionController): void {
    const snapshot = playback.getSession()
    if (snapshot) {
      this.tombstones.delete(id)
      this.tombstones.set(id, snapshot)
      while (this.tombstones.size > this.tombstoneLimit) {
        const oldestId = this.tombstones.keys().next().value as string | undefined
        if (oldestId === undefined) break
        this.tombstones.delete(oldestId)
      }
    }
    this.viewers.remove(id)
    this.sessions.delete(id)
    if (this.activeSessionId === id) this.activeSessionId = null
  }
}
