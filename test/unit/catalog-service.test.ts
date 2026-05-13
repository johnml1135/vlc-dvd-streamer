import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/disc/catalog-service.js'
import type { RawDiscScan } from '../../src/disc/types.js'

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
})