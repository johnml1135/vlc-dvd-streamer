import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/disc/catalog-service.js'
import { VlcWorker } from '../../src/vlc/worker.js'

describe('CatalogService', () => {
  it('refreshes disc metadata through the VLC worker and hides short extras by default', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-catalog-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      drive: 'D:',
      timeoutMs: 5000,
    })
    const service = new CatalogService({
      cacheDir,
      drive: 'D:',
      minVisibleTitleDurationSeconds: 300,
      worker,
    })

    const snapshot = await service.refresh()
    const visibleTitles = service.listTitles({ includeShort: false })
    const allTitles = service.listTitles({ includeShort: true })

    expect(snapshot.state).toBe('catalog_ready')
    expect(snapshot.disc?.discId).toBe('fake-disc-001')
    expect(visibleTitles).toHaveLength(2)
    expect(allTitles).toHaveLength(3)
    expect(visibleTitles.find((title) => title.likelyMainFeature)?.titleNumber).toBe(1)
    expect(allTitles[0]?.thumbnailUrl).toContain('/api/discs/current/titles/1/thumbnail.jpg')
  })
})