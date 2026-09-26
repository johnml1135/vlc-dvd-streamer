import { describe, expect, it } from 'vitest'
import { ActiveViewerRegistry } from '../../../src/session/viewer-ownership.js'

describe('Active viewer ownership', () => {
  it('keeps a second page passive until it explicitly takes over', () => {
    const events: Array<{ sessionId: string }> = []
    const viewers = new ActiveViewerRegistry({ now: () => 0, onChange: (event) => events.push(event) })

    expect(viewers.attach('session-1', 'page-a')).toBe(true)
    expect(viewers.attach('session-1', 'page-b')).toBe(false)
    expect(viewers.getActiveViewerToken('session-1')).toBe('page-a')
    expect(viewers.takeOver('session-1', 'page-b')).toBe(true)
    expect(viewers.getActiveViewerToken('session-1')).toBe('page-b')
    expect(events).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'session-1' },
    ])
  })

  it('silently takes over after 15 seconds without accepted feedback', () => {
    let now = 0
    const viewers = new ActiveViewerRegistry({ now: () => now })

    expect(viewers.attach('session-1', 'page-a')).toBe(true)
    now = 14_999
    expect(viewers.attach('session-1', 'page-b')).toBe(false)
    expect(viewers.recordFeedback('session-1', 'page-a')).toBe(true)
    now = 29_998
    expect(viewers.attach('session-1', 'page-b')).toBe(false)
    now = 29_999
    expect(viewers.attach('session-1', 'page-b')).toBe(true)
    expect(viewers.getActiveViewerToken('session-1')).toBe('page-b')
  })

  it('does not let a non-active page refresh owner feedback time', () => {
    let now = 0
    const viewers = new ActiveViewerRegistry({ now: () => now })

    viewers.attach('session-1', 'page-a')
    now = 10_000
    expect(viewers.recordFeedback('session-1', 'page-b')).toBe(false)
    now = 15_000
    expect(viewers.attach('session-1', 'page-b')).toBe(true)
  })

  it('clears ownership when a Playback session is retired', () => {
    const events: Array<{ sessionId: string }> = []
    const viewers = new ActiveViewerRegistry({ now: () => 0, onChange: (event) => events.push(event) })

    viewers.attach('session-1', 'page-a')
    viewers.remove('session-1')

    expect(viewers.getActiveViewerToken('session-1')).toBeNull()
    expect(events.at(-1)).toEqual({ sessionId: 'session-1' })
  })

  it('releases a closing page so its replacement can claim immediately', () => {
    const events: Array<{ sessionId: string }> = []
    const viewers = new ActiveViewerRegistry({ now: () => 0, onChange: (event) => events.push(event) })

    expect(viewers.attach('session-1', 'page-before-navigation')).toBe(true)
    expect(viewers.release('session-1', 'page-before-navigation')).toBe(true)
    expect(viewers.attach('session-1', 'page-after-navigation')).toBe(true)
    expect(viewers.getActiveViewerToken('session-1')).toBe('page-after-navigation')
    expect(events).toEqual([
      { sessionId: 'session-1' },
      { sessionId: 'session-1' },
      { sessionId: 'session-1' },
    ])
  })
})
