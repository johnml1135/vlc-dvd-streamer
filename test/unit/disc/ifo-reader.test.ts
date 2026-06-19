import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDvdTitlesFromIfo } from '../../../src/disc/ifo-reader.js'

const SECTOR = 2048
const TT_SRPT_SECTOR = 1
const PTT_SECTOR = 2
const PGCIT_SECTOR = 3

interface TitleSpec {
  angles?: number
  chapters: number
  vts: number
  ttn: number
}

interface AudioSlot {
  language?: string
  invalidLanguage?: boolean
  codingByte?: number
}

interface SubpSlot {
  language?: string
  codingByte?: number
}

interface VtsSpec {
  // One pgcn list per VTS-title (chapter -> pgcn); index 0 is vts-title 1.
  pttByTitle: number[][]
  // Playback time [h, m, s] per pgc; index 0 is pgcn 1.
  pgcDurations: Array<[number, number, number]>
  audio?: AudioSlot[]
  subp?: SubpSlot[]
  pttSrptSector?: number
  pgcitSector?: number
  corruptPgcStart?: boolean
}

describe('readDvdTitlesFromIfo', () => {
  it('reads titles, durations, and real (non-placeholder) tracks', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 2, vts: 1, ttn: 1 }, { chapters: 3, vts: 1, ttn: 2 }],
      vts: {
        1: {
          // Single-PGC titles repeat their PGC across every chapter entry.
          pttByTitle: [[1, 1], [2, 2, 2]],
          pgcDurations: [[0, 2, 5], [0, 0, 30]],
          audio: [{ language: 'en' }, { language: 'fr' }, {}], // third slot is an empty placeholder
          subp: [{ language: 'en' }, {}], // second slot is an empty placeholder
        },
      },
    })

    expect(await readDvdTitlesFromIfo(dir)).toEqual([
      {
        titleNumber: 1,
        durationSeconds: 125,
        angleCount: 1,
        chapterCount: 2,
        audioTracks: [{ id: 0, label: 'English' }, { id: 1, label: 'French' }],
        subtitleTracks: [{ id: 0, label: 'English' }],
      },
      {
        titleNumber: 2,
        durationSeconds: 30,
        angleCount: 1,
        chapterCount: 3,
        audioTracks: [{ id: 0, label: 'English' }, { id: 1, label: 'French' }],
        subtitleTracks: [{ id: 0, label: 'English' }],
      },
    ])
  })

  it('sums distinct PGCs for a multi-PGC title and disambiguates duplicate / unlabeled tracks', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 2, vts: 1, ttn: 1 }],
      vts: {
        1: {
          pttByTitle: [[1, 2]], // two chapters -> two distinct PGCs
          pgcDurations: [[0, 1, 40], [0, 0, 50]], // 100s + 50s
          audio: [
            { language: 'en' },
            { language: 'en' }, // duplicate language -> "English (2)"
            { invalidLanguage: true }, // type=language but non-letter code -> generic label
          ],
          subp: [{ codingByte: 0x02 }], // present stream, no declared language -> generic label
        },
      },
    })

    expect(await readDvdTitlesFromIfo(dir)).toEqual([
      {
        titleNumber: 1,
        durationSeconds: 150,
        angleCount: 1,
        chapterCount: 2,
        audioTracks: [
          { id: 0, label: 'English' },
          { id: 1, label: 'English (2)' },
          { id: 2, label: 'Audio 3' },
        ],
        subtitleTracks: [{ id: 0, label: 'Subtitle 1' }],
      },
    ])
  })

  it('maps known language codes and falls back to the raw code for unknown ones', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 1, vts: 1, ttn: 1 }],
      vts: {
        1: {
          pttByTitle: [[1]],
          pgcDurations: [[1, 0, 0]],
          audio: [{ language: 'es' }, { language: 'xx' }],
        },
      },
    })

    const [title] = await readDvdTitlesFromIfo(dir)
    expect(title?.durationSeconds).toBe(3600)
    expect(title?.audioTracks).toEqual([
      { id: 0, label: 'Spanish' },
      { id: 1, label: 'xx' },
    ])
  })

  it('reuses a cached VTS and skips titles whose VTS file is missing', async () => {
    const dir = await writeDisc({
      titles: [
        { chapters: 1, vts: 1, ttn: 1 },
        { chapters: 1, vts: 1, ttn: 1 }, // same VTS -> cache hit
        { chapters: 1, vts: 2, ttn: 1 }, // VTS 2 file not written -> skipped
      ],
      vts: {
        1: { pttByTitle: [[1]], pgcDurations: [[0, 0, 42]] },
      },
    })

    const titles = await readDvdTitlesFromIfo(dir)
    expect(titles.map((title) => title.titleNumber)).toEqual([1, 2])
    expect(titles.every((title) => title.durationSeconds === 42)).toBe(true)
  })

  it('skips a title whose PGC table is unreadable (out-of-range pointer)', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 1, vts: 1, ttn: 1 }],
      vts: {
        1: { pttByTitle: [[1]], pgcDurations: [[0, 1, 0]], pgcitSector: 9999 },
      },
    })

    expect(await readDvdTitlesFromIfo(dir)).toEqual([])
  })

  it('skips a title whose chapter (PTT) table pointer is unreadable', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 1, vts: 1, ttn: 1 }],
      vts: {
        1: { pttByTitle: [[1]], pgcDurations: [[0, 1, 0]], pttSrptSector: 9999 },
      },
    })

    expect(await readDvdTitlesFromIfo(dir)).toEqual([])
  })

  it('skips a PGC whose start pointer is out of range', async () => {
    const dir = await writeDisc({
      titles: [{ chapters: 1, vts: 1, ttn: 1 }],
      vts: {
        1: { pttByTitle: [[1]], pgcDurations: [[0, 1, 0]], corruptPgcStart: true },
      },
    })

    expect(await readDvdTitlesFromIfo(dir)).toEqual([])
  })

  it('skips VTS files with a bad signature and caches the negative result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-ifo-vts-'))
    // Titles point at: VTS1 (valid), VTS2 (bad signature, referenced twice -> cache),
    // VTS3 (missing file, referenced twice -> cache).
    await writeFile(join(dir, 'VIDEO_TS.IFO'), buildVmgi([
      { chapters: 1, vts: 1, ttn: 1 },
      { chapters: 1, vts: 2, ttn: 1 },
      { chapters: 1, vts: 2, ttn: 1 },
      { chapters: 1, vts: 3, ttn: 1 },
      { chapters: 1, vts: 3, ttn: 1 },
    ]))
    await writeFile(join(dir, 'VTS_01_0.IFO'), buildVtsi({ pttByTitle: [[1]], pgcDurations: [[0, 0, 10]] }))
    await writeFile(join(dir, 'VTS_02_0.IFO'), Buffer.alloc(8192)) // present but not a VTS file

    const titles = await readDvdTitlesFromIfo(dir)
    expect(titles.map((title) => title.titleNumber)).toEqual([1])
  })

  it('throws when the title table pointer is outside the VMGI file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-ifo-oob-'))
    const vmgi = Buffer.alloc(4096)
    vmgi.write('DVDVIDEO-VMG', 0, 'latin1')
    vmgi.writeUInt32BE(9999, 0xc4) // sector pointer past EOF
    await writeFile(join(dir, 'VIDEO_TS.IFO'), vmgi)

    await expect(readDvdTitlesFromIfo(dir)).rejects.toThrow(/TT_SRPT/i)
  })

  it('throws when the title table lists no titles', async () => {
    const dir = await writeDisc({ titles: [], vts: {} })
    await expect(readDvdTitlesFromIfo(dir)).rejects.toThrow(/no playable titles/i)
  })

  it('rejects a file that is not a DVD video manager', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-ifo-bad-'))
    await writeFile(join(dir, 'VIDEO_TS.IFO'), Buffer.alloc(4096))
    await expect(readDvdTitlesFromIfo(dir)).rejects.toThrow(/VMGI/i)
  })
})

// --- fixture builders ---------------------------------------------------------

async function writeDisc(spec: { titles: TitleSpec[]; vts: Record<number, VtsSpec> }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-ifo-'))
  await writeFile(join(dir, 'VIDEO_TS.IFO'), buildVmgi(spec.titles))
  for (const [vtsNumber, vtsSpec] of Object.entries(spec.vts)) {
    await writeFile(join(dir, `VTS_${String(vtsNumber).padStart(2, '0')}_0.IFO`), buildVtsi(vtsSpec))
  }
  return dir
}

function buildVmgi(titles: TitleSpec[]): Buffer {
  const buffer = Buffer.alloc(4096)
  buffer.write('DVDVIDEO-VMG', 0, 'latin1')
  buffer.writeUInt32BE(TT_SRPT_SECTOR, 0xc4)

  const base = TT_SRPT_SECTOR * SECTOR
  buffer.writeUInt16BE(titles.length, base)
  titles.forEach((title, index) => {
    const entry = base + 8 + index * 12
    buffer.writeUInt8(title.angles ?? 1, entry + 1)
    buffer.writeUInt16BE(title.chapters, entry + 2)
    buffer.writeUInt8(title.vts, entry + 6)
    buffer.writeUInt8(title.ttn, entry + 7)
  })

  return buffer
}

function buildVtsi(spec: VtsSpec): Buffer {
  const buffer = Buffer.alloc(16384)
  buffer.write('DVDVIDEO-VTS', 0, 'latin1')

  const pttSector = spec.pttSrptSector ?? PTT_SECTOR
  const pgcitSector = spec.pgcitSector ?? PGCIT_SECTOR
  buffer.writeUInt32BE(pttSector, 0xc8)
  buffer.writeUInt32BE(pgcitSector, 0xcc)

  writePttSrpt(buffer, pttSector, spec.pttByTitle)
  writePgcit(buffer, pgcitSector, spec.pgcDurations)
  writeAudioAttrs(buffer, spec.audio ?? [])
  writeSubpAttrs(buffer, spec.subp ?? [])

  if (spec.corruptPgcStart) {
    // Point the first PGC's start byte past EOF so it is skipped.
    buffer.writeUInt32BE(0xffffff, pgcitSector * SECTOR + 8 + 4)
  }

  return buffer
}

function writePttSrpt(buffer: Buffer, sector: number, pttByTitle: number[][]): void {
  if (sector * SECTOR + 8 > buffer.length) {
    return
  }

  const base = sector * SECTOR
  buffer.writeUInt16BE(pttByTitle.length, base)
  let cursor = 8 + pttByTitle.length * 4 // arrays start after the offset table
  pttByTitle.forEach((pgcns, index) => {
    buffer.writeUInt32BE(cursor, base + 8 + index * 4)
    pgcns.forEach((pgcn, chapter) => {
      buffer.writeUInt16BE(pgcn, base + cursor + chapter * 4)
    })
    cursor += pgcns.length * 4
  })
}

function writePgcit(buffer: Buffer, sector: number, durations: Array<[number, number, number]>): void {
  if (sector * SECTOR + 8 > buffer.length) {
    return
  }

  const base = sector * SECTOR
  buffer.writeUInt16BE(durations.length, base)
  let cursor = 8 + durations.length * 8 // PGCs start after the SRP table
  durations.forEach(([hours, minutes, seconds], index) => {
    buffer.writeUInt32BE(cursor, base + 8 + index * 8 + 4)
    const playbackTime = base + cursor + 4
    buffer.writeUInt8(bcd(hours), playbackTime)
    buffer.writeUInt8(bcd(minutes), playbackTime + 1)
    buffer.writeUInt8(bcd(seconds), playbackTime + 2)
    cursor += 16
  })
}

function writeAudioAttrs(buffer: Buffer, slots: AudioSlot[]): void {
  buffer.writeUInt8(slots.length, 0x0203)
  slots.forEach((slot, index) => {
    const attr = 0x0204 + index * 8
    if (slot.codingByte !== undefined) {
      buffer.writeUInt8(slot.codingByte, attr)
    } else if (slot.invalidLanguage) {
      buffer.writeUInt8(0x04, attr) // lang_type = 1
      buffer.writeUInt8(0x00, attr + 2) // non-letter -> readLanguageCode returns null
      buffer.writeUInt8(0x00, attr + 3)
    } else if (slot.language) {
      buffer.writeUInt8(0x04, attr) // lang_type = 1
      buffer.write(slot.language, attr + 2, 'latin1')
    }
    // else: leave zeroed -> empty placeholder
  })
}

function writeSubpAttrs(buffer: Buffer, slots: SubpSlot[]): void {
  buffer.writeUInt8(slots.length, 0x0255)
  slots.forEach((slot, index) => {
    const attr = 0x0256 + index * 6
    if (slot.codingByte !== undefined) {
      buffer.writeUInt8(slot.codingByte, attr)
    } else if (slot.language) {
      buffer.writeUInt8(0x01, attr) // type = 1
      buffer.write(slot.language, attr + 2, 'latin1')
    }
    // else: leave zeroed -> empty placeholder
  })
}

function bcd(value: number): number {
  return (Math.floor(value / 10) << 4) | (value % 10)
}
