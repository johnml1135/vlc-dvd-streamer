import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedProcessHandle } from '../vlc/process-supervisor.js'
import type { VlcWorker } from '../vlc/worker.js'
import type { ServerLog } from '../logging/server-log.js'

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
  logger?: ServerLog
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
      this.options.logger?.info('session', `Reusing active session ${active.id} for title ${active.titleNumber}.`)
      return this.toPlaybackSession(active)
    }

    if (active && active.state !== 'stopped') {
      this.options.logger?.info('session', `Replacing active session ${active.id} with title ${request.titleNumber}.`)
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
    this.options.logger?.info('session', `Session ${id} created for title ${request.titleNumber}.`)

    try {
      await this.waitForReadiness(session)
      session.state = 'ready'
      session.lastAccessedAt = new Date().toISOString()
      this.options.logger?.info('session', `Session ${session.id} is ready.`)
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
    this.options.logger?.info('session', `Stopping session ${session.id}.`)
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
      const segmentName = getFirstSegmentName(manifest)
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
      await session.handle.stop()
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

function getFirstSegmentName(manifest: string): string | null {
  if (!manifest.trimStart().startsWith('#EXTM3U')) {
    return null
  }

  const segmentLine = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))

  if (!segmentLine) {
    return null
  }

  const withoutQuery = segmentLine.split('?')[0]
  const segmentName = withoutQuery.split('/').filter(Boolean).at(-1)
  return segmentName?.endsWith('.ts') ? segmentName : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}