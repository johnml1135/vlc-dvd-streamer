import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VlcWorker } from '../vlc/worker.js'
import type { CatalogProgress, CatalogSnapshot, DiscSummary, DiscTitle, RawDiscScan } from './types.js'
import type { ServerLog } from '../logging/server-log.js'

export interface CatalogServiceOptions {
  cacheDir: string
  drive: string
  minVisibleTitleDurationSeconds: number
  worker: VlcWorker
  logger?: ServerLog
  onSnapshot?: (snapshot: CatalogSnapshot) => void
}

export class CatalogService {
  private readonly options: CatalogServiceOptions
  private snapshot: CatalogSnapshot = {
    state: 'empty',
    disc: null,
  }
  private refreshPromise: Promise<CatalogSnapshot> | null = null

  constructor(options: CatalogServiceOptions) {
    this.options = options
  }

  getSnapshot(): CatalogSnapshot {
    return this.snapshot
  }

  listTitles(input: { includeShort: boolean }): DiscTitle[] {
    const titles = this.snapshot.disc?.titles ?? []

    if (input.includeShort || titles.length === 0) {
      return titles
    }

    const visible = titles.filter((title) => title.durationSeconds >= this.options.minVisibleTitleDurationSeconds)
    return visible.length > 0 ? visible : titles
  }

  findTitle(titleNumber: number): DiscTitle | undefined {
    return this.snapshot.disc?.titles.find((title) => title.titleNumber === titleNumber)
  }

  startRefresh(): void {
    void this.refresh()
  }

  async refresh(): Promise<CatalogSnapshot> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.runRefresh()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async runRefresh(): Promise<CatalogSnapshot> {
    this.options.logger?.info('catalog', `Refreshing DVD catalog for ${this.options.drive}.`)
    this.setSnapshot({
      state: 'disc_detected',
      disc: null,
      progress: undefined,
    })

    this.setSnapshot({
      state: 'catalog_loading',
      disc: null,
      progress: {
        scannedTitles: 0,
        totalTitles: null,
        currentTitleNumber: null,
      },
    })

    try {
      const scan = await this.options.worker.scanDisc({
        drive: this.options.drive,
        onProgress: (progress) => {
          this.setSnapshot({
            state: 'catalog_loading',
            disc: null,
            progress,
          })
        },
      })
      const disc = await this.normalizeScan(scan)

      this.setSnapshot({
        state: 'catalog_ready',
        disc,
        progress: undefined,
      })
      this.options.logger?.info('catalog', `Catalog ready for ${disc.discId} with ${disc.titles.length} titles.`)
    } catch (error) {
      this.setSnapshot({
        state: 'catalog_error',
        disc: null,
        progress: undefined,
        error: {
          message: 'Could not read DVD titles.',
          detail: error instanceof Error ? error.message : 'Unknown catalog error.',
        },
      })
      this.options.logger?.error('catalog', this.snapshot.error?.detail ?? 'The VLC worker could not build a title catalog.')
    }

    return this.snapshot
  }

  private setSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
    this.snapshot = snapshot
    this.options.onSnapshot?.(snapshot)
    return snapshot
  }

  private async normalizeScan(scan: RawDiscScan): Promise<DiscSummary> {
    const discCacheDir = join(this.options.cacheDir, 'discs', scan.discId)
    await mkdir(discCacheDir, { recursive: true })

    const longestDuration = Math.max(...scan.titles.map((title) => title.durationSeconds))
    const titles = scan.titles
      .slice()
      .sort((left, right) => left.titleNumber - right.titleNumber)
      .map<DiscTitle>((title) => ({
        id: `${scan.discId}-title-${title.titleNumber}`,
        titleNumber: title.titleNumber,
        label: `Title ${title.titleNumber}`,
        durationSeconds: title.durationSeconds,
        likelyMainFeature: title.durationSeconds === longestDuration,
        thumbnailUrl: `/api/discs/current/titles/${title.titleNumber}/thumbnail.jpg`,
        audioTracks: title.audioTracks,
        subtitleTracks: title.subtitleTracks,
      }))

    return {
      discId: scan.discId,
      drive: scan.drive,
      titles,
    }
  }
}