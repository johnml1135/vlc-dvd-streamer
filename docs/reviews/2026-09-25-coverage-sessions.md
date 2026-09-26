# Coverage review: playback sessions and recovery

Date: 2026-09-25  
Scope: `src/session/*`, VLC worker/process supervision, playback and stream routes, browser playback, related unit/integration tests and Playwright flows.

## Summary

- Existing coverage is strong for ordinary seeks, immutable HLS publication, recovery ordering, runway feedback, and cancellation after work has started.
- An unreadable first slot never reaches the recovery monitor; the session waits for initial readiness and then fails.
- Browser seeks at the current buffered end are treated as local even though the server's playable range excludes that endpoint; restart exhaustion also allows one extra failed restart.
- Stopped sessions remain in memory, stale session directories are not swept at server startup, and reopening a stopped player URL renders a dead player; `.cache/sessions` currently has 55 directories.
- Review was read-only; no tests were run and no physical DVD/VLC operation was attempted. Only this report is new.

## Coverage inventory

| behaviour | covered? | test file | level |
|---|---|---|---|
| Same-request double start/reuse, replacement, stop | Covered for same-request concurrency and sequential replacement; no A→B→A or different request during A startup | `test/integration/session-manager.integration.test.ts`, `test/integration/session-lifecycle.integration.test.ts`, `playwright/catalog-player-flows.spec.ts` | Integration, e2e |
| Startup readiness, deadline, malformed/missing output, early VLC exit | Covered with injected workers and a readiness deadline; no real child that hangs silently | `test/integration/session-readiness.integration.test.ts`, `test/integration/session-damaged-disc.integration.test.ts` | Integration |
| Stop before readiness; stop while recovery is active | Partial: deferred restart and placeholder ownership are exercised, but no direct start-then-stop-before-ready assertion | `test/integration/session-lifecycle.integration.test.ts` | Integration |
| Seek inside/current window, remote seek, successive seeks, title-time slots | Covered for normal positions and sequential seeks; exact buffer/live-edge boundary, 0, and title-end behavior are not exercised through the browser | `test/unit/session/timeline.test.ts`, `test/integration/session-seek-timeline.integration.test.ts`, `test/unit/browser-playback.test.ts`, `playwright/player-harness.spec.ts` | Unit, integration, e2e |
| Seek/recovery races and latest browser seek response | Covered for a queued seek invalidating recovery, stop during deferred restart, and competing browser seek responses; no high-volume seek burst | `test/integration/session-recovery-ordering.integration.test.ts`, `test/integration/session-lifecycle.integration.test.ts`, `playwright/player-harness.spec.ts` | Integration, e2e |
| Consecutive unreadable slots, retry/runway policy, one transient self-recovery | Strong in-memory coverage of a three-slot scratch, drained/healthy runway, retries, and one self-healing stall; no second stall after resume | `test/integration/session-bad-sector-recovery.integration.test.ts`, `test/integration/session-runway-recovery.integration.test.ts` | Integration |
| Bad sector at title time 0, final slot, or immediately after seek | Missing as explicit cases. Startup currently fails before monitoring when slot 1 cannot produce a valid segment | `test/integration/session-bad-sector-recovery.integration.test.ts` has only a middle scratch | Integration gap |
| Restart-failure cap / VLC death mid-play | Exhaustion is exercised only with `maxAttempts: 0`; no exact positive cap assertion or mid-play process-death profile | `test/integration/session-lifecycle.integration.test.ts`, `test/integration/vlc/hls-session-lifetime.integration.test.ts` | Integration |
| Placeholder commit/cancellation, HLS partial files, immutable old regions/revisions | Strong publication-level coverage. Null-packet fallback when no rendered/custom placeholder exists has no direct assertion | `test/integration/hls-publication.integration.test.ts` | Integration |
| Playback feedback validation, freshness, throttling, disposal | Strong unit/integration/e2e coverage; reports from multiple reporters are covered in the evidence unit test | `test/unit/runway-evidence.test.ts`, `test/integration/playback-feedback.integration.test.ts`, `test/unit/browser-playback.test.ts`, `playwright/player-harness.spec.ts` | Unit, integration, e2e |
| Leaving player, BFCache return, inactivity stop | Browser teardown and persisted-page reload are covered; inactivity is tested with a fake clock, but reopening the expired player URL is not | `playwright/player-harness.spec.ts`, `test/integration/session-lifecycle.integration.test.ts` | Integration, e2e |
| Two tabs sharing one session; runtime audio/subtitle changes | Missing. Same session can be reused, but player ignores `session.updated`; there is no runtime track-change endpoint/control | `playwright/catalog-player-flows.spec.ts`, `src/http/routes/api-routes.ts` | No multi-tab/runtime-track test |
| Stopped/replaced stream URLs, 404 vs 410, byte ranges | Partial: missing asset and wrong generation return 404; old region publication is tested below the route. No stopped/replaced route or Range request contract test | `test/integration/api.integration.test.ts`, `test/integration/hls-publication.integration.test.ts` | Integration gap |
| File/process cleanup, server restart | Normal stop, failed startup, inactivity, and deferred worker cleanup are tested. No startup sweep or forced-parent-exit/orphan-process test | `test/integration/session-lifecycle.integration.test.ts`, `test/unit/vlc/process-supervisor.test.ts` | Integration, unit gap |

## Findings ranked by severity

### P1 — S1. An unreadable first slot cannot be recovered

- **Scenario:** Start a title whose first two-second slot is unreadable, then the disc becomes readable at slot 2.
- **Current behaviour:** Startup waits for the first valid published segment at `playback-session.ts:514–530` and only starts the recovery monitor after readiness succeeds at `playback-session.ts:520–524`. A no-output first slot therefore ends in readiness timeout or early-exit cleanup; placeholder/retry recovery never runs. The existing damaged-disc startup test covers a fatal unreadable stream, not a first-slot scratch that clears at slot 2.
- **Classification:** Confirmed recovery gap with user-visible playback failure.
- **Proposed test:** Integration case in `test/integration/session-bad-sector-recovery.integration.test.ts`; use a deterministic in-memory worker that remains alive with no slot-1 output and emits slot 2 after a restart. No fake profile or physical drive required. Also run a real-argv `stall-then-resume` variant if that profile can model an initial-slot stall.
- **Proposed fix:** Apply a bounded startup stall/recovery policy before declaring readiness failure: distinguish a live producer stalled at slot 1 from a process that died or a silent startup hang, publish slot 1 as a placeholder only after the existing retry/closure checks, then restart at slot 2. Preserve the overall readiness deadline for a process that never makes progress.
- **Effort:** M.

### P2 — S2. Seeking to the buffered end is incorrectly handled locally

- **Scenario:** With a region buffered through 8 seconds, seek to exactly 8 seconds, the next slot boundary at the live edge.
- **Current behaviour:** `browser-playback.ts:112–122` treats `titleSeconds === buffered.end()` as buffered (`<=`), and `seekTitleTo` then sets `video.currentTime` and returns without calling the server at `browser-playback.ts:410–415`. The server timeline defines ranges as half-open (`timeline.ts:98–99`), so 8 seconds is outside `[start, end)` and needs a server seek/restart. The current browser unit test only seeks to an interior buffered time.
- **Classification:** Confirmed bug; an exact live-edge seek can leave playback waiting at the end of its available media.
- **Proposed test:** Add a unit case in `test/unit/browser-playback.test.ts` with `buffered=[0,8]` and seek target 8; assert `POST /api/sessions/:id/seek` is issued. No fake profile needed.
- **Proposed fix:** Treat buffered intervals as half-open for title-time containment (`titleSeconds < endSeconds`) and keep the equality case on the remote seek path.
- **Effort:** S.

### P2 — S3. `maxAttempts` permits one more failed restart than configured

- **Scenario:** Configure `maxAttempts: 2`; every recovery restart fails.
- **Current behaviour:** The option is described as the maximum failed restarts before exhaustion in `playback-session.ts:109–110`. The failure counter increments at line 949, but exhaustion checks `restartFailures > maxAttempts` at lines 949–954. It consequently exhausts on failure 3, not failure 2. The existing exhaustion test uses `maxAttempts: 0`, which cannot reveal the positive-boundary discrepancy.
- **Classification:** Confirmed off-by-one against the option contract.
- **Proposed test:** Extend `test/integration/session-lifecycle.integration.test.ts` with `maxAttempts: 2` and a worker that succeeds initially but throws on each restart; assert exhaustion occurs on exactly the configured number of failed restarts. Use the in-memory worker fixture, no fake profile.
- **Proposed fix:** Compare against the documented cap (`>=`) after incrementing, or rename/document the option if the intended value counts retries after the configured number of failures.
- **Effort:** S.

### P2 — S4. Stopped session controllers accumulate in memory

- **Scenario:** Start and stop or replace many titles during a long server uptime.
- **Current behaviour:** `SessionManager.sessions` is an unbounded map (`session-manager.ts:19`); `stop` and `cleanupInactive` stop controllers but do not remove them (`session-manager.ts:86–113`). Each retained controller keeps its timeline, recovery state, and publication maps for the session's assets. The stopped snapshot is intentionally still returned by `getSession`, but there is no retention limit.
- **Classification:** Confirmed unbounded in-process retention; likely memory growth proportional to sessions played and slots published.
- **Proposed test:** Add a manager lifecycle test that plays/stops many sessions and asserts a documented bounded tombstone/history policy. Use a temp cache and deterministic in-memory worker; no fake profile.
- **Proposed fix:** Retain only a bounded/TTL status tombstone after stop, releasing the controller/publication maps and allowing old IDs to become not found after that retention window.
- **Effort:** M.

### P2 — S5. Server startup does not sweep crash-left session directories

- **Scenario:** A process is terminated before its normal stop hook, then the server starts again with the same cache directory.
- **Current behaviour:** Startup creates the cache root at `server.ts:14–15` and later creates a new in-memory `SessionManager` at lines 86–102. Inactivity cleanup only walks controllers in that process's map (`session-manager.ts:102–113`), so directories from a prior process are undiscoverable. The current main checkout has **55** directories under `.cache/sessions`.
- **Classification:** Confirmed disk-leak path after crash/restart. A child VLC process surviving forced parent termination is also plausible but not verified by the inspected tests.
- **Proposed test:** Add a filesystem-level startup cleanup test using a temp `CACHE_DIR` prepopulated with stale session directories and unrelated cache/log files; assert only stale session data is removed before serving. No VLC profile needed. Separately add a child-process parent-exit test before claiming orphan VLC cleanup works.
- **Proposed fix:** Add a guarded startup sweep for stale session directories, and decide how to handle VLC children after an unclean host exit (for example, a Windows job/process ownership mechanism). Do not sweep while another server instance may own the cache.
- **Effort:** M for stale files; L if crash-safe process ownership is included.

### P2 — S6. Reopening a stopped/expired player URL renders a dead player

- **Scenario:** Leave playback idle until cleanup stops it, then reopen the old `/player/:sessionId` URL from history or a bookmark.
- **Current behaviour:** The player route checks only whether a session record exists, touches it, and renders the player (`ui-routes.ts:65–85`). `touch()` does not revive stopped sessions (`playback-session.ts:243–254`), and a retired publication returns no assets (`hls-publication.ts:221–239`), so the page loads while its manifest/segments return 404 (`stream-routes.ts:38–51`). The inactivity test stops and removes files but does not request the old player route.
- **Classification:** Confirmed stale-page behavior; recovery/restart policy for expired sessions is unspecified.
- **Proposed test:** Extend an API/UI integration test to expire a session with the injected clock, then request `/player/:id` and its old manifest. Assert the chosen contract (redirect/home with an explanation, or explicit 410) rather than a 200 dead player. Use an in-process manager; no fake profile.
- **Proposed fix:** Reject non-ready sessions at the player route and show a clear expired/stopped state or redirect to the catalog. Do not silently render an unusable player.
- **Effort:** S.

### P2 — S7. A new title request waits behind an unresolved startup

- **Scenario:** Start title A with a slow/hung first output, immediately request title B, then return to A.
- **Current behaviour:** `SessionManager.start` serializes the whole startup operation through `select` and awaits `playback.start(request)` before the next selection runs (`session-manager.ts:66–81, 116–119`). A later different request does not invalidate the in-progress startup; it can wait for the full readiness timeout (default 120 seconds) before replacing A. Same-request double starts are covered, but different-title concurrency during readiness is not.
- **Classification:** Confirmed queueing behavior; suspected product bug because the brief expects rapid back-and-forth selection to honor the newest request.
- **Proposed test:** Add a deterministic lifecycle test with deferred readiness for A, issue start B, and assert B cancels/retire-cleans A promptly while an A→A duplicate still reuses one session. Use an in-memory worker; the future `slow-start` fake profile is useful for a real-argv integration version.
- **Proposed fix:** Treat a different start as a newer mutation intent for the current starting session, waking/cancelling its readiness wait and cleaning up through the existing ownership queue before starting B.
- **Effort:** M.

### P2 — S8. One tab does not learn that another tab changed the shared session region

- **Scenario:** Open the same session in two tabs; seek in tab A while tab B is playing the previous region.
- **Current behaviour:** The seek route publishes `session.updated` (`api-routes.ts:183–195`), but the player event handler accepts only `session.recovery` (`browser-playback.ts:598–601`). Tab B remains attached to its old region and any playback report for that region becomes stale. Old region assets intentionally remain immutable/readable until the session closes, so this can present as a delayed stall rather than an immediate error. The architecture describes one viewer, so whether tabs must synchronize needs an explicit contract.
- **Classification:** Suspected multi-tab state bug / clear coverage gap; not strong while the one-viewer contract is unresolved.
- **Proposed test:** Add a Playwright test with two pages that start the same request (same session ID), seek in one page, and assert either that the second follows the current region or that the application clearly enforces single-tab ownership. Use synthetic HLS or the future fake `healthy` profile; no physical drive.
- **Proposed fix:** If tabs are supported, consume matching `session.updated`/seek events, abort stale feedback, and reconcile the other page to the authoritative region. Otherwise make single-tab ownership visible and prevent stale playback.
- **Effort:** M.

### P2 — S9. Windows stop escalation and queue liveness lack an integration test

- **Scenario:** VLC produces no output and ignores the first termination request while stop/replacement/server close is waiting.
- **Current behaviour:** Session cleanup logs after `stopTimeoutMs` but still awaits `handle.stop()` without a deadline (`playback-session.ts:1066–1076`), so the serialized session/selection queue remains blocked until that promise settles. The real process supervisor does escalate from SIGTERM to SIGKILL after one second (`process-supervisor.ts:113–125`), but its tests cover only successful exit/liveness, not that Windows escalation closes the process. I found no confirmed leak in the real `VlcWorker` path from source inspection alone.
- **Classification:** High-value platform test gap; suspected unbounded hang if the hard-kill path fails.
- **Proposed test:** Add a Windows-targeted process integration test using future `hang-silent` fake VLC configured to ignore SIGTERM; assert escalation closes the child, session directory cleanup completes, and a queued replacement/stop can finish. It must use fake VLC only, never the physical DVD.
- **Proposed fix:** Keep ownership/files until process closure, but make the supervisor's hard-kill completion path observable and bounded; avoid treating the warning timer itself as a stop timeout.
- **Effort:** M.

### P3 — S10. Runtime audio/subtitle changes are not an implemented operation

- **Scenario:** Change audio or subtitle selection while a title is already playing.
- **Current behaviour:** Track IDs are accepted and validated for session start (`http/playback.ts:41–139`) and passed to the VLC worker at launch (`vlc/worker.ts:87–128`). The API exposes start, seek, feedback, and stop, but no runtime track-change route; the player has no track controls. Existing Playwright coverage verifies only selections made before Start.
- **Classification:** Capability gap if the brief expects mid-play switching; not a test-only gap.
- **Proposed test:** If this is in scope, add a player-flow test that changes tracks during playback and verifies the selected track in the replacement worker/session without losing title time. Use future fake `healthy` profile; no DVD.
- **Proposed fix:** Define a track-change API and ownership semantics, then restart VLC at the current title time with the new track and reconcile the browser region.
- **Effort:** L.

### P3 — S11. HTTP status and byte-range behavior are unspecified at the stream route

- **Scenario:** Request a segment with `Range`, request an old-region manifest after seek, or request assets after stop/replacement.
- **Current behaviour:** The route returns 404 whenever `readStreamAsset` returns null and sends the complete in-memory content without inspecting a `Range` header (`stream-routes.ts:38–51`). Publication tests cover old region identity and immutable bytes; API tests cover missing assets and wrong generations, but not stale URLs through the HTTP route, stopped-session semantics, or byte ranges. No current manifest emits byte-range directives, so partial responses may not be required; the contract is simply untested.
- **Classification:** Coverage/specification gap, not a confirmed protocol bug.
- **Proposed test:** Add route integration cases for old region after seek (expected 200), stopped/replaced session (choose and document 404 vs 410), and valid/invalid Range requests (choose 200 whole-body vs 206/416 support). Use an in-process publication fixture or future fake `healthy` profile.
- **Proposed fix:** Document the intended status/range contract; implement Range support only if a client/manifest mode requires it, and return a deliberate Gone response if stopped sessions should differ from nonexistent IDs.
- **Effort:** S–M.

### P3 — S12. Several recovery edge cases have no direct test

- **Scenario:** A healthy stream stalls, resumes, then stalls again; a bad slot occurs just after a seek or in the final title slot; rendered/custom placeholder generation is unavailable.
- **Current behaviour:** The in-memory recovery tests cover a middle multi-slot scratch, one self-healing stall, and seeking away during a fill. They do not exercise a second stall after progress resets retry state, a final-slot placeholder, or a placeholder with no rendered/custom bytes. The code has a null-packet fallback in `hls-publication.ts:254–260`, but no direct test asserts that fallback is published and readable.
- **Classification:** Test gap; no additional defect confirmed from the inspected code path.
- **Proposed test:** Add deterministic cases to `test/integration/session-bad-sector-recovery.integration.test.ts` and `test/integration/hls-publication.integration.test.ts`; use an in-memory worker for final-slot/after-seek cases, and future `stall-then-resume` profile configured for two stall cycles. Assert the fallback segment is registered and readable.
- **Proposed fix:** No code fix unless these tests expose a boundary error.
- **Effort:** S.

## STRONG findings

- **S1:** First-slot unreadability bypasses recovery and fails the session.
- **S2:** Seeking exactly to the buffered/live-edge boundary is incorrectly handled locally.
- **S3:** Positive `maxAttempts` values exhaust one failed restart later than documented.
- **S4:** Stopped session controllers/publication maps are retained without a bound.
- **S5:** Crash-left `.cache/sessions` directories are not swept at startup (55 are present now).
- **S6:** An expired/stopped player URL still renders an unusable player page.

The behavior in S7–S12 should be resolved or tested after confirming the intended product contracts, especially rapid start supersession, multi-tab ownership, runtime track switching, and Range responses.
