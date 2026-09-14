# Development Guide

This document keeps the development workflow out of the user-facing README.

## Local Development

Use Node.js 22.13 or newer. In source execution, the explicit browser asset routes strip TypeScript syntax; built execution serves the JavaScript emitted by `tsc`. Both use the same browser modules without a separate bundler.

Install dependencies and run the app with the fake VLC shim when you want the full browser flow without a physical DVD drive:

```powershell
npm install
$env:VLC_PATH = (Get-Command node).Source
$env:VLC_SHIM_SCRIPT = 'test/fixtures/fake-vlc.ts'
npm run dev
```

For a foreground production-style run:

```powershell
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$env:DVD_DRIVE = 'F:'
npm run build
npm run start:foreground
```

## Validation Commands

Run these before calling a change complete:

```powershell
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:e2e
```

The coverage command writes text, HTML, and lcov reports under [../coverage](../coverage). The Playwright suite starts the app with the fake VLC environment configured by [../playwright.config.ts](../playwright.config.ts).

## Useful Scripts

- `npm run dev` starts `tsx watch src/server.ts`.
- `npm start` starts the Windows background host through `scripts/windows/start.ps1`.
- `npm stop` stops the background host.
- `npm run start:foreground` starts `src/server.ts` in the current terminal.
- `npm run install:windows` installs the scheduled task and firewall rule.

## Fake VLC Profiles

The test shim lives at [../test/fixtures/fake-vlc.ts](../test/fixtures/fake-vlc.ts).

Useful environment knobs include:

- `VLC_PATH=(Get-Command node).Source`
- `VLC_SHIM_SCRIPT=test/fixtures/fake-vlc.ts`
- `FAKE_VLC_PROFILE=healthy`
- `FAKE_VLC_PROFILE=scratched-scan`
- `FAKE_VLC_PROFILE=scratched-playback`
- `FAKE_VLC_PROFILE=bad-sector-midplayback`
- `FAKE_VLC_BAD_END_SECONDS=12`

## Architecture Pointers

- App factory: [../src/app.ts](../src/app.ts)
- Production wiring: [../src/server.ts](../src/server.ts)
- Session selection, reuse and inactivity: [../src/session/session-manager.ts](../src/session/session-manager.ts)
- Serialized playback lifecycle and worker ownership: [../src/session/playback-session.ts](../src/session/playback-session.ts)
- Monotonic recovery deadlines and scheduling: [../src/session/playback-time.ts](../src/session/playback-time.ts)
- Current browser runway and download fallback: [../src/session/runway-evidence.ts](../src/session/runway-evidence.ts)
- Immutable HLS assets and versioned playlists: [../src/session/hls-publication.ts](../src/session/hls-publication.ts)
- VLC command construction: [../src/vlc/args.ts](../src/vlc/args.ts)
- VLC worker boundary: [../src/vlc/worker.ts](../src/vlc/worker.ts)
- Stream routes: [../src/http/routes/stream-routes.ts](../src/http/routes/stream-routes.ts)
- API routes: [../src/http/routes/api-routes.ts](../src/http/routes/api-routes.ts)
- Browser UI rendering: [../src/ui/page.ts](../src/ui/page.ts)
- Browser playback and title-time seeks: [../src/ui/browser-playback.ts](../src/ui/browser-playback.ts)
- Shared browser event transport: [../src/ui/browser-events.ts](../src/ui/browser-events.ts)
- Shared server/browser time formatting: [../src/shared/format-clock.ts](../src/shared/format-clock.ts)
- Pure HLS manifest transformations: [../src/media/hls-manifest.ts](../src/media/hls-manifest.ts)

Publication uses private output directories for each VLC run and publishes complete assets before advertising them. A published slot keeps its first bytes for the session, including a bad-sector placeholder. Explicit seeks create a new region URL; recovery appends to the current region. See the [publication research](research/2026-09-14-hls-publication.md) and [browser research](research/2026-09-14-browser-playback.md) for the source evidence and tradeoffs.

Recovery treats an elapsed deadline as a reason to inspect output. Before replacing a missing segment, the session closes the worker and checks its final output. Recovery decisions are cancelled by newer seek or stop intent. The [recovery design](superpowers/specs/2026-09-14-recovery-design.md) and [timing research](research/2026-09-14-recovery-timing.md) explain these ordering guarantees.

`SessionManagerOptions.time` supplies elapsed time and scheduling together. Tests use the manual adapter in `test/helpers/manual-playback-time.ts` to advance recovery deadlines while retaining real filesystem operations. `SessionManagerOptions.now` supplies calendar timestamps and activity times; changing it does not advance recovery. Browser feedback is qualified by the current region and expires after five seconds; current-region segment downloads provide a fallback when feedback is unavailable.

## Planning And Specs

OpenSpec change artifacts for the active implementation track:

- [../openspec/changes/implement-v1-dvd-streaming/proposal.md](../openspec/changes/implement-v1-dvd-streaming/proposal.md)
- [../openspec/changes/implement-v1-dvd-streaming/design.md](../openspec/changes/implement-v1-dvd-streaming/design.md)
- [../openspec/changes/implement-v1-dvd-streaming/research-verification.md](../openspec/changes/implement-v1-dvd-streaming/research-verification.md)
- [../openspec/changes/implement-v1-dvd-streaming/tasks.md](../openspec/changes/implement-v1-dvd-streaming/tasks.md)
- [superpowers/plans/2026-05-13-v1-command-harness-first-slice.md](superpowers/plans/2026-05-13-v1-command-harness-first-slice.md)

Capability specs live under [../openspec/changes/implement-v1-dvd-streaming/specs](../openspec/changes/implement-v1-dvd-streaming/specs):

- [Browser playback](../openspec/changes/implement-v1-dvd-streaming/specs/browser-playback/spec.md)
- [Streaming sessions](../openspec/changes/implement-v1-dvd-streaming/specs/streaming-sessions/spec.md)
- [VLC worker](../openspec/changes/implement-v1-dvd-streaming/specs/vlc-worker/spec.md)
- [Disc catalog](../openspec/changes/implement-v1-dvd-streaming/specs/disc-catalog/spec.md)
- [Web API](../openspec/changes/implement-v1-dvd-streaming/specs/web-api/spec.md)
- [Configuration and security](../openspec/changes/implement-v1-dvd-streaming/specs/configuration-security/spec.md)
- [Automated testing](../openspec/changes/implement-v1-dvd-streaming/specs/automated-testing/spec.md)
