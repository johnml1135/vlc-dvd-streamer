import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDvdTitlesFromIfo } from '../../src/disc/ifo-reader.js'

describe('synthetic DVD fixture', () => {
  it('contains two playable titles with the expected audio and subtitle tracks', async () => {
    const videoTsDir = resolve(process.cwd(), 'test/fixtures/dvd/VIDEO_TS')
    const titles = await readDvdTitlesFromIfo(videoTsDir)
    const vob = await stat(resolve(videoTsDir, 'VTS_01_1.VOB'))

    expect(titles).toHaveLength(2)
    expect(titles[0]?.durationSeconds).toBeGreaterThanOrEqual(18)
    expect(titles[0]?.durationSeconds).toBeLessThanOrEqual(20)
    expect(titles[1]?.durationSeconds).toBe(6)
    expect(titles[0]?.audioTracks).toEqual([{ id: 0, label: 'English' }, { id: 1, label: 'French' }])
    expect(titles[0]?.subtitleTracks).toEqual([{ id: 0, label: 'English' }])
    expect(vob.size).toBeLessThan(4_000_000)
  })
})
