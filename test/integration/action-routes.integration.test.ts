import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createCatalogServiceStub, createSessionManagerStub } from '../helpers/app-stubs.js'

describe('action routes', () => {
  it('starts playback through the HTML action route and redirects to the player page', async () => {
    const start = vi.fn().mockResolvedValue({
      id: 'session-1',
      discId: 'disc-001',
      drive: 'F:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 2,
      state: 'ready',
      outputDir: '.cache/sessions/session-1',
      manifestPath: '.cache/sessions/session-1/index.m3u8',
      manifestUrl: '/streams/session-1/index.m3u8',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    })

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
                discId: 'disc-001',
                drive: 'F:',
                titles: [],
              },
            }
          },
          findTitle() {
            return {
              id: 'disc-001-title-1',
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
          start,
        }),
      },
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/play',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'discId=disc-001&titleNumber=1&audioTrack=1&subtitleTrack=2',
      })

      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/player/session-1')
      expect(start).toHaveBeenCalledWith({
        discId: 'disc-001',
        drive: 'F:',
        titleNumber: 1,
        audioTrack: 1,
        subtitleTrack: 2,
      })
    } finally {
      await app.close()
    }
  })

  it('stops playback through the HTML action route and redirects home', async () => {
    const stop = vi.fn().mockResolvedValue(true)
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: [process.execPath],
      },
      services: {
        sessionManager: createSessionManagerStub({
          stop,
        }),
      },
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/sessions/session-1/stop',
      })

      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/')
      expect(stop).toHaveBeenCalledWith('session-1')
    } finally {
      await app.close()
    }
  })
})