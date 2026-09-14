import { describe, expect, it } from 'vitest'
import { RunwayEvidence } from '../../src/session/runway-evidence.js'

const range = { startSeconds: 0, endSeconds: 20 }
const payload = (overrides: Record<string, unknown> = {}) => ({
  manifestUrl: '/streams/s/index.m3u8?region=0',
  reporterId: 'browser-1',
  sequence: 1,
  positionSeconds: 4,
  bufferedEndSeconds: 12,
  paused: false,
  playbackRate: 1,
  ...overrides,
})

describe('RunwayEvidence', () => {
  it('accepts valid reports, rejects malformed/reordered reports, and expires them', () => {
    let now = 0
    const evidence = new RunwayEvidence(() => now, 2)
    evidence.setRegion('/streams/s/index.m3u8?region=0')

    expect(evidence.report(payload(), range, 20)).toBe('accepted')
    expect(evidence.report(payload({ sequence: 1 }), range, 20)).toBe('stale')
    expect(evidence.report(payload({ sequence: 2, positionSeconds: -1 }), range, 20)).toBe('invalid')
    now = 5_000
    expect(evidence.runwaySlots(10)).toBeNull()
    expect(evidence.report(payload({ sequence: 1 }), range, 20)).toBe('stale')
    expect(evidence.report(payload({ sequence: 2 }), range, 20)).toBe('accepted')
  })

  it('uses the minimum playing runway, ages it, and ignores paused viewers', () => {
    let now = 0
    const evidence = new RunwayEvidence(() => now, 2)
    evidence.setRegion('/streams/s/index.m3u8?region=0')
    expect(evidence.report(payload({ reporterId: 'playing-a', bufferedEndSeconds: 18 }), range, 20)).toBe('accepted')
    expect(evidence.report(payload({ reporterId: 'playing-b', sequence: 1, positionSeconds: 8, bufferedEndSeconds: 20 }), range, 20)).toBe('accepted')
    expect(evidence.report(payload({ reporterId: 'paused', sequence: 1, paused: true, positionSeconds: 19, bufferedEndSeconds: 20 }), range, 20)).toBe('accepted')
    expect(evidence.runwaySlots(10)).toBeCloseTo((12 - 2) / 2)
    now = 1_000
    expect(evidence.runwaySlots(10)).toBeCloseTo((12 - 2) / 2 - 1 / 2)
    now = 6_000
    expect(evidence.runwaySlots(10)).toBeNull()
  })

  it('accounts for playback rate and clamps reported buffering to produced output', () => {
    let now = 0
    const evidence = new RunwayEvidence(() => now, 2)
    evidence.setRegion('/streams/s/index.m3u8?region=0')
    expect(evidence.report(payload({ playbackRate: 2, positionSeconds: 4, bufferedEndSeconds: 40 }), range, 20)).toBe('accepted')
    // Produced slot 6 ends at 12s, so runway is (12 - 4) / 2 - 2 transport seconds.
    expect(evidence.runwaySlots(6)).toBeCloseTo(1)
    now = 1_000
    expect(evidence.runwaySlots(6)).toBeCloseTo(0.5)

    expect(evidence.report(payload({ reporterId: 'stationary', sequence: 1, paused: false, playbackRate: 0 }), range, 20)).toBe('accepted')
    expect(evidence.runwaySlots(6)).toBeCloseTo(0.5)
  })

  it('preserves sequence tombstones, bounds reporter memory, and resets downloads by region', () => {
    let now = 0
    const evidence = new RunwayEvidence(() => now, 2)
    evidence.setRegion('/streams/s/index.m3u8?region=0')
    expect(evidence.report(payload({ sequence: 5 }), range, 20)).toBe('accepted')
    evidence.setRegion('/streams/s/index.m3u8?region=1')
    expect(evidence.report(payload({ sequence: 1, manifestUrl: '/streams/s/index.m3u8?region=0' }), range, 20)).toBe('stale')
    evidence.noteDownload('/streams/s/index.m3u8?region=1', 4)
    expect(evidence.runwaySlots(6)).toBe(2)
    evidence.setRegion('/streams/s/index.m3u8?region=2')
    expect(evidence.runwaySlots(6)).toBeNull()
    expect(evidence.report(payload({ sequence: 1, manifestUrl: '/streams/s/index.m3u8?region=2' }), range, 20)).toBe('stale')

    for (let index = 0; index < 63; index += 1) {
      expect(evidence.report(payload({ reporterId: `reporter-${index}`, sequence: 1, manifestUrl: '/streams/s/index.m3u8?region=2' }), range, 20)).toBe('accepted')
    }
    expect(evidence.report(payload({ reporterId: 'reporter-overflow', sequence: 1, manifestUrl: '/streams/s/index.m3u8?region=2' }), range, 20)).toBe('stale')
    expect(evidence.report(payload({ reporterId: 'reporter-0', sequence: 6, manifestUrl: '/streams/s/index.m3u8?region=2' }), range, 20)).toBe('accepted')
  })
})
