import { describe, expect, it } from 'vitest'
import {
  buildStitchedManifest,
  createInitialTimelineRuntime,
  isTimeInRange,
  noteTimelineProgress,
  normalizeSeekPosition,
  segmentNumberForTime,
  toTimelineSnapshot,
} from '../../../src/session/timeline.js'

describe('session timeline helpers', () => {
  it('normalizes seek positions to valid segment boundaries', () => {
    expect(normalizeSeekPosition(21.8, 120, 2)).toBe(20)
    expect(normalizeSeekPosition(120, 120, 2)).toBe(118)
    expect(normalizeSeekPosition(121, 120, 2)).toBeNull()
    expect(normalizeSeekPosition(Number.NaN, 120, 2)).toBeNull()
    expect(segmentNumberForTime(20, 2)).toBe(11)
  })

  it('tracks current and generated title ranges from HLS segment names', () => {
    const runtime = createInitialTimelineRuntime(120)

    noteTimelineProgress(runtime, ['segment-000001.ts', 'segment-000002.ts', 'segment-000003.ts'], 2)
    noteTimelineProgress(runtime, ['segment-000011.ts', 'segment-000012.ts'], 2)

    expect(runtime.currentRange).toEqual({ startSeconds: 20, endSeconds: 24 })
    expect(toTimelineSnapshot(runtime, '/streams/session-1/', 2).generatedRanges).toEqual([
      { startSeconds: 0, endSeconds: 6 },
      { startSeconds: 20, endSeconds: 24 },
    ])
    expect(isTimeInRange(22, runtime.currentRange)).toBe(true)
    expect(isTimeInRange(24, runtime.currentRange)).toBe(false)
  })

  it('builds stitched manifests with discontinuities until the title cache is complete', () => {
    const partialRuntime = createInitialTimelineRuntime(12)
    noteTimelineProgress(partialRuntime, ['segment-000001.ts', 'segment-000002.ts'], 2)
    noteTimelineProgress(partialRuntime, ['segment-000005.ts'], 2)

    expect(buildStitchedManifest(partialRuntime, 2)).toBe([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:1',
      '#EXTINF:2,',
      'segment-000001.ts',
      '#EXTINF:2,',
      'segment-000002.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2,',
      'segment-000005.ts',
      '',
    ].join('\n'))

    const completeRuntime = createInitialTimelineRuntime(6)
    noteTimelineProgress(completeRuntime, ['segment-000001.ts', 'segment-000002.ts', 'segment-000003.ts'], 2)

    expect(buildStitchedManifest(completeRuntime, 2)).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(buildStitchedManifest(completeRuntime, 2)).toContain('#EXT-X-ENDLIST')
  })
})