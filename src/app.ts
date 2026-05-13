import { constants } from 'node:fs'
import { access, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import websocket from '@fastify/websocket'
import type { AppConfig } from './config.js'
import type { CatalogService } from './disc/catalog-service.js'
import type { CatalogSnapshot, DiscTitle } from './disc/types.js'
import { EventHub } from './events/event-hub.js'
import type { SessionManager } from './session/session-manager.js'
import { renderHomePage, renderPlayerPage } from './ui/page.js'
import { normalizeHlsTransportStream } from './vlc/transport-stream.js'
import type { VlcWorker } from './vlc/worker.js'
import { findVlc } from './vlc/find-vlc.js'
import type { ServerLog } from './logging/server-log.js'

interface AppServices {
  catalogService?: CatalogService
  eventHub?: EventHub
  sessionManager?: SessionManager
  vlcWorker?: VlcWorker
  serverLog?: ServerLog
}

export interface AppDeps {
  config: AppConfig
  services: Record<string, unknown>
}

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+2mS2WQAAAABJRU5ErkJggg==',
  'base64',
)

async function getHealthSnapshot(config: AppConfig) {
  const vlc = await findVlc(config.vlcCandidates)

  return {
    ok: vlc.found,
    dependencies: {
      vlc,
    },
  }
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify()
  const services = deps.services as AppServices
  const eventHub = services.eventHub ?? new EventHub()
  const serverLog = services.serverLog

  await app.register(formbody)
  await app.register(websocket)

  app.addHook('onClose', async () => {
    await services.sessionManager?.stopAll()
  })

  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = eventHub.subscribe((event) => {
      socket.send(JSON.stringify(event))
    })

    socket.on('close', unsubscribe)
  })

  app.get('/', async (request, reply) => {
    const catalogService = services.catalogService
    const sessionManager = services.sessionManager
    const health = await getHealthSnapshot(deps.config)
    const includeShort = parseBooleanQuery((request.query as Record<string, string | undefined>)?.includeShort)

    let snapshot: CatalogSnapshot = {
      state: 'empty',
      disc: null,
    }
    let titles: DiscTitle[] = []

    if (catalogService) {
      snapshot = catalogService.getSnapshot()
      if (snapshot.state === 'empty') {
        snapshot = await catalogService.refresh()
      }

      if (snapshot.state === 'catalog_ready') {
        titles = catalogService.listTitles({ includeShort })
      }
    }

    reply.type('text/html').send(renderHomePage({
      health,
      snapshot,
      titles,
      includeShort,
      activeSession: sessionManager?.getActiveSession(),
    }))
  })

  app.get('/player/:sessionId', async (request, reply) => {
    const sessionManager = services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const sessionId = String((request.params as { sessionId: string }).sessionId)
    const videoOnly = parseBooleanQuery((request.query as Record<string, string | undefined>)?.videoOnly)
    if (!isValidSessionId(sessionId)) {
      return sendApiError(reply, 400, 'Invalid session id.')
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return sendApiError(reply, 404, 'Session not found.')
    }

    sessionManager.touch(sessionId)

    reply.type('text/html').send(renderPlayerPage({
      session,
      manifestUrl: appendStreamFlag(session.manifestUrl, 'videoOnly', videoOnly),
    }))
  })

  app.get('/assets/hls.mjs', async (_request, reply) => {
    try {
      const require = createRequire(import.meta.url)
      const hlsPath = require.resolve('hls.js/dist/hls.mjs')
      const contents = await readFile(hlsPath, 'utf8')
      reply.type('text/javascript').send(contents)
    } catch {
      reply.code(404).type('text/plain').send('hls.js asset is not installed.')
    }
  })

  app.post('/actions/refresh', async (_request, reply) => {
    const catalogService = services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    const snapshot = await catalogService.refresh()
    eventHub.publish({ type: 'disc.updated', payload: snapshot })
    eventHub.publish({ type: 'catalog.updated', payload: snapshot })
    reply.redirect('/')
  })

  app.post('/actions/play', async (request, reply) => {
    const catalogService = services.catalogService
    const sessionManager = services.sessionManager
    if (!catalogService || !sessionManager) {
      return sendApiError(reply, 503, 'Playback services are not configured.')
    }

    const body = request.body as Record<string, string | undefined>
    const discId = String(body.discId ?? '')
    const titleNumber = Number(body.titleNumber)
    const audioTrack = parseOptionalNumber(body.audioTrack)
    const subtitleTrack = parseOptionalNumber(body.subtitleTrack)
    const snapshot = catalogService.getSnapshot()

    if (snapshot.state !== 'catalog_ready' || snapshot.disc?.discId !== discId) {
      return sendApiError(reply, 400, 'The selected disc is no longer current.')
    }

    if (!catalogService.findTitle(titleNumber)) {
      return sendApiError(reply, 400, 'The selected title is not available.')
    }

    const session = await sessionManager.start({
      discId,
      drive: snapshot.disc.drive,
      titleNumber,
      audioTrack: audioTrack ?? undefined,
      subtitleTrack: subtitleTrack ?? undefined,
    })

    if (session.state !== 'ready') {
      return sendApiError(reply, 502, session.error?.message ?? 'Could not start playback.', session.error?.detail)
    }

    eventHub.publish({ type: 'session.updated', payload: session })

    reply.redirect(`/player/${session.id}`)
  })

  app.post('/actions/sessions/:sessionId/stop', async (request, reply) => {
    const sessionManager = services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const sessionId = String((request.params as { sessionId: string }).sessionId)
    const stopped = await sessionManager.stop(sessionId)
    eventHub.publish({ type: 'session.updated', payload: { sessionId, stopped } })
    reply.redirect('/')
  })

  app.get('/api/health', async () => {
    return getHealthSnapshot(deps.config)
  })

  app.get('/api/discs/current', async (_request, reply) => {
    const catalogService = services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    return catalogService.getSnapshot()
  })

  app.get('/api/logs', async () => {
    return serverLog?.list() ?? []
  })

  app.post('/api/discs/current/refresh', async (_request, reply) => {
    const catalogService = services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    const snapshot = await catalogService.refresh()
    eventHub.publish({ type: 'disc.updated', payload: snapshot })
    eventHub.publish({ type: 'catalog.updated', payload: snapshot })
    return snapshot
  })

  app.get('/api/discs/current/titles', async (request, reply) => {
    const catalogService = services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    const snapshot = catalogService.getSnapshot()
    if (snapshot.state !== 'catalog_ready' || !snapshot.disc) {
      return sendApiError(reply, 409, 'No catalog is ready yet.', snapshot.error?.detail)
    }

    const includeShort = parseBooleanQuery((request.query as Record<string, string | undefined>)?.includeShort)
    return {
      discId: snapshot.disc.discId,
      titles: catalogService.listTitles({ includeShort }),
    }
  })

  app.get('/api/discs/current/titles/:titleNumber/thumbnail.jpg', async (request, reply) => {
    const catalogService = services.catalogService
    const vlcWorker = services.vlcWorker
    if (!catalogService || !vlcWorker) {
      return sendApiError(reply, 503, 'Thumbnail services are not configured.')
    }

    const titleNumber = Number((request.params as { titleNumber: string }).titleNumber)
    const snapshot = catalogService.getSnapshot()
    const title = catalogService.findTitle(titleNumber)

    if (!Number.isInteger(titleNumber) || titleNumber < 1 || snapshot.state !== 'catalog_ready' || !snapshot.disc || !title) {
      return sendApiError(reply, 404, 'Thumbnail title not found.')
    }

    const outputDir = join(deps.config.cacheDir, 'discs', snapshot.disc.discId, `title-${titleNumber}`)
    const outputPath = join(outputDir, 'thumbnail.jpg')
    await mkdir(outputDir, { recursive: true })

    try {
      await access(outputPath, constants.F_OK)
    } catch {
      try {
        await vlcWorker.generateThumbnail({
          drive: snapshot.disc.drive,
          titleNumber,
          outputDir,
          startTimeSeconds: 45,
          runTimeSeconds: 2,
        })
        eventHub.publish({ type: 'thumbnail.updated', payload: { discId: snapshot.disc.discId, titleNumber } })
      } catch {
        reply.type('image/png').send(PLACEHOLDER_PNG)
        return
      }
    }

    try {
      const file = await readFile(outputPath)
      reply.type('image/png').send(file)
    } catch {
      reply.type('image/png').send(PLACEHOLDER_PNG)
    }
  })

  app.post('/api/sessions', async (request, reply) => {
    const catalogService = services.catalogService
    const sessionManager = services.sessionManager
    if (!catalogService || !sessionManager) {
      return sendApiError(reply, 503, 'Playback services are not configured.')
    }

    const body = request.body as {
      discId?: string
      titleNumber?: number
      audioTrack?: number
      subtitleTrack?: number
    }
    const snapshot = catalogService.getSnapshot()

    if (snapshot.state !== 'catalog_ready' || !snapshot.disc) {
      return sendApiError(reply, 409, 'No DVD catalog is ready yet.')
    }

    if (body.discId !== snapshot.disc.discId) {
      return sendApiError(reply, 400, 'The selected disc is no longer current.')
    }

    const titleNumber = Number(body.titleNumber)
    if (!catalogService.findTitle(titleNumber)) {
      return sendApiError(reply, 400, 'The selected title is not available.')
    }

    const session = await sessionManager.start({
      discId: snapshot.disc.discId,
      drive: snapshot.disc.drive,
      titleNumber,
      audioTrack: typeof body.audioTrack === 'number' ? body.audioTrack : undefined,
      subtitleTrack: typeof body.subtitleTrack === 'number' ? body.subtitleTrack : undefined,
    })

    if (session.state !== 'ready') {
      return sendApiError(reply, 502, session.error?.message ?? 'Playback failed to start.', session.error?.detail)
    }

    eventHub.publish({ type: 'session.updated', payload: session })

    return session
  })

  app.get('/api/sessions/:sessionId', async (request, reply) => {
    const sessionManager = services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const sessionId = String((request.params as { sessionId: string }).sessionId)
    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return sendApiError(reply, 404, 'Session not found.')
    }

    sessionManager.touch(sessionId)

    return session
  })

  app.delete('/api/sessions/:sessionId', async (request, reply) => {
    const sessionManager = services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const sessionId = String((request.params as { sessionId: string }).sessionId)
    const stopped = await sessionManager.stop(sessionId)
    eventHub.publish({ type: 'session.updated', payload: { sessionId, stopped } })
    return { stopped }
  })

  app.get('/streams/:sessionId/:asset', async (request, reply) => {
    const sessionManager = services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const { sessionId, asset } = request.params as { sessionId: string; asset: string }
    const videoOnly = parseBooleanQuery((request.query as Record<string, string | undefined>)?.videoOnly)
    if (!isValidSessionId(sessionId) || !isValidAssetName(asset)) {
      return sendApiError(reply, 400, 'Invalid stream path.')
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return sendApiError(reply, 404, 'Session not found.')
    }

    sessionManager.touch(sessionId)

    const filePath = join(session.outputDir, asset)
    try {
      const file = await readFile(filePath)
      if (asset.endsWith('.m3u8')) {
        const content = videoOnly ? rewriteManifest(file.toString('utf8'), 'videoOnly') : file
        reply.type('application/vnd.apple.mpegurl').send(content)
        return
      }

      const content = normalizeHlsTransportStream(file, { includeAudio: !videoOnly })
      reply.type('video/mp2t').send(content)
    } catch {
      return sendApiError(reply, 404, 'Stream asset not found.')
    }
  })

  return app
}

function parseBooleanQuery(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

function appendStreamFlag(url: string, key: string, enabled: boolean): string {
  if (!enabled) {
    return url
  }

  return `${url}${url.includes('?') ? '&' : '?'}${key}=1`
}

function rewriteManifest(manifest: string, key: string): string {
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) {
        return line
      }

      return `${line}${line.includes('?') ? '&' : '?'}${key}=1`
    })
    .join('\n')
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isValidSessionId(sessionId: string): boolean {
  return /^[a-z0-9-]+$/i.test(sessionId)
}

function isValidAssetName(asset: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(asset) && !asset.includes('..') && !asset.includes('/') && !asset.includes('\\')
}

function sendApiError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, message: string, detail?: string) {
  return reply.code(statusCode).send({
    message,
    detail,
  })
}