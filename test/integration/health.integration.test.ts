import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'

describe('health route', () => {
  it('reports VLC dependency status', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: ['missing-vlc.exe'],
      },
      services: {},
    })

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      const body = response.json()

      expect(response.statusCode).toBe(200)
      expect(body).toHaveProperty('dependencies.vlc.found')
      expect(body).toHaveProperty('dependencies.vlc.path')
    } finally {
      await app.close()
    }
  })
})