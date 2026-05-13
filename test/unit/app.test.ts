import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'

describe('buildApp', () => {
  it('creates a Fastify app with a health route placeholder', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 3000,
        cacheDir: '.cache',
        vlcCandidates: ['missing-vlc.exe'],
      },
      services: {},
    })

    const response = await app.inject({ method: 'GET', url: '/api/health' })

    expect(response.statusCode).toBe(200)
  })
})