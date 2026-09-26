import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeBrowserPlayback } from '../../src/ui/browser-playback.js'

const transport = vi.hoisted(() => ({
  listener: undefined as ((event: { type: string; payload: unknown }) => void) | undefined,
  unsubscribe: vi.fn(),
}))
vi.mock('../../src/ui/browser-events.js', () => ({
  subscribeAppEvents(listener: typeof transport.listener) {
    transport.listener = listener
    return transport.unsubscribe
  },
}))

class Element extends EventTarget {
  textContent = ''
  value = '0'
  hidden = true
  disabled = false
}
class Video extends Element {
  dataset = {
    manifestUrl: '/streams/test/index.m3u8?region=0&videoOnly=1',
    sessionManifestUrl: '/streams/test/index.m3u8?region=0',
    sessionId: 'test', durationSeconds: '120', epochStartSeconds: '0', recoveryEpoch: '0',
  }
  currentTime = 0
  private source = ''
  currentSrc = ''
  readyState = 0
  get src() { return this.source }
  set src(value: string) {
    this.source = value
    this.currentSrc = value
    this.readyState = value ? 1 : 0
  }
  error: { code: number; message: string } | null = null
  paused = false
  playbackRate = 1
  buffered: { length: number; start: (index: number) => number; end: (index: number) => number } = {
    length: 0, start: () => 0, end: () => 10,
  }
  canPlayType() { return 'maybe' }
  pause = vi.fn(() => { this.paused = true })
  load = vi.fn()
  play = vi.fn(async () => { this.paused = false })
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}

function setup(savedResume?: string, epochStartSeconds = '0') {
  const video = new Video(), status = new Element(), seek = new Element(), retry = new Element()
  video.dataset.epochStartSeconds = epochStartSeconds
  const elements: Record<string, Element> = {
    player: video, 'player-status': status, 'title-seek': seek, 'retry-playback': retry,
    'title-current-time': new Element(), 'title-buffered-summary': new Element(),
  }
  // These doubles implement only the DOM surface used by native playback.
  const root = { getElementById: (id: string) => elements[id] ?? null, activeElement: null } as unknown as Document
  const windowEvents = new EventTarget()
  const storage = new Map<string, string>()
  if (savedResume) storage.set('playback-resume:test', savedResume)
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  vi.stubGlobal('window', Object.assign(windowEvents, {
    location: { origin: 'http://localhost', reload: vi.fn() },
    sessionStorage,
  }))
  vi.stubGlobal('sessionStorage', sessionStorage)
  vi.stubGlobal('navigator', { userAgent: 'Version/17.0 Safari/605.1' })
  vi.stubGlobal('HTMLVideoElement', Video)
  vi.stubGlobal('HTMLInputElement', Element)
  vi.stubGlobal('HTMLButtonElement', Element)
  const dispose = initializeBrowserPlayback(root)
  return { video, status, seek, retry, dispose, windowEvents }
}

beforeEach(() => {
  transport.listener = undefined
  transport.unsubscribe.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native browser playback', () => {
  it('reports the active raw region and the end of the contiguous current buffer range', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetch)
    const { video, dispose } = setup(undefined, '100')
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.buffered = {
        length: 3,
        start: (index: number) => [0, 7, 20][index],
        end: (index: number) => [5, 15, 25][index],
      }
      video.dispatchEvent(new Event('loadedmetadata'))
      video.currentTime = 4.5
      video.dispatchEvent(new Event('timeupdate'))

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      const request = fetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(request[0]).toBe('/api/sessions/test/playback')
      expect(JSON.parse(String((request[1] as RequestInit).body))).toMatchObject({
        manifestUrl: '/streams/test/index.m3u8?region=0',
        sequence: 1,
        positionSeconds: 104.5,
        bufferedEndSeconds: 105,
        paused: false,
        playbackRate: 1,
      })
      expect(JSON.parse(String((request[1] as RequestInit).body)).reporterId).toEqual(expect.any(String))
    } finally { dispose() }
  })

  it('ignores metadata before the attachment is ready', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetch)
    const { video, dispose } = setup()
    try {
      video.currentTime = 4
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('timeupdate'))
      expect(fetch).not.toHaveBeenCalled()

      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('timeupdate'))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    } finally { dispose() }
  })

  it('coalesces playback changes behind one in-flight report and throttles to one per second', async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const responses: Array<(value: unknown) => void> = []
    const fetch = vi.fn(() => new Promise(resolve => { responses.push(resolve) }))
    vi.stubGlobal('fetch', fetch)
    const { video, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.dispatchEvent(new Event('loadedmetadata'))
      video.currentTime = 3
      video.dispatchEvent(new Event('timeupdate'))
      expect(fetch).toHaveBeenCalledTimes(1)

      video.currentTime = 8
      video.dispatchEvent(new Event('timeupdate'))
      expect(fetch).toHaveBeenCalledTimes(1)
      video.currentTime = 12
      responses[0]({ ok: true, status: 204 })
      await Promise.resolve()

      now = 999
      vi.advanceTimersByTime(999)
      expect(fetch).toHaveBeenCalledTimes(1)
      now = 1000
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      expect(fetch).toHaveBeenCalledTimes(2)
      const request = fetch.mock.calls[1] as unknown as [string, RequestInit]
      expect(JSON.parse(String(request[1].body))).toMatchObject({
        positionSeconds: 12,
        sequence: 2,
      })
      responses[1]({ ok: true, status: 204 })
    } finally { dispose() }
  })

  it('sends a heartbeat while paused and aborts reports and timers on disposal', async () => {
    vi.useFakeTimers()
    const requests: RequestInit[] = []
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      requests.push(init)
      return new Promise(resolve => {
        init.signal?.addEventListener('abort', () => resolve({ ok: false, status: 0 }), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetch)
    const { video, dispose } = setup()
    await vi.waitFor(() => expect(video.src).toContain('region=0'))
    video.paused = true
    video.dispatchEvent(new Event('loadedmetadata'))
    vi.advanceTimersByTime(4000)
    await Promise.resolve()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(requests[0].signal?.aborted).toBe(true)
    expect(JSON.parse(String(requests[1].body))).toMatchObject({ paused: true })

    dispose()
    expect(requests[1].signal?.aborted).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('drops a queued old-region report when a remote seek adopts a new source', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const fetch = vi.fn((url: string) => {
      if (url.endsWith('/seek')) {
        return Promise.resolve({ ok: true, json: async () => ({
          action: 'restarted', positionSeconds: 20,
          session: {
            id: 'test', manifestUrl: '/streams/test/index.m3u8?region=1',
            timeline: { currentRange: { startSeconds: 20, endSeconds: 30 } },
          },
        }) })
      }
      return Promise.resolve({ ok: true, status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    const { video, seek, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.dispatchEvent(new Event('loadedmetadata'))
      video.currentTime = 1
      video.dispatchEvent(new Event('timeupdate'))
      await Promise.resolve()
      now = 100
      video.currentTime = 2
      video.dispatchEvent(new Event('timeupdate'))
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/playback'))).toHaveLength(1)

      seek.value = '20'
      seek.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(video.src).toContain('region=1'))
      now = 1000
      video.currentSrc = '/streams/test/index.m3u8?region=0&videoOnly=1'
      video.readyState = 1
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('timeupdate'))
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/playback'))).toHaveLength(1)
      video.currentSrc = video.src
      video.dispatchEvent(new Event('loadedmetadata'))
      video.dispatchEvent(new Event('timeupdate'))
      await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/playback'))).toHaveLength(2))

      const playbackRequests = fetch.mock.calls.filter(([url]) => url.endsWith('/playback'))
      const request = playbackRequests[1] as unknown as [string, RequestInit]
      expect(JSON.parse(String(request[1].body))).toMatchObject({
        manifestUrl: '/streams/test/index.m3u8?region=1',
        positionSeconds: 20,
      })
    } finally { dispose() }
  })

  it('offers a fatal-error retry that retains the native playback position', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      id: 'test', manifestUrl: '/streams/test/index.m3u8?region=0',
      timeline: { currentRange: { startSeconds: 0, endSeconds: 30 } },
    }) }))
    const { video, status, retry, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.dispatchEvent(new Event('loadedmetadata'))
      video.currentTime = 7
      video.error = { code: 3, message: 'The DVD video could not be decoded.' }
      video.dispatchEvent(new Event('error'))
      expect(retry.hidden).toBe(false)
      expect(status.textContent).toContain('could not be decoded')
      retry.dispatchEvent(new Event('click'))
      await vi.waitFor(() => expect(status.textContent).toBe('Using native HLS support.'))
      video.currentTime = 0
      video.dispatchEvent(new Event('loadedmetadata'))
      expect(video.currentTime).toBe(7)
      expect(retry.hidden).toBe(true)
      expect(video.pause).toHaveBeenCalledTimes(1)
      expect(video.play).toHaveBeenCalledTimes(1)
    } finally { dispose() }
  })

  it.each([['/streams/test/index.m3u8?region=0', 7], ['/streams/test/index.m3u8?region=1', 0]])(
    'restores saved position only for the same region (%s)', async (manifestUrl, expectedTime) => {
      const { video, dispose } = setup(JSON.stringify({ manifestUrl, startSeconds: 0, mediaTime: 7 }))
      try {
        await vi.waitFor(() => expect(video.src).toContain('region=0'))
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(expectedTime)
        expect(sessionStorage.getItem('playback-resume:test')).toBeNull()
      } finally { dispose() }
    },
  )

  it('reconciles a failed seek with the server region and accepts its recovery', async () => {
    const recovered = { id: 'test', manifestUrl: '/streams/test/index.m3u8?region=1',
      timeline: { currentRange: { startSeconds: 20, endSeconds: 24 } }, recovery: { epoch: 1 } }
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, json: async () => recovered })
    vi.stubGlobal('fetch', fetch)
    const { video, status, seek, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      seek.value = '20'; seek.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(video.src).toContain('region=1'))
      expect(video.src).toContain('videoOnly=1')
      expect(video.dataset.epochStartSeconds).toBe('20')
      transport.listener?.({ type: 'session.recovery', payload: { sessionId: 'test', session: recovered, message: 'Recovered playback.' } })
      expect(status.textContent).toBe('Recovered playback.')
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { dispose() }
  })

  it('seeks within the buffer locally and releases native resources on disposal', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { video, seek, dispose } = setup()
    await vi.waitFor(() => expect(video.src).toContain('region=0'))
    video.buffered.length = 1
    seek.value = '4'; seek.dispatchEvent(new Event('change'))
    expect(video.currentTime).toBe(4)
    expect(fetch).not.toHaveBeenCalled()
    dispose(); dispose()
    expect(video.pause).toHaveBeenCalledTimes(1)
    expect(video.src).toBe('')
    expect(transport.unsubscribe).toHaveBeenCalledTimes(1)
    seek.value = '5'; seek.dispatchEvent(new Event('change'))
    expect(video.currentTime).toBe(4)
  })

  it('does not reattach after a delayed failed seek response following disposal', async () => {
    let respond: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { respond = resolve })))
    const { video, seek, dispose } = setup()
    await vi.waitFor(() => expect(video.src).toContain('region=0'))
    seek.value = '20'; seek.dispatchEvent(new Event('change'))
    dispose()
    respond({ ok: false, status: 409 })
    await Promise.resolve()
    await Promise.resolve()
    expect(video.src).toBe('')
  })
})

  it('shows a matching terminal session failure and stops native playback', async () => {
    const { video, status, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      transport.listener?.({
        type: 'session.updated',
        payload: { id: 'test', state: 'failed', error: { message: 'Playback stopped after repeated unreadable DVD sectors.' } },
      })
      expect(status.textContent).toBe('Playback failed: Playback stopped after repeated unreadable DVD sectors.')
      expect(video.pause).toHaveBeenCalled()
      expect(video.src).toBe('')
    } finally { dispose() }
  })
