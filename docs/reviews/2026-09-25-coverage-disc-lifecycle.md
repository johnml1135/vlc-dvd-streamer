# Coverage review: disc lifecycle, catalog, server, and UI

Date: 2026-09-25  
Scope: disc detection and catalog scanning, thumbnails, startup/configuration, server/runtime/logging, and related UI/event flows.

## Summary

- Unit and integration coverage is solid for ordinary IFO parsing, healthy catalog refresh, API flow, and normal session cleanup; Playwright covers happy-path catalog and player use.
- Eject and disc-swap behavior is not covered end to end; an unreadable first playback slot fails during startup, while successful silent recovery restarts can keep filling placeholders.
- Partial IFO reads can be accepted as complete catalogs, thumbnail requests can launch an unbounded number of VLC processes, and disc cache identity is too weak.
- Open browser subscribers do not reconnect after a server restart, terminal playback failure is ignored by the player, and failed HTML playback returns a JSON response.
- Review was read-only: no tests were run, no physical DVD was accessed, and only this report was written for this task.

## Coverage inventory

| Behaviour | Covered? | Test file | Level |
|---|---|---|---|
| IFO title, duration, language, and track parsing; missing/corrupt VTS handling | Covered, with missing VTS intentionally skipped | `test/unit/disc/ifo-reader.test.ts` | Unit, synthetic IFO buffers |
| VLC scan parsing, IFO fast path, progress, and malformed scan payloads | Covered for normal and malformed inputs; no partial-IFO fallback or 50-title budget case | `test/unit/vlc/disc-scanner.test.ts`, `test/unit/vlc/scan-parser.test.ts` | Unit |
| Optical drive selection | Partial: loaded-drive preference, fallback, no-drive, and PowerShell failure; no two-loaded-drive ambiguity | `test/unit/disc/optical-drive.test.ts` | Unit |
| Catalog refresh, title filtering, and scan progress | Covered for successful and damaged scan paths; no same-disc metadata reuse test | `test/unit/catalog-service.test.ts`, `test/integration/catalog.integration.test.ts`, `test/integration/catalog-damaged-disc.integration.test.ts` | Unit, integration |
| Concurrent catalog refresh requests | Code deduplicates an in-flight refresh; no direct concurrency test | `src/disc/catalog-service.ts` | Untested implementation path |
| API catalog/refresh/start/stop and track/seek validation | Covered for the ordinary request flow; limited refresh spam and error-state UI coverage | `test/integration/api.integration.test.ts` | Integration |
| Thumbnail generation and cache | Minimal: one request creates a directory and returns stub bytes; no MIME, failure, cache-hit, concurrency, or swap case | `test/integration/thumbnail-route.integration.test.ts` | Integration, stub worker |
| Catalog and player happy path | Covered for selecting titles, track choices, replacing/stopping sessions, and browser playback | `playwright/catalog-player-flows.spec.ts`, `playwright/smoke.spec.ts`, `playwright/player-harness.spec.ts` | E2E, synthetic HLS/fake worker |
| Playback readiness, recovery, and cleanup | Strong for finite bad-sector windows, seek ordering, and normal stop; no eject/no-output-until-title-end scenario | `test/integration/session-readiness.integration.test.ts`, `test/integration/session-bad-sector-recovery.integration.test.ts`, `test/integration/session-runway-recovery.integration.test.ts`, `test/integration/session-lifecycle.integration.test.ts` | Integration, mostly injected worker |
| Failed HTML start and terminal player state | Missing: action route tests only successful redirect; player tests recovery events and client media errors, not terminal server failure | `test/integration/action-routes.integration.test.ts`, `playwright/player-harness.spec.ts` | Integration, E2E gap |
| WebSocket close/reconnect | Partial: a new subscriber reconnects after close; existing page subscribers do not | `test/unit/browser-events.test.ts` | Unit |
| Config, health, and production server startup | Config tests invalid numeric values; health checks missing-VLC status; no process-level bind failure/startup error test | `test/unit/config.test.ts`, `test/integration/health.integration.test.ts`, `test/unit/app.test.ts` | Unit, integration |
| File and host logs | Append/reopen behavior covered; no size limit or rotation coverage | `test/unit/file-log-sink.test.ts`, `test/unit/server-log.test.ts` | Unit |
| Manual/background server process management | Pure path/state helpers covered; no PID-reuse, crash/restart, or Windows host process-tree test | `test/unit/manual-server-control.test.ts`, `scripts/windows/*.ps1` | Unit helpers only |
| Startup cleanup of prior session files/processes | Normal stop and failed-start cleanup covered; no new-server startup sweep or parent-crash child-process test | `test/integration/session-lifecycle.integration.test.ts`, `test/unit/vlc/process-supervisor.test.ts` | Integration gap |

## Findings ranked by severity

### P1 — D1. Successful silent recovery restarts can fill the rest of a title with placeholders

**Scenario:** Start playback, eject the disc after initial segments appear, and let each restarted VLC process start successfully but emit no HLS data.

**Current behaviour:** The recovery monitor invokes `performRecoveryStep` on a stall (`src/session/playback-session.ts:737-746`). After read retries are spent, recovery publishes a placeholder for the current slot and advances the restart position (`:864-918`). A successful `restartRecoveryWorker` does not wait for a fresh segment; `waitForFreshSegment` exists for seek paths, while restart failures are counted only when startup throws (`:937-956`). `consecutiveBadSlots` is incremented but has no exhaustion limit (`:898-907`). An ejected drive can therefore produce placeholder playback slot by slot through a long title instead of a bounded failed session.

**Classification:** Confirmed lifecycle bug.

**Proposed test:** Add an integration case in `test/integration/session-bad-sector-recovery.integration.test.ts` or a new `test/integration/session-eject.integration.test.ts`: emit initial segments, use the future `eject-midstream` profile, and make every successful restart silent. Assert a bounded terminal state, stopped worker, and no placeholder-fill loop. Add a `dies-midstream` case for repeated dead-on-arrival workers.

**Proposed fix:** Bound unproductive recovery across successful starts as well as thrown starts. Require fresh output after restart, and stop with a clear drive/eject error when the configured retry or bad-slot budget is exhausted.

**Effort:** M.

### P1 — D2. The player ignores terminal session failure updates

**Scenario:** Keep the player open while recovery exhausts or startup/recovery reports a terminal session failure.

**Current behaviour:** Recovery exhaustion changes the session to `failed` and publishes `session.updated` (`src/session/playback-session.ts:1044-1055`). The browser handler accepts only `session.recovery` (`src/ui/browser-playback.ts:598-609`), so the open page ignores the terminal state and can remain on “Attaching HLS stream...” (`src/ui/page.ts:56-65`).

**Classification:** Confirmed UI bug.

**Proposed test:** Add a Playwright case in `playwright/player-harness.spec.ts` that delivers a matching terminal `session.updated` event and asserts the failure reason and a useful return/retry action. Exercise the server path with future `dies-midstream` or `eject-midstream` fake VLC.

**Proposed fix:** Handle matching failed/stopped `session.updated` events in the player, stop stale media work, and render a clear message with a route back to the catalog or a supported retry action.

**Effort:** S/M.

### P1 — D3. A partial IFO read can be marked as a complete ready catalog

**Scenario:** Scan a disc with several titles where one referenced VTS IFO is missing or corrupt but other VTS files are readable.

**Current behaviour:** `readDvdTitlesFromIfo` silently skips entries whose VTS cannot be loaded (`src/disc/ifo-reader.ts:65-84`); tests intentionally exercise that behavior (`test/unit/disc/ifo-reader.test.ts:130-145,180-196`). `scanDiscFromIfo` falls back to VLC only on an exception or when no titles remain; any nonempty subset is returned as the scan (`src/vlc/disc-scanner.ts:81-103`). Users can see a ready catalog with missing titles and no indication of the omission.

**Classification:** Confirmed incomplete-catalog bug; skipping a damaged title may be intentional, but silently presenting the subset as complete is not observable.

**Proposed test:** Add a unit test in `test/unit/vlc/disc-scanner.test.ts` using a synthetic `VIDEO_TS` fixture with one readable and one damaged/missing VTS IFO; assert fallback recovers the omitted title or the returned catalog explicitly records omissions. No fake VLC profile or physical disc is needed.

**Proposed fix:** Compare successfully decoded entries with the VMGI title table and fall back to VLC when the IFO result is incomplete, or expose skipped titles as a catalog warning.

**Effort:** M.

### P1 — D4. An unreadable first slot fails startup before recovery can run

**Scenario:** Start a title whose first segment is temporarily unreadable, then the drive becomes readable at a later slot.

**Current behaviour:** `startOwned` waits for initial readiness and only schedules the recovery monitor after it receives the first valid HLS progress (`src/session/playback-session.ts:514-525`). `waitForReadiness` polls until output or the readiness deadline and then throws (`:567-595`); failure cleanup marks the session failed (`:526-534`). Recovery never gets a chance to insert a first-slot placeholder and resume.

**Classification:** Confirmed coverage/behavior gap for a transient start-of-title read error. A fully absent/ejected disc should still fail cleanly within the startup deadline.

**Proposed test:** Add a deterministic integration case to `test/integration/session-bad-sector-recovery.integration.test.ts` where the initial worker remains alive without slot 1, then a restart emits slot 2. Also exercise future `stall-then-resume` with the first output delayed, while preserving the `hang-silent` timeout behavior for a permanently silent startup.

**Proposed fix:** Apply a bounded startup recovery policy to a live producer stalled before first output, while preserving the overall readiness deadline and cleanup for a permanently silent or exited process.

**Effort:** M.

### P2 — D5. Thumbnail requests have no per-title deduplication or global process limit

**Scenario:** Load a catalog with many uncached title thumbnails or issue repeated requests for one title.

**Current behaviour:** Each request independently checks for the same output file and launches `generateThumbnail` on a cache miss (`src/http/routes/api-routes.ts:92-107`). The worker runs a managed VLC process per call and writes the same `thumbnail.jpg` path for that title (`src/vlc/worker.ts:54-84`). Concurrent calls can therefore start many VLC processes and race on the same output file. Failed requests return an uncached placeholder, so retries repeat the work (`api-routes.ts:99-119`).

**Classification:** Confirmed resource/race bug.

**Proposed test:** Extend `test/integration/thumbnail-route.integration.test.ts` with concurrent requests for the same title and for 50 titles. Use a deferred worker to assert same-title single-flight and a small global active-process cap; then use future `slow-start` or `drive-busy` fake VLC to verify the process limit through the real managed-worker path.

**Proposed fix:** Deduplicate in-flight work by `(discId, titleNumber)` and limit concurrent thumbnail VLC processes. Add a short retry backoff or cache the placeholder response after failure.

**Effort:** M.

### P2 — D6. Disc cache IDs change with drive letters and can collide across discs

**Scenario:** Move a disc between drive letters, or insert a different disc with the same title numbers and durations into the same drive.

**Current behaviour:** `computeDiscId` hashes only the drive string and title-number/duration pairs (`src/vlc/disc-scanner.ts:450-456`). Moving one disc creates a different cache directory, while two different discs with matching title metadata can share an ID and reuse the wrong thumbnail cache (`src/disc/catalog-service.ts:123-125`).

**Classification:** Confirmed cache identity bug.

**Proposed test:** Add scanner unit tests in `test/unit/vlc/disc-scanner.test.ts` for two distinct synthetic DVD fixtures with identical title/duration metadata and for the same fixture exposed under two drive paths. Use the fixture directory through `DVD_DRIVE`; no physical drive or fake profile is needed.

**Proposed fix:** Derive identity from stable DVD metadata/content such as hashes of `VIDEO_TS.IFO` and referenced VTS IFOs, and exclude the drive letter.

**Effort:** M.

### P2 — D7. Fifty-title fallback scans have no overall deadline

**Scenario:** Refresh a damaged or busy 50-title disc that requires VLC metadata fallback for each title.

**Current behaviour:** The real-VLC scanner probes titles serially (`src/vlc/disc-scanner.ts:122-168`). Each process receives its own timeout (`:218-225`), so total scan time can grow with title count and can include more than one probe per title. `CatalogService.refresh()` waits for the entire scan (`src/disc/catalog-service.ts:82-93`); there is no scan-wide budget or cancellation.

**Classification:** Confirmed scan-latency/resource gap; especially visible when another program keeps the drive busy.

**Proposed test:** Add a unit case in `test/unit/vlc/disc-scanner.test.ts` with 50 discovered titles and an injected runner that times out per-command; assert a defined aggregate budget stops later probes. After the fake framework work lands, add an integration case using `drive-busy` and a 50-title synthetic fixture.

**Proposed fix:** Add a scan-wide deadline/cancellation token and stop launching probes once exhausted; return a clear drive-busy/timeout catalog error.

**Effort:** M.

### P2 — D8. Re-inserting the same disc always rescans metadata

**Scenario:** Eject and reinsert the same disc, then choose Refresh Disc.

**Current behaviour:** Every sequential `CatalogService.refresh()` enters `runRefresh()` and calls `worker.scanDisc()` (`src/disc/catalog-service.ts:51-62,82-93`). `normalizeScan()` only creates the cache directory; it does not load persisted catalog metadata (`:123-145`). Concurrent in-flight calls are deduplicated, but a completed scan is not reused.

**Classification:** Confirmed requirement gap for the brief’s same-disc cache scenario; whether rescanning is preferable should be an explicit product choice.

**Proposed test:** Add a unit test in `test/unit/catalog-service.test.ts` with two sequential refreshes for the same synthetic disc and an asserted scan count/cache policy. Use a fixture directory as `DVD_DRIVE` for an end-to-end version.

**Proposed fix:** Persist catalog metadata keyed by a reliable disc fingerprint and reuse it on reinsert, with a deliberate force-rescan path. Fix D6’s fingerprint before trusting this cache.

**Effort:** M.

### P2 — D9. Startup leaves crash-abandoned session directories behind

**Scenario:** Terminate the server during playback, then restart it using the same cache directory.

**Current behaviour:** Startup creates the cache root (`src/server.ts:14-15`) but does not sweep `sessions/`. A new `SessionManager` starts with an empty map (`src/session/session-manager.ts:18-25`), and cleanup only walks controllers in that map (`:102-113`). The checkout currently has about 55 session directories, consistent with this unhandled restart path.

**Classification:** Confirmed disk-leak bug. A VLC child surviving a forced parent exit is plausible but not proven by the current process tests; normal `app.close()` does stop owned sessions (`src/app.ts:16-20`).

**Proposed test:** Add `test/integration/server-restart.integration.test.ts` with a temporary cache containing stale session folders plus unrelated files; assert startup removes only abandoned session folders. Separately spawn the server with future `hang-silent` fake VLC, kill the parent process, restart it, and assert the old child is gone before claiming orphan cleanup works.

**Proposed fix:** Add a guarded startup sweep for stale session directories. For crash-safe VLC ownership on Windows, use a process-tree/job ownership mechanism and verify it with a parent-kill integration test; do not sweep a cache that another server instance may own.

**Effort:** M for stale files; L for crash-safe process ownership.

### P2 — D10. New playback requests wait for a slow or silent startup to finish

**Scenario:** Start title A while VLC is slow or silent, then immediately choose title B.

**Current behaviour:** `SessionManager.start()` serializes the whole operation and awaits `playback.start(request)` before another selection runs (`src/session/session-manager.ts:66-82,116-119`). The default readiness timeout is 120 seconds (`src/session/playback-session.ts:567-570`). A different title request can wait out that deadline before replacing the current request.

**Classification:** Confirmed queueing behavior; likely user-facing bug for back-and-forth title selection, but cancellation/supersession policy should be explicit.

**Proposed test:** Add a deterministic lifecycle test with deferred readiness for A and a request for B; assert the intended latest-request behavior and that A is cleaned promptly. Add a real-child version using future `slow-start` or `hang-silent` in `test/integration/session-lifecycle.integration.test.ts`.

**Proposed fix:** Treat a different start request as a newer selection intent that cancels the pending readiness wait and retires A before starting B, while preserving same-request reuse.

**Effort:** M.

### P2 — D11. Existing browser subscribers do not reconnect after the server restarts

**Scenario:** Leave the catalog or player page open while the server or WebSocket connection restarts.

**Current behaviour:** `subscribeAppEvents()` connects when called (`src/ui/browser-events.ts:11-14`), but the socket `close` handler only nulls the reference (`:49-53`). Existing listeners remain registered, and no reconnect is attempted until a new subscriber calls `subscribeAppEvents`. The unit test covers only that new-subscriber case (`test/unit/browser-events.test.ts:69-75`).

**Classification:** Confirmed event-stream bug; live catalog, server logs, and playback events stop updating in an already-open page.

**Proposed test:** Extend `test/unit/browser-events.test.ts` with an active listener, a socket close, and automatic reconnection while the listener remains subscribed. Add a Playwright case that simulates a server restart/socket close and verifies a subsequent event arrives.

**Proposed fix:** Reconnect with bounded backoff while listeners remain, cancel retry timers after the last unsubscribe, and avoid reconnecting after page teardown.

**Effort:** S.

### P2 — D12. Failed playback form submissions return raw JSON instead of a useful page

**Scenario:** Select a title and submit Start Stream while VLC fails to start or the drive is busy.

**Current behaviour:** The catalog renders a normal HTML form (`src/ui/page.ts:104-122`); the action route sends the API error object on startup failure (`src/http/routes/ui-routes.ts:134-146`, `src/http/route-utils.ts:21-25`). The browser navigates to the JSON response. Existing action-route coverage only asserts a successful redirect (`test/integration/action-routes.integration.test.ts:5-20`).

**Classification:** Confirmed UI error-state gap.

**Proposed test:** Add an integration failure case to `test/integration/action-routes.integration.test.ts` and a Playwright case that starts against future `drive-busy` or `slow-start` fake VLC. Assert a human-readable message and a clear retry/back-to-catalog action.

**Proposed fix:** Render an HTML error page or handle the form submission in the client and show the message inline, preserving a useful retry path.

**Effort:** S/M.

### P2 — D13. Autodetection silently chooses the first of multiple loaded drives

**Scenario:** Two optical drives contain discs and the intended disc is in the second drive; alternatively, the selected drive letter changes while the server remains running.

**Current behaviour:** `selectOpticalDrive()` returns the first `mediaLoaded` drive (`src/disc/optical-drive.ts:30-37`), and `src/server.ts:36-49` resolves the drive only once at startup. `CatalogService` retains that resolved drive. The unit test covers one loaded drive, not ambiguity (`test/unit/disc/optical-drive.test.ts:15-21`).

**Classification:** Confirmed wrong-drive risk and coverage gap; the first-loaded policy is deterministic but not necessarily the user’s intended disc.

**Proposed test:** Add a unit case in `test/unit/disc/optical-drive.test.ts` with two loaded drives and assert explicit `DVD_DRIVE` wins or ambiguity is surfaced. Add a server/catalog integration case in `test/integration/catalog.integration.test.ts` for drive removal or letter change. Use mocked PowerShell results; no optical drive access.

**Proposed fix:** Prefer explicit selection, and when multiple drives are loaded without one, ask the user to choose or report ambiguity. Re-detect before refresh if automatic drive tracking is supported.

**Effort:** S/M.

### P2 — D14. Manual server start/stop trusts a possibly reused PID

**Scenario:** The server exits, Windows reuses its PID for another process, and the user runs the manual stop script.

**Current behaviour:** The script treats any live PID in its state file as the server (`scripts/manual-server.ts:18-37,85-92`), then sends the stop command to that PID (`:174-187`). It stores command and arguments (`src/runtime/manual-server-control.ts:16-27`) but does not check them before reporting “already running” or stopping the process. A reused PID can be mistaken for the server or can identify an unrelated process.

**Classification:** Confirmed process-control bug; the harmful scenario depends on PID reuse.

**Proposed test:** Extract injectable process identity checks and add tests in `test/unit/manual-server-control.test.ts` for a live unrelated PID and a stale server state. No fake VLC or DVD fixture is needed.

**Proposed fix:** Persist and validate process identity, such as executable/command line plus start time, before treating or killing a recorded PID.

**Effort:** M.

### P2 — D15. The configured recovery restart cap permits one extra failed restart

**Scenario:** Configure `maxAttempts` to 2 and have every recovery worker restart fail.

**Current behaviour:** `restartRecoveryWorker` increments `restartFailures` and exhausts only when the count is greater than `maxAttempts` (`src/session/playback-session.ts:945-955`). The configured cap is therefore exceeded by one failure. Existing exhaustion coverage uses `maxAttempts: 0`, which does not expose a positive-boundary mismatch (`test/integration/session-lifecycle.integration.test.ts:300-326`).

**Classification:** Confirmed off-by-one bug against the documented maximum failed-restart contract.

**Proposed test:** Extend `test/integration/session-lifecycle.integration.test.ts` with `maxAttempts: 2` and a worker that starts initially but throws on each restart; assert the exact number of failed restarts before exhaustion. No fake profile or DVD fixture is needed.

**Proposed fix:** Exhaust when the incremented failure count reaches the documented cap, or clarify the option contract if it intentionally counts retries after that many failures.

**Effort:** S.

### P2 — D16. A disc swap does not invalidate a session that still targets the same drive

**Scenario:** Start playback from disc A, replace it with disc B in the same drive, and keep the old player session open.

**Current behaviour:** A session retains its requested `discId` and drive, and the manager only compares those values when a new start request arrives (`src/session/session-manager.ts:66-81,122-125`). Catalog refresh updates catalog state independently; it does not stop or revalidate the active session. VLC playback continues to use the drive passed at session start (`src/vlc/worker.ts:87-90`). It is not established whether VLC will fail or read B's matching title, so the mixed-content outcome is suspected, but there is no explicit swap handling.

**Classification:** Suspected live-disc identity bug and a confirmed missing lifecycle test.

**Proposed test:** Add an integration case to `test/integration/session-lifecycle.integration.test.ts` (or a new `test/integration/session-disc-swap.integration.test.ts`) that starts against synthetic `VIDEO_TS` fixture A, switches the `DVD_DRIVE` folder backing the same drive to fixture B, then refreshes. Assert that the old session either stops with a clear media-changed state or remains safely bound to A; it must not serve B while labeled with A's `discId`. Use the future `eject-midstream` fake profile for the eject boundary.

**Proposed fix:** Revalidate stable media identity at a safe playback boundary and stop the old session when it changes; do not label output from a newly inserted disc with the original session identity.

**Effort:** M.

### P2 — D17. A thumbnail started for one catalog snapshot can populate its cache after a disc swap

**Scenario:** Begin generating a thumbnail while A is cataloged, swap the medium to B before VLC reads it, then reinsert A later.

**Current behaviour:** The route derives the cache path from the captured snapshot's `discId` and drive (`src/http/routes/api-routes.ts:84-106`), awaits generation, and does not recheck that the catalog/media identity is still current before the generated file becomes reusable. If VLC reads B after the swap, B's image can be stored under A's ID. The actual drive-read race is not proven by a stub-only test, so this is classified as suspected.

**Classification:** Suspected cache-corruption race.

**Proposed test:** Extend `test/integration/thumbnail-route.integration.test.ts` with a deferred worker: start a request for A, switch the catalog snapshot to B before the worker completes, then assert A's persistent cache is not populated with that result. Add a real-argv synthetic-folder version if the test harness can swap the fixture path during generation.

**Proposed fix:** Generate into a temporary path and publish to the persistent cache only after revalidating the media identity; use the stable fingerprint proposed in D6.

**Effort:** M.

### P2 — D18. Stopped session controllers accumulate for the lifetime of the server

**Scenario:** Start, stop, and replace titles repeatedly during a long-running server process.

**Current behaviour:** `SessionManager` retains every controller in an unbounded `sessions` map (`src/session/session-manager.ts:18-20`). `stop`, `stopAll`, and `cleanupInactive` stop controllers but do not remove them from that map (`:85-113`), keeping session snapshots and publication/recovery state reachable after playback ends.

**Classification:** Confirmed in-memory retention/resource leak; no current load or retention-bound test.

**Proposed test:** Add a lifecycle test that starts and stops many sessions and asserts a documented bounded history/retention policy. Use a temporary cache and deterministic in-memory worker; no fake profile is needed.

**Proposed fix:** Keep only bounded or time-limited stopped-session status records and release the controller/publication state after that retention period.

**Effort:** M.

### P3 — D19. Application and host logs grow without rotation

**Scenario:** Keep the background server running and logging through repeated scans, sessions, and recovery events.

**Current behaviour:** The file sink opens in append mode and writes every entry without a limit (`src/logging/file-log-sink.ts:21-35`). The manual host also appends stdout/stderr, and the Windows background host uses `Add-Content` without rotation (`scripts/manual-server.ts:99-103`, `scripts/windows/background-host.ps1:25-29`). The log test verifies append/reopen, not retention (`test/unit/file-log-sink.test.ts:19-48`).

**Classification:** Confirmed disk-growth/product gap.

**Proposed test:** Extend `test/unit/file-log-sink.test.ts` with deterministic size thresholds and retained-file counts. Add a host-script policy test or move rotation into a shared helper.

**Proposed fix:** Rotate by size or age, cap retained files, and apply the policy to application and background-host logs.

**Effort:** M.

### P3 — D20. Cached JPEG thumbnails are sent with a PNG content type

**Scenario:** Request a thumbnail after VLC has successfully generated and cached it.

**Current behaviour:** The worker writes `thumbnail.jpg` (`src/vlc/worker.ts:54-84`), but the cached response is always typed `image/png` (`src/http/routes/api-routes.ts:114-119`). The current route test checks bytes but not the content type (`test/integration/thumbnail-route.integration.test.ts:58-64`).

**Classification:** Confirmed HTTP metadata bug.

**Proposed test:** Assert cached and placeholder MIME types in `test/integration/thumbnail-route.integration.test.ts`.

**Proposed fix:** Serve cached files as `image/jpeg` and keep `image/png` for the PNG placeholder.

**Effort:** S.

### P3 — D21. Full server startup errors lack process-level coverage

**Scenario:** Start the production server with a port already in use, an invalid environment value, or a missing/wrong VLC executable.

**Current behaviour:** Config unit tests reject some invalid numeric values and the health integration test reports a missing VLC dependency, but neither boots `src/server.ts` as a child process. `server.ts` logs VLC resolution and then awaits `app.listen()` (`src/server.ts:53-59,121-127`); port-bind failure and startup/shutdown diagnostics are therefore not asserted by current tests.

**Classification:** Coverage gap; no specific startup defect confirmed from the inspected path.

**Proposed test:** Add process-level cases to `test/integration/server-startup.integration.test.ts` with a temporary cache, an occupied local port, invalid config, and an invalid `VLC_PATH`. Assert the chosen contract for each case: readable bind/config diagnostics, and a healthy-but-degraded health response when VLC is missing. Assert no orphan process. No disc path or physical drive should be involved.

**Proposed fix:** No code fix unless the process test exposes an unclear error, leaked timer/log stream, or orphan child.

**Effort:** S/M.

## STRONG findings

- **D1:** Silent successful recovery can keep publishing placeholders across the title after eject.
- **D2:** The player ignores terminal failed-session events.
- **D3:** A partial IFO read can be presented as a complete catalog.
- **D4:** A transient unreadable first slot bypasses recovery and fails startup.
- **D5:** Concurrent thumbnail misses can launch unbounded VLC processes and collide on one output path.
- **D6:** The disc ID is both drive-dependent and collision-prone, risking wrong thumbnail-cache reuse.
- **D9:** Crash-abandoned session directories are never swept on startup.
- **D11:** Open browser subscribers never reconnect after WebSocket close.
- **D12:** A failed HTML start leaves the user on a raw JSON response without a retry path.
- **D14:** Manual stop can trust a stale/reused PID without confirming process identity.
- **D15:** Positive recovery restart limits are exceeded by one failed restart.

The scan-wide deadline, same-disc catalog cache, multiple-drive choice, log rotation, and startup process coverage should also be addressed, with product policy clarified where noted.
