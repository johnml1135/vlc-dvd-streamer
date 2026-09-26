import { randomUUID } from 'node:crypto'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CatalogSnapshot, DiscTitle } from '../../disc/types.js'
import type { AppContext } from '../app-types.js'
import { DRIVE_BUSY_MESSAGE, isDriveBusyMessage, userFacingDriveError } from '../../disc/drive-errors.js'
import { getHealthSnapshot } from '../health.js'
import { parsePlaybackRequest, startPlaybackSession } from '../playback.js'
import { appendStreamFlag, isValidSessionId, parseBooleanQuery, sendApiError } from '../route-utils.js'
import { renderHomePage, renderPlayerPage, renderRetryPage } from '../../ui/page.js'

interface HomeQuery {
  includeShort?: string
  notice?: string
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

const browserAssetExtension = extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'

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
      notice: request.query.notice === 'session-ended'
        ? 'This playback session has ended. Choose a title to start a new stream.'
        : undefined,
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
    if (!session || session.state === 'stopped' || session.state === 'failed') {
      return reply.redirect('/?notice=session-ended')
    }

    const viewerToken = randomUUID()
    const viewer = sessionManager.attachViewer(sessionId, viewerToken)
    if (viewer.ok && viewer.active) sessionManager.touch(sessionId)
    reply.type('text/html').send(renderPlayerPage({
      session,
      manifestUrl: appendStreamFlag(session.manifestUrl, 'videoOnly', videoOnly),
      viewerToken,
      viewerActive: viewer.ok && viewer.active,
    }))
  })

  app.get('/assets/browser-events.js', async (_request, reply) => {
    await sendBrowserAsset(reply, 'browser-events')
  })

  app.get('/assets/browser-playback.js', async (_request, reply) => {
    await sendBrowserAsset(reply, 'browser-playback')
  })

  app.get('/shared/format-clock.js', async (_request, reply) => {
    await sendBrowserAsset(reply, 'format-clock')
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

    const snapshot = await catalogService.refresh({ force: true })
    if (snapshot.state === 'catalog_error') {
      const detail = snapshot.error?.detail ?? snapshot.error?.message ?? 'Could not read DVD titles.'
      const message = isDriveBusyMessage(detail) ? DRIVE_BUSY_MESSAGE : snapshot.error?.message ?? detail
      const health = await getHealthSnapshot(context.config)
      reply.code(503).type('text/html').send(renderHomePage({
        health,
        snapshot: { ...snapshot, error: { message, detail } },
        titles: [],
        includeShort: false,
      }))
      return
    }

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
      const message = userFacingDriveError(result.message, result.detail)
      const detail = result.detail && message !== DRIVE_BUSY_MESSAGE ? ` ${result.detail}` : ''
      reply.code(result.statusCode).type('text/html').send(renderRetryPage({
        message: `${message}${detail}`,
        action: '/actions/play',
        fields: {
          discId: playbackRequest.request.discId,
          titleNumber: String(playbackRequest.request.titleNumber),
          audioTrack: playbackRequest.request.audioTrack === null ? '' : String(playbackRequest.request.audioTrack),
          subtitleTrack: playbackRequest.request.subtitleTrack === null ? '' : String(playbackRequest.request.subtitleTrack),
        },
      }))
      return
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

async function sendBrowserAsset(reply: FastifyReply, assetName: 'browser-events' | 'browser-playback' | 'format-clock'): Promise<void> {
  try {
    const directory = assetName === 'format-clock' ? 'shared' : 'ui'
    const assetUrl = new URL(`../../${directory}/${assetName}${browserAssetExtension}`, import.meta.url)
    const source = await readFile(assetUrl, 'utf8')
    const contents = browserAssetExtension === '.ts'
      ? stripTypeScriptTypes(source, { mode: 'strip' })
      : source
    reply.type('text/javascript').send(contents)
  } catch {
    reply.code(404).type('text/plain').send('Browser asset is not available.')
  }
}
