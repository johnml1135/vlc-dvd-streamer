import { expect, type Page } from '@playwright/test'

export async function openReadyCatalog(page: Page): Promise<void> {
  await page.goto('/')

  const titleHeading = page.getByRole('heading', { name: 'Title 1' })
  if (await titleHeading.count() === 0) {
    const refreshButton = page.getByRole('button', { name: 'Refresh Disc' })
    if (await refreshButton.count() > 0) {
      await refreshButton.click()
    }
  }

  await expect.poll(async () => {
    if (await titleHeading.count() > 0) {
      return true
    }

    await page.reload()
    return await titleHeading.count() > 0
  }, { timeout: 15_000, intervals: [250, 500, 1000] }).toBe(true)
  await expect(titleHeading).toBeVisible()
}
