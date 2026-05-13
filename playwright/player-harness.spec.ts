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