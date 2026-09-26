import { access, mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

  it('reuses a saved catalog by disc identity and forces a rescan on request', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-catalog-cache-'))
    const identity = 'disc-known-identity'
    const scanDisc = vi.fn(async ({ drive }: { drive?: string }) => ({
      discId: identity,
      drive: drive ?? 'D:',
      titles: [{
        titleNumber: 1,
        durationSeconds: scanDisc.mock.calls.length === 1 ? 600 : 720,
        audioTracks: [],
        subtitleTracks: [],
      }],
    }))
    const worker = {
      identifyDisc: vi.fn(async () => identity),
      scanDisc,
    }
    const createService = (drive: string) => new CatalogService({
      cacheDir,
      drive,
      minVisibleTitleDurationSeconds: 300,
      worker: worker as never,
    })

    const first = await createService('D:').refresh()
    const thumbnailPath = join(cacheDir, 'discs', identity, 'title-1', 'thumbnail.jpg')
    await mkdir(join(cacheDir, 'discs', identity, 'title-1'), { recursive: true })
    await writeFile(thumbnailPath, 'saved thumbnail')

    const reinserted = await createService('E:').refresh()
    expect(scanDisc).toHaveBeenCalledTimes(1)
    expect(reinserted.disc?.drive).toBe('E:')
    expect(reinserted.disc?.titles).toEqual(first.disc?.titles)
    await expect(readFile(thumbnailPath, 'utf8')).resolves.toBe('saved thumbnail')

    const refreshed = await createService('E:').refresh({ force: true })
    expect(scanDisc).toHaveBeenCalledTimes(2)
    expect(refreshed.disc?.titles[0]?.durationSeconds).toBe(720)
    await expect(access(thumbnailPath)).resolves.toBeUndefined()
  })
})
