## 1. Repository Foundation

- [ ] 1.1 Create a Fastify + TypeScript Node project with `package.json`, `tsconfig.json`, source folders, and npm scripts for dev, build, typecheck, lint, test, and browser tests.
- [ ] 1.2 Add structured logging, environment/config loading, runtime cache directory creation, and safe defaults for host, port, cache path, VLC path candidates, title duration threshold, inactive timeout, and bitrates.
- [ ] 1.3 Add a health route that reports server status and VLC dependency status.
- [ ] 1.4 Add an initial static frontend shell served by the Fastify app.

## 2. Test Harness First

- [ ] 2.1 Add Vitest configuration and unit test structure for server modules.
- [ ] 2.2 Add a fake VLC executable or fake media worker fixture that can write HLS manifests, TS segments, thumbnail files, stdout/stderr, delays, and failure exits.
- [ ] 2.3 Add integration test helpers for temporary cache directories, fake config, app startup, and cleanup.
- [ ] 2.4 Add Playwright Test configuration for browser tests against the local app with fake VLC fixtures.

## 3. VLC Worker

- [ ] 3.1 Implement VLC path discovery, version/preflight command execution, process timeouts, log capture, and clear missing-VLC errors.
- [ ] 3.2 Implement DVD title MRL and VLC argument builders with unit tests for drive, title, audio, subtitle, thumbnail, and HLS command options.
- [ ] 3.3 Implement VLC thumbnail command execution with output detection, retry timestamps, and placeholder fallback.
- [ ] 3.4 Implement VLC HLS command execution with manifest/first-segment readiness detection and failure reporting.
- [ ] 3.5 Enforce the VLC-only boundary in code organization so catalog, thumbnail, and streaming modules cannot use non-VLC DVD sidecars.

## 4. Disc Catalog

- [ ] 4.1 Implement optical drive and disc polling for Windows with states `no_drive`, `empty`, `disc_detected`, `catalog_loading`, `catalog_ready`, `catalog_error`, and `disc_removed`.
- [ ] 4.2 Implement current-disc identity and cache layout under `.cache/discs/<disc-id>/`.
- [ ] 4.3 Implement VLC-derived title metadata scanning and normalize titles into the catalog shape.
- [ ] 4.4 Implement short-title filtering, `includeShort=true`, and likely-main-feature inference.
- [ ] 4.5 Implement thumbnail cache and endpoint behavior through the VLC thumbnail worker.

## 5. Streaming Sessions

- [ ] 5.1 Implement the single active session manager with reuse for same title/options and replacement for different title/options.
- [ ] 5.2 Implement session states, timestamps, output directories, readiness polling, timeouts, log capture, and failure details.
- [ ] 5.3 Implement stop, inactivity cleanup, server shutdown cleanup, and disc-removal cleanup.
- [ ] 5.4 Implement safe stream file serving for manifests and TS segments with path traversal tests.

## 6. API And WebSocket Surface

- [ ] 6.1 Implement `GET /api/health`, `GET /api/discs/current`, and `POST /api/discs/current/refresh`.
- [ ] 6.2 Implement `GET /api/discs/current/titles` and `GET /api/discs/current/titles/:titleNumber/thumbnail.jpg`.
- [ ] 6.3 Implement `POST /api/sessions`, `GET /api/sessions/:sessionId`, and `DELETE /api/sessions/:sessionId`.
- [ ] 6.4 Implement one WebSocket endpoint with `disc.updated`, `catalog.updated`, `thumbnail.updated`, `session.updated`, `session.log`, and `error` events.
- [ ] 6.5 Implement consistent validation and error response shapes for user-facing messages and technical details.

## 7. Browser Experience

- [ ] 7.1 Implement the disc waiting screen for no-drive, empty-drive, loading, removed, and catalog-error states.
- [ ] 7.2 Implement the catalog screen with title cards, thumbnails, duration, likely-main-feature badge, audio selector, subtitle selector, play action, show-extras control, refresh, settings, and stop-current-stream action.
- [ ] 7.3 Implement the player screen with startup progress, native HLS detection, hls.js fallback, video controls, buffering state, fatal error handling, retry, stop stream, and back-to-titles actions.
- [ ] 7.4 Add Playwright tests for waiting, catalog, playback startup, stop, retry, and unsupported-browser states using fake data and fake VLC output.

## 8. Configuration And Security

- [ ] 8.1 Implement optional password protection that is off by default and applies to pages, API, WebSocket, and stream routes when configured.
- [ ] 8.2 Implement LAN binding behavior, exact URL display, and unauthenticated LAN warning when password protection is disabled on a non-loopback host.
- [ ] 8.3 Validate all client-supplied ids and path components for disc, title, session, thumbnail, manifest, and segment routes.
- [ ] 8.4 Document first-run configuration, VLC setup, Windows firewall guidance, LAN access, and the unsupported public-internet boundary.

## 9. Hardware Validation

- [ ] 9.1 Add env-gated hardware validation commands for real VLC and real DVD drive testing.
- [ ] 9.2 Validate on Windows with VLC 3.x that title MRL selection works without DVD menu interaction.
- [ ] 9.3 Validate real thumbnail generation, HLS manifest/segment output, hls.js playback in Chromium or Edge, seeking, stopping, and disc removal cleanup.
- [ ] 9.4 Capture VLC version, drive letter, title number, command arguments, and logs for hardware validation failures.

## 10. Final Verification

- [ ] 10.1 Run unit and non-hardware integration tests with fake VLC.
- [ ] 10.2 Run Playwright Test browser coverage with fake VLC output.
- [ ] 10.3 Run typecheck, lint, and production build.
- [ ] 10.4 Run OpenSpec validation for this change.
- [ ] 10.5 Update README with completed setup, run, test, and hardware validation commands.