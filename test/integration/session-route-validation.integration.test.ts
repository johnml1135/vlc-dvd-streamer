import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createSessionManagerStub } from '../helpers/app-stubs.js'

describe('session route validation', () => {
  it('rejects invalid session ids across player and API session routes', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: [process.execPath],
      },
      services: {
        sessionManager: createSessionManagerStub(),
      },
    })

    try {
      const player = await app.inject({ method: 'GET', url: '/player/bad_session' })
      const getSession = await app.inject({ method: 'GET', url: '/api/sessions/bad_session' })
      const deleteSession = await app.inject({ method: 'DELETE', url: '/api/sessions/bad_session' })

      expect(player.statusCode).toBe(400)
      expect(getSession.statusCode).toBe(400)
      expect(deleteSession.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects invalid session ids and assets across action and stream routes', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: [process.execPath],
      },
      services: {
        sessionManager: createSessionManagerStub(),
      },
    })

    try {
      const stop = await app.inject({ method: 'POST', url: '/actions/sessions/bad_session/stop' })
      const badSessionStream = await app.inject({ method: 'GET', url: '/streams/bad_session/index.m3u8' })
      const badAssetStream = await app.inject({ method: 'GET', url: '/streams/session-1/bad%5Cname.ts' })

      expect(stop.statusCode).toBe(400)
      expect(badSessionStream.statusCode).toBe(400)
      expect(badAssetStream.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})