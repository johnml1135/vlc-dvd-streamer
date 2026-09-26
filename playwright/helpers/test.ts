import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'
export type { Route, WebSocketRoute } from '@playwright/test'

/**
 * Stops every Playback session a test's page visited. Specs start the same
 * title, so a surviving session would hand the next test's page an Active
 * viewer it cannot see (a closed context does not reliably fire pagehide).
 */
export const test = base.extend<{ stopVisitedSessions: void }>({
  stopVisitedSessions: [async ({ page, request }, use) => {
    const sessionIds = new Set<string>()
    page.on('framenavigated', (frame) => {
      const match = /\/player\/([^/?#]+)/.exec(frame.url())
      if (match?.[1]) sessionIds.add(decodeURIComponent(match[1]))
    })
    await use()
    for (const sessionId of sessionIds) {
      await request.delete(`/api/sessions/${encodeURIComponent(sessionId)}`).catch(() => {})
    }
  }, { auto: true }],
})
