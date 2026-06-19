import { describe, expect, it } from 'vitest'
import {
  buildRegionManifest,
  buildStitchedManifest,
  createInitialTimelineRuntime,
  isTimeInRange,
  markBadSlot,
  noteGeneratedSlots,
  normalizeSeekPosition,
  segmentNumberForTime,
  setRegionStart,
  slotEndSeconds,
  slotForTime,
  slotStartSeconds,
  toTimelineSnapshot,
} from '../../../src/session/timeline.js'

describe('slot grid helpers', () => {
  it('maps DVD time to fixed slots and back', () => {
    expect(slotForTime(0, 2)).toBe(1)
    expect(slotForTime(2, 2)).toBe(2)
    expect(slotForTime(3.9, 2)).toBe(2)
    expect(slotForTime(20, 2)).toBe(11)
    // segmentNumberForTime is retained as an alias for slotForTime.
    expect(segmentNumberForTime(20, 2)).toBe(11)

    expect(slotStartSeconds(1, 2)).toBe(0)
    expect(slotStartSeconds(11, 2)).toBe(20)
    expect(slotEndSeconds(11, 2)).toBe(22)
  })

  it('normalizes seek positions to slot boundaries inside the title', () => {
    expect(normalizeSeekPosition(21.8, 120, 2)).toBe(20)
    expect(normalizeSeekPosition(120, 120, 2)).toBe(118)
    expect(normalizeSeekPosition(121, 120, 2)).toBeNull()
    expect(normalizeSeekPosition(Number.NaN, 120, 2)).toBeNull()
  })
})

describe('timeline runtime', () => {
  it('tracks generated slots and the contiguous current region', () => {
    const runtime = createInitialTimelineRuntime(120, 2)

    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts', 'segment-000003.ts'], 0)

    const snapshot = toTimelineSnapshot(runtime, '/streams/s1/', 2)
    expect(snapshot.currentRange).toEqual({ startSeconds: 0, endSeconds: 6 })
    expect(snapshot.generatedRanges).toEqual([{ startSeconds: 0, endSeconds: 6 }])
    expect(isTimeInRange(4, snapshot.currentRange)).toBe(true)
    expect(isTimeInRange(6, snapshot.currentRange)).toBe(false)
  })

  it('keeps the region anchored to its start while it grows across a VLC restart', () => {
    const runtime = createInitialTimelineRuntime(120, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)
    // A VLC restart at the same place produces a new epoch group but the
    // region must keep its original start so client time stays continuous.
    noteGeneratedSlots(runtime, ['segment-000003.ts', 'segment-000004.ts'], 1)

    const snapshot = toTimelineSnapshot(runtime, '/streams/s1/', 2)
    expect(snapshot.currentRange).toEqual({ startSeconds: 0, endSeconds: 8 })
  })

  it('starts a fresh region on a user seek', () => {
    const runtime = createInitialTimelineRuntime(120, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)

    setRegionStart(runtime, slotForTime(60, 2))
    noteGeneratedSlots(runtime, ['segment-000031.ts', 'segment-000032.ts'], 1)

    const snapshot = toTimelineSnapshot(runtime, '/streams/s1/', 2)
    expect(snapshot.currentRange).toEqual({ startSeconds: 60, endSeconds: 64 })
    // Both disjoint regions remain in the whole-title generated ranges.
    expect(snapshot.generatedRanges).toEqual([
      { startSeconds: 0, endSeconds: 4 },
      { startSeconds: 60, endSeconds: 64 },
    ])
  })
})

describe('region manifest (what the browser plays)', () => {
  it('lists every slot of the contiguous region with a placeholder filling a bad slot', () => {
    const runtime = createInitialTimelineRuntime(120, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)
    markBadSlot(runtime, 3)
    noteGeneratedSlots(runtime, ['segment-000004.ts', 'segment-000005.ts'], 1)

    expect(buildRegionManifest(runtime, 2)).toBe([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-MEDIA-SEQUENCE:1',
      '#EXTINF:2,',
      'segment-000001.ts',
      '#EXTINF:2,',
      'segment-000002.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2,',
      'segment-000003.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2,',
      'segment-000004.ts',
      '#EXTINF:2,',
      'segment-000005.ts',
      '',
    ].join('\n'))
  })

  it('stops the region at the first not-yet-produced slot (the live edge)', () => {
    const runtime = createInitialTimelineRuntime(120, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)
    // slot 3 missing, slot 4 exists but is not contiguous -> not part of the region yet
    noteGeneratedSlots(runtime, ['segment-000004.ts'], 0)

    const manifest = buildRegionManifest(runtime, 2)
    expect(manifest).toContain('segment-000002.ts')
    expect(manifest).not.toContain('segment-000004.ts')
    expect(manifest).not.toContain('#EXT-X-ENDLIST')
  })

  it('closes the region as VOD once it reaches the end of the title', () => {
    const runtime = createInitialTimelineRuntime(6, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts', 'segment-000003.ts'], 0)

    const manifest = buildRegionManifest(runtime, 2)
    expect(manifest).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(manifest).toContain('#EXT-X-ENDLIST')
    expect(manifest).not.toContain('#EXT-X-PLAYLIST-TYPE:EVENT')
  })
})

describe('stitched manifest (whole-title cache view)', () => {
  it('joins disjoint generated ranges with discontinuities', () => {
    const runtime = createInitialTimelineRuntime(120, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)
    noteGeneratedSlots(runtime, ['segment-000005.ts'], 1)

    expect(buildStitchedManifest(runtime, 2)).toBe([
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
  })

  it('marks the whole title VOD when every slot is present', () => {
    const runtime = createInitialTimelineRuntime(6, 2)
    noteGeneratedSlots(runtime, ['segment-000001.ts', 'segment-000002.ts'], 0)
    markBadSlot(runtime, 3)

    const manifest = buildStitchedManifest(runtime, 2)
    expect(manifest).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(manifest).toContain('#EXT-X-ENDLIST')
  })
})
