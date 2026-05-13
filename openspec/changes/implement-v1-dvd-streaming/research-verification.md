# Research Verification

## Verified Sources

- VLC command-line help confirms the general stream MRL syntax `[[access][/demux]://]URL[#[title][:chapter][-[title][:chapter]]]`, DVD device inputs, dummy interface, scene filter options, playback start/run time options, audio/subtitle track options, stream output options, livehttp HLS output options, TS mux keyframe options, x264 options, deinterlace options, HTTP interface host/password options, and `vlc://quit`.
- VLC HTTP requests documentation confirms `/requests/status.xml`, `/requests/playlist.xml`, `pl_stop`, `pl_empty`, `seek`, and `volume` style control commands. This remains diagnostics-only for v1 and must be localhost-bound if enabled.
- hls.js documentation confirms hls.js works on top of a standard HTML video element, requires Media Source Extensions where native HLS is unavailable, supports MPEG-TS/H.264/AAC HLS inputs, and documents the native-HLS-first feature detection pattern using `video.canPlayType("application/vnd.apple.mpegurl")` before `Hls.isSupported()`.
- MDN HTMLMediaElement documentation confirms the media properties, methods, and events used by the browser player, including `play()`, `pause()`, `currentTime`, `duration`, `volume`, `muted`, `buffered`, `seekable`, `loadedmetadata`, `timeupdate`, `seeking`, `seeked`, `playing`, `waiting`, and `error`.
- Playwright documentation confirms Playwright Test is an end-to-end test framework with test runner, assertions, isolation, parallelization, reports, and support for Chromium, Firefox, and WebKit.
- Microsoft Playwright MCP documentation confirms Playwright MCP is a Model Context Protocol server for browser automation through accessibility snapshots. It is useful for agent-driven exploration and debugging, while Playwright Test is the better repeatable CI test framework.

## Corrections Applied

- Removed FFmpeg sidecar fallback from the v1 architecture. VLC remains the only DVD access and media generation engine.
- Removed MakeMKV-style or other companion scanner paths from v1 title metadata. Title metadata SHALL come through VLC only.
- Changed the concurrency model from multi-client same-session sharing to personal single-viewer replacement: a different title/options request stops the active session and starts the new one.
- Set optional password protection as off by default, with warnings when serving unauthenticated LAN-visible traffic.

## Still Requires Hardware Validation

- `dvd://D:#N` and any alternate VLC-only MRL shape must be validated against Windows VLC 3.x and real DVDs.
- VLC `livehttp` HLS output must be validated on Windows while reading from an optical drive.
- Audio track selection, DVD subtitle burn-in, deinterlacing quality, seek behavior, and drive release after process stop must be validated with representative discs.
- Commercial DVD behavior may vary. The project SHALL not implement decryption itself and SHALL rely only on installed VLC behavior.