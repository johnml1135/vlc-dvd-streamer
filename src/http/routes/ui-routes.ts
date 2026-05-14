import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { CatalogSnapshot, DiscTitle } from '../../disc/types.js'
import type { AppContext } from '../app-types.js'
import { getHealthSnapshot } from '../health.js'
import { parsePlaybackRequest, startPlaybackSession } from '../playback.js'
import { appendStreamFlag, isValidSessionId, parseBooleanQuery, sendApiError } from '../route-utils.js'
import { renderHomePage, renderPlayerPage } from '../../ui/page.js'

interface HomeQuery {
  includeShort?: string
}

interface PlayerParams {
  sessionId: string
}

interface PlayerQuery {
  videoOnly?: string
}

interface StopSessionParams {
  sessionId: string
}

export async function registerUiRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get<{ Querystring: HomeQuery }>('/', async (request, reply) => {
    const catalogService = context.services.catalogService
    const sessionManager = context.services.sessionManager
    const health = await getHealthSnapshot(context.config)
    const includeShort = parseBooleanQuery(request.query.includeShort)

    let snapshot: CatalogSnapshot = {
      state: 'empty',
      disc: null,
    }
    let titles: DiscTitle[] = []

    if (catalogService) {
      snapshot = catalogService.getSnapshot()
      if (snapshot.state === 'empty') {
        catalogService.startRefresh()
        snapshot = catalogService.getSnapshot()
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

  app.get<{ Params: PlayerParams; Querystring: PlayerQuery }>('/player/:sessionId', async (request, reply) => {
    const sessionManager = context.services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const { sessionId } = request.params
    const videoOnly = parseBooleanQuery(request.query.videoOnly)
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
    const catalogService = context.services.catalogService
    if (!catalogService) {
      return sendApiError(reply, 503, 'Catalog service is not configured.')
    }

    catalogService.startRefresh()
    reply.redirect('/')
  })

  app.post<{ Body: unknown }>('/actions/play', async (request, reply) => {
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
    }, playbackRequest.request, {
      catalogUnavailableStatusCode: 400,
      catalogUnavailableMessage: 'The selected disc is no longer current.',
      startupFailureMessage: 'Could not start playback.',
    })

    if (!result.ok) {
      return sendApiError(reply, result.statusCode, result.message, result.detail)
    }

    reply.redirect(`/player/${result.session.id}`)
  })

  app.post<{ Params: StopSessionParams }>('/actions/sessions/:sessionId/stop', async (request, reply) => {
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
    reply.redirect('/')
  })
}