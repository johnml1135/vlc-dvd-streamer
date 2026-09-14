# Playback depth implementation plan

**Goal:** Implement all three approved architecture opportunities while preserving single-viewer playback and title-time behavior.

**Architecture:** Session selection delegates lifecycle ordering to a playback session module. HLS publication owns slot/file consistency. Browser playback owns seeks and recovery independently of log presentation. Retain the command construction/process supervision split and real/fake VLC adapters.

**Tech stack:** TypeScript, Fastify, VLC, Vitest, Playwright, native HLS and hls.js.

## Scope and evidence

- User approved all three candidates in the architecture report, with further research into publication and browser playback before implementation.
- Baseline: 34 files / 111 tests passed on 2026-09-14.
- Alternatives considered: moving methods without changing ownership fails the deletion test; a generic event/state framework adds hypothetical seams. Use domain-specific owners and existing dependency seams.
- Work in the existing clean checkout. Research agents are read-only; implementation ownership is restricted to named files.

## 1. Playback lifecycle

- [x] Add `test/integration/session-lifecycle.integration.test.ts` exercising concurrent starts/seeks and a deferred worker restart overlapping stop.
- [x] Run `npx vitest run test/integration/session-lifecycle.integration.test.ts` and confirm the current ordering fails the behavioral assertions.
- [x] Extract `src/session/playback-session.ts`; keep `src/session/session-manager.ts` responsible for selection, reuse, replacement, and inactivity.
- [x] Make one owner serialize seek/recovery/retirement, retain ownership until worker closure, and await background output work before deletion.
- [x] Preserve existing exported request/snapshot types. Run lifecycle, seek, readiness, damaged-disc and runway integration tests.

## 2. HLS publication (research before code)

- [x] Reconcile current VLC file output, manifest observations, placeholder writes and route delivery with primary HLS documentation; record sources and conclusions.
- [x] Add tests for missing earlier segments, a delayed/failed placeholder write, old-manifest observations after restart, and manifest-to-asset consistency.
- [x] Implement `src/session/hls-publication.ts` around the useful timeline implementation. Hide mutable slot state and publication ordering; use real temporary directories in tests.
- [x] Integrate into playback lifecycle; delegate stream asset preparation through the existing session manager seam so routes no longer compose storage and activity bookkeeping.
- [x] Preserve video-only manifest rewriting, transport normalization, traversal rejection, generated ranges and discontinuities.
- [x] Run publication/timeline tests plus stream/readiness/seek/recovery integration tests.

## 3. Browser playback (research before code)

- [x] Confirm browser module serving under both source execution and emitted output, native HLS/hls.js lifetime rules, and event ordering using repository evidence and primary documentation.
- [x] Add behavior tests for recovery with no log drawer, recovery retaining playback position, server seeks reloading correctly, and stale seek responses.
- [x] Extract browser playback from `src/ui/page.ts` into an independently testable browser module; establish event delivery before asynchronous HLS attachment.
- [x] Keep server logs and catalog refresh as independent event observers; dispose listeners and playback resources when leaving.
- [x] Serve browser assets through an explicit allowlist. Preserve layout and browser selection/video-only behavior.
- [x] Replace player script text assertions with asset/rendering and observable behavior checks; retain existing Playwright scenarios.

## Final verification

- [x] Independent review of lifecycle/publication/event invariants; address actionable findings.
- [x] Run `npm run typecheck`, `npm run build`, `npm test`, `npm run test:coverage`, and `npm run test:e2e` using an available browser.
- [x] Inspect final diff and working tree; document hardware-only validation limits and research results.

## Completed design and review

Research: [HLS publication](../../research/2026-09-14-hls-publication.md) and [browser playback](../../research/2026-09-14-browser-playback.md). Both investigations preceded their implementations.

Lifecycle regression tests first reproduced concurrent ownership failures. Final independent review additionally reproduced and fixed rejected-spawn cleanup, incomplete placeholder publication, stale end-of-title state after backward seeks, exhausted-session inactivity cleanup, and directory cleanup before a worker handle exists. Publication tests reject missing EXTINF and segment durations outside the fixed VLC target. Browser regressions cover recovery without logs, overlapping seek responses, final seek intent, region changes, video-only flags, and disposal.

No physical DVD or native Safari playback was exercised. Fake VLC and synthetic HLS validate ownership and browser behavior; inherited lightweight MPEG-TS validation and null-packet fallback do not guarantee decodable damaged-disc playback.

## Initial architecture verification results

- Typecheck and build passed.
- Vitest: 141 tests passed across 38 files, including 11 lifecycle and 13 publication cases.
- Coverage gates passed unchanged: statements 77.78%, branches 64.03%, functions 85.11%, lines 77.61%. Browser playback behavior is exercised by Playwright; its execution is not included in the Node coverage report.
- Full Playwright suite: 12 tests passed using installed Microsoft Edge through a temporary `channel: 'msedge'` configuration, removed afterward.
- Both browser assets served successfully from the compiled app; source asset routes are covered by Vitest.
- Final diff whitespace check passed. Changes remain uncommitted for review.

## Follow-up code review

The user requested fixes for all eight findings, then a commit and push.

- [x] Move manifest transformations into an inward media helper and select response MIME types in the route.
- [x] Use injected clocks for session timestamps, readiness and inactivity; recovery follow-up separates calendar time from monotonic elapsed time.
- [x] Remove session-manager non-null assertions and narrow the controller/snapshot explicitly.
- [x] Share one browser-compatible clock formatter across server and browser rendering.
- [x] Synchronize the stale-response regression on completion instead of a fixed sleep.
- [x] Reconcile a failed seek with the server's actual region before waiting for recovery.
- [x] Restore playback and subscriptions when returning from back/forward cache.
- [x] Provide useful fatal-error messages and a retry action for native HLS and hls.js.
- [x] Run final verification and review the fixes; see the [recovery follow-up results](2026-09-14-recovery-ownership.md#verification-results). Commit and push are the final delivery steps.
