import { describe, expect, it } from 'vitest'
import { extractPlayableTitleNumbers, parseTitleProbeLog } from '../../../src/vlc/scan-parser.js'

describe('extractPlayableTitleNumbers', () => {
  it('uses the base disc probe log to discover playable title numbers', () => {
    const log = [
      '[000001c9e0f6e600] dvdnav demux debug: Found 4 VTS\'s',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  0"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  1"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  2"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  3"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  4"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  5"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  6"',
      '[000001c9e0fa8050] main input debug: attempt to destroy nonexistent variable "title  7"',
    ].join('\n')

    expect(extractPlayableTitleNumbers(log)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('parseTitleProbeLog', () => {
  it('extracts zero-based VLC track ids while keeping one-based labels for display', () => {
    const log = [
      '[000001f19445a350] main input debug: `file/directory:///C:/Users/johnm/AppData/Roaming/vlc/ml.xspf\' successfully opened',
      '[000001f195da8050] main input debug: `dvd:///F:/#1\' successfully opened',
      '[000001f19445e9f0] dvdnav demux debug:      - pgc_length=649107000',
      '[000001f195da8050] main input debug: video is disabled, not selecting ES 0xbd20',
      '[000001f195da8050] main input debug: video is disabled, not selecting ES 0xbd22',
      '[000001f19445e9f0] dvdnav demux debug: DVDNAV_SPU_STREAM_CHANGE',
      '[000001f19445e9f0] dvdnav demux debug:      - physical_wide=128',
      '[000001f19445e9f0] dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
      '[000001f19445e9f0] dvdnav demux debug:      - physical=0',
    ].join('\n')

    expect(parseTitleProbeLog(log)).toEqual({
      durationSeconds: 7212,
      audioTracks: [{ id: 0, label: 'Audio 1' }],
      subtitleTracks: [
        { id: 0, label: 'Subtitle 1' },
        { id: 2, label: 'Subtitle 3' },
      ],
    })
  })
})