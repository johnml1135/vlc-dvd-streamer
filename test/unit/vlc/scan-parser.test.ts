import { describe, expect, it } from 'vitest'
import * as scanParser from '../../../src/vlc/scan-parser.js'
import { extractPlayableTitleNumbers, mergeTitleProbeMetadata, parseTitleProbeLog } from '../../../src/vlc/scan-parser.js'

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

describe('mergeTitleProbeMetadata', () => {
  it('unions audio and subtitle track ids discovered across multiple title probes', () => {
    const englishProbe = parseTitleProbeLog([
      '[000001f195da8050] main input debug: `dvd:///F:/#1\' successfully opened',
      '[000001f19445e9f0] dvdnav demux debug:      - pgc_length=649107000',
      '[000001f195da8050] main input debug: video is disabled, not selecting ES 0xbd20',
      '[000001f19445e9f0] dvdnav demux debug: DVDNAV_SPU_STREAM_CHANGE',
      '[000001f19445e9f0] dvdnav demux debug:      - physical_wide=128',
      '[000001f19445e9f0] dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
      '[000001f19445e9f0] dvdnav demux debug:      - physical=0',
    ].join('\n'))

    const frenchProbe = parseTitleProbeLog([
      '[000001f195da8050] main input debug: `dvd:///F:/#1\' successfully opened',
      '[000001f19445e9f0] dvdnav demux debug:      - pgc_length=649107000',
      '[000001f19445e9f0] dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
      '[000001f19445e9f0] dvdnav demux debug:      - physical=1',
    ].join('\n'))

    expect(mergeTitleProbeMetadata([englishProbe, frenchProbe])).toEqual({
      durationSeconds: 7212,
      audioTracks: [
        { id: 0, label: 'Audio 1' },
        { id: 1, label: 'Audio 2' },
      ],
      subtitleTracks: [{ id: 0, label: 'Subtitle 1' }],
    })
  })
})

describe('enrichTrackLabels', () => {
  it('relabels generic CLI probe tracks with runtime libVLC metadata and adds missing subtitle options', () => {
    const enrichTrackLabels = (scanParser as unknown as {
      enrichTrackLabels?: (
        parsed: {
          durationSeconds: number
          audioTracks: Array<{ id: number; label: string }>
          subtitleTracks: Array<{ id: number; label: string }>
        },
        runtime: {
          mediaTracks: Array<{ id: number; type: number; language: string | null; description: string | null }>
          audio: Array<{ id: number; name: string | null }>
          subtitles: Array<{ id: number; name: string | null }>
        },
      ) => {
        durationSeconds: number
        audioTracks: Array<{ id: number; label: string }>
        subtitleTracks: Array<{ id: number; label: string }>
      }
    }).enrichTrackLabels

    expect(typeof enrichTrackLabels).toBe('function')

    expect(
      enrichTrackLabels!({
        durationSeconds: 7212,
        audioTracks: [
          { id: 0, label: 'Audio 1' },
          { id: 1, label: 'Audio 2' },
        ],
        subtitleTracks: [{ id: 0, label: 'Subtitle 1' }],
      }, {
        mediaTracks: [
          { id: 0, type: 0, language: 'en', description: null },
          { id: 1, type: 0, language: 'es', description: null },
        ],
        audio: [],
        subtitles: [
          { id: -1, name: 'Disable' },
          { id: 0xbd20, name: 'Track 1 - [English]' },
          { id: 0xbd21, name: 'Track 2 - [Spanish]' },
        ],
      }),
    ).toEqual({
      durationSeconds: 7212,
      audioTracks: [
        { id: 0, label: 'English' },
        { id: 1, label: 'Spanish' },
      ],
      subtitleTracks: [
        { id: 0, label: 'English' },
        { id: 1, label: 'Spanish' },
      ],
    })
  })

  it('normalizes raw runtime audio ids and prefers audio descriptions over media track language guesses', () => {
    const enrichTrackLabels = (scanParser as unknown as {
      enrichTrackLabels?: (
        parsed: {
          durationSeconds: number
          audioTracks: Array<{ id: number; label: string }>
          subtitleTracks: Array<{ id: number; label: string }>
        },
        runtime: {
          mediaTracks: Array<{ id: number; type: number; language: string | null; description: string | null }>
          audio: Array<{ id: number; name: string | null }>
          subtitles: Array<{ id: number; name: string | null }>
        },
      ) => {
        durationSeconds: number
        audioTracks: Array<{ id: number; label: string }>
        subtitleTracks: Array<{ id: number; label: string }>
      }
    }).enrichTrackLabels

    expect(typeof enrichTrackLabels).toBe('function')

    expect(
      enrichTrackLabels!({
        durationSeconds: 7212,
        audioTracks: [
          { id: 0, label: 'Audio 1' },
          { id: 1, label: 'Audio 2' },
        ],
        subtitleTracks: [],
      }, {
        mediaTracks: [
          { id: 0, type: 1, language: null, description: null },
          { id: 1, type: 0, language: 'es', description: null },
          { id: 3, type: 0, language: 'de', description: null },
        ],
        audio: [
          { id: 0xbd80, name: 'Track 1 - [English]' },
          { id: 0xbd81, name: 'Track 2 - [French]' },
        ],
        subtitles: [],
      }),
    ).toEqual({
      durationSeconds: 7212,
      audioTracks: [
        { id: 0, label: 'English' },
        { id: 1, label: 'French' },
      ],
      subtitleTracks: [],
    })
  })
})

describe('language probe fallback', () => {
  it('extracts the currently selected audio and subtitle track ids from an explicit language probe log', () => {
    const extractSelectedAudioTrackId = (scanParser as unknown as {
      extractSelectedAudioTrackId?: (log: string) => number | null
    }).extractSelectedAudioTrackId
    const extractSelectedSubtitleTrackId = (scanParser as unknown as {
      extractSelectedSubtitleTrackId?: (log: string) => number | null
    }).extractSelectedSubtitleTrackId

    expect(typeof extractSelectedAudioTrackId).toBe('function')
    expect(typeof extractSelectedSubtitleTrackId).toBe('function')

    const spanishProbeLog = [
      '[0000024f15dd30b0] main input debug: selected audio language[0] es',
      '[0000024f15dd30b0] main input debug: selected audio language[1] none',
      '[0000024f15dd30b0] main input debug: selected sub language[0] es',
      '[0000024f15dd30b0] main input debug: selected sub language[1] none',
      '[0000024f15dd30b0] main input debug: video is disabled, not selecting ES 0xbd21',
      '[0000024f15db0950] dvdnav demux debug: DVDNAV_SPU_STREAM_CHANGE',
      '[0000024f15db0950] dvdnav demux debug:      - physical_wide=1',
      '[0000024f15db0950] dvdnav demux debug: DVDNAV_AUDIO_STREAM_CHANGE',
      '[0000024f15db0950] dvdnav demux debug:      - physical=0',
    ].join('\n')

    expect(extractSelectedAudioTrackId!(spanishProbeLog)).toBe(0)
    expect(extractSelectedSubtitleTrackId!(spanishProbeLog)).toBe(1)
  })

  it('applies inferred language labels and adds newly discovered subtitle tracks', () => {
    const applyInferredTrackLabels = (scanParser as unknown as {
      applyInferredTrackLabels?: (
        parsed: {
          durationSeconds: number
          audioTracks: Array<{ id: number; label: string }>
          subtitleTracks: Array<{ id: number; label: string }>
        },
        inferred: {
          audio: Array<{ id: number; label: string }>
          subtitles: Array<{ id: number; label: string }>
        },
      ) => {
        durationSeconds: number
        audioTracks: Array<{ id: number; label: string }>
        subtitleTracks: Array<{ id: number; label: string }>
      }
    }).applyInferredTrackLabels

    expect(typeof applyInferredTrackLabels).toBe('function')

    expect(
      applyInferredTrackLabels!({
        durationSeconds: 7212,
        audioTracks: [
          { id: 0, label: 'Audio 1' },
          { id: 1, label: 'Audio 2' },
        ],
        subtitleTracks: [{ id: 0, label: 'Subtitle 1' }],
      }, {
        audio: [
          { id: 0, label: 'English' },
          { id: 1, label: 'French' },
        ],
        subtitles: [
          { id: 0, label: 'English' },
          { id: 1, label: 'Spanish' },
        ],
      }),
    ).toEqual({
      durationSeconds: 7212,
      audioTracks: [
        { id: 0, label: 'English' },
        { id: 1, label: 'French' },
      ],
      subtitleTracks: [
        { id: 0, label: 'English' },
        { id: 1, label: 'Spanish' },
      ],
    })
  })
})