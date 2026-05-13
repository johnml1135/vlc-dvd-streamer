import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CatalogService } from '../../src/disc/catalog-service.js'
import { VlcWorker } from '../../src/vlc/worker.js'

describe('CatalogService damaged disc handling', () => {
  it('surfaces a catalog error when VLC cannot scan a scratched disc', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-damaged-catalog-'))
    const worker = new VlcWorker({
      executable: process.execPath,
      shimScript: 'test/fixtures/fake-vlc.ts',
      shimEnv: { FAKE_VLC_PROFILE: 'scratched-scan' },
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

    expect(snapshot.state).toBe('catalog_error')
    expect(snapshot.error?.detail).toMatch(/scratched|read error/i)
  })
})
