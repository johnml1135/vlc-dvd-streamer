import type { Page } from '@playwright/test'

export interface SyntheticHlsOptions {
  profile?: 'healthy'
}

export async function installSyntheticHls(page: Page, options: SyntheticHlsOptions = {}): Promise<void> {
  const profile = options.profile ?? 'healthy'

  await page.addInitScript(() => {
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function patchedCanPlayType(type: string): CanPlayTypeResult {
      if (type === 'application/vnd.apple.mpegurl') {
        return ''
      }

      return originalCanPlayType.call(this, type)
    }
  })

  await page.route('**/assets/hls.mjs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: buildSyntheticHlsModule(profile),
    })
  })
}

function buildSyntheticHlsModule(profile: 'healthy'): string {
  return `
const players = new WeakMap()

function createRanges(start, end) {
  return {
    length: end > start ? 1 : 0,
    start(index) {
      if (index !== 0 || end <= start) {
        throw new DOMException('The index is not in the allowed range.', 'IndexSizeError')
      }

      return start
    },
    end(index) {
      if (index !== 0 || end <= start) {
        throw new DOMException('The index is not in the allowed range.', 'IndexSizeError')
      }

      return end
    },
  }
}

async function verifyStream(source) {
  const manifestUrl = new URL(source, window.location.origin)
  const manifestResponse = await fetch(manifestUrl.toString())
  if (!manifestResponse.ok) {
    throw new Error('Manifest request failed.')
  }

  const manifestText = await manifestResponse.text()
  const assetPath = manifestText
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))

  if (!assetPath) {
    throw new Error('Manifest did not expose a media segment.')
  }

  const assetUrl = new URL(assetPath, manifestUrl)
  const assetResponse = await fetch(assetUrl.toString())
  if (!assetResponse.ok) {
    throw new Error('Segment request failed.')
  }
}

function installHarness(video, source) {
  if (players.has(video)) {
    return players.get(video)
  }

  const state = {
    currentTime: 0,
    duration: 5400,
    paused: true,
    readyState: 0,
    verified: false,
    interval: null,
  }

  function dispatch(type) {
    video.dispatchEvent(new Event(type))
  }

  function stopTicker() {
    if (state.interval !== null) {
      clearInterval(state.interval)
      state.interval = null
    }
  }

  function startTicker() {
    stopTicker()
    state.interval = setInterval(() => {
      if (state.paused) {
        return
      }

      state.currentTime = Math.min(state.currentTime + 0.5, state.duration)
      dispatch('timeupdate')

      if (state.currentTime >= state.duration) {
        state.paused = true
        stopTicker()
        dispatch('ended')
      }
    }, 250)
  }

  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get() {
        return state.currentTime
      },
      set(value) {
        const next = Math.max(0, Math.min(Number(value) || 0, state.duration))
        dispatch('seeking')
        state.currentTime = next
        dispatch('timeupdate')
        queueMicrotask(() => dispatch('seeked'))
      },
    },
    duration: {
      configurable: true,
      get() {
        return state.duration
      },
    },
    readyState: {
      configurable: true,
      get() {
        return state.readyState
      },
    },
    paused: {
      configurable: true,
      get() {
        return state.paused
      },
    },
    seekable: {
      configurable: true,
      get() {
        return createRanges(0, state.duration)
      },
    },
    buffered: {
      configurable: true,
      get() {
        return createRanges(0, Math.max(30, state.currentTime + 30))
      },
    },
  })

  Object.defineProperty(video, 'play', {
    configurable: true,
    value: async () => {
      if (!state.verified) {
        await verifyStream(source)
        state.verified = true
        state.readyState = 4
        dispatch('loadedmetadata')
        dispatch('loadeddata')
        dispatch('canplay')
      }

      state.paused = false
      dispatch('play')
      dispatch('playing')
      startTicker()
    },
  })

  Object.defineProperty(video, 'pause', {
    configurable: true,
    value: () => {
      state.paused = true
      stopTicker()
      dispatch('pause')
    },
  })

  const harness = {
    destroy() {
      stopTicker()
      state.paused = true
    },
  }

  players.set(video, harness)
  return harness
}

export default class SyntheticHls {
  static isSupported() {
    return ${profile === 'healthy' ? 'true' : 'false'}
  }

  loadSource(source) {
    this.source = source
  }

  attachMedia(video) {
    this.video = video
    this.harness = installHarness(video, this.source || video.dataset.manifestUrl || '')
  }

  destroy() {
    this.harness?.destroy()
  }

  on() {}

  off() {}
}
`
}