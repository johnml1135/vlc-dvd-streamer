import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeHlsTransportStream } from '../vlc/transport-stream.js'
import { appendManifestQuery, rewriteSessionManifest } from '../media/hls-manifest.js'
import {
  buildRegionManifest, buildStitchedManifest, createInitialTimelineRuntime,
  getCurrentRange, isTimeInRange, nextExpectedSlot, normalizeSeekPosition,
  publishSlot, setRegionStart, slotForTime, toTimelineSnapshot,
} from './timeline.js'

export interface PublicationEpoch { readonly id: number; readonly outputDir: string; readonly baseUrl: string }
export interface PublicationProgress { segmentNames: string[]; lastSegmentName: string; lastSegmentNumber: number }
export interface PublishedAsset { content: string | Buffer; kind: 'playlist' | 'segment'; slotNumber?: number }
export interface AssetOptions { generation?: string; region?: string; revision?: string; videoOnly?: boolean }
interface PublicationOptions {
  outputDir: string
  baseUrl: string
  durationSeconds?: number
  segmentDurationSeconds: number
  writePlaceholderSegment?: (path: string, slot: number) => Promise<void>
  warn?: (message: string) => void
}
interface PublishedFile { path: string; slot: number }

/** Owns the relationship between title slots and downloadable immutable bytes. */
export class HlsPublication {
  private readonly timeline
  private readonly files = new Map<string, PublishedFile>()
  private epoch: PublicationEpoch | undefined
  private nextEpoch = 0
  private region = 0
  private revision = 0
  private readonly slotRevisions = new Map<number, number>()
  private readonly retiredRegions = new Map<number, { startSlot: number; revision: number }>()
  private closed = false
  private readonly seen = new Set<string>()
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: PublicationOptions) {
    this.timeline = createInitialTimelineRuntime(options.durationSeconds, options.segmentDurationSeconds)
  }

  get manifestUrl(): string { return `${this.options.baseUrl}index.m3u8?region=${this.region}` }
  get currentRegion(): string { return String(this.region) }
  isCurrentRegion(region?: string): boolean { return region === this.currentRegion }
  get currentRange() { return getCurrentRange(this.timeline) }
  get nextSlot(): number { return nextExpectedSlot(this.timeline) }
  get durationSeconds(): number | undefined { return this.options.durationSeconds }
  normalizeSeek(seconds: number): number | null {
    return normalizeSeekPosition(seconds, this.options.durationSeconds, this.options.segmentDurationSeconds)
  }
  contains(seconds: number): boolean { return isTimeInRange(seconds, this.currentRange) }
  snapshot() {
    return { ...toTimelineSnapshot(this.timeline, this.options.baseUrl, this.options.segmentDurationSeconds),
      stitchedManifestUrl: `${this.options.baseUrl}stitched.m3u8?revision=${this.revision}` }
  }
  regionManifest(region = this.region): string {
    const archived = this.retiredRegions.get(region)
    const timeline = archived ? { ...this.atRevision(archived.revision), regionStartSlot: archived.startSlot } : this.timeline
    const manifest = appendManifestQuery(
      buildRegionManifest(timeline, this.options.segmentDurationSeconds).replace('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-PLAYLIST-TYPE:EVENT'),
      'region',
      String(region),
    )
    return archived && !manifest.includes('#EXT-X-ENDLIST') ? `${manifest}#EXT-X-ENDLIST\n` : manifest
  }
  stitchedManifest(revision = this.revision): string {
    const manifest = buildStitchedManifest(this.atRevision(revision), this.options.segmentDurationSeconds)
    return manifest.includes('#EXT-X-ENDLIST') ? manifest : `${manifest}#EXT-X-ENDLIST\n`
  }

  private atRevision(revision: number) {
    return { ...this.timeline, slots: new Map([...this.timeline.slots].filter(([slot]) => (this.slotRevisions.get(slot) ?? Infinity) <= revision)) }
  }

  seekTo(seconds: number): void {
    this.retiredRegions.set(this.region, { startSlot: this.timeline.regionStartSlot, revision: this.revision })
    this.region += 1
    setRegionStart(this.timeline, slotForTime(seconds, this.options.segmentDurationSeconds))
    this.timeline.lastSeekSeconds = seconds
    this.timeline.status = 'seeking'
    this.timeline.message = `Seeking to ${seconds} seconds.`
  }

  finishSeek(message: string, seconds?: number): void {
    this.timeline.status = 'idle'
    this.timeline.message = message
    if (seconds !== undefined) this.timeline.lastSeekSeconds = seconds
  }

  beginEpoch(): Promise<PublicationEpoch> { return this.mutate(() => this.beginEpochOwned()) }

  private async beginEpochOwned(): Promise<PublicationEpoch> {
    if (this.closed) throw new Error('HLS publication is retired.')
    const id = this.nextEpoch++
    const epoch = { id, outputDir: join(this.options.outputDir, 'raw', String(id)), baseUrl: this.options.baseUrl }
    await mkdir(epoch.outputDir, { recursive: true })
    this.epoch = epoch
    this.seen.clear()
    return epoch
  }

  observe(epoch: PublicationEpoch, manifestPath = join(epoch.outputDir, 'index.m3u8')): Promise<PublicationProgress | null> {
    return this.mutate(() => this.observeOwned(epoch, manifestPath))
  }

  private async observeOwned(epoch: PublicationEpoch, manifestPath: string): Promise<PublicationProgress | null> {
    if (this.closed || this.epoch !== epoch) return null
    let manifest: string
    try {
      manifest = await readFile(manifestPath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
    let segments = parsePlaylist(manifest)
    // A VLC run started with --start-time first emits a near-empty, audio-only
    // stub segment (pre-seek residue) under the initial segment number. Serving
    // it makes MSE players initialise without a video track (bufferAppendError)
    // and shifts every real segment one slot late. Drop it and renumber the
    // rest. VLC lists every segment (numsegs=0), so the stub is always first.
    const first = segments[0]
    if (first && first.duration < SEEK_STUB_MAX_SECONDS) {
      if (segments.length === 1) return null
      segments = segments.slice(1).map(segment => ({ ...segment, slot: segment.slot - 1 }))
    }
    const names: string[] = []
    let previousSlot: number | undefined
    for (const segment of segments) {
      if (this.closed || this.epoch !== epoch) return null
      if (previousSlot !== undefined && segment.slot !== previousSlot + 1) break
      // EVENT target duration cannot change after publication. VLC's fixed GOP
      // promises this bound; leave violations unpublished for normal recovery.
      if (Math.round(segment.duration) > Math.ceil(this.options.segmentDurationSeconds)) break
      // An EVENT region must remain append-only. Previously published slots keep
      // their original bytes and discontinuity group throughout the session.
      if (!this.seen.has(segment.name)) {
        let bytes: Buffer
        try {
          bytes = await readFile(join(epoch.outputDir, segment.name))
        } catch (error) {
          if (isMissingFileError(error)) break
          throw error
        }
        if (!looksLikeTransportStream(bytes)) break
        if (!this.timeline.slots.has(segment.slot)) {
          const committed = await this.publish(segment.slot, String(epoch.id), bytes, 'generated', epoch.id, segment.duration)
          if (!committed) return null
        }
        this.seen.add(segment.name)
      }
      names.push(segment.name)
      previousSlot = segment.slot
    }
    const lastSegmentName = names.at(-1)
    if (!lastSegmentName || previousSlot === undefined) return null
    return { segmentNames: names, lastSegmentName, lastSegmentNumber: previousSlot }
  }

  publishPlaceholder(slot: number, shouldCommit?: () => boolean): Promise<boolean> {
    return this.mutate(() => this.publishPlaceholderOwned(slot, shouldCommit))
  }

  private async publishPlaceholderOwned(slot: number, shouldCommit?: () => boolean): Promise<boolean> {
    if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('Invalid playback slot.')
    if (this.closed || this.timeline.slots.has(slot)) return false
    if (shouldCommit && !shouldCommit()) return false
    const stagingDir = join(this.options.outputDir, 'staging')
    await mkdir(stagingDir, { recursive: true })
    const stagingPath = join(stagingDir, `${randomUUID()}.ts`)
    try {
      let bytes: Buffer | undefined
      if (this.options.writePlaceholderSegment) {
        try {
          await this.options.writePlaceholderSegment(stagingPath, slot)
          const candidate = await readFile(stagingPath)
          if (looksLikeTransportStream(candidate)) bytes = candidate
        } catch (error) {
          this.options.warn?.(`Custom bad-sector placeholder failed for slot ${slot}: ${String(error)}`)
        }
      }
      if (!bytes) {
        try {
          const candidate = await readFile(join(this.options.outputDir, 'placeholder.ts'))
          if (looksLikeTransportStream(candidate)) bytes = candidate
        } catch { /* Rendered placeholder is optional. */ }
      }
      bytes ??= nullPacket()
      // Remove the render staging file before the publication commit fence. If
      // cleanup fails, no slot is advertised and the caller receives that
      // failure while it can still safely retry the operation.
      await rm(stagingPath, { force: true })
      return await this.publish(slot, 'placeholder', bytes, 'bad', -1, this.options.segmentDurationSeconds, shouldCommit)
    } catch (error) {
      // Cleanup is best effort after an earlier failure. In particular, do not
      // replace the original render or publication error with cleanup noise.
      await rm(stagingPath, { force: true }).catch(() => {})
      throw error
    }
  }

  private async publish(
    slot: number,
    generation: string,
    bytes: Buffer,
    source: 'generated' | 'bad',
    group: number,
    duration: number,
    shouldCommit?: () => boolean,
  ): Promise<boolean> {
    const directory = join(this.options.outputDir, 'published', generation)
    await mkdir(directory, { recursive: true })
    const name = segmentName(slot)
    const path = join(directory, name)
    const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
    // This is the commit fence. All staging, byte validation and rename work is
    // complete, so cancellation can never leave an advertised partial asset.
    if (this.closed || this.timeline.slots.has(slot) || (shouldCommit && !shouldCommit())) return false
    const assetUri = `${name}?generation=${generation}`
    this.files.set(assetUri, { path, slot })
    publishSlot(this.timeline, slot, { source, group, assetUri, durationSeconds: duration })
    this.slotRevisions.set(slot, ++this.revision)
    return true
  }

  async readAsset(name: string, options: AssetOptions = {}): Promise<PublishedAsset | null> {
    if (this.closed) return null
    if (name === 'index.m3u8' || name === 'stitched.m3u8') {
      const region = options.region === undefined ? this.region : parseCanonicalRegion(options.region)
      const revision = options.revision === undefined ? this.revision : Number(options.revision)
      if (region === null || !Number.isSafeInteger(region) || region < 0 || region > this.region || !Number.isSafeInteger(revision) || revision < 0 || revision > this.revision) return null
      const manifest = name === 'index.m3u8' ? this.regionManifest(region) : this.stitchedManifest(revision)
      return { content: rewriteSessionManifest(manifest, { queryFlag: options.videoOnly ? 'videoOnly' : undefined }), kind: 'playlist' }
    }
    const file = this.files.get(`${name}?generation=${options.generation}`)
    if (!file) return null
    try {
      const bytes = await readFile(file.path)
      if (this.closed) return null
      return { content: normalizeHlsTransportStream(bytes, { includeAudio: !options.videoOnly }), kind: 'segment', slotNumber: file.slot }
    } catch { return null }
  }

  retire(): void { this.closed = true }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation)
    this.mutations = result.catch(() => {})
    return result
  }
}

const SEEK_STUB_MAX_SECONDS = 0.5

function segmentName(slot: number): string { return `segment-${String(slot).padStart(6, '0')}.ts` }
function segmentSlot(name: string): number | null {
  const match = /^segment-(\d+)\.ts$/.exec(name)
  const slot = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(slot) && slot >= 1 ? slot : null
}
function looksLikeTransportStream(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x47
}
function nullPacket(): Buffer {
  const bytes = Buffer.alloc(188, 0xff)
  bytes.set([0x47, 0x1f, 0xff, 0x10])
  return bytes
}
function parsePlaylist(text: string) {
  if (!text.trimStart().startsWith('#EXTM3U')) return []
  const segments: Array<{ name: string; slot: number; duration: number }> = []
  let duration: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      const parsed = Number(line.slice(8).split(',')[0])
      duration = Number.isFinite(parsed) && parsed > 0 ? parsed : null
    } else if (line && !line.startsWith('#')) {
      // VLC's index-url is either an absolute app path or a bare segment name.
      const name = line.split('?')[0]?.split('/').at(-1) ?? ''
      const slot = segmentSlot(name)
      if (slot === null || duration === null) return []
      segments.push({ name, slot, duration })
      duration = null
    }
  }
  return segments
}

function parseCanonicalRegion(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
