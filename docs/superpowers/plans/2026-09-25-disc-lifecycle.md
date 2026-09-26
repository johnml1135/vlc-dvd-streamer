# Disc Lifecycle Findings Implementation Plan

> **For agentic workers:** Execute each finding as a red/green test-first slice. This task is already authorized for inline execution.

**Goal:** Fix the selected lifecycle findings and product decisions in the `fix-disc` worktree, with bounded process ownership and clear user-facing failures.

**Architecture:** Keep browser behavior in the existing UI assets, scanner completeness in the scanner/IFO reader boundary, and thumbnail scheduling in an HTTP helper. Reuse a process identity reader for manual-server PID validation and a cache-local VLC PID registry; startup sweeps only matching PID/start-time pairs.

**Tech Stack:** TypeScript, Vitest, Fastify injection, Playwright, Node child processes, Windows PowerShell process identity.

---

### Task 1: D2 terminal playback state

**Files:** `src/ui/browser-playback.ts`, `playwright/player-harness.spec.ts`.

- [ ] Add a Playwright test that sends a matching failed `session.updated` event and expects the terminal reason, a catalog link, and detached media.
- [ ] Run `npm run test:e2e -- --grep "terminal session failure"`; verify it fails because the event is ignored.
- [ ] Handle matching failed/stopped updates, invalidate outstanding work, abort reports, destroy HLS/native media, and show the server reason plus a return-to-catalog action.
- [ ] Rerun the focused E2E and verify it passes.

### Task 2: D3 partial IFO catalog detection

**Files:** `src/disc/ifo-reader.ts`, `src/vlc/disc-scanner.ts`, `test/unit/disc/ifo-reader.test.ts`, `test/unit/vlc/disc-scanner.test.ts`.

- [ ] Add a synthetic VMGI/VTS test where the table names two titles and one VTS is missing; assert the detailed IFO result reports an incomplete title set.
- [ ] Add a scanner test that an incomplete IFO result falls back to VLC and returns its recovered title set.
- [ ] Run both focused tests; verify the completeness assertion fails before implementation.
- [ ] Add detailed expected/decoded/skipped title metadata while preserving the existing titles-only reader API; make the scanner fall back on incomplete results.
- [ ] Rerun focused tests and then the scanner/IFO test files.

### Task 3: D5 thumbnail single-flight and process cap

**Files:** `src/http/thumbnail-jobs.ts` (new), `src/http/routes/api-routes.ts`, `test/unit/http/thumbnail-jobs.test.ts` (new), `test/integration/thumbnail-route.integration.test.ts`.

- [ ] Add tests for same-key single-flight and a maximum of two active jobs across distinct keys; run the focused file and verify the assertions fail before the helper exists.
- [ ] Add an in-memory job coordinator keyed by disc ID/title, with a two-job global cap and queued work.
- [ ] Route cache misses through the coordinator; retain placeholder behavior after job failure.
- [ ] Add route tests with a deferred worker for same-title overlap and 50 distinct title requests; verify at most two worker calls are active and duplicate calls share one result.
- [ ] Run focused unit and integration tests.

### Task 4: D20 thumbnail response MIME

**Files:** `src/http/routes/api-routes.ts`, `test/integration/thumbnail-route.integration.test.ts`.

- [ ] Assert cached JPEG responses use `image/jpeg` and generated PNG placeholders use `image/png`; verify the cached assertion fails first.
- [ ] Select response MIME from the cached file path and preserve PNG for placeholders.
- [ ] Rerun the thumbnail route tests.

### Task 5: D11 browser event reconnection

**Files:** `src/ui/browser-events.ts`, `test/unit/browser-events.test.ts`.

- [ ] Add a fake-timer test where an existing listener receives an event after its socket closes and the capped-backoff replacement socket opens; verify it fails before implementation.
- [ ] Reconnect while subscribers remain, cap retry delay, reset delay after open, and cancel pending timers when the final subscriber unsubscribes.
- [ ] Rerun the browser event unit tests.

### Task 6: D12 and Q4 HTML failure/retry flows

**Files:** `src/ui/page.ts`, `src/http/routes/ui-routes.ts`, `test/integration/action-routes.integration.test.ts`, `test/unit/page.test.ts`.

- [ ] Add action-route tests proving failed playback and failed refresh return HTML with the exact busy message and a `Retry` form; verify they fail before implementation.
- [ ] Add a reusable escaped HTML retry page; preserve playback request values in the retry form and submit refresh only on a user click.
- [ ] Await one refresh attempt in the refresh action, map the busy error to “The DVD drive is in use by another program”, and do not add polling.
- [ ] Show the same busy message and Retry control for a failed initial catalog scan; keep normal catalog success redirect behavior.
- [ ] Rerun focused integration/page tests and relevant Playwright tests.

### Task 7: D14 manual-server PID identity

**Files:** `src/runtime/process-identity.ts` (new), `src/runtime/manual-server-control.ts`, `scripts/manual-server.ts`, `test/unit/manual-server-control.test.ts`.

- [ ] Add pure tests for matching PID/start-time/executable identity and rejecting stale or unrelated live PIDs; verify they fail before helper implementation.
- [ ] Read Windows process executable, command line, and creation time by numeric PID; persist the observed creation time in server state.
- [ ] Refuse “already running” and stop operations unless stored and live identities match; delete only stale state files.
- [ ] Rerun the focused unit test and typecheck.

### Task 8: Q5 VLC orphan registry

**Files:** `src/vlc/process-registry.ts` (new), `src/vlc/process-supervisor.ts`, `src/server.ts`, `test/unit/vlc/process-registry.test.ts` (new).

- [ ] Add tests proving the cache-local PID file stores PID/start time, startup kills only exact live matches, and mismatched/reused PIDs are retained from being killed; verify tests fail before implementation.
- [ ] Track VLC executable spawns and remove entries on close; serialize PID-file mutations.
- [ ] Sweep matching entries before server services start, then install tracking hooks for future VLC children.
- [ ] Rerun focused tests, server tests, and inspect the only `server.ts` edit for startup locality.

### Final verification and handoff

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e` from this worktree.
- [ ] Run `git diff --check` and confirm only intended worktree files changed.
- [ ] Append intended commit messages and their file lists to `.cache/commits.md`; leave changes uncommitted.
