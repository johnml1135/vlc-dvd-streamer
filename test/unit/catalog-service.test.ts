import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/disc/catalog-service.js'
import type { CatalogSnapshot, RawDiscScan } from '../../src/disc/types.js'

describe('CatalogService', () => {
  it('preserves an empty audio track list so the UI can fall back to automatic selection', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-catalog-unit-'))
    const scan: RawDiscScan = {
      discId: 'disc-123',
      drive: 'D:',
      titles: [
        {
          titleNumber: 1,
          durationSeconds: 7212,
          audioTracks: [],
          subtitleTracks: [],
        },
      ],
    }

    const service = new CatalogService({
      cacheDir,
      drive: 'D:',
      minVisibleTitleDurationSeconds: 300,
      worker: {
        scanDisc: async () => scan,
      } as never,
    })

    const snapshot = await service.refresh()

    expect(snapshot.state).toBe('catalog_ready')
    expect(snapshot.disc?.titles[0]?.audioTracks).toEqual([])
  })

  it('publishes scan progress snapshots while titles are still being probed', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-catalog-progress-'))
    const scan: RawDiscScan = {
      discId: 'disc-123',
      drive: 'D:',
      titles: [
        {
          titleNumber: 1,
          durationSeconds: 7212,
          audioTracks: [],
          subtitleTracks: [],
        },
      ],
    }
    const snapshots: CatalogSnapshot[] = []

    const service = new CatalogService({
      cacheDir,
      drive: 'D:',
      minVisibleTitleDurationSeconds: 300,
      onSnapshot: (snapshot) => {
        snapshots.push(JSON.parse(JSON.stringify(snapshot)) as CatalogSnapshot)
      },
      worker: {
        scanDisc: async ({ onProgress }: { onProgress?: (progress: { scannedTitles: number; totalTitles: number; currentTitleNumber: number | null }) => void }) => {
          onProgress?.({
            scannedTitles: 1,
            totalTitles: 4,
            currentTitleNumber: 2,
          })
          return scan
        },
      } as never,
    })

    await service.refresh()

    expect(snapshots).toContainEqual(expect.objectContaining({
      state: 'catalog_loading',
      progress: {
        scannedTitles: 1,
        totalTitles: 4,
        currentTitleNumber: 2,
      },
    }))
  })
})