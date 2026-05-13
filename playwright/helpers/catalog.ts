import { expect, type Page } from '@playwright/test'

export async function openReadyCatalog(page: Page): Promise<void> {
  await page.goto('/')

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const titleHeading = page.getByRole('heading', { name: 'Title 1' })
    if (await titleHeading.count() > 0) {
      await expect(titleHeading).toBeVisible()
      return
    }

    const refreshButton = page.getByRole('button', { name: 'Refresh Disc' })
    if (await refreshButton.count() > 0) {
      await refreshButton.click()
    } else {
      await page.reload()
    }
  }

  await expect(page.getByRole('heading', { name: 'Title 1' })).toBeVisible()
}