import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reads DVD title metadata straight from the unencrypted IFO files in a
 * VIDEO_TS directory (no playback, no CSS), so a full catalog scan takes
 * milliseconds instead of one VLC disc-open per title.
 *
 * Offsets and structures mirror libdvdread (the library VLC/mpv/HandBrake/lsdvd
 * all use) — see src/dvdread/ifo_types.h:
 *  - VIDEO_TS.IFO (VMGI) holds the title table (TT_SRPT @ VMGI+0xC4): every
 *    playable title and which VTS + title-within-VTS it maps to.
 *  - VTS_nn_0.IFO (VTSI) holds the chapter→PGC map (VTS_PTT_SRPT @ VTSI+0xC8),
 *    the PGC table (VTS_PGCIT @ VTSI+0xCC) where each PGC carries its playback
 *    time, and the audio/subpicture stream attributes (counts @ 0x203/0x255).
 */

const SECTOR_BYTES = 2048

export interface IfoTrack {
  id: number
  label: string
}

export interface IfoTitle {
  titleNumber: number
  durationSeconds: number
  angleCount: number
  chapterCount: number
  audioTracks: IfoTrack[]
  subtitleTracks: IfoTrack[]
}

interface TitleSearchEntry {
  titleNumber: number
  vtsNumber: number
  vtsTitleNumber: number
  angleCount: number
  chapterCount: number
}

interface VtsInfo {
  vtsi: Buffer
  /** Absolute byte offset of each VTS-title's PTT (chapter) array. */
  pttArrayOffsetByVtsTitle: Map<number, number>
  durationByPgc: Map<number, number>
  audioTracks: IfoTrack[]
  subtitleTracks: IfoTrack[]
}

export interface IfoReadResult {
  titles: IfoTitle[]
  expectedTitleCount: number
  skippedTitleNumbers: number[]
}

export async function readDvdTitlesFromIfo(videoTsDir: string): Promise<IfoTitle[]> {
  return (await readDvdTitlesFromIfoDetailed(videoTsDir)).titles
}

export async function readDvdTitlesFromIfoDetailed(videoTsDir: string): Promise<IfoReadResult> {
  const vmgi = await readFile(join(videoTsDir, 'VIDEO_TS.IFO'))
  if (!hasIfoSignature(vmgi, 'DVDVIDEO-VMG')) {
    throw new Error('VIDEO_TS.IFO is not a valid DVD video manager (VMGI) file.')
  }

  const { entries: titleEntries, expectedTitleCount } = parseTitleSearchPointerTable(vmgi)
  if (expectedTitleCount === 0) {
    throw new Error('The DVD title table (TT_SRPT) listed no playable titles.')
  }

  const vtsCache = new Map<number, VtsInfo | null>()
  const titles: IfoTitle[] = []

  for (const entry of titleEntries) {
    const vts = await loadVtsInfo(videoTsDir, entry.vtsNumber, vtsCache)
    if (!vts) {
      continue
    }

    const durationSeconds = titleDurationSeconds(vts, entry.vtsTitleNumber, entry.chapterCount)
    if (durationSeconds <= 0) {
      continue
    }

    titles.push({
      titleNumber: entry.titleNumber,
      durationSeconds,
      angleCount: entry.angleCount,
      chapterCount: entry.chapterCount,
      audioTracks: vts.audioTracks,
      subtitleTracks: vts.subtitleTracks,
    })
  }

  const decodedTitleNumbers = new Set(titles.map((title) => title.titleNumber))
  const skippedTitleNumbers = Array.from({ length: expectedTitleCount }, (_, index) => index + 1)
    .filter((titleNumber) => !decodedTitleNumbers.has(titleNumber))

  return { titles, expectedTitleCount, skippedTitleNumbers }
}
function parseTitleSearchPointerTable(vmgi: Buffer): { entries: TitleSearchEntry[]; expectedTitleCount: number } {
  const base = vmgi.readUInt32BE(0xc4) * SECTOR_BYTES
  if (base + 8 > vmgi.length) {
    throw new Error('TT_SRPT sector pointer is outside the VMGI file.')
  }

  const expectedTitleCount = vmgi.readUInt16BE(base)
  const entries: TitleSearchEntry[] = []

  for (let index = 0; index < expectedTitleCount; index += 1) {
    const entryStart = base + 8 + index * 12
    if (entryStart + 12 > vmgi.length) {
      break
    }

    entries.push({
      titleNumber: index + 1,
      angleCount: vmgi.readUInt8(entryStart + 1),
      chapterCount: vmgi.readUInt16BE(entryStart + 2),
      vtsNumber: vmgi.readUInt8(entryStart + 6),
      vtsTitleNumber: vmgi.readUInt8(entryStart + 7),
    })
  }

  return { entries, expectedTitleCount }
}
async function loadVtsInfo(videoTsDir: string, vtsNumber: number, cache: Map<number, VtsInfo | null>): Promise<VtsInfo | null> {
  if (cache.has(vtsNumber)) {
    return cache.get(vtsNumber) ?? null
  }

  const info = await readVtsInfo(videoTsDir, vtsNumber)
  cache.set(vtsNumber, info)
  return info
}

async function readVtsInfo(videoTsDir: string, vtsNumber: number): Promise<VtsInfo | null> {
  const fileName = `VTS_${String(vtsNumber).padStart(2, '0')}_0.IFO`
  let vtsi: Buffer
  try {
    vtsi = await readFile(join(videoTsDir, fileName))
  } catch {
    return null
  }

  if (!hasIfoSignature(vtsi, 'DVDVIDEO-VTS')) {
    return null
  }

  try {
    return {
      vtsi,
      pttArrayOffsetByVtsTitle: parseVtsPttSrpt(vtsi),
      durationByPgc: parsePgcDurations(vtsi),
      audioTracks: parseAudioAttributes(vtsi),
      subtitleTracks: parseSubpictureAttributes(vtsi),
    }
  } catch {
    // Malformed VTS table — let the scanner fall back to the VLC probe path.
    return null
  }
}

/**
 * Title duration = sum of the distinct PGCs that play the title's chapters.
 * For the common single-PGC title this is just that one PGC's playback time;
 * for multi/random-PGC titles it correctly sums each distinct PGC once.
 */
function titleDurationSeconds(vts: VtsInfo, vtsTitleNumber: number, chapterCount: number): number {
  const arrayOffset = vts.pttArrayOffsetByVtsTitle.get(vtsTitleNumber)
  if (arrayOffset === undefined) {
    return 0
  }

  const distinctPgcns = new Set<number>()
  for (let chapter = 0; chapter < Math.max(1, chapterCount); chapter += 1) {
    const entryOffset = arrayOffset + chapter * 4
    if (entryOffset + 2 > vts.vtsi.length) {
      break
    }

    const pgcn = vts.vtsi.readUInt16BE(entryOffset)
    if (pgcn > 0) {
      distinctPgcns.add(pgcn)
    }
  }

  let totalSeconds = 0
  for (const pgcn of distinctPgcns) {
    totalSeconds += vts.durationByPgc.get(pgcn) ?? 0
  }

  return totalSeconds
}

/** VTS_PTT_SRPT: per VTS-title offset to its chapter (PTT) array. */
function parseVtsPttSrpt(vtsi: Buffer): Map<number, number> {
  const base = vtsi.readUInt32BE(0xc8) * SECTOR_BYTES
  if (base + 8 > vtsi.length) {
    return new Map()
  }

  const titleCount = vtsi.readUInt16BE(base)
  const offsetByVtsTitle = new Map<number, number>()

  for (let vtsTitle = 1; vtsTitle <= titleCount; vtsTitle += 1) {
    const offsetPointer = base + 8 + (vtsTitle - 1) * 4
    if (offsetPointer + 4 > vtsi.length) {
      break
    }

    const arrayOffset = base + vtsi.readUInt32BE(offsetPointer)
    if (arrayOffset + 2 <= vtsi.length) {
      offsetByVtsTitle.set(vtsTitle, arrayOffset)
    }
  }

  return offsetByVtsTitle
}

/** VTS_PGCIT: each PGC carries its total playback time (a BCD dvd_time_t at PGC+4). */
function parsePgcDurations(vtsi: Buffer): Map<number, number> {
  const base = vtsi.readUInt32BE(0xcc) * SECTOR_BYTES
  if (base + 8 > vtsi.length) {
    return new Map()
  }

  const pgcCount = vtsi.readUInt16BE(base)
  const durationByPgc = new Map<number, number>()

  for (let pgcn = 1; pgcn <= pgcCount; pgcn += 1) {
    const srpStart = base + 8 + (pgcn - 1) * 8
    if (srpStart + 8 > vtsi.length) {
      break
    }

    const pgcStart = base + vtsi.readUInt32BE(srpStart + 4)
    if (pgcStart + 8 > vtsi.length) {
      continue
    }

    durationByPgc.set(pgcn, dvdTimeToSeconds(vtsi, pgcStart + 4))
  }

  return durationByPgc
}

// Stream-count fields are single bytes (nr_of_vts_audio_streams @0x0203,
// nr_of_vts_subp_streams @0x0255); the byte before each is zero.
function parseAudioAttributes(vtsi: Buffer): IfoTrack[] {
  const count = Math.min(vtsi.readUInt8(0x0203), 8)
  const slots: TrackSlot[] = []

  for (let index = 0; index < count; index += 1) {
    const attr = 0x0204 + index * 8
    if (attr + 4 > vtsi.length) {
      break
    }

    const codingByte = vtsi.readUInt8(attr)
    const languageType = (codingByte >> 2) & 0x03
    slots.push({
      codingByte,
      language: languageType === 1 ? readLanguageCode(vtsi, attr + 2) : null,
    })
  }

  return buildTracks('Audio', slots)
}

function parseSubpictureAttributes(vtsi: Buffer): IfoTrack[] {
  const count = Math.min(vtsi.readUInt8(0x0255), 32)
  const slots: TrackSlot[] = []

  for (let index = 0; index < count; index += 1) {
    const attr = 0x0256 + index * 6
    if (attr + 4 > vtsi.length) {
      break
    }

    const codingByte = vtsi.readUInt8(attr)
    const languageType = codingByte & 0x03
    slots.push({
      codingByte,
      language: languageType === 1 ? readLanguageCode(vtsi, attr + 2) : null,
    })
  }

  return buildTracks('Subtitle', slots)
}

interface TrackSlot {
  codingByte: number
  language: string | null
}

/**
 * Studio discs reserve up to the maximum number of stream slots and leave the
 * unused ones zeroed. Drop those empty placeholders, keep stable 0-based ids
 * for the real streams, and disambiguate repeated language labels.
 */
function buildTracks(kind: 'Audio' | 'Subtitle', slots: TrackSlot[]): IfoTrack[] {
  const labelCounts = new Map<string, number>()
  const tracks: IfoTrack[] = []

  slots.forEach((slot, index) => {
    if (slot.codingByte === 0 && slot.language === null) {
      return
    }

    const baseLabel = slot.language ? languageDisplayName(slot.language) : `${kind} ${index + 1}`
    const seen = (labelCounts.get(baseLabel) ?? 0) + 1
    labelCounts.set(baseLabel, seen)
    tracks.push({ id: index, label: seen > 1 ? `${baseLabel} (${seen})` : baseLabel })
  })

  return tracks
}

function dvdTimeToSeconds(buffer: Buffer, offset: number): number {
  const hours = fromBcd(buffer.readUInt8(offset))
  const minutes = fromBcd(buffer.readUInt8(offset + 1))
  const seconds = fromBcd(buffer.readUInt8(offset + 2))
  return hours * 3600 + minutes * 60 + seconds
}

function fromBcd(byte: number): number {
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f)
}

function readLanguageCode(buffer: Buffer, offset: number): string | null {
  const first = buffer.readUInt8(offset)
  const second = buffer.readUInt8(offset + 1)
  if (!isAsciiLetter(first) || !isAsciiLetter(second)) {
    return null
  }

  return String.fromCharCode(first, second).toLowerCase()
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function languageDisplayName(languageCode: string): string {
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
    const name = displayNames.of(languageCode)
    return name && name !== languageCode ? name : languageCode
  } catch {
    return languageCode
  }
}

function hasIfoSignature(buffer: Buffer, signature: string): boolean {
  return buffer.length >= signature.length && buffer.toString('latin1', 0, signature.length) === signature
}
