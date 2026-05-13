import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { ManagedProcessHandle } from '../vlc/process-supervisor.js'
import type { VlcWorker } from '../vlc/worker.js'

export type SessionState = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'

export interface SessionRequest {
  discId: string
  drive: string
  titleNumber: number
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
}

interface SessionRecord extends PlaybackSession {
  handle: ManagedProcessHandle
}

export interface SessionManagerOptions {
  cacheDir: string
  inactivityMs: number
  worker: VlcWorker
  readinessTimeoutMs?: number
}

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

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.state === 'stopped' || session.state === 'failed') {
      return
    }

    session.lastAccessedAt = new Date().toISOString()
  }

  async start(request: SessionRequest): Promise<PlaybackSession> {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
    if (active && this.isSameRequest(active, request) && active.state === 'ready') {
      active.lastAccessedAt = new Date().toISOString()
      return this.toPlaybackSession(active)
    }

    if (active && active.state !== 'stopped') {
      await this.stop(active.id)
    }

    const id = randomUUID()
    const outputDir = join(this.options.cacheDir, 'sessions', id)
    await mkdir(outputDir, { recursive: true })

    const now = new Date().toISOString()
    const runtime = await this.options.worker.startHlsSession({
      drive: request.drive,
      titleNumber: request.titleNumber,
      audioTrack: request.audioTrack,
      subtitleTrack: request.subtitleTrack,
      outputDir,
      baseUrl: `/streams/${id}/`,
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
    }

    this.sessions.set(id, session)
    this.activeSessionId = id

    try {
      await this.waitForReadiness(session)
      session.state = 'ready'
      session.lastAccessedAt = new Date().toISOString()
      return this.toPlaybackSession(session)
    } catch (error) {
      session.state = 'failed'
      session.error = {
        message: 'Playback session failed to become ready.',
        detail: error instanceof Error ? error.message : 'Unknown playback startup error.',
      }
      this.activeSessionId = null
      return this.toPlaybackSession(session)
    }
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.state === 'stopped') {
      return false
    }

    session.state = 'stopping'
    await session.handle.stop()
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
        await this.stop(sessionId)
      }
    }
  }

  private async waitForReadiness(session: SessionRecord): Promise<void> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 15000)

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

    await session.handle.stop()
    throw new Error('Timed out waiting for HLS manifest and first segment.')
  }

  private async hasReadyFiles(outputDir: string, manifestPath: string): Promise<boolean> {
    try {
      await access(manifestPath, constants.F_OK)
      const files = await readdir(outputDir)
      return files.some((file) => file.endsWith('.ts'))
    } catch {
      return false
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
    return {
      discId: session.discId,
      drive: session.drive,
      titleNumber: session.titleNumber,
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
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}