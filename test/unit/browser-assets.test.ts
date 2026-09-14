import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'

describe('browser assets', () => {
  it.each([
    ['/assets/browser-events.js', 'subscribeAppEvents'],
    ['/assets/browser-playback.js', 'initializeBrowserPlayback'],
    ['/shared/format-clock.js', 'formatClock'],
  ])('serves the typed source module %s as browser JavaScript', async (url, exportName) => {
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
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toMatch(/^text\/javascript/)
      expect(response.body).toContain(`export function ${exportName}`)
      expect(response.body).not.toMatch(/export interface|export type/)
    } finally {
      await app.close()
    }
  })
})
