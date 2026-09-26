import { formatClock } from '../src/shared/format-clock.js'
import { expect, test, type Route, type WebSocketRoute } from './helpers/test.js'
import { openReadyCatalog } from './helpers/catalog.js'
import { installSyntheticHls } from './helpers/synthetic-hls.js'

test('player stream advances in the browser and allows seeking', async ({ page }) => {
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()

  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')

  const playResult = await page.locator('#player').evaluate(async (node) => {
    const player = node as HTMLVideoElement

    return Promise.race([
      player.play().then(() => 'resolved').catch((error: unknown) => `rejected:${String(error)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ])
  })

  expect(playResult).toBe('resolved')

  const initialState = await page.locator('#player').evaluate((node) => ({
    currentTime: (node as HTMLVideoElement).currentTime,
    readyState: (node as HTMLVideoElement).readyState,
  }))

  await expect.poll(async () => {
    return page.locator('#player').evaluate((node) => (node as HTMLVideoElement).currentTime)
  }, { timeout: 6000 }).toBeGreaterThan(initialState.currentTime)

  const seekTarget = await page.locator('#player').evaluate((node) => (node as HTMLVideoElement).currentTime + 5)
  await page.locator('#player').evaluate((node, target) => {
    ;(node as HTMLVideoElement).currentTime = target
  }, seekTarget)

  await expect.poll(async () => {
    return page.locator('#player').evaluate((node) => (node as HTMLVideoElement).currentTime)
  }, { timeout: 3000 }).toBeGreaterThanOrEqual(seekTarget)
})

test('title timeline uses the server seek path for unbuffered jumps', async ({ page, request }) => {
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()

  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await expect(page.locator('#title-duration')).toHaveText('1:30:00')

  const sessionId = getSessionId(page.url())
  const sessionBeforeSeek = await (await request.get(`/api/sessions/${sessionId}`)).json()
  const remoteTarget = Math.ceil((sessionBeforeSeek.timeline.currentRange.endSeconds + 60) / 4) * 4
  expect(remoteTarget).toBeLessThan(sessionBeforeSeek.durationSeconds)
  const seekResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === 'POST'
      && response.url().includes(`/api/sessions/${sessionId}/seek`)
  })

  await page.locator('#title-seek').evaluate((node, targetSeconds) => {
    const seekControl = node as HTMLInputElement
    seekControl.value = String(targetSeconds)
    seekControl.dispatchEvent(new Event('input', { bubbles: true }))
    seekControl.dispatchEvent(new Event('change', { bubbles: true }))
  }, remoteTarget)

  const seekResponse = await seekResponsePromise
  expect(seekResponse.ok()).toBe(true)
  const seekBody = await seekResponse.json()

  expect(seekBody).toMatchObject({ action: 'restarted', positionSeconds: remoteTarget })
  await expect(page.locator('#player-status')).toHaveText(`Buffering from ${formatClock(remoteTarget)}.`)
  await expect(page.locator('#title-current-time')).toHaveText(formatClock(remoteTarget))

  const sessionResponse = await request.get(`/api/sessions/${sessionId}`)
  expect(sessionResponse.ok()).toBe(true)
  await expect.poll(async () => {
    const session = await (await request.get(`/api/sessions/${sessionId}`)).json()
    return session.timeline.currentRange.startSeconds
  }, { timeout: 5000 }).toBe(remoteTarget)
})

test('real hls.js resumes playback feedback only after the new region is ready', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    ;(window as typeof window & { __playbackReports?: unknown[]; __playbackPending?: number }).__playbackReports = []
    ;(window as typeof window & { __playbackPending?: number }).__playbackPending = 0
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/sessions/') && url.endsWith('/playback') && typeof init?.body === 'string') {
        const reports = (window as typeof window & { __playbackReports: unknown[] }).__playbackReports
        reports.push(JSON.parse(init.body))
        ;(window as typeof window & { __playbackPending: number }).__playbackPending += 1
        try {
          return await nativeFetch(input, init)
        } finally {
          ;(window as typeof window & { __playbackPending: number }).__playbackPending -= 1
        }
      }
      return nativeFetch(input, init)
    }
  })

  // The harness stream contains deliberately minimal transport data, so this test keeps
  // hls.js and its real manifest/MediaSource attachment but controls the media element's
  // readiness state. It verifies report guards without claiming decoded media playback.
  let initialManifestPath = ''
  let initialManifestResponseDone = false
  const initialManifestHandler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.endsWith('/index.m3u8')) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    initialManifestPath = url.pathname + url.search
    await route.fulfill({ response })
    initialManifestResponseDone = true
  }
  await page.route('**/streams/**', initialManifestHandler)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await page.locator('#player').evaluate((node) => {
    const player = node as HTMLVideoElement & { __controlledCurrentTime?: number }
    let controlledCurrentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0
    Object.defineProperty(player, 'readyState', { configurable: true, value: 4 })
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => controlledCurrentTime,
      set: (value: number) => {
        if (Number.isFinite(value)) controlledCurrentTime = Math.max(0, value)
      },
    })
    Object.defineProperty(player, 'buffered', {
      configurable: true,
      get: () => ({
        length: 1,
        start: () => 0,
        end: () => 8,
      }),
    })
    player.__controlledCurrentTime = controlledCurrentTime
  })
  await expect.poll(() => initialManifestResponseDone, { timeout: 8000 }).toBe(true)
  await page.unroute('**/streams/**', initialManifestHandler)
  // Give hls.js a turn to consume the delivered manifest before signaling DOM readiness.
  await page.waitForTimeout(100)
  await expect.poll(async () => page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('#player')?.dispatchEvent(new Event('loadedmetadata'))
    return (window as typeof window & { __playbackReports?: unknown[] }).__playbackReports?.length ?? 0
  }), { timeout: 8000, intervals: [100, 100, 250, 500] }).toBeGreaterThan(0)
  await expect.poll(async () => page.evaluate(() => {
    return (window as typeof window & { __playbackPending?: number }).__playbackPending ?? 0
  }), { timeout: 3000 }).toBe(0)

  const { remoteTarget } = await readSeekTargets(page)
  const initialManifest = await page.locator('#player').getAttribute('data-session-manifest-url')
  expect(initialManifest).toBeTruthy()
  const initialManifestUrl = new URL(initialManifest!, page.url())
  expect(initialManifestPath).toBe(initialManifestUrl.pathname + initialManifestUrl.search)
  const initialRegion = new URL(initialManifest!, page.url()).searchParams.get('region')
  const reportCountBeforeSeek = await page.evaluate(() => {
    return (window as typeof window & { __playbackReports?: unknown[] }).__playbackReports?.length ?? 0
  })
  const firstReport = await page.evaluate(() => {
    const reports = (window as typeof window & { __playbackReports?: Array<{ manifestUrl: string; reporterId: string; sequence: number }> }).__playbackReports ?? []
    return reports[0]
  })
  expect(firstReport.manifestUrl).toBe(initialManifest)
  let delayedManifestRoute: Route | undefined
  let delayedManifestPath = ''
  let releaseManifest: (() => void) | undefined
  await page.route('**/streams/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/index.m3u8') && url.searchParams.get('region') !== initialRegion) {
      delayedManifestRoute = route
      delayedManifestPath = url.pathname + url.search
      await new Promise<void>((resolve) => { releaseManifest = resolve })
      await route.continue()
      return
    }
    await route.continue()
  })

  await changeTitleSeek(page, remoteTarget)
  await expect.poll(() => Boolean(delayedManifestRoute), { timeout: 8000 }).toBe(true)
  await page.locator('#player').evaluate((node) => {
    const player = node as HTMLVideoElement
    player.dispatchEvent(new Event('loadedmetadata'))
    player.dispatchEvent(new Event('timeupdate'))
  })
  await page.waitForTimeout(1200)
  const reportsBeforeReady = await page.evaluate(() => {
    return {
      count: (window as typeof window & { __playbackReports?: unknown[] }).__playbackReports?.length ?? 0,
      reports: [...((window as typeof window & { __playbackReports?: Array<{ manifestUrl: string }> }).__playbackReports ?? [])],
    }
  })
  expect(reportsBeforeReady.count).toBe(reportCountBeforeSeek)
  expect(reportsBeforeReady.reports.every((report) => report.manifestUrl === initialManifest)).toBe(true)

  releaseManifest?.()
  await expect.poll(async () => page.evaluate((count) => {
    document.querySelector<HTMLVideoElement>('#player')?.dispatchEvent(new Event('loadedmetadata'))
    return (window as typeof window & { __playbackReports?: unknown[] }).__playbackReports?.length ?? 0
  }, reportCountBeforeSeek), { timeout: 8000 }).toBeGreaterThan(reportCountBeforeSeek)
  const newRegionReport = await page.evaluate((count) => {
    const reports = (window as typeof window & { __playbackReports?: Array<{ manifestUrl: string; reporterId: string; sequence: number }> }).__playbackReports ?? []
    return reports.slice(count)[0]
  }, reportCountBeforeSeek)
  expect(newRegionReport?.manifestUrl).toBe(delayedManifestPath)
  expect(newRegionReport).toMatchObject({ reporterId: firstReport.reporterId })
  expect(newRegionReport?.sequence).toBeGreaterThan(firstReport.sequence)
})

test('recovery updates the current session without resetting or reloading playback', async ({ page }) => {
  let browserSocket: WebSocketRoute | undefined
  await page.routeWebSocket('/ws', (socket) => {
    browserSocket = socket
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()

  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await expect.poll(() => Boolean(browserSocket)).toBe(true)
  await page.locator('#player').evaluate(async (node) => {
    await (node as HTMLVideoElement).play()
  })
  await expect.poll(async () => page.locator('#player').evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0)

  const before = await readSyntheticPlaybackState(page)
  const recoveryPayload = await page.locator('#player').evaluate((node) => {
    const player = node as HTMLVideoElement
    const sessionId = player.dataset.sessionId ?? ''
    const manifestUrl = player.dataset.sessionManifestUrl ?? ''
    const startSeconds = Number(player.dataset.epochStartSeconds || '0')

    return {
      sessionId,
      status: 'recovering',
      message: 'Recovering an unreadable DVD area.',
      session: {
        id: sessionId,
        manifestUrl,
        timeline: { currentRange: { startSeconds, endSeconds: startSeconds + 30 } },
        recovery: { epoch: 1 },
      },
    }
  })
  browserSocket!.send(JSON.stringify({ type: 'session.recovery', payload: recoveryPayload }))

  await expect(page.locator('#player-status')).toHaveText('Recovering an unreadable DVD area.')
  await expect(page.locator('#player')).toHaveAttribute('data-recovery-epoch', '1')
  const after = await readSyntheticPlaybackState(page)
  expect(after.loadedSources).toEqual(before.loadedSources)
  expect(after.currentTime).toBeGreaterThanOrEqual(before.currentTime)
})

test('the latest seek response owns the playback region and keeps video-only mode', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch
    window.fetch = async (...args) => {
      const response = await originalFetch(...args)
      const body = args[1]?.body
      if (typeof body === 'string') {
        const payload: unknown = await response.clone().json()
        response.json = async () => payload
        // The message runs after the awaiting client's response continuation and microtasks.
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          document.documentElement.dataset.completedSeek = body
          channel.port1.close()
          channel.port2.close()
        }
        channel.port2.postMessage(null)
      }
      return response
    }
  })
  const pendingSeeks = new Map<number, Route>()
  await page.route(/\/api\/sessions\/[^/]+\/seek$/, async (route) => {
    const requestBody = route.request().postDataJSON() as { positionSeconds: number }
    pendingSeeks.set(requestBody.positionSeconds, route)
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page).toHaveURL(/\/player\//)
  await page.goto(`${page.url()}?videoOnly=1`)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')

  const sessionId = getSessionId(page.url())
  const { remoteTarget, laterRemoteTarget } = await readSeekTargets(page)
  await changeTitleSeek(page, remoteTarget)
  await expect.poll(() => pendingSeeks.has(remoteTarget)).toBe(true)
  await changeTitleSeek(page, laterRemoteTarget)
  await expect.poll(() => pendingSeeks.has(laterRemoteTarget)).toBe(true)

  await fulfillSeek(pendingSeeks.get(laterRemoteTarget)!, sessionId, laterRemoteTarget)
  await expect(page.locator('#player-status')).toHaveText(`Buffering from ${formatClock(laterRemoteTarget)}.`)
  await expect(page.locator('#player')).toHaveAttribute('data-epoch-start-seconds', String(laterRemoteTarget))
  await expect.poll(async () => {
    const state = await readSyntheticPlaybackState(page)
    const currentSource = new URL(state.loadedSources.at(-1) ?? '', page.url())
    return {
      region: currentSource.searchParams.get('region'),
      videoOnly: currentSource.searchParams.get('videoOnly'),
    }
  }).toEqual({ region: String(laterRemoteTarget), videoOnly: '1' })

  await fulfillSeek(pendingSeeks.get(remoteTarget)!, sessionId, remoteTarget)
  await expect(page.locator('html')).toHaveAttribute('data-completed-seek', JSON.stringify({ positionSeconds: remoteTarget }))
  const finalState = await readSyntheticPlaybackState(page)
  const finalSource = new URL(finalState.loadedSources.at(-1) ?? '', page.url())
  expect(finalSource.searchParams.get('region')).toBe(String(laterRemoteTarget))
  await expect(page.locator('#player')).toHaveAttribute('data-epoch-start-seconds', String(laterRemoteTarget))
  await expect(page.locator('#player-status')).toHaveText(`Buffering from ${formatClock(laterRemoteTarget)}.`)
})

test('a buffered-looking intent is still sent when an earlier server seek is pending', async ({ page }) => {
  const pendingSeeks = new Map<number, Route>()
  await page.route(/\/api\/sessions\/[^/]+\/seek$/, async (route) => {
    const requestBody = route.request().postDataJSON() as { positionSeconds: number }
    pendingSeeks.set(requestBody.positionSeconds, route)
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')

  const sessionId = getSessionId(page.url())
  const { remoteTarget, bufferedTarget } = await readSeekTargets(page)
  await changeTitleSeek(page, remoteTarget)
  await expect.poll(() => pendingSeeks.has(remoteTarget)).toBe(true)
  await changeTitleSeek(page, bufferedTarget)
  await expect.poll(() => pendingSeeks.has(bufferedTarget)).toBe(true)

  await fulfillSeek(pendingSeeks.get(remoteTarget)!, sessionId, remoteTarget)
  await fulfillSeek(pendingSeeks.get(bufferedTarget)!, sessionId, bufferedTarget)
  await expect(page.locator('#player-status')).toHaveText(`Buffering from ${formatClock(bufferedTarget)}.`)
  await expect.poll(async () => {
    const state = await readSyntheticPlaybackState(page)
    return new URL(state.loadedSources.at(-1) ?? '', page.url()).searchParams.get('region')
  }).toBe(String(bufferedTarget))
})

test('an already-available response reloads a server region the browser has not adopted', async ({ page }) => {
  const pendingSeeks = new Map<number, Route>()
  await page.route(/\/api\/sessions\/[^/]+\/seek$/, async (route) => {
    const requestBody = route.request().postDataJSON() as { positionSeconds: number }
    pendingSeeks.set(requestBody.positionSeconds, route)
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')

  const sessionId = getSessionId(page.url())
  const { remoteTarget } = await readSeekTargets(page)
  const alreadyAvailableTarget = remoteTarget + 2
  await changeTitleSeek(page, remoteTarget)
  await expect.poll(() => pendingSeeks.has(remoteTarget)).toBe(true)
  await changeTitleSeek(page, alreadyAvailableTarget)
  await expect.poll(() => pendingSeeks.has(alreadyAvailableTarget)).toBe(true)

  await fulfillSeek(pendingSeeks.get(remoteTarget)!, sessionId, remoteTarget)
  await fulfillSeek(pendingSeeks.get(alreadyAvailableTarget)!, sessionId, alreadyAvailableTarget, {
    action: 'already-available',
    region: remoteTarget,
    startSeconds: remoteTarget,
  })

  await expect(page.locator('#player-status')).toHaveText(`Buffering from ${formatClock(alreadyAvailableTarget)}.`)
  await expect(page.locator('#player')).toHaveAttribute('data-epoch-start-seconds', String(remoteTarget))
  await expect.poll(async () => {
    const state = await readSyntheticPlaybackState(page)
    const source = new URL(state.loadedSources.at(-1) ?? '', page.url())
    return { region: source.searchParams.get('region'), currentTime: state.currentTime }
  }).toEqual({ region: String(remoteTarget), currentTime: 2 })
})

test('leaving the player tears down hls and its shared event subscription', async ({ page }) => {
  let openedSockets = 0
  let closedSockets = 0
  await page.routeWebSocket('/ws', (socket) => {
    openedSockets += 1
    socket.onClose(() => {
      closedSockets += 1
    })
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await expect.poll(() => openedSockets).toBeGreaterThan(0)

  await page.getByRole('link', { name: 'Back to titles' }).click()

  await expect(page).toHaveURL('/')
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('synthetic-hls-destroyed'))).toBe('1')
  await expect.poll(() => closedSockets).toBeGreaterThan(0)
})

async function readSeekTargets(page: import('@playwright/test').Page): Promise<{
  bufferedTarget: number
  laterRemoteTarget: number
  remoteTarget: number
}> {
  return page.locator('#player').evaluate((node) => {
    const player = node as HTMLVideoElement
    const epochStart = Number(player.dataset.epochStartSeconds || '0')
    const duration = Number(player.dataset.durationSeconds || '0')
    const direction = duration - epochStart >= 180 ? 1 : -1

    return {
      bufferedTarget: epochStart + 5,
      remoteTarget: epochStart + (60 * direction),
      laterRemoteTarget: epochStart + (120 * direction),
    }
  })
}


function getSessionId(url: string): string {
  const match = /\/player\/([^/?#]+)/.exec(url)
  if (!match) {
    throw new Error(`Could not read session id from URL: ${url}`)
  }

  return match[1]
}

async function changeTitleSeek(page: import('@playwright/test').Page, positionSeconds: number): Promise<void> {
  await page.locator('#title-seek').evaluate((node, targetSeconds) => {
    const seekControl = node as HTMLInputElement
    seekControl.value = String(targetSeconds)
    seekControl.dispatchEvent(new Event('input', { bubbles: true }))
    seekControl.dispatchEvent(new Event('change', { bubbles: true }))
  }, positionSeconds)
}

async function fulfillSeek(
  route: Route,
  sessionId: string,
  positionSeconds: number,
  options: {
    action?: 'already-available' | 'restarted'
    region?: number
    startSeconds?: number
  } = {},
): Promise<void> {
  const region = options.region ?? positionSeconds
  const startSeconds = options.startSeconds ?? positionSeconds
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    json: {
      action: options.action ?? 'restarted',
      positionSeconds,
      session: {
        id: sessionId,
        manifestUrl: `/streams/${sessionId}/index.m3u8?region=${region}`,
        timeline: {
          currentRange: { startSeconds, endSeconds: startSeconds + 8 },
        },
        recovery: { epoch: 0 },
      },
    },
  })
}

async function readSyntheticPlaybackState(page: import('@playwright/test').Page): Promise<{
  currentTime: number
  loadedSources: string[]
}> {
  return page.locator('#player').evaluate((node) => {
    const state = (globalThis as typeof globalThis & {
      __syntheticHlsState?: { instances: Array<{ loadedSources: string[] }> }
    }).__syntheticHlsState

    return {
      currentTime: (node as HTMLVideoElement).currentTime,
      loadedSources: [...(state?.instances.at(-1)?.loadedSources ?? [])],
    }
  })
}
for (const failure of ['conflict', 'network'] as const) {
  test(`a failed ${failure} seek adopts the server region`, async ({ page }) => {
    let browserSocket: WebSocketRoute | undefined
    await page.routeWebSocket('/ws', (socket) => { browserSocket = socket })
    await installSyntheticHls(page)
    await openReadyCatalog(page)
    await page.getByRole('button', { name: 'Start Stream' }).first().click()
    await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
    const sessionId = getSessionId(page.url())
    const session = {
      id: sessionId,
      manifestUrl: `/streams/${sessionId}/index.m3u8?region=999`,
      timeline: { currentRange: { startSeconds: 120, endSeconds: 128 } },
      recovery: { epoch: 2 },
    }
    await page.route(`/api/sessions/${sessionId}`, (route) => route.fulfill({ json: session }))
    await page.route(`/api/sessions/${sessionId}/seek`, (route) => failure === 'conflict'
      ? route.fulfill({ status: 409, json: { error: 'seek failed' } })
      : route.abort('failed'))
    await changeTitleSeek(page, 180)
    await expect(page.locator('#player')).toHaveAttribute('data-epoch-start-seconds', '120')
    await expect.poll(async () => (await readSyntheticPlaybackState(page)).loadedSources.at(-1)).toBe(session.manifestUrl)
    await expect(page.locator('#title-current-time')).toHaveText('2:00')
    await expect.poll(() => Boolean(browserSocket)).toBe(true)
    browserSocket!.send(JSON.stringify({ type: 'session.recovery', payload: {
      sessionId, session, message: 'Recovered the adopted region.',
    } }))
    await expect(page.locator('#player-status')).toHaveText('Recovered the adopted region.')
  })
}

for (const errorType of ['mediaError', 'networkError', 'otherError', 'native']) {
  test(`fatal ${errorType} offers retry and preserves position`, async ({ page }) => {
    await installSyntheticHls(page)
    await openReadyCatalog(page)
    await page.getByRole('button', { name: 'Start Stream' }).first().click()
    await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
    await page.locator('#player').evaluate((node, type) => {
      const video = node as HTMLVideoElement
      video.currentTime = 7
      if (type === 'native') {
        Object.defineProperty(video, 'error', { value: { code: 3, message: 'decoder failed' } })
        video.dispatchEvent(new Event('error'))
      } else {
        const state = (globalThis as typeof globalThis & {
          __syntheticHlsState?: { instances: Array<{ emit(event: string, data: unknown): void }> }
        }).__syntheticHlsState
        state?.instances.at(-1)?.emit('hlsError', { fatal: true, type, details: 'decoder failed' })
      }
    }, errorType)
    await expect(page.getByRole('button', { name: 'Retry playback' })).toBeVisible()
    await expect(page.locator('#player-status')).toContainText('decoder failed')
    await page.getByRole('button', { name: 'Retry playback' }).click()
    await expect(page.getByRole('button', { name: 'Retry playback' })).toBeHidden()
    await expect.poll(async () => (await readSyntheticPlaybackState(page)).currentTime).toBeGreaterThanOrEqual(7)
    await expect.poll(async () => page.locator('#player').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(false)
    await expect.poll(async () => page.evaluate(() => {
      const state = (globalThis as typeof globalThis & {
        __syntheticHlsState?: { instances: Array<{ destroyed?: boolean }> }
      }).__syntheticHlsState
      return state?.instances.filter((instance) => !instance.destroyed).length
    })).toBe(1)
  })
}

test('persisted pageshow restores playback position and log subscription', async ({ page }) => {
  let browserSocket: WebSocketRoute | undefined
  await page.routeWebSocket('/ws', (socket) => { browserSocket = socket })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  const navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame())
  await page.locator('#player').evaluate((node) => {
    ;(node as HTMLVideoElement).currentTime = 9
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  await navigation
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await expect.poll(async () => (await readSyntheticPlaybackState(page)).currentTime).toBe(9)
  await expect.poll(() => Boolean(browserSocket)).toBe(true)
  browserSocket!.send(JSON.stringify({ type: 'server.log', payload: { message: 'restored log subscription' } }))
  await expect(page.locator('#server-log-output')).toContainText('restored log subscription')
  const restoredEpoch = await page.locator('#player').getAttribute('data-epoch-start-seconds')
  await changeTitleSeek(page, Number(restoredEpoch) + 5)
  await expect(page.locator('#player-status')).toHaveText('Playing from the existing buffer.')
})

test('terminal session failure stops stale playback and offers return to titles', async ({ page }) => {
  let browserSocket: WebSocketRoute | undefined
  await page.routeWebSocket('/ws', (socket) => {
    browserSocket = socket
  })
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()
  await expect(page).toHaveURL(/\/player\//)
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')
  await expect.poll(() => Boolean(browserSocket)).toBe(true)
  await page.locator('#player').evaluate(async (node) => {
    await (node as HTMLVideoElement).play()
  })

  browserSocket!.send(JSON.stringify({
    type: 'session.updated',
    payload: { id: 'another-session', state: 'failed', error: { message: 'unrelated failure' } },
  }))
  await expect(page.locator('#player-status')).toHaveText('Using hls.js fallback.')

  browserSocket!.send(JSON.stringify({
    type: 'session.updated',
    payload: {
      id: await page.locator('#player').getAttribute('data-session-id'),
      state: 'failed',
      error: { message: 'Playback stopped after repeated unreadable DVD sectors.', detail: 'The drive remained unreadable.' },
    },
  }))

  await expect(page.locator('#player-status')).toHaveText('Playback failed: Playback stopped after repeated unreadable DVD sectors.')
  await expect(page.getByRole('link', { name: 'Back to titles' })).toBeVisible()
  await expect.poll(() => page.locator('#player').evaluate((node) => (node as HTMLVideoElement).src)).toBe('')
  await expect.poll(() => page.locator('#player').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
})
