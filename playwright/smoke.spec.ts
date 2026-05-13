import { expect, test } from '@playwright/test'

test('homepage renders catalog and starts a session', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'DVD Streamer' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Title 1' })).toBeVisible()

  await page.getByRole('button', { name: 'Start Stream' }).first().click()

  await expect(page).toHaveURL(/\/player\//)
  await expect(page.getByText('Manifest URL')).toBeVisible()
})