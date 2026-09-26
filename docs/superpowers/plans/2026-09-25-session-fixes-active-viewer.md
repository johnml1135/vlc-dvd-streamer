# Session Fixes and Active Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the seven session findings and enforce one server-owned Active viewer per Playback session, including passive pages, takeover, inactivity takeover, and rejected non-owner feedback.

**Architecture:** Keep session lifetime and viewer ownership in `SessionManager`, whose existing controller map owns Playback sessions. Add a viewer token per rendered player page, explicit attach/takeover endpoints, and a viewer-change event; browser playback starts only after ownership is granted and tears down immediately when ownership changes. Keep the existing bounded tombstone, storage lease, and session intent work localized.

**Tech Stack:** TypeScript, Fastify, Vitest, Playwright, EventHub, synthetic HLS fixture.

---

### Task 1: Verify S1–S7 against the WIP and its parent

**Files:**
- Inspect: `src/session/playback-session.ts`, `src/session/session-manager.ts`, `src/session/session-storage.ts`, `src/http/routes/ui-routes.ts`, `src/ui/browser-playback.ts`
- Test: `test/integration/session-initial-recovery.integration.test.ts`
- Test: `test/integration/session-lifecycle.integration.test.ts`
- Test: `test/unit/session/session-storage.test.ts`
- Test: `test/integration/api.integration.test.ts`
- Test: `test/unit/browser-playback.test.ts`

- [ ] Run S1 first-slot recovery, S2 live-edge seek, S3 positive restart cap, S4 ten tombstones, S5 guarded sweep, S6 ended-page redirect, and S7 superseding-start tests against the pre-WIP source with the WIP regression tests copied into a disposable directory under `.cache/`.
- [ ] Run the same seven focused tests against the WIP source and retain only changes required by a failing assertion.
- [ ] Keep readiness bounded by its existing overall startup deadline and verify the unreadable slot 1 case resumes at slot 2.

Run focused suites: `npm test -- test/integration/session-initial-recovery.integration.test.ts test/integration/session-lifecycle.integration.test.ts test/unit/session/session-storage.test.ts test/integration/api.integration.test.ts test/unit/browser-playback.test.ts`.

Expected: the pre-WIP regression cases fail on the relevant behavior; all seven pass on the WIP source.

### Task 2: Add server-side Active viewer ownership

**Files:**
- Modify: `src/session/session-manager.ts`
- Modify: `src/http/app-types.ts`
- Test: `test/unit/session/viewer-ownership.test.ts`

- [ ] Write unit tests proving first attach owns the session, another token is passive, explicit takeover transfers ownership, and a different token silently takes over after 15 seconds without accepted feedback.
- [ ] Run `npm test -- test/unit/session/viewer-ownership.test.ts` and confirm the missing ownership API fails the assertions.
- [ ] Add `attachViewer(sessionId, viewerToken)`, `takeOverViewer(sessionId, viewerToken)`, and token-gated `reportPlayback(sessionId, viewerToken, report)` behavior to `SessionManager`; publish `session.viewer` with `{ sessionId, activeViewerToken }` whenever ownership changes.
- [ ] Refresh owner activity only after the controller accepts Playback feedback; reject missing, stale, and non-owner tokens without calling the controller or changing Runway evidence.
- [ ] Remove ownership state when its Playback session is retired and run the ownership unit tests green.

### Task 3: Expose ownership through HTTP and player rendering

**Files:**
- Modify: `src/http/routes/api-routes.ts`
- Modify: `src/http/routes/ui-routes.ts`
- Modify: `src/http/app-types.ts`
- Modify: `src/ui/page.ts`
- Test: `test/integration/playback-feedback.integration.test.ts`
- Test: `test/integration/api.integration.test.ts`

- [ ] Add integration tests for attach/takeover status, event publication, and HTTP 409 when an old page submits Playback feedback after takeover.
- [ ] Run the new route tests and confirm missing viewer endpoints and missing token enforcement fail.
- [ ] Generate a cryptographically random viewer token for each player page and include it in the rendered page without embedding it in stream URLs.
- [ ] Add `POST /api/sessions/:sessionId/viewer/attach` and `POST /api/sessions/:sessionId/viewer/takeover`, validate session IDs and non-empty tokens, and return `{ active: boolean }`.
- [ ] Require the token in `/playback` feedback and map a non-owner result to HTTP 409; run route tests green.

### Task 4: Make the browser page passive until it owns playback

**Files:**
- Modify: `src/ui/page.ts`
- Modify: `src/ui/browser-playback.ts`
- Test: `test/unit/browser-playback.test.ts`

- [ ] Add unit tests proving a passive page does not attach a manifest or send feedback, explicit takeover activates playback, and loss of ownership pauses/detaches playback and stops feedback.
- [ ] Run the focused browser tests to observe these failures before implementation.
- [ ] Gate stream attachment, seeks, and feedback on the server response to the page's attach call; include the viewer token in each Playback report.
- [ ] Handle `session.viewer` events by activating only the page whose token now owns playback and deactivating every page whose token lost ownership.
- [ ] Render the passive prompt `Playing on another device — Take over?` and the previous owner's `Watching elsewhere — Take back` control; run browser unit tests green.

### Task 5: Verify two-page ownership in Playwright

**Files:**
- Modify: `playwright/catalog-player-flows.spec.ts`
- Reuse: `playwright/helpers/synthetic-hls.ts`

- [ ] Add a two-page browser test that starts one Playback session, opens its player URL in a second page, confirms the second page is passive and sends no Playback feedback, then takes over and confirms the first page becomes passive.
- [ ] Run the new Playwright case against the existing behavior and confirm it fails on the missing passive/takeover contract.
- [ ] Run the case green and verify the test server uses only the synthetic worker fixture; never access a physical drive.

### Task 6: Run required gates and record lead handoff

**Files:**
- Modify: `.cache/commits.md`

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e` from this worktree.
- [ ] Append intended commit subject(s) and their exact file lists to `.cache/commits.md`; do not create a commit.
- [ ] Report each S-item, Active viewer behavior, test evidence, files changed, and each gate's exact result.
