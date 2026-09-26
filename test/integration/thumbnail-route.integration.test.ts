import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createCatalogServiceStub, createVlcWorkerStub } from '../helpers/app-stubs.js'

describe('thumbnail route', () => {
  it('creates the title thumbnail directory before invoking the worker', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-thumb-route-'))
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
            return {
              state: 'catalog_ready',
              disc: {
                discId: 'disc-test',
                drive: 'F:',
                titles: [],
              },
            }
          },
          findTitle(titleNumber: number) {
            if (titleNumber !== 1) {
              return undefined
            }

            return {
              id: 'disc-test-title-1',
              titleNumber: 1,
              label: 'Title 1',
              durationSeconds: 120,
              likelyMainFeature: true,
              thumbnailUrl: '/api/discs/current/titles/1/thumbnail.jpg',
              audioTracks: [{ id: 1, label: 'Audio 1' }],
              subtitleTracks: [],
            }
          },
        }),
        vlcWorker: createVlcWorkerStub({
          async generateThumbnail({ outputDir }: { outputDir: string }) {
            const outputPath = join(outputDir, 'thumbnail.jpg')
            await writeFile(outputPath, 'REAL_THUMB', 'utf8')
            return { outputPath }
          },
        }),
      },
    })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/discs/current/titles/1/thumbnail.jpg',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('REAL_THUMB')
      expect(response.headers['content-type']).toContain('image/jpeg')
    } finally {
      await app.close()
    }
  })
})
describe('thumbnail request scheduling', () => {
  it('shares one worker call for overlapping requests for the same title', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-thumb-single-flight-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let workerCalls = 0
    const app = await createThumbnailTestApp(cacheDir, 1, async ({ outputDir }) => {
      workerCalls += 1
      await gate
      const outputPath = join(outputDir, 'thumbnail.jpg')
      await writeFile(outputPath, 'SHARED_THUMB', 'utf8')
      return { outputPath }
    })

    try {
      const url = '/api/discs/current/titles/1/thumbnail.jpg'
      const first = app.inject({ method: 'GET', url })
      const second = app.inject({ method: 'GET', url })
      await vi.waitFor(() => expect(workerCalls).toBe(1))
      expect(workerCalls).toBe(1)
      release()
      const responses = await Promise.all([first, second])
      expect(responses.map((response) => response.body)).toEqual(['SHARED_THUMB', 'SHARED_THUMB'])
      expect(workerCalls).toBe(1)
    } finally {
      release()
      await app.close()
    }
  })

  it('limits concurrent thumbnail workers while serving 50 distinct titles', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-thumb-limit-'))
    const releases: Array<() => void> = []
    let active = 0
    let maximumActive = 0
    let workerCalls = 0
    const app = await createThumbnailTestApp(cacheDir, 50, async ({ outputDir }) => {
      workerCalls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      const outputPath = join(outputDir, 'thumbnail.jpg')
      await writeFile(outputPath, 'THUMB', 'utf8')
      active -= 1
      return { outputPath }
    })

    try {
      const requests = Array.from({ length: 50 }, (_, index) => app.inject({
        method: 'GET',
        url: `/api/discs/current/titles/${index + 1}/thumbnail.jpg`,
      }))
      await vi.waitFor(() => expect(workerCalls).toBe(2))
      expect(active).toBe(2)
      expect(workerCalls).toBe(2)
      while (workerCalls < 50) {
        const nextCount = Math.min(50, workerCalls + 2)
        releases.splice(0, 2).forEach((finish) => finish())
        await vi.waitFor(() => expect(workerCalls).toBe(nextCount))
      }
      releases.splice(0).forEach((finish) => finish())
      const responses = await Promise.all(requests)
      expect(responses).toHaveLength(50)
      expect(responses.every((response) => response.statusCode === 200)).toBe(true)
      expect(maximumActive).toBe(2)
    } finally {
      releases.splice(0).forEach((finish) => finish())
      await app.close()
    }
  })

  it('serves the generated PNG placeholder with a PNG content type after failure', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-thumb-placeholder-'))
    const app = await createThumbnailTestApp(cacheDir, 1, async () => {
      throw new Error('VLC could not read title')
    })

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/discs/current/titles/1/thumbnail.jpg',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('image/png')
    } finally {
      await app.close()
    }
  })

  it('discards a thumbnail job when the catalog changes discs before it completes', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-thumb-disc-swap-'))
    let currentSnapshot = makeSnapshot('disc-a', 1)
    let release!: () => void
    let workerStarted!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { workerStarted = resolve })
    const app = await buildApp({
      config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
      services: {
        catalogService: createCatalogServiceStub({
          getSnapshot: () => currentSnapshot,
          findTitle: (titleNumber) => currentSnapshot.disc?.titles.find((title) => title.titleNumber === titleNumber),
        }),
        vlcWorker: createVlcWorkerStub({
          async generateThumbnail({ outputDir }) {
            workerStarted()
            await gate
            const outputPath = join(outputDir, 'thumbnail.jpg')
            await writeFile(outputPath, 'THUMBNAIL-FROM-OTHER-DISC', 'utf8')
            return { outputPath }
          },
        }),
      },
    })

    try {
      const responsePromise = app.inject({ method: 'GET', url: '/api/discs/current/titles/1/thumbnail.jpg' })
      await started
      currentSnapshot = makeSnapshot('disc-b', 1)
      release()
      const response = await responsePromise
      expect(response.headers['content-type']).toContain('image/png')
      await expect(access(join(cacheDir, 'discs', 'disc-a', 'title-1', 'thumbnail.jpg'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release()
      await app.close()
    }
  })
})

function makeSnapshot(discId: string, titleNumber: number) {
  const title = {
    id: `${discId}-title-${titleNumber}`,
    titleNumber,
    label: `Title ${titleNumber}`,
    durationSeconds: 120,
    likelyMainFeature: true,
    thumbnailUrl: `/api/discs/current/titles/${titleNumber}/thumbnail.jpg`,
    audioTracks: [],
    subtitleTracks: [],
  }
  return {
    state: 'catalog_ready' as const,
    disc: { discId, drive: 'D:', titles: [title] },
  }
}

async function createThumbnailTestApp(
  cacheDir: string,
  titleCount: number,
  generateThumbnail: (input: { outputDir: string }) => Promise<{ outputPath: string }>,
) {
  const titles = Array.from({ length: titleCount }, (_, index) => ({
    id: `disc-schedule-title-${index + 1}`,
    titleNumber: index + 1,
    label: `Title ${index + 1}`,
    durationSeconds: 120,
    likelyMainFeature: index === 0,
    thumbnailUrl: `/api/discs/current/titles/${index + 1}/thumbnail.jpg`,
    audioTracks: [],
    subtitleTracks: [],
  }))
  const snapshot = {
    state: 'catalog_ready' as const,
    disc: { discId: 'disc-schedule', drive: 'D:', titles },
  }
  return buildApp({
    config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
    services: {
      catalogService: createCatalogServiceStub({
        getSnapshot: () => snapshot,
        findTitle: (titleNumber) => titles.find((title) => title.titleNumber === titleNumber),
      }),
      vlcWorker: createVlcWorkerStub({ generateThumbnail }),
    },
  })
}
