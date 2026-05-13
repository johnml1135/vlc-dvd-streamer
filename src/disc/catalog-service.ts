import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VlcWorker } from '../vlc/worker.js'
import type { CatalogSnapshot, DiscSummary, DiscTitle, RawDiscScan } from './types.js'

export interface CatalogServiceOptions {
  cacheDir: string
  drive: string
  minVisibleTitleDurationSeconds: number
  worker: VlcWorker
}

export class CatalogService {
  private readonly options: CatalogServiceOptions
  private snapshot: CatalogSnapshot = {
    state: 'empty',
    disc: null,
  }

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

  async refresh(): Promise<CatalogSnapshot> {
    this.snapshot = {
      state: 'disc_detected',
      disc: null,
    }

    this.snapshot = {
      state: 'catalog_loading',
      disc: null,
    }

    try {
      const scan = await this.options.worker.scanDisc({ drive: this.options.drive })
      const disc = await this.normalizeScan(scan)

      this.snapshot = {
        state: 'catalog_ready',
        disc,
      }
    } catch (error) {
      this.snapshot = {
        state: 'catalog_error',
        disc: null,
        error: {
          message: 'Could not read DVD titles.',
          detail: error instanceof Error ? error.message : 'Unknown catalog error.',
        },
      }
    }

    return this.snapshot
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
        audioTracks: title.audioTracks.length > 0
          ? title.audioTracks
          : [{ id: 1, label: 'Audio 1' }],
        subtitleTracks: title.subtitleTracks,
      }))

    return {
      discId: scan.discId,
      drive: scan.drive,
      titles,
    }
  }
}