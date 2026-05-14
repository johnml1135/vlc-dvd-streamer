import { constants } from 'node:fs'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app-types.js'
import { getHealthSnapshot } from '../health.js'
import { parsePlaybackRequest, startPlaybackSession } from '../playback.js'
import { isValidSessionId, parseBooleanQuery, sendApiError } from '../route-utils.js'

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+2mS2WQAAAABJRU5ErkJggg==',
  'base64',
)

interface TitlesQuery {
  includeShort?: string
}

interface TitleParams {
  titleNumber: string
}

interface SessionParams {
  sessionId: string
}

export async function registerApiRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/api/health', async () => getHealthSnapshot(context.config))

  app.get('/api/discs/current', async (_request, reply) => {
    const catalogService = context.services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    return catalogService.getSnapshot()
  })

  app.get('/api/logs', async () => {
    return context.serverLog?.list() ?? []
  })

  app.post('/api/discs/current/refresh', async (_request, reply) => {
    const catalogService = context.services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    const snapshot = await catalogService.refresh()
    context.eventHub.publish({ type: 'disc.updated', payload: snapshot })
    context.eventHub.publish({ type: 'catalog.updated', payload: snapshot })
    return snapshot
  })

  app.get<{ Querystring: TitlesQuery }>('/api/discs/current/titles', async (request, reply) => {
    const catalogService = context.services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    const snapshot = catalogService.getSnapshot()
    if (snapshot.state !== 'catalog_ready' || !snapshot.disc) {
      return sendApiError(reply, 409, 'No catalog is ready yet.', snapshot.error?.detail)
    }

    const includeShort = parseBooleanQuery(request.query.includeShort)
    return {
      discId: snapshot.disc.discId,
      titles: catalogService.listTitles({ includeShort }),
    }
  })

  app.get<{ Params: TitleParams }>('/api/discs/current/titles/:titleNumber/thumbnail.jpg', async (request, reply) => {
    const catalogService = context.services.catalogService
    const vlcWorker = context.services.vlcWorker
    if (!catalogService || !vlcWorker) {
      return sendApiError(reply, 503, 'Thumbnail services are not configured.')
    }

    const titleNumber = Number(request.params.titleNumber)
    const snapshot = catalogService.getSnapshot()
    const title = catalogService.findTitle(titleNumber)

    if (!Number.isInteger(titleNumber) || titleNumber < 1 || snapshot.state !== 'catalog_ready' || !snapshot.disc || !title) {
      return sendApiError(reply, 404, 'Thumbnail title not found.')
    }

    const outputDir = join(context.config.cacheDir, 'discs', snapshot.disc.discId, `title-${titleNumber}`)
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
        context.eventHub.publish({ type: 'thumbnail.updated', payload: { discId: snapshot.disc.discId, titleNumber } })
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

  app.post<{ Body: unknown }>('/api/sessions', async (request, reply) => {
    const catalogService = context.services.catalogService
    const sessionManager = context.services.sessionManager
    if (!catalogService || !sessionManager) {
      return sendApiError(reply, 503, 'Playback services are not configured.')
    }

    const playbackRequest = parsePlaybackRequest(request.body)
    if (!playbackRequest.ok) {
      return sendApiError(reply, 400, playbackRequest.message)
    }

    const result = await startPlaybackSession({
      catalogService,
      sessionManager,
      eventHub: context.eventHub,
    }, playbackRequest.request)

    if (!result.ok) {
      return sendApiError(reply, result.statusCode, result.message, result.detail)
    }

    return result.session
  })

  app.get<{ Params: SessionParams }>('/api/sessions/:sessionId', async (request, reply) => {
    const sessionManager = context.services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const { sessionId } = request.params
    if (!isValidSessionId(sessionId)) {
      return sendApiError(reply, 400, 'Invalid session id.')
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return sendApiError(reply, 404, 'Session not found.')
    }

    sessionManager.touch(sessionId)
    return session
  })

  app.delete<{ Params: SessionParams }>('/api/sessions/:sessionId', async (request, reply) => {
    const sessionManager = context.services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const { sessionId } = request.params
    if (!isValidSessionId(sessionId)) {
      return sendApiError(reply, 400, 'Invalid session id.')
    }

    const stopped = await sessionManager.stop(sessionId)
    context.eventHub.publish({ type: 'session.updated', payload: { sessionId, stopped } })
    return { stopped }
  })
}