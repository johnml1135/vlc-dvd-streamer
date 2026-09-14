# Recovery Ownership Implementation Plan

> Agentic workers: the user requested Luna implementation agents. Give recovery/timing, publication/feedback, and browser work separate file ownership; the primary integrates, verifies, and obtains independent review. User authorized execution, commit and push.

**Goal:** Reliable recovery decisions independent of timer luck, with current browser runway evidence.

**Architecture:** Playback session owns the complete recovery operation. PlaybackTime isolates elapsed deadlines and wakeups. Runway evidence validates region and report freshness behind a narrow interface.

**Tech stack:** TypeScript, Node 22, Vitest, Fastify, Playwright.

- [x] Add failing recovery ordering tests at the existing SessionManager interface: a readable segment emitted during stop must win; failed stop cannot commit a placeholder.
- [x] Add PlaybackTime production/manual adapters and exercise readiness and cancellation with logical time.
- [x] Concentrate recovery phases and retry state; revalidate before closure, collect output after closure, commit only current decisions.
- [x] Add region-qualified browser feedback, validation, sequence/freshness, and bounded fallback; add route and module tests.
- [x] Add browser reporter with ordered transport, source/seek guards, abortable disposal and focused regression tests.
- [x] Replace wall-time runway/readiness fixtures; preserve integration coverage of real publication bytes.
- [x] Update glossary and development/research docs; independently review spec compliance and implementation quality.
- [x] Run npm.cmd run typecheck, npm.cmd test, npm.cmd run test:coverage, npm.cmd run build and all Edge Playwright tests. Inspect git diff --check.
- [x] Remove temporary review configuration and prepare the verified changes for the authorized commit and push.

## Verification results

- Independent Sol spec, browser and standards reviews: GO after the reported findings were fixed.
- Typecheck and build passed. Compiled browser playback, event and shared formatter assets served successfully.
- Full Vitest: 42 files, 174 tests passed. The final coverage run also passed all 174 tests.
- Coverage thresholds passed unchanged: statements 83.43%, branches 71.55%, functions 90.04%, lines 84.27%.
- Full Playwright suite: 20 tests passed using installed Microsoft Edge. Its temporary configuration was removed.
- The hls.js feedback regression uses the real library and manifest/MediaSource lifecycle with controlled media readiness. It does not claim decoded playback from the minimal fake VLC transport data.
- Physical DVD behavior and native Safari playback remain hardware/browser validation limits.

Delivery follows this committed checklist: commit the authorized changes, push `main`, and verify remote HEAD and a clean worktree.
