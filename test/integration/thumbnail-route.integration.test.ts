import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    } finally {
      await app.close()
    }
  })
})