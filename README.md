# VLC DVD Streamer

Turn a Windows PC with a DVD drive into a simple browser-based player for the disc that is currently inserted.

The intended experience is straightforward:

1. Put a DVD into the host machine.
2. Open the web app from another device on your LAN.
3. See the playable titles on that disc.
4. Pick a title.
5. Watch it in a normal browser video player.

If you are looking for rip automation, backup workflows, or library management, this is not that project. VLC DVD Streamer is intentionally focused on playback of the DVD that is in the drive right now.

## Who It Is For

- Personal, local-network use.
- One DVD drive.
- One active playback session at a time.
- One viewer switching between titles as needed.

## What Version 1 Is Trying To Do

The first version is a deterministic title-based player:

- Detect the inserted DVD.
- Build a title catalog from that disc.
- Show title cards with screenshot, duration, and playback options.
- Start a temporary HLS session for the selected title.
- Play through HTML5 video, using native HLS where available and hls.js elsewhere.

DVD menus are not part of v1. The app treats the disc as a collection of playable titles.

## What Version 1 Is Not Trying To Do

- Rip discs.
- Automate backups.
- Emulate full DVD menus.
- Support multiple simultaneous viewers.
- Expose the app to the public internet.

## Status

The repository now contains a working fake-VLC-backed vertical slice:

- a Fastify + TypeScript server with health, disc, title, session, stream, and WebSocket surfaces
- a VLC worker boundary with typed command builders, managed process supervision, thumbnail generation, and HLS session startup
- a single-session catalog/player browser flow served directly from the app
- Vitest integration coverage plus a Playwright smoke flow that opens the catalog and starts a session

The verified path today is the automated fake-VLC mode. Real VLC path detection is implemented, but real-disc scanning and playback still need hardware validation against Windows VLC 3.x.

## Run The Verified Flow

Use the fake VLC shim when you want the implemented browser/catalog/session flow without a physical drive:

```powershell
$env:VLC_PATH = (Get-Command node).Source
$env:VLC_SHIM_SCRIPT = 'test/fixtures/fake-vlc.ts'
npm run dev
```

Then open `http://127.0.0.1:3000`.

## Test And Build

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e -- playwright/smoke.spec.ts
```

## Hardware Validation Notes

For manual real-VLC bring-up, point `VLC_PATH` at `vlc.exe` and clear `VLC_SHIM_SCRIPT`:

```powershell
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
Remove-Item Env:VLC_SHIM_SCRIPT -ErrorAction Ignore
npm run dev
```

That path currently validates executable discovery and keeps the real VLC command builders isolated in code, but real title scanning and playback commands still need physical-drive validation before treating the app as hardware-ready.

## How It Works

The current plan is:

- VLC remains the only DVD/media engine.
- The server owns state, session lifecycle, and file serving.
- The browser only talks to the app server, never directly to VLC.
- Selecting a different title stops the current playback session and starts the new one.
- The app exposes a WebSocket feed at `/ws` for disc, catalog, thumbnail, and session updates.

## Developer Documentation

Core planning docs:

- [Product scope](specs/01-product-scope.md)
- [Architecture](specs/02-architecture.md)
- [VLC and HLS command plan](specs/03-vlc-hls-command-plan.md)
- [Implementation plan](specs/05-implementation-plan.md)

OpenSpec change artifacts for the active implementation track:

- [OpenSpec proposal](openspec/changes/implement-v1-dvd-streaming/proposal.md)
- [OpenSpec design](openspec/changes/implement-v1-dvd-streaming/design.md)
- [Research verification](openspec/changes/implement-v1-dvd-streaming/research-verification.md)
- [OpenSpec tasks](openspec/changes/implement-v1-dvd-streaming/tasks.md)
- [Harness-first implementation plan](docs/superpowers/plans/2026-05-13-v1-command-harness-first-slice.md)

## Important Notes

- The app is for local-network use, not public internet streaming.
- Commercial DVD behavior varies, so real-disc validation remains mandatory.
- DVD subtitles are image-based. V1 supports subtitles off or server-side burn-in, not live browser-selectable WebVTT captions.
- Users are responsible for using the software only where they have the right to play and stream the disc content.

## License

MIT. See [LICENSE](LICENSE).
