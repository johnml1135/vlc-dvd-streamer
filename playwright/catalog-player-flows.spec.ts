import { expect, test } from '@playwright/test'
import { openReadyCatalog } from './helpers/catalog.js'
import { installSyntheticHls } from './helpers/synthetic-hls.js'

test('catalog toggles extra titles on demand', async ({ page }) => {
  await openReadyCatalog(page)

  await expect(page.getByRole('heading', { name: 'Title 1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Title 3' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Show extras' }).click()
  await expect(page.getByRole('heading', { name: 'Title 3' })).toBeVisible()

  await page.getByRole('link', { name: 'Hide extras' }).click()
  await expect(page.getByRole('heading', { name: 'Title 3' })).toHaveCount(0)
})

test('starting with subtitles off returns home and stops the active session', async ({ page, request }) => {
  await installSyntheticHls(page)
  await openReadyCatalog(page)
  await page.getByRole('button', { name: 'Start Stream' }).first().click()

  await expect(page).toHaveURL(/\/player\//)
  const sessionId = getSessionId(page.url())
  const sessionResponse = await request.get(`/api/sessions/${sessionId}`)
  expect(sessionResponse.ok()).toBe(true)
  const session = await sessionResponse.json()

  expect(session.audioTrack).toBeUndefined()
  expect(session.subtitleTrack).toBeUndefined()

  await page.getByRole('link', { name: 'Back to titles' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Active stream')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open player' })).toBeVisible()

  await page.locator('.active-banner').getByRole('button', { name: 'Stop Stream' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Active stream')).toHaveCount(0)
})

test('selected audio and subtitles carry into the session and a new title replaces it', async ({ page, request }) => {
  await installSyntheticHls(page)
  await openReadyCatalog(page)

  const firstCard = page.locator('.title-card').first()
  await firstCard.getByLabel('Audio').selectOption('2')
  await firstCard.getByLabel('Subtitles').selectOption('1')
  await firstCard.getByRole('button', { name: 'Start Stream' }).click()

  await expect(page).toHaveURL(/\/player\//)
  const firstSessionId = getSessionId(page.url())
  const firstSessionResponse = await request.get(`/api/sessions/${firstSessionId}`)
  expect(firstSessionResponse.ok()).toBe(true)
  const firstSession = await firstSessionResponse.json()

  expect(firstSession.audioTrack).toBe(2)
  expect(firstSession.subtitleTrack).toBe(1)
  expect(firstSession.titleNumber).toBe(1)

  await page.getByRole('link', { name: 'Back to titles' }).click()
  await page.locator('.title-card').nth(1).getByRole('button', { name: 'Start Stream' }).click()

  await expect(page).toHaveURL(/\/player\//)
  const secondSessionId = getSessionId(page.url())
  expect(secondSessionId).not.toBe(firstSessionId)

  const secondSessionResponse = await request.get(`/api/sessions/${secondSessionId}`)
  expect(secondSessionResponse.ok()).toBe(true)
  const secondSession = await secondSessionResponse.json()

  expect(secondSession.titleNumber).toBe(2)
  expect(secondSession.audioTrack).toBeUndefined()
  expect(secondSession.subtitleTrack).toBeUndefined()

  const previousSessionResponse = await request.get(`/api/sessions/${firstSessionId}`)
  expect(previousSessionResponse.ok()).toBe(true)
  const previousSession = await previousSessionResponse.json()

  expect(previousSession.state).toBe('stopped')
})

function getSessionId(url: string): string {
  const match = /\/player\/([^/?#]+)/.exec(url)
  if (!match) {
    throw new Error(`Could not read session id from URL: ${url}`)
  }

  return match[1]
}