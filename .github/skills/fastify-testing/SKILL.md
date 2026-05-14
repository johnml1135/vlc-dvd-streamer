---
name: fastify-testing
description: Use when adding, changing, or reviewing Fastify, Vitest, Playwright, VLC worker, HLS playback, temp-cache, fake-process, or Node service tests in this repository.
---

# Fastify And Node Service Testing

Use this skill to keep tests for this app fast at the bottom, realistic at the edges, and safe around process and DVD hardware behavior.

## Sources

- Fastify Testing Guide: `https://fastify.dev/docs/latest/Guides/Testing/`
- Vitest Guide and config docs: `https://vitest.dev/guide/`, `https://vitest.dev/config/`
- Playwright Web Server and baseURL docs: `https://playwright.dev/docs/test-webserver`, `https://playwright.dev/docs/api/class-testoptions#test-options-base-url`
- Node.js fs and os docs: `https://nodejs.org/api/fs.html`, `https://nodejs.org/api/os.html`
- Local patterns: `src/app.ts`, `vitest.config.ts`, `playwright.config.ts`, `test/fixtures/fake-vlc.ts`, `test/helpers/temp-dir.ts`, `playwright/helpers/synthetic-hls.ts`

## Test Pyramid For This App

1. Unit tests in `test/unit/**`: pure parsing, argument construction, page rendering, config validation, catalog/session logic. Use fake objects and small temp dirs. Do not spawn VLC or start HTTP listeners.
2. Integration tests in `test/integration/**`: Fastify app, catalog/session managers, fake VLC process behavior, temp cache directories, lifecycle cleanup. Keep process-heavy tests sequential; this repo already sets `fileParallelism: false` for integration.
3. Browser tests in `playwright/**`: full user flows through the running server, `webServer`, `baseURL`, fake VLC env, and synthetic HLS where the browser player needs deterministic media.
4. Manual or real-hardware checks: only for DVD drive/VLC compatibility not covered by the fake worker. Never make CI depend on a physical disc or installed VLC when the fake can express the behavior.

## Fastify Route Injection

Prefer the `buildApp(deps)` factory from `src/app.ts` and `app.inject()` for API and HTML route behavior. Injection boots plugins without binding a port, keeps tests deterministic, and lets services be replaced directly.

```ts
const app = await buildApp({ config, services })
try {
  const response = await app.inject({ method: 'GET', url: '/api/health' })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ ok: true })
} finally {
  await app.close()
}
```

Use request options instead of string-building when behavior depends on method, headers, query, cookies, or payload. Assert status first, then parse JSON or inspect HTML. Close the app in `finally`; `onClose` stops active sessions.

Start a real listener only when testing socket-level behavior, external fetch clients, or Playwright flows. For WebSocket/event stream behavior, prefer injection only if it exercises the actual contract; otherwise use the smallest running-server test possible.

## Fakes And Hardware Boundaries

Use fakes for behavior, not for implementation details:

- For route tests, inject fake `catalogService`, `sessionManager`, `vlcWorker`, `eventHub`, or `serverLog` through `buildApp` services.
- For process behavior, use `test/fixtures/fake-vlc.ts` through `VLC_PATH: process.execPath` plus `VLC_SHIM_SCRIPT`. Cover healthy scan/playback, delayed startup, stderr, nonzero exits, and scratched-disc profiles before reaching for real VLC.
- For browser HLS flows, use Playwright `webServer` with repo env and `playwright/helpers/synthetic-hls.ts` when the test is about UI/player behavior rather than VLC segment generation.
- Reserve real DVD/VLC checks for manual validation or narrowly named opt-in tests. Mark assumptions clearly and keep them out of default `npm test` and `npm run test:e2e` unless the environment provides the hardware.

## Async Readiness

Test observable readiness, not elapsed time. Good readiness signals in this repo include a ready session state, an HLS manifest plus segment file, a fake VLC `FAKE_VLC_READY` line, a 2xx route response, a visible player control, or a stopped prior session.

When testing startup windows, make the delay meaningful and bounded. Use Vitest per-test timeouts only for cases that intentionally exercise long readiness windows, like the session readiness integration test. Avoid fixed sleeps; wait on app APIs, file existence, process completion promises, Playwright assertions, or helper functions that poll a specific condition.

## Temp Dirs And Cleanup

Use isolated cache roots for anything that writes manifests, segments, thumbnails, or logs. Prefer `mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-...-'))` and remove with `rm(dir, { recursive: true, force: true, maxRetries: ... })` when a test owns the directory. The repo-level integration setup creates `.cache`; do not let tests depend on stale `.cache` contents.

Always stop process-bearing services and managers in `finally` or `afterEach`: `await manager.stopAll()`, `await app.close()`, and await process completion handles when the assertion depends on exit state. On Windows, cleanup can race with still-open handles, so close/stop first and then remove temp directories.

## Common Mistakes

- Starting `src/server.ts` for route tests instead of injecting `buildApp(deps)`.
- Forgetting `await app.close()`, leaving session managers or sockets alive.
- Letting integration tests run in parallel when they share process fixtures, ports, `.cache`, or global env.
- Using real VLC or a real DVD to prove app behavior that `fake-vlc.ts` can model.
- Sleeping for readiness instead of waiting for manifest/session/UI/process evidence.
- Reusing `.cache` or a fixed output directory across tests, which hides ordering bugs.
- Testing fake internals instead of the public route/session/catalog contract.
- Forgetting Playwright `baseURL`; browser tests should navigate with relative URLs under the configured server.
- Setting `reuseExistingServer: true` in CI-like runs where stale server state would pollute results.
- Leaving env vars such as `FAKE_VLC_PROFILE`, `VLC_PATH`, or `VLC_SHIM_SCRIPT` mutated after a test.
