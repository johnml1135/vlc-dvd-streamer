# Research Verification

## Verified Sources

- VLC command-line help confirms the general stream MRL syntax `[[access][/demux]://]URL[#[title][:chapter][-[title][:chapter]]]`, DVD device inputs, dummy interface, scene filter options, playback start/run time options, audio/subtitle track options, stream output options, livehttp HLS output options, TS mux keyframe options, x264 options, deinterlace options, HTTP interface host/password options, and `vlc://quit`.
- VLC HTTP requests documentation confirms `/requests/status.xml`, `/requests/playlist.xml`, `pl_stop`, `pl_empty`, `seek`, and `volume` style control commands. This remains diagnostics-only for v1 and must be localhost-bound if enabled.
- hls.js documentation confirms hls.js works on top of a standard HTML video element, requires Media Source Extensions where native HLS is unavailable, supports MPEG-TS/H.264/AAC HLS inputs, and documents the native-HLS-first feature detection pattern using `video.canPlayType("application/vnd.apple.mpegurl")` before `Hls.isSupported()`.
- MDN HTMLMediaElement documentation confirms the media properties, methods, and events used by the browser player, including `play()`, `pause()`, `currentTime`, `duration`, `volume`, `muted`, `buffered`, `seekable`, `loadedmetadata`, `timeupdate`, `seeking`, `seeked`, `playing`, `waiting`, and `error`.
- Playwright documentation confirms Playwright Test is an end-to-end test framework with test runner, assertions, isolation, parallelization, reports, and support for Chromium, Firefox, and WebKit.
- Microsoft Playwright MCP documentation confirms Playwright MCP is a Model Context Protocol server for browser automation through accessibility snapshots. It is useful for agent-driven exploration and debugging, while Playwright Test is the better repeatable CI test framework.
- Fastify documentation confirms `fastify.inject()` is the recommended route/plugin testing mechanism and supports an app-factory style that avoids binding a real network port during tests.
- Vitest documentation confirms support for `setupFiles`, multi-project test configuration, and disabling `fileParallelism` for sequential process-heavy suites.
- Playwright documentation confirms `webServer` plus `use.baseURL` is the intended way to start a local app once and exercise it through relative URLs.
- Node.js `child_process` documentation confirms the architectural rules that matter for this repo: `spawn()` and `execFile()` can execute binaries without a shell; `shell` execution is unsafe with unsanitized input; `windowsHide` is available for Windows subprocesses; `AbortSignal` can cancel `spawn()`/`execFile()`; the `error` event covers spawn/kill/abort failures; the `close` event occurs after stdio closes and is safer than `exit` for final completion; Windows only honors a narrow subset of signals and kills abruptly; shell wrappers can leave child-of-shell processes alive when the parent is killed.

## Corrections Applied

- Removed FFmpeg sidecar fallback from the v1 architecture. VLC remains the only DVD access and media generation engine.
- Removed MakeMKV-style or other companion scanner paths from v1 title metadata. Title metadata SHALL come through VLC only.
- Changed the concurrency model from multi-client same-session sharing to personal single-viewer replacement: a different title/options request stops the active session and starts the new one.
- Set optional password protection as off by default, with warnings when serving unauthenticated LAN-visible traffic.

## Command-Handling Conclusions

- Managed VLC playback and thumbnail jobs should be spawned directly from the VLC executable path with an argv array, not through shell command strings.
- `shell: true` should be avoided for VLC execution because it complicates Windows quoting and can break reliable process termination.
- `windowsHide: true` should be enabled for managed VLC processes on Windows to avoid console-window noise.
- The runner should determine final completion on the `close` event, not only `exit`, so stdout/stderr capture is complete before status evaluation or cleanup.
- The runner should explicitly handle `error`, `spawn`, `close`, and timeout/abort behavior as separate lifecycle events.
- The app should keep managed VLC sessions attached to the server process rather than using `detached`, because replacement, inactivity cleanup, and shutdown all require reliable ownership of the running process.
- For automated tests, the preferred strategy is not to mock shell strings or `child_process` internals everywhere. Instead, isolate command creation behind a typed builder and run integration tests against a fake VLC executable that behaves like the real process boundary.
- Process-heavy integration tests should be allowed to run sequentially when shared temp directories, ports, or fake executable state would make parallelism flaky.

## Framework Conclusions

- Fastify should be built through an application factory and tested through `inject()` wherever possible.
- Vitest should own unit and Node integration coverage for the command boundary and app services.
- Playwright Test should boot the app through `webServer` and use `baseURL` for browser tests.
- Playwright MCP remains useful for exploratory debugging, not as the repeatable CI runner.

## Still Requires Hardware Validation

- `dvd://D:#N` and any alternate VLC-only MRL shape must be validated against Windows VLC 3.x and real DVDs.
- VLC `livehttp` HLS output must be validated on Windows while reading from an optical drive.
- Audio track selection, DVD subtitle burn-in, deinterlacing quality, seek behavior, and drive release after process stop must be validated with representative discs.
- Commercial DVD behavior may vary. The project SHALL not implement decryption itself and SHALL rely only on installed VLC behavior.