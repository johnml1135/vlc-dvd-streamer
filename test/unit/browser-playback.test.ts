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
    sessionId: 'test', viewerToken: 'page-a', viewerActive: 'true',
    durationSeconds: '120', epochStartSeconds: '0', recoveryEpoch: '0',
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

function setup(savedResume?: string, epochStartSeconds = '0', viewerActive = true, storedViewerToken?: string) {
  const video = new Video(), status = new Element(), seek = new Element(), retry = new Element()
  const playerContent = new Element(), viewerPassive = new Element(), viewerStatus = new Element()
  const takeOverViewer = new Element(), stopStreamForm = new Element()
  video.dataset.epochStartSeconds = epochStartSeconds
  video.dataset.viewerActive = String(viewerActive)
  const elements: Record<string, Element> = {
    player: video, 'player-status': status, 'title-seek': seek, 'retry-playback': retry,
    'player-content': playerContent, 'viewer-passive': viewerPassive, 'viewer-status': viewerStatus,
    'take-over-viewer': takeOverViewer, 'stop-stream-form': stopStreamForm,
    'title-current-time': new Element(), 'title-buffered-summary': new Element(),
  }
  // These doubles implement only the DOM surface used by native playback.
  const root = Object.assign(new EventTarget(), {
    getElementById: (id: string) => elements[id] ?? null,
    activeElement: null,
    visibilityState: 'hidden' as DocumentVisibilityState,
  }) as unknown as Document
  const windowEvents = new EventTarget()
  const storage = new Map<string, string>()
  if (savedResume) storage.set('playback-resume:test', savedResume)
  if (storedViewerToken) storage.set('viewer-token:test', storedViewerToken)
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
  return { video, status, seek, retry, playerContent, viewerPassive, viewerStatus, takeOverViewer, stopStreamForm, dispose, windowEvents, root, storage }
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
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetch = vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init })
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
    const playbackRequests = requests.filter(({ url }) => url.endsWith('/playback'))
    expect(playbackRequests).toHaveLength(2)
    expect(playbackRequests[0].init.signal?.aborted).toBe(true)
    expect(JSON.parse(String(playbackRequests[1].init.body))).toMatchObject({ paused: true })

    dispose()
    expect(playbackRequests[1].init.signal?.aborted).toBe(true)
    expect(requests.every(({ init }) => init.signal?.aborted)).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(requests.filter(({ url }) => url.endsWith('/playback'))).toHaveLength(2)
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

  it('sends a seek at the half-open buffer end to the server', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      action: 'restarted', positionSeconds: 4,
      session: { id: 'test', manifestUrl: '/streams/test/index.m3u8?region=1' },
    }) })
    vi.stubGlobal('fetch', fetch)
    const { video, seek, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      video.buffered = { length: 1, start: () => 0, end: () => 4 }
      seek.value = '4'
      seek.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/test/seek')
    } finally { dispose() }
  })

  it('keeps a passive page from attaching media or sending Playback feedback', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { video, viewerPassive, viewerStatus, takeOverViewer, dispose } = setup(undefined, '0', false)
    try {
      await Promise.resolve()
      vi.advanceTimersByTime(5000)
      expect(video.src).toBe('')
      expect(fetch.mock.calls.every(([url]) => !url.endsWith('/playback') && !url.includes('/streams/'))).toBe(true)
      expect(viewerPassive.hidden).toBe(false)
      expect(viewerStatus.textContent).toContain('Playing on another device')
      expect(takeOverViewer.textContent).toBe('Take over?')
    } finally { dispose() }
  })

  it('reuses the tab viewer token after a reload renders the page passive', async () => {
    const attachTokens: string[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/viewer/attach')) {
        attachTokens.push(JSON.parse(String(init?.body)).viewerToken)
        return { ok: true, json: async () => ({ active: true }) }
      }
      return { ok: true, status: 204 }
    })
    vi.stubGlobal('fetch', fetch)
    const { video, viewerPassive, storage, dispose } = setup(undefined, '0', false, 'page-before-reload')
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      expect(attachTokens[0]).toBe('page-before-reload')
      expect(viewerPassive.hidden).toBe(true)
      expect(storage.get('viewer-token:test')).toBe('page-before-reload')
    } finally { dispose() }
  })

  it('records the server token for this tab when the page renders active', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) }))
    const { storage, dispose } = setup(undefined, '0', true, 'stale-token')
    try {
      expect(storage.get('viewer-token:test')).toBe('page-a')
    } finally { dispose() }
  })

  it('silently takes over when periodic ownership checks find the old viewer gone', async () => {
    vi.useFakeTimers()
    let attachRequests = 0
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/viewer/attach')) {
        attachRequests += 1
        return { ok: true, json: async () => ({ active: attachRequests > 1 }) }
      }
      return { ok: true, status: 204 }
    })
    vi.stubGlobal('fetch', fetch)
    const { video, viewerStatus, takeOverViewer, dispose } = setup(undefined, '0', false)
    try {
      await vi.advanceTimersByTimeAsync(4000)
      expect(attachRequests).toBe(3)
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      expect(viewerStatus.textContent).toBe('')
      expect(takeOverViewer.textContent).toBe('Take over?')
    } finally { dispose() }
  })

  it('refreshes ownership when a background page becomes visible', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ active: true }) }))
    vi.stubGlobal('fetch', fetch)
    const { video, root, dispose } = setup(undefined, '0', false)
    try {
      const visibleRoot = root as Document & { visibilityState: DocumentVisibilityState }
      visibleRoot.visibilityState = 'visible'
      root.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      expect(fetch).toHaveBeenCalledWith('/api/sessions/test/viewer/attach', expect.any(Object))
    } finally { dispose() }
  })

  it('releases its active claim on pagehide before a restored page claims ownership', () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const { windowEvents, dispose } = setup()
    try {
      const pagehide = new Event('pagehide')
      Object.defineProperty(pagehide, 'persisted', { value: true })
      windowEvents.dispatchEvent(pagehide)

      const release = fetch.mock.calls.find(([url]) => url.endsWith('/viewer/release'))
      expect(release?.[0]).toBe('/api/sessions/test/viewer/release')
      expect(release?.[1]).toMatchObject({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ viewerToken: 'page-a' }),
      })
      expect(release?.[1].signal).toBeUndefined()
    } finally { dispose() }
  })

  it('claims a page rendered without an owner as soon as playback initializes', async () => {
    let finishClaim: ((response: { ok: boolean; json: () => Promise<{ active: boolean }> }) => void) | undefined
    const fetch = vi.fn(() => new Promise<{ ok: boolean; json: () => Promise<{ active: boolean }> }>((resolve) => {
      finishClaim = resolve
    }))
    vi.stubGlobal('fetch', fetch)
    const { video, status, dispose } = setup(undefined, '0', false)
    try {
      expect(fetch).toHaveBeenCalledWith('/api/sessions/test/viewer/attach', expect.any(Object))
      expect(video.src).toBe('')
      finishClaim?.({ ok: true, json: async () => ({ active: true }) })
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      expect(status.textContent).toBe('Using native HLS support.')
    } finally { dispose() }
  })

  it('attaches from the server claim without waiting for a later ownership check', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetch)
    const { video, status, root, dispose } = setup()
    try {
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      const visibleRoot = root as Document & { visibilityState: DocumentVisibilityState }
      visibleRoot.visibilityState = 'visible'
      root.dispatchEvent(new Event('visibilitychange'))
      expect(status.textContent).toBe('Using native HLS support.')
      expect(fetch).toHaveBeenCalledWith('/api/sessions/test/viewer/attach', expect.any(Object))
    } finally { dispose() }
  })

  it('takes over on confirmation and becomes passive when another page takes ownership', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/viewer/takeover')) return { ok: true, json: async () => ({ active: true }) }
      if (url.endsWith('/viewer/attach')) return { ok: true, json: async () => ({ active: false }) }
      return { ok: true, status: 204 }
    })
    vi.stubGlobal('fetch', fetch)
    const { video, status, playerContent, viewerPassive, viewerStatus, takeOverViewer, stopStreamForm, dispose } = setup(undefined, '0', false)
    try {
      expect(video.src).toBe('')
      takeOverViewer.dispatchEvent(new Event('click'))
      await vi.waitFor(() => expect(video.src).toContain('region=0'))
      expect(playerContent.hidden).toBe(false)
      expect(viewerPassive.hidden).toBe(true)
      expect(stopStreamForm.hidden).toBe(false)

      transport.listener?.({ type: 'session.viewer', payload: { sessionId: 'test' } })
      expect(video.src).toBe('')
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/sessions/test/viewer/attach', expect.any(Object)))
      await vi.waitFor(() => expect(video.src).toBe(''))
      expect(video.pause).toHaveBeenCalled()
      expect(playerContent.hidden).toBe(true)
      expect(viewerPassive.hidden).toBe(false)
      expect(viewerStatus.textContent).toContain('Watching elsewhere')
      expect(takeOverViewer.textContent).toBe('Take back')
      expect(status.textContent).not.toContain('Playing')
    } finally { dispose() }
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
