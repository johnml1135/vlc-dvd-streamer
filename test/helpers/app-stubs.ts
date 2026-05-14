import type { CatalogSnapshot } from '../../src/disc/types.js'
import type { CatalogServiceLike, SessionManagerLike, VlcWorkerLike } from '../../src/http/app-types.js'
import type { SessionRequest } from '../../src/session/session-manager.js'

export function createCatalogServiceStub(overrides: Partial<CatalogServiceLike> = {}): CatalogServiceLike {
  const emptySnapshot: CatalogSnapshot = {
    state: 'empty',
    disc: null,
  }

  return {
    getSnapshot() {
      return emptySnapshot
    },
    startRefresh() {},
    async refresh() {
      return emptySnapshot
    },
    listTitles() {
      return []
    },
    findTitle() {
      return undefined
    },
    ...overrides,
  }
}

export function createSessionManagerStub(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    async start(request: SessionRequest) {
      return {
        ...request,
        id: 'session-stub',
        state: 'failed',
        outputDir: '.cache/sessions/session-stub',
        manifestPath: '.cache/sessions/session-stub/index.m3u8',
        manifestUrl: '/streams/session-stub/index.m3u8',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        error: {
          message: 'Playback failed to start.',
        },
      }
    },
    getSession() {
      return undefined
    },
    getActiveSession() {
      return undefined
    },
    getStitchedManifest() {
      return null
    },
    async seek() {
      return { ok: false, reason: 'not-found', message: 'Session not found.' }
    },
    touch() {},
    async stop() {
      return false
    },
    async stopAll() {},
    ...overrides,
  }
}

export function createVlcWorkerStub(overrides: Partial<VlcWorkerLike> = {}): VlcWorkerLike {
  return {
    async generateThumbnail() {
      return { outputPath: '.cache/thumbnail.jpg' }
    },
    ...overrides,
  }
}