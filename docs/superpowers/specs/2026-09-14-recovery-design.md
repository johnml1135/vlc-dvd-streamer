# Recovery ownership and timing

Approved by the user's “Do it all” after the architecture report.

Recovery remains serialized with seek/start/stop in the Playback session module. Its recovery implementation owns suspicion, revalidation, worker closure, final observation, slot decision, publication, restart and progress accounting. A missing observation while the worker is running is not proof of an unreadable slot; local observation errors do not authorize a placeholder. After confirmed worker closure, absent or unplayable output can consume the bounded read-retry policy for the exact stalled slot. Non-ENOENT filesystem failures remain unavailable evidence and do not consume that policy. A late valid segment collected after closure wins. Failed closure cannot commit retry or bad-range state. Stop and a pending seek invalidate uncommitted recovery. Published media remains immutable.

PlaybackTime is an internal dependency with elapsed now() and cancellable schedule(delayMs, task). Production uses performance.now and timers; tests use a manual adapter that awaits a scheduled operation. Calendar now remains for user-visible timestamps and session activity only. Readiness and recovery share elapsed time and cancellable waits. A late wakeup evaluates fresh evidence; no catch-up burst of recovery decisions.

Browser playback reports carry raw manifestUrl (region identity), reporterId, sequence, title position, contiguous buffered end, paused and playbackRate. Reports use single-flight POST /api/sessions/:sessionId/playback, at most once per second during playback with a periodic heartbeat while paused. Suppress reports during source changes and pending seeks; abort and cancel on disposal. Server validates finite bounds and identity, rejects old sequences, records receipt on its elapsed clock, and expires feedback after 5 seconds. Fresh feedback estimates playable seconds remaining (aged while playing); paused feedback grants bounded patience. Missing/stale feedback uses a conservative current-region download estimate. Asset reads from obsolete regions must not change it.

Validation: deterministic deadline edges; final output during stop; failed stop and cancellation; stalled restart retry anchoring; wall-clock jumps; prefetch vs playhead; stale and reordered reports; browser cleanup; malformed route payloads. Replace millisecond timer fixtures with explicitly controlled producer output and manual time, retain real filesystem publication tests and browser end-to-end checks. Full typecheck, test, coverage, build and Edge Playwright checks precede commit/push. Physical DVD behavior remains a hardware validation limit.

## Independent review refinements

Public seek/stop synchronously advance a mutation-intent generation; checks after awaits and at publication commit fence superseded recovery. A restart handle returned after invalidation is stopped before it can be installed. Publication checks cancellation after staging and immediately before registering a placeholder. Counter/event changes follow successful closure and commitment. A local observation failure cannot record an unreadable slot.

Every region-manifest segment URI carries its region. Stitched and unqualified asset reads receive no download credit. The controller captures and rechecks region around asynchronous asset reads; old assets remain readable.

Feedback retains per-reporter sequence high-water marks independently of five-second freshness, bounded to 64 reporters per session. Multiple current-region playing reporters use minimum runway; paused reporters cannot mask a playing viewer. A zero playback rate is stationary. Wall runway is media remaining divided by rate, minus receipt age and a conservative two-second transport allowance. Paused patience remains capped by recovery policy. Browser transport times out after two seconds; abort does not prove server non-delivery.

Each monitor schedules from completion/current elapsed time, avoiding catch-up bursts. A cancelled callback already queued is fenced by the same intent generation.
