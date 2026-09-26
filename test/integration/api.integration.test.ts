import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { CatalogService } from '../../src/disc/catalog-service.js'
import type { CatalogSnapshot } from '../../src/disc/types.js'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'
import { createCatalogServiceStub, createSessionManagerStub } from '../helpers/app-stubs.js'

describe('app API', () => {
  it('redirects an ended player session to the catalog with a visible message', async () => {
    const endedSession = {
      discId: 'disc-001', drive: 'D:', titleNumber: 1,
      id: 'ended-session', state: 'stopped' as const,
      outputDir: '.cache/sessions/ended-session',
      manifestPath: '.cache/sessions/ended-session/index.m3u8',
      manifestUrl: '/streams/ended-session/index.m3u8',
      startedAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
    }
    const app = await buildApp({
      config: { host: '127.0.0.1', port: 3000, cacheDir: '.cache', vlcCandidates: [process.execPath] },
      services: {
        catalogService: createCatalogServiceStub(),
        sessionManager: createSessionManagerStub({
          getSession: (id) => id === endedSession.id ? endedSession : undefined,
        }),
      },
    })

    try {
      const player = await app.inject({ method: 'GET', url: '/player/ended-session' })
      expect(player.statusCode).toBe(302)
      expect(player.headers.location).toBe('/?notice=session-ended')

      const catalog = await app.inject({ method: 'GET', url: player.headers.location })
      expect(catalog.statusCode).toBe(200)
      expect(catalog.body).toContain('This playback session has ended. Choose a title to start a new stream.')

      const expired = await app.inject({ method: 'GET', url: '/player/expired-session' })
      expect(expired.statusCode).toBe(302)
      expect(expired.headers.location).toBe('/?notice=session-ended')
    } finally { await app.close() }
  })

  it('renders the home page immediately while the catalog refresh continues in the background', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-api-home-'))
    let startRefreshCalls = 0
    let refreshCalls = 0
    let snapshot: CatalogSnapshot = {
      state: 'empty',
      disc: null,
    }

    const refreshPromise = new Promise<CatalogSnapshot>((resolve) => {
      setTimeout(() => {
        snapshot = {
          state: 'catalog_ready',
          disc: {
            discId: 'fake-disc-001',
            drive: 'D:',
            titles: [],
          },
        }
        resolve(snapshot)
      }, 300)
    })

    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir,
        vlcCandidates: [process.execPath],
      },
      services: {
        catalogService: createCatalogServiceStub({
          getSnapshot() {
            return snapshot
          },
          startRefresh() {
            startRefreshCalls += 1
            snapshot = {
              state: 'catalog_loading',
              disc: null,
              progress: {
                scannedTitles: 1,
                totalTitles: 4,
                currentTitleNumber: 2,
              },
            }
            void refreshPromise
          },
          async refresh() {
            refreshCalls += 1
            return refreshPromise
          },
          listTitles() {
            return []
          },
          findTitle() {
            return undefined
          },
        }),
        sessionManager: createSessionManagerStub({
          getActiveSession() {
            return undefined
          },
        }),
      },
    })

    try {
      const startedAt = Date.now()
      const response = await app.inject({ method: 'GET', url: '/' })
      const elapsedMs = Date.now() - startedAt

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Reading titles from the disc.')
      expect(response.body).toContain('1 of 4 titles scanned')
      expect(startRefreshCalls).toBe(1)
      expect(refreshCalls).toBe(0)
      expect(elapsedMs).toBeLessThan(200)
    } finally {
      await app.close()
    }
  })

  it('refreshes the disc, lists titles, starts a stream, serves the manifest, and stops the session', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-api-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      drive: 'D:',
      timeoutMs: 5000,
    })
    const catalogService = new CatalogService({
      cacheDir,
      drive: 'D:',
      minVisibleTitleDurationSeconds: 300,
      worker,
    })
    const sessionManager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker,
    })
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir,
        vlcCandidates: [process.execPath],
      },
      services: {
        catalogService,
        sessionManager,
        vlcWorker: worker,
      },
    })

    try {
      const refresh = await app.inject({ method: 'POST', url: '/api/discs/current/refresh' })
      expect(refresh.statusCode).toBe(200)
      expect(refresh.json().state).toBe('catalog_ready')

      const titles = await app.inject({ method: 'GET', url: '/api/discs/current/titles' })
      expect(titles.statusCode).toBe(200)
      expect(titles.json().titles).toHaveLength(2)

      const started = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          discId: 'fake-disc-001',
          titleNumber: 1,
          audioTrack: 1,
          subtitleTrack: 1,
        },
      })

      expect(started.statusCode).toBe(200)
      expect(started.json().state).toBe('ready')

      const manifest = await app.inject({ method: 'GET', url: started.json().manifestUrl })
      expect(manifest.statusCode).toBe(200)
      expect(manifest.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(manifest.body).toContain('#EXTM3U')

      const videoOnlyManifest = await app.inject({
        method: 'GET',
        url: `${started.json().manifestUrl}&videoOnly=1`,
      })

      expect(videoOnlyManifest.statusCode).toBe(200)
      expect(videoOnlyManifest.body).toContain('segment-000001.ts?generation=0&videoOnly=1')

      const beforeMissing = sessionManager.getSession(started.json().id)?.lastAccessedAt
      const missing = await app.inject({ method: 'GET', url: `/streams/${started.json().id}/segment-999999.ts?generation=0` })
      expect(missing.statusCode).toBe(404)
      expect(sessionManager.getSession(started.json().id)?.lastAccessedAt).toBe(beforeMissing)
      const wrongGeneration = await app.inject({ method: 'GET', url: `/streams/${started.json().id}/segment-000001.ts?generation=999` })
      expect(wrongGeneration.statusCode).toBe(404)
      const segmentUri = videoOnlyManifest.body.split('\n').find(line => line.startsWith('segment-'))
      const segment = await app.inject({ method: 'GET', url: `/streams/${started.json().id}/${segmentUri}` })
      expect(segment.statusCode).toBe(200)
      expect(segment.headers['content-type']).toContain('video/mp2t')
      expect(segment.rawPayload.length).toBeGreaterThan(0)

      const player = await app.inject({
        method: 'GET',
        url: `/player/${started.json().id}?videoOnly=1`,
      })

      expect(player.statusCode).toBe(200)
      expect(player.body).toContain('/streams/')
      expect(player.body).toContain('index.m3u8?region=0&amp;videoOnly=1')

      const stopped = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${started.json().id}`,
      })

      expect(stopped.statusCode).toBe(200)
      expect(stopped.json().stopped).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('rejects out-of-range playback track selections before starting VLC', async () => {
    const startSession = vi.fn()
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: [process.execPath],
      },
      services: {
        catalogService: createCatalogServiceStub({
          getSnapshot() {
            return {
              state: 'catalog_ready',
              disc: {
                discId: 'fake-disc-001',
                drive: 'D:',
                titles: [],
              },
            }
          },
          findTitle(titleNumber: number) {
            if (titleNumber !== 1) {
              return undefined
            }

            return {
              id: 'fake-disc-001-title-1',
              titleNumber: 1,
              label: 'Title 1',
              durationSeconds: 7200,
              likelyMainFeature: true,
              thumbnailUrl: '/api/discs/current/titles/1/thumbnail.jpg',
              audioTracks: [{ id: 1, label: 'English' }],
              subtitleTracks: [{ id: 2, label: 'English subtitles' }],
            }
          },
        }),
        sessionManager: createSessionManagerStub({
          start: startSession,
        }),
      },
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          discId: 'fake-disc-001',
          titleNumber: 1,
          audioTrack: 99,
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/audio track/i)
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('seeks an existing session and serves its stitched manifest', async () => {
    const session = {
      id: 'session-1',
      discId: 'disc-001',
      drive: 'D:',
      titleNumber: 1,
      durationSeconds: 120,
      state: 'ready' as const,
      outputDir: '.cache/sessions/session-1',
      manifestPath: '.cache/sessions/session-1/index.m3u8',
      manifestUrl: '/streams/session-1/index.m3u8',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
      timeline: {
        durationSeconds: 120,
        status: 'idle' as const,
        currentRange: { startSeconds: 20, endSeconds: 28 },
        generatedRanges: [
          { startSeconds: 0, endSeconds: 8 },
          { startSeconds: 20, endSeconds: 28 },
        ],
        stitchedManifestUrl: '/streams/session-1/stitched.m3u8',
      },
    }
    const seek = vi.fn().mockResolvedValue({
      ok: true,
      action: 'restarted',
      positionSeconds: 20,
      session,
    })
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: [process.execPath],
      },
      services: {
        sessionManager: createSessionManagerStub({
          getSession() {
            return session
          },
          async readStreamAsset(_sessionId, name, options) {
            if (name !== 'stitched.m3u8') return null
            return {
              kind: 'playlist',
              content: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000001.ts${options?.videoOnly ? '?videoOnly=1' : ''}\n`,
            }
          },
          seek,
        }),
      },
    })

    try {
      const seekResponse = await app.inject({
        method: 'POST',
        url: '/api/sessions/session-1/seek',
        payload: { positionSeconds: '20' },
      })

      expect(seekResponse.statusCode).toBe(200)
      expect(seekResponse.json()).toMatchObject({
        ok: true,
        action: 'restarted',
        positionSeconds: 20,
      })
      expect(seek).toHaveBeenCalledWith('session-1', { positionSeconds: 20 })

      const stitched = await app.inject({ method: 'GET', url: '/streams/session-1/stitched.m3u8?videoOnly=1' })

      expect(stitched.statusCode).toBe(200)
      expect(stitched.headers['content-type']).toContain('application/vnd.apple.mpegurl')
      expect(stitched.body).toContain('segment-000001.ts?videoOnly=1')
    } finally {
      await app.close()
    }
  })
})
