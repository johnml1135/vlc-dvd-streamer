import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VlcWorker } from '../vlc/worker.js'
import type { CatalogProgress, CatalogSnapshot, DiscSummary, DiscTitle, RawDiscScan } from './types.js'
import type { ServerLog } from '../logging/server-log.js'
import { DRIVE_BUSY_MESSAGE, isDriveBusyMessage } from './drive-errors.js'

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

  async isDiscCurrent(discId: string): Promise<boolean> {
    if (this.snapshot.disc?.discId !== discId) return false

    const identifyDisc = (this.options.worker as VlcWorker & { identifyDisc?: (drive?: string) => Promise<string> }).identifyDisc
    if (!identifyDisc) return true
    try {
      return await identifyDisc.call(this.options.worker, this.options.drive) === discId
    } catch {
      return false
    }
  }

  startRefresh(): void {
    void this.refresh()
  }

  async refresh(input: { force?: boolean } = {}): Promise<CatalogSnapshot> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.runRefresh(input.force === true)
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async runRefresh(force: boolean): Promise<CatalogSnapshot> {
    this.options.logger?.info('catalog', `Refreshing DVD catalog for ${this.options.drive}.`)

    try {
      if (!force) {
        const discId = await this.identifyCurrentDisc()
        if (discId) {
          const cachedDisc = await this.readCachedDisc(discId)
          if (cachedDisc) {
            this.setSnapshot({ state: 'catalog_ready', disc: cachedDisc })
            this.options.logger?.info('catalog', `Reused saved catalog for ${discId}.`)
            return this.snapshot
          }
        }
      }

      this.setSnapshot({ state: 'disc_detected', disc: null, progress: undefined })
      this.setSnapshot({
        state: 'catalog_loading',
        disc: null,
        progress: { scannedTitles: 0, totalTitles: null, currentTitleNumber: null },
      })

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
      await this.writeCachedDisc(disc)

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

  private async identifyCurrentDisc(): Promise<string | null> {
    const identifyDisc = (this.options.worker as VlcWorker & { identifyDisc?: (drive?: string) => Promise<string> }).identifyDisc
    if (!identifyDisc) return null

    try {
      return await identifyDisc.call(this.options.worker, this.options.drive)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isDriveBusyMessage(message)) throw new Error(DRIVE_BUSY_MESSAGE, { cause: error })
      this.options.logger?.warn('catalog', `Could not fingerprint ${this.options.drive} before refresh; running a full scan: ${message}`)
      return null
    }
  }

  private async readCachedDisc(discId: string): Promise<DiscSummary | null> {
    const cachePath = join(this.options.cacheDir, 'discs', discId, 'catalog.json')
    try {
      const value: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
      if (!isCachedDiscSummary(value, discId)) return null
      return { ...value, drive: this.options.drive }
    } catch {
      return null
    }
  }

  private async writeCachedDisc(disc: DiscSummary): Promise<void> {
    const cachePath = join(this.options.cacheDir, 'discs', disc.discId, 'catalog.json')
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(disc), 'utf8')
      await rename(temporaryPath, cachePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      this.options.logger?.warn('catalog', `Could not save catalog for ${disc.discId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function isCachedDiscSummary(value: unknown, discId: string): value is DiscSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<DiscSummary>
  return candidate.discId === discId
    && typeof candidate.drive === 'string'
    && Array.isArray(candidate.titles)
    && candidate.titles.every((title) => title !== null && typeof title === 'object'
      && typeof title.id === 'string'
      && Number.isInteger(title.titleNumber)
      && typeof title.durationSeconds === 'number'
      && typeof title.thumbnailUrl === 'string'
      && Array.isArray(title.audioTracks)
      && Array.isArray(title.subtitleTracks))
}
