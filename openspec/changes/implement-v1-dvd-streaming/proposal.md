## Why

The repository has strong planning notes but no executable implementation contract yet. This change turns the current product scope, architecture, API, VLC command plan, implementation phases, and verified research into OpenSpec artifacts that can drive the first working version.

## What Changes

- Create the v1 VLC DVD streaming app as a personal, local-network web app for one DVD drive, one active player, and one viewer at a time.
- Use Fastify + TypeScript for the Node.js server, API routes, WebSocket updates, static frontend hosting, stream file serving, configuration, and lifecycle ownership.
- Use VLC as the only DVD access, probing, thumbnail, and streaming engine. No FFmpeg sidecar, MakeMKV scanner, direct VOB reader, or alternate non-VLC DVD path is part of v1.
- Document the VLC control model as a split worker strategy: direct CLI process ownership for preflight, probing, thumbnails, and HLS, playback-time libVLC APIs for language-bearing track-label enrichment, and localhost-only VLC HTTP for diagnostics.
- Treat the DVD as a list of playable titles, not as an interactive menu tree.
- Generate temporary HLS files with VLC and play them in a browser through native HLS where available or hls.js where Media Source Extensions are available.
- Replace the prior concurrency model with a personal-use policy: starting a different title stops the existing VLC session and starts the requested one.
- Add a test strategy built around Vitest, fake VLC process fixtures, Fastify integration tests, Playwright Test, Playwright MCP for exploratory agent debugging, and an explicit real-hardware validation suite.

## Capabilities

### New Capabilities

- `disc-catalog`: Detect DVD availability, build a VLC-derived title catalog, filter titles, and generate thumbnails.
- `vlc-worker`: Discover and control VLC processes for probing, thumbnail capture, title playback, subtitle burn-in, and HLS generation.
- `streaming-sessions`: Manage single-viewer HLS session lifecycle, readiness, replacement, cleanup, and stream file serving.
- `web-api`: Expose REST and WebSocket surfaces for health, disc state, title catalog, thumbnails, sessions, and errors.
- `browser-playback`: Provide the catalog and player UX with native HLS or hls.js playback through a normal HTML video element.
- `configuration-security`: Provide configuration, LAN binding behavior, optional password protection, route safety, and cache path rules.
- `automated-testing`: Define repeatable automated tests, VLC mocking, Playwright usage, Playwright MCP usage, and hardware validation gates.

### Modified Capabilities

- None. This is the first OpenSpec change for a repo with no implemented capabilities.

## Impact

- Future implementation will add a TypeScript Node.js project, likely under `src/`, plus frontend assets, tests, and runtime cache directories.
- Runtime dependencies are expected to include Fastify, WebSocket support, hls.js, and a structured logger.
- Development dependencies are expected to include TypeScript, Vitest, Playwright Test, linting/formatting tools, and fake VLC test fixtures.
- The host system must have VLC installed for real playback. Automated CI must not require a physical DVD drive.
- Existing planning files under `specs/` remain as source notes, but this OpenSpec change becomes the implementation contract.