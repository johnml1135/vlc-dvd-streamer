import { readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app-types.js'
import { isValidAssetName, isValidSessionId, parseBooleanQuery, rewriteSessionManifest, sendApiError } from '../route-utils.js'
import { normalizeHlsTransportStream } from '../../vlc/transport-stream.js'

interface StreamParams {
  sessionId: string
  asset: string
}

function parseSegmentSlot(asset: string): number | null {
  const match = /^segment-(\d+)\.ts$/i.exec(asset)
  if (!match) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isInteger(parsed) ? parsed : null
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

    // A segment fetch tells us where playback's leading edge is, which recovery
    // uses to decide how long it can keep retrying a stalled read.
    const requestedSlot = parseSegmentSlot(asset)
    if (requestedSlot !== null) {
      sessionManager.noteClientSegmentRequest(sessionId, requestedSlot)
    }

    // The browser-facing manifests are composed server-side from the DVD-time
    // slot grid (placeholders inline), not read raw from VLC. They already carry
    // correctly-placed discontinuities, so no epoch-based rewrite is needed.
    if (asset === 'index.m3u8' || asset === 'stitched.m3u8') {
      const manifest = asset === 'index.m3u8'
        ? sessionManager.getRegionManifest(sessionId)
        : sessionManager.getStitchedManifest(sessionId)
      if (!manifest) {
        return sendApiError(reply, 404, 'Stream asset not found.')
      }

      const content = rewriteSessionManifest(manifest, {
        queryFlag: videoOnly ? 'videoOnly' : undefined,
      })
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
      reply.type('application/vnd.apple.mpegurl').send(content)
      return
    }

    try {
      const file = await readFile(`${session.outputDir}/${asset}`)
      if (asset.endsWith('.m3u8')) {
        const content = rewriteSessionManifest(file.toString('utf8'), {
          queryFlag: videoOnly ? 'videoOnly' : undefined,
        })
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
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