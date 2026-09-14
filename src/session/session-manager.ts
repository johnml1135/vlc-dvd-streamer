import { PlaybackSessionController } from './playback-session.js'
import type { AssetOptions, PublishedAsset } from './hls-publication.js'
import type {
  PlaybackReportResult, PlaybackSession, PlaybackSeekResult, PlaybackSessionControllerOptions, SessionRequest,
} from './playback-session.js'

export interface SessionManagerOptions extends PlaybackSessionControllerOptions {
  inactivityMs: number
}

export type {
  SessionState, SessionRequest, PlaybackSession, PlaybackSeekAction, PlaybackSeekResult,
  PlaybackRecoveryRange, PlaybackRecoveryStatus, PlaybackRecoverySnapshot,
  PlaybackRecoveryOptions, SessionManagerEvent, PlaybackSessionControllerOptions, PlaybackReportResult,
} from './playback-session.js'

/** Selects the single active title. Each playback module owns its worker and files. */
export class SessionManager {
  private readonly sessions = new Map<string, PlaybackSessionController>()
  private activeSessionId: string | null = null
  private selections: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? Date.now
  }

  getSession(sessionId: string): PlaybackSession | undefined {
    return this.sessions.get(sessionId)?.getSession()
  }

  async readStreamAsset(sessionId: string, name: string, options: AssetOptions = {}): Promise<PublishedAsset | null> {
    return this.sessions.get(sessionId)?.readAsset(name, options) ?? null
  }

  async reportPlayback(sessionId: string, body: unknown): Promise<PlaybackReportResult> {
    const playback = this.sessions.get(sessionId)
    if (!playback) return 'not-found'
    return playback.reportPlayback(body)
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
    return this.select(async () => {
      const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
      const snapshot = active?.getSession()
      if (active && snapshot?.state === 'ready' && this.isSameRequest(snapshot, request)) {
        active.touch()
        return active.getSession() ?? snapshot
      }
      if (active) await active.stop()
      const playback = new PlaybackSessionController(this.options, (id) => {
        // Register as soon as the worker is owned, including during readiness.
        // Failed shutdown must never orphan a writer outside this selection queue.
        this.sessions.set(id, playback)
        this.activeSessionId = id
      })
      return playback.start(request)
    })
  }

  stop(sessionId: string): Promise<boolean> {
    this.sessions.get(sessionId)?.requestStop()
    return this.select(async () => {
      const stopped = await this.sessions.get(sessionId)?.stop() ?? false
      if (this.activeSessionId === sessionId) this.activeSessionId = null
      return stopped
    })
  }

  stopAll(): Promise<void> {
    for (const playback of this.sessions.values()) playback.requestStop()
    return this.select(async () => {
      for (const playback of this.sessions.values()) await playback.stop()
      this.activeSessionId = null
    })
  }

  cleanupInactive(): Promise<void> {
    return this.select(async () => {
      const now = this.now()
      for (const [id, playback] of this.sessions) {
        const session = playback.getSession()
        if (!session || session.state === 'stopped') continue
        if (now - Date.parse(session.lastAccessedAt) > this.options.inactivityMs) {
          await playback.stop()
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
}
