## Context

The repo is a planning scaffold for a Windows-hosted DVD streaming app. The desired v1 experience is personal and deterministic: insert a DVD, open a LAN web UI, choose a title, and play it through a normal browser video player. The app is intentionally not a ripper, media library, DVD menu emulator, or public internet service.

The architecture is a Fastify + TypeScript server that owns state and lifecycle, plus VLC child processes that do all DVD access and media generation. VLC is a media engine only; the browser never talks directly to VLC in v1.

Because the app is Windows-hosted and command-driven, process supervision is part of the core architecture, not a low-level afterthought. The codebase should not let API handlers assemble ad-hoc shell strings or manage child-process lifecycle directly. Command construction, execution, timeout handling, and shutdown behavior need first-class boundaries.

User architecture decisions captured on 2026-05-13:

- Password protection is optional and off by default.
- Backend stack is Fastify + TypeScript.
- VLC is the only DVD engine. Remove FFmpeg fallback and other sidecar DVD access paths.
- Title metadata comes through VLC only.
- The app assumes one user, one viewer, one DVD player. Starting a different title stops the existing session and starts the new request.

## Goals / Non-Goals

**Goals:**

- Build a typed Fastify server with REST APIs, WebSocket state updates, static frontend serving, and safe stream file routes.
- Detect DVD drive/disc state and expose a VLC-derived title catalog with thumbnails, audio options, and subtitle limitations.
- Start, monitor, replace, stop, and clean VLC HLS sessions for selected titles.
- Play generated HLS through native HLS or hls.js using HTMLMediaElement controls.
- Make the core system testable without VLC or a physical DVD by using process-level fake VLC fixtures and temporary HLS outputs.
- Keep all DVD access behind a VLC worker boundary.

**Non-Goals:**

- DVD menus or interactive navigation.
- Multiple simultaneous titles, users, or transcodes.
- Permanent ripping or media-library indexing.
- Public internet exposure.
- FFmpeg, MakeMKV, direct VOB parsing, or other non-VLC DVD access in v1.
- Browser-selectable DVD subtitle tracks. V1 supports subtitles off or VLC burn-in when validated.

## Decisions

### Decision: Use a modular Fastify + TypeScript server

Fastify gives typed route schemas, good testability with request injection, and a clean plugin model without making the first version heavy. The server should be organized around feature modules rather than technical layers: config, VLC worker, disc catalog, streaming sessions, API routes, WebSocket events, and frontend hosting.

The app should be created through a `buildApp(deps)` factory rather than a process-global singleton. The entrypoint owns filesystem and process startup, while tests can call the same factory with fake config, temp cache directories, and fake VLC dependencies.

Alternatives considered:

- Express + TypeScript is familiar but gives less schema-driven structure.
- Minimal Node HTTP keeps dependencies low but pushes too much routing, validation, and test plumbing into app code.

### Decision: Separate command specs from process execution

Every VLC operation should pass through two boundaries:

- a command builder that turns validated business input into an executable path plus argv array
- a process supervisor that owns `spawn`, log capture, timeout/abort control, and stop escalation

This keeps Windows quoting, argument validation, and process shutdown logic out of route handlers and domain modules. It also makes the fake VLC harness straightforward: tests can validate the command builder separately from the process runner, and integration tests can substitute a fake executable without changing application code.

At the architecture level, each VLC invocation should have a typed command spec containing at least:

- executable path
- argv array
- working directory
- environment overrides
- timeout policy
- log label / operation type
- expected output contract when relevant

The process supervisor should return a managed handle that exposes spawned pid, collected stdout/stderr, completion status, and cancellation controls.

### Decision: Spawn VLC directly and avoid shell execution

The app should execute the VLC binary directly with an argv array and `shell: false`. It should not construct shell command strings from request-derived values. On Windows, that avoids shell quoting hazards, reduces command-injection risk, and keeps the app attached to the real VLC pid it wants to supervise.

Use `windowsHide: true` for managed VLC processes. Do not use `detached` for normal playback sessions because the app must stop VLC on session replacement, inactivity cleanup, disc removal, and server shutdown.

The supervisor should treat the child process `error` event as a spawn or delivery failure, and treat final completion on the `close` event after stdio has drained. Timeout handling should use abort/kill plus an explicit wait for process closure before cleaning session files.

### Decision: Keep VLC as the only DVD/media boundary

Every operation that touches DVD media SHALL go through the VLC worker boundary. This includes title probing, thumbnail capture, subtitle burn-in, and HLS generation. The codebase may use alternate VLC command shapes if `livehttp` needs adjustment, but it SHALL NOT add FFmpeg, MakeMKV, direct VOB readers, or other DVD sidecars in v1.

This keeps legal, operational, and testing boundaries simpler. It also avoids building two media pipelines before proving the first one.

### Decision: Model personal playback as replacement, not concurrency

The session manager should maintain at most one active playback session per configured drive. If a request asks for the same title/options while a session is active, it can reuse the existing session. If it asks for a different title/options, the server stops the existing VLC process, cleans or retires its session directory, and starts the requested session.

This matches the intended one-user appliance shape and avoids extra UX around conflicts.

### Decision: Use HLS files as the browser/server contract

The VLC worker writes a manifest and MPEG-TS segments into a session directory. The server waits for `index.m3u8` and the first segment before returning a ready session. The browser receives only app server URLs such as `/streams/:sessionId/index.m3u8`.

The app should prefer reliable startup and cleanup over low latency. A few seconds of startup delay is acceptable.

### Decision: Make automated tests own the process boundary

Tests should not shell out to real VLC by default. Core tests should use a fake VLC executable or fake media worker that can write deterministic playlists/segments, emit logs, delay readiness, exit early, and simulate disc removal. This lets unit, integration, and browser tests run in CI without hardware.

Use Vitest for unit and Node integration tests. Use Playwright Test for repeatable browser automation. Use Playwright MCP only for exploratory agent-driven debugging or visual/manual acceptance, not as the CI framework.

The Vitest setup should split unit and integration suites so process-heavy integration tests can run sequentially when needed. Browser automation should use Playwright's `webServer` plus `baseURL` pattern to boot the local app once and test it as a user would.

## Risks / Trade-offs

- VLC `livehttp` may behave differently on Windows/VLC 3.x than the documented examples. Mitigation: validate on real hardware before polishing UI and keep command construction isolated.
- Commercial DVDs may have confusing title structures. Mitigation: keep title filtering conservative and expose a show-extras path.
- VLC-only metadata may be incomplete. Mitigation: surface unknown language/track metadata clearly and avoid pretending labels are richer than they are.
- Optional password off by default is easier for personal LAN use but weaker if exposed broadly. Mitigation: default to explicit LAN binding, display a warning when unauthenticated on non-loopback interfaces, and keep public internet out of scope.
- Fake VLC tests can miss real drive timing and codec issues. Mitigation: maintain an env-gated hardware validation suite and do early prototype testing with real discs.
- Windows process semantics differ from POSIX signal semantics. Mitigation: keep one documented process-supervision path, avoid shell wrappers, and test timeout/kill behavior against the fake VLC harness before real-hardware validation.

## Migration Plan

This is a greenfield implementation. There is no data migration.

Implementation should proceed in vertical slices:

1. Project skeleton, health endpoint, config, logging, cache directories.
2. VLC preflight and fake VLC test harness.
3. Disc detection and VLC-derived catalog metadata.
4. Thumbnail generation and cache behavior.
5. HLS session manager and stream routes.
6. Browser catalog/player flow with hls.js/native HLS.
7. Playback options, cleanup, optional auth, and hardware validation docs.

## Open Questions

- Which exact VLC title-probing command gives reliable durations and track metadata on Windows VLC 3.x?
- Does `dvd://D:#N` work consistently for representative discs, or does the worker need a second VLC-only MRL shape?
- Which host binding should the first run default to: loopback with explicit LAN opt-in, or LAN interface with a visible unauthenticated warning?
- What minimum DVD/title duration threshold should be the default for hiding short clips?