import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app-types.js'
import { isValidAssetName, isValidSessionId, parseBooleanQuery, sendApiError } from '../route-utils.js'

interface StreamParams {
  sessionId: string
  asset: string
}

interface StreamQuery {
  videoOnly?: string
  generation?: string
  region?: string
  revision?: string
}

export async function registerStreamRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = context.eventHub.subscribe((event) => {
      socket.send(JSON.stringify(event))
    })

    socket.on('close', unsubscribe)
  })

  app.get<{ Params: StreamParams; Querystring: StreamQuery }>('/streams/:sessionId/:asset', async (request, reply) => {
    const sessionManager = context.services.sessionManager
    if (!sessionManager) {
      return sendApiError(reply, 503, 'Session manager is not configured.')
    }

    const { sessionId, asset } = request.params
    const videoOnly = parseBooleanQuery(request.query.videoOnly)
    if (!isValidSessionId(sessionId) || !isValidAssetName(asset)) {
      return sendApiError(reply, 400, 'Invalid stream path.')
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return sendApiError(reply, 404, 'Session not found.')
    }

    const content = await sessionManager.readStreamAsset(sessionId, asset, {
      videoOnly,
      generation: request.query.generation,
      region: request.query.region,
      revision: request.query.revision,
    })
    if (!content) return sendApiError(reply, 404, 'Stream asset not found.')
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
    return reply.type(content.kind === 'playlist' ? 'application/vnd.apple.mpegurl' : 'video/mp2t').send(content.content)
  })
}
