# Implementation Plan

## Phase 0: Repository Foundation

Deliverables:

- README.
- MIT license.
- Planning specs.

Done when the repository can explain what will be built before code exists.

## Phase 1: App Skeleton

Deliverables:

- Node.js project setup.
- Web server with health endpoint.
- Static frontend shell.
- Configuration loading.
- Structured logger.
- Runtime cache directory creation.

Validation:

- Server starts on Windows.
- `GET /api/health` returns dependency status.
- Missing VLC path gives a clear error.

## Phase 2: VLC Preflight

Deliverables:

- VLC path detection.
- Version command with timeout.
- Test command for dummy interface startup.
- Configurable host, port, and cache directory.

Validation:

- VLC installed at default path is detected.
- A bad VLC path is reported clearly.
- VLC commands never hang indefinitely.

## Phase 3: Disc Detection

Deliverables:

- Optical drive detection on Windows.
- Disc inserted/empty state polling.
- Stable current-disc state model.
- WebSocket `disc.updated` events.

Validation:

- App shows no-disc state with an empty drive.
- App detects inserted DVD without restarting the server.
- App detects disc removal and stops active sessions.

## Phase 4: Catalog Service

Deliverables:

- Title metadata scan.
- Duration parsing.
- Main-feature heuristic.
- Short-title filtering with `show extras` support.
- `GET /api/discs/current/titles` endpoint.

Validation:

- A real DVD shows multiple titles.
- The longest title is marked as likely main feature.
- Short titles are hidden by default but retrievable.
- Catalog errors surface to UI and logs.

## Phase 5: Thumbnail Service

Deliverables:

- VLC scene-filter thumbnail command builder.
- Thumbnail cache by disc ID and title number.
- Retry timestamps for black/missing thumbnails.
- Thumbnail endpoint.

Validation:

- Each visible title eventually has a thumbnail.
- Missing thumbnail generation returns a placeholder, not a broken UI.
- Disc removal during generation is handled cleanly.

## Phase 6: HLS Session Manager

Deliverables:

- VLC HLS command builder.
- Per-session output directories.
- Manifest readiness detection.
- First-segment readiness detection.
- Stop and cleanup logic.
- `POST /api/sessions`, `GET /api/sessions/:id`, and `DELETE /api/sessions/:id`.
- Static serving for `/streams/:sessionId/*`.

Validation:

- Starting a title creates `index.m3u8` and `.ts` segments.
- Browser can fetch playlist and segments through the app server.
- Killing a session stops VLC and removes temporary files.
- Starting an unsupported concurrent title is blocked with a clear message.

## Phase 7: Browser Player

Deliverables:

- Catalog UI.
- Playback page or panel.
- hls.js integration.
- Native HLS branch.
- Loading, buffering, retry, and error states.
- Stop stream and back-to-catalog controls.

Validation:

- Chromium or Edge can play via hls.js.
- Browser controls can pause, resume, seek, mute, and fullscreen.
- Fatal hls.js errors appear as useful UI messages.

## Phase 8: Playback Options

Deliverables:

- Audio track selection before session start.
- Subtitle mode selection.
- Subtitle burn-in command option if validated.
- Config defaults for bitrate and title filtering.

Validation:

- Selected audio track is used when VLC supports it.
- Subtitle off works reliably.
- Subtitle burn-in either works on tested discs or is hidden behind an experimental flag.

## Phase 9: Robustness And Packaging

Deliverables:

- Startup checks.
- Windows firewall guidance.
- Optional password protection.
- LAN URL display.
- Inactivity timeout.
- Log download endpoint or log file location.
- Basic install/run documentation.

Validation:

- Clean first-run experience on a Windows desktop.
- Clear diagnostics for headless or monitorless hosts.
- No stale VLC processes after stop, crash, or disc removal.

## Test Strategy

Unit tests:

- Command builders.
- Config parsing.
- API response shapes.
- State transitions.
- Cache path sanitization.

Integration tests:

- Health endpoint.
- Session lifecycle with mocked VLC process.
- WebSocket event flow.
- Stream static file access restrictions.

Manual hardware tests:

- Empty drive.
- Insert DVD.
- Catalog scan.
- Thumbnail generation.
- Main title playback.
- Seek and resume.
- Disc removal during playback.
- VLC missing or bad path.

## First Prototype Milestone

The first useful milestone is not a polished UI. It is this end-to-end path:

1. Start server.
2. Insert DVD.
3. Scan titles.
4. Start title 1 or longest title.
5. Generate HLS files.
6. Load manifest in a browser with hls.js.
7. Stop session cleanly.

After that works, improve catalog quality and UI polish.

## Decisions To Revisit After Prototype

- Whether VLC `livehttp` is stable enough on Windows.
- Whether FFmpeg should be added as a required sidecar.
- Whether title metadata needs MakeMKV-style parsing.
- Whether subtitle burn-in is worth supporting in v1.
- Whether password protection should be mandatory by default.
