import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app-types.js'
import { isValidAssetName, isValidSessionId, parseBooleanQuery, rewriteManifest, sendApiError } from '../route-utils.js'
import { normalizeHlsTransportStream } from '../../vlc/transport-stream.js'

interface StreamParams {
  sessionId: string
  asset: string
}

interface StreamQuery {
  videoOnly?: string
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

    sessionManager.touch(sessionId)

    try {
      const file = await readFile(`${session.outputDir}/${asset}`)
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
}