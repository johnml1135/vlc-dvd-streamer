import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { PlaybackSession } from '../../src/session/session-manager.js'
import { createSessionManagerStub } from '../helpers/app-stubs.js'

const session: PlaybackSession = {
  id: 'session-1',
  discId: 'disc-1',
  drive: 'D:',
  titleNumber: 1,
  durationSeconds: 120,
  state: 'ready',
  outputDir: '.cache/session-1',
  manifestPath: '.cache/session-1/index.m3u8',
  manifestUrl: '/streams/session-1/index.m3u8?region=0',
  startedAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z',
}

const report = {
  manifestUrl: session.manifestUrl,
  reporterId: 'browser-1',
  sequence: 1,
  positionSeconds: 4,
  bufferedEndSeconds: 12,
  paused: false,
  playbackRate: 1,
}

async function setup(reportPlayback: (sessionId: string, body: unknown) => Promise<'accepted' | 'stale' | 'invalid' | 'not-found'>) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-feedback-'))
  const app = await buildApp({
    config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
    services: {
      sessionManager: createSessionManagerStub({
        getSession() { return session },
        reportPlayback,
      }),
    },
  })
  return app
}

describe('playback feedback API', () => {
  it('forwards accepted feedback without touching the session in the route', async () => {
    const reportPlayback = vi.fn().mockResolvedValue('accepted')
    const app = await setup(reportPlayback)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/playback', payload: report })
      expect(response.statusCode).toBe(204)
      expect(response.body).toBe('')
      expect(reportPlayback).toHaveBeenCalledWith('session-1', report)
    } finally {
      await app.close()
    }
  })

  it.each([
    ['stale', 409],
    ['invalid', 400],
    ['not-found', 404],
  ] as const)('maps manager result %s to HTTP %d', async (result, statusCode) => {
    const app = await setup(async () => result)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/playback', payload: { unexpected: true } })
      expect(response.statusCode).toBe(statusCode)
    } finally {
      await app.close()
    }
  })

  it('rejects invalid session ids and reports unavailable managers', async () => {
    const reportPlayback = vi.fn().mockResolvedValue('accepted')
    const invalidIdApp = await setup(reportPlayback)
    try {
      expect((await invalidIdApp.inject({ method: 'POST', url: '/api/sessions/bad_session/playback', payload: report })).statusCode).toBe(400)
    } finally {
      await invalidIdApp.close()
    }

    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-feedback-missing-'))
    const app = await buildApp({
      config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
      services: {},
    })
    try {
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session-1/playback', payload: report })).statusCode).toBe(503)
    } finally {
      await app.close()
    }
    expect(reportPlayback).not.toHaveBeenCalled()
  })
})
