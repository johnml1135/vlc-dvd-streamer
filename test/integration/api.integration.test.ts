import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { CatalogService } from '../../src/disc/catalog-service.js'
import { SessionManager } from '../../src/session/session-manager.js'
import { VlcWorker } from '../../src/vlc/worker.js'

describe('app API', () => {
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
    expect(manifest.body).toContain('#EXTM3U')

    const videoOnlyManifest = await app.inject({
      method: 'GET',
      url: `${started.json().manifestUrl}?videoOnly=1`,
    })

    expect(videoOnlyManifest.statusCode).toBe(200)
    expect(videoOnlyManifest.body).toContain('segment-000001.ts?videoOnly=1')

    const player = await app.inject({
      method: 'GET',
      url: `/player/${started.json().id}?videoOnly=1`,
    })

    expect(player.statusCode).toBe(200)
    expect(player.body).toContain('/streams/')
    expect(player.body).toContain('index.m3u8?videoOnly=1')

    const stopped = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${started.json().id}`,
    })

    expect(stopped.statusCode).toBe(200)
    expect(stopped.json().stopped).toBe(true)
  })
})