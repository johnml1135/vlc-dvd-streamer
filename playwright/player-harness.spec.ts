import { expect, test } from '@playwright/test'
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
  const seekResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === 'POST'
      && response.url().includes(`/api/sessions/${sessionId}/seek`)
  })

  await page.locator('#title-seek').evaluate((node, targetSeconds) => {
    const seekControl = node as HTMLInputElement
    seekControl.value = String(targetSeconds)
    seekControl.dispatchEvent(new Event('input', { bubbles: true }))
    seekControl.dispatchEvent(new Event('change', { bubbles: true }))
  }, 60)

  const seekResponse = await seekResponsePromise
  expect(seekResponse.ok()).toBe(true)
  const seekBody = await seekResponse.json()

  expect(seekBody).toMatchObject({ action: 'restarted', positionSeconds: 60 })
  await expect(page.locator('#player-status')).toHaveText('Buffering from 1:00.')
  await expect(page.locator('#title-current-time')).toHaveText('1:00')

  const sessionResponse = await request.get(`/api/sessions/${sessionId}`)
  expect(sessionResponse.ok()).toBe(true)
  await expect.poll(async () => {
    const session = await (await request.get(`/api/sessions/${sessionId}`)).json()
    return session.timeline.currentRange.startSeconds
  }, { timeout: 5000 }).toBe(60)
})

function getSessionId(url: string): string {
  const match = /\/player\/([^/?#]+)/.exec(url)
  if (!match) {
    throw new Error(`Could not read session id from URL: ${url}`)
  }

  return match[1]
}