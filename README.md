# VLC DVD Streamer

VLC DVD Streamer turns a Windows PC with a DVD drive into a simple browser player for the disc that is in the drive right now.

The normal usage flow is:

1. Install the app on the Windows PC that has the DVD drive.
2. Leave that PC signed in on your home or office LAN.
3. Insert a DVD.
4. Open the app from another machine on the same network.
5. Pick a title from the thumbnail grid.
6. Watch in the embedded HTML5 player and maximize it if you want full screen.

This project is intentionally about playback, not ripping, backup, or library management.

## What The UI Does

The UI is designed around the simplest reliable DVD workflow:

- A title grid with thumbnails so you can tell the main feature from extras.
- Audio and subtitle choices on each title card before playback starts.
- A dedicated player page with the normal browser video controls, which can be maximized full screen.
- Short status messages that tell you whether VLC is available, whether the disc is still loading, and how the browser attached to the stream.
- A single active stream model: starting a new title replaces the current session.

If you want full DVD menu emulation, multiple viewers at once, or internet-facing streaming, this is not that project.

## Quick Start

If you just want to run it manually on the current machine:

```powershell
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$env:DVD_DRIVE = 'F:'
npm install
npm run build
npm start
```

`npm start` now launches the server in the background, prints the PID, and writes manual-run logs to `.runtime\logs\manual-server.stdout.log` and `.runtime\logs\manual-server.stderr.log`.

Use `npm stop` to stop that background server again.

If you want the server attached to the current terminal instead, use `npm run start:foreground`.

Then open `http://127.0.0.1:3000` on the host PC.

If you want other machines on your LAN to reach it during a manual run, bind to every interface:

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$env:DVD_DRIVE = 'F:'
npm run build
npm start
```

Then open `http://<host-pc-ip>:3000` from another device on the same network.

## Install It For Daily Use

The Windows install script is for the appliance-style setup you asked for:

- the server stays available on the local network
- it does not open a browser automatically
- it watches the DVD drive for disc changes
- it refreshes the catalog when a disc is inserted, removed, or swapped
- it creates the Windows Firewall rule needed for other machines to connect

Run the installer from an elevated PowerShell window:

```powershell
npm run install:windows -- -Drive F: -Port 3000 -VlcPath 'C:\Program Files\VideoLAN\VLC\vlc.exe'
```

What the installer does:

- builds the app for production use
- writes `.runtime\installed-settings.json` with the selected drive, port, and VLC path
- creates a scheduled task named `VLC DVD Streamer` that starts the background host at logon
- creates a Windows Firewall inbound rule for the selected TCP port on Domain and Private networks
- starts the background host immediately so you do not have to log out and back in

After the install finishes, it prints the LAN URLs it found. Open one of those URLs from another machine on your network.

## How Day-To-Day Use Works

Once the installer is in place:

1. Keep the host PC signed in.
2. Insert a DVD.
3. Wait a few seconds for the background watcher to refresh the catalog.
4. From another machine, open `http://<host-pc-ip>:3000`.
5. Pick a title from the thumbnail grid.
6. Press `Start Stream`.
7. Use the browser's maximize or full-screen control on the player page if you want a larger view.

On some commercial discs, `Start Stream` can take around one to two minutes before the player page opens while VLC negotiates disc access and writes the first HLS segments.

Helpful UI details:

- `Show extras` reveals the shorter bonus titles that are hidden by default.
- `Open player` returns to the active session if you already started one.
- `Stop Stream` ends the current VLC-backed session.
- `Back to titles` returns to the thumbnail grid without closing the server.
- The player shows the full title duration from the DVD catalog even while HLS is still being generated.
- Seeking inside the browser's current buffered range stays local and does not restart VLC.
- Seeking to an unloaded title time asks the server to restart VLC at that DVD time and buffer a new HLS window.
- Generated segment files are retained for the active session and exposed through `stitched.m3u8`, so ranges produced before and after jumps can be stitched together as the title cache fills in.

If VLC stops producing new HLS segments during playback, the server treats that as a possible unreadable DVD area instead of waiting indefinitely. It stops the stalled VLC process, restarts the same title about 10 seconds farther ahead, serves the next HLS manifest with discontinuity markers, and shows a short recovery status on the player page. The browser should only see a coherent stream resume after the skipped range.

Recovery defaults can be tuned with these environment variables when you need to experiment with a difficult disc:

- `SESSION_RECOVERY_STALL_MS` defaults to `12000`.
- `SESSION_RECOVERY_RESTART_READINESS_MS` defaults to `30000`.
- `SESSION_RECOVERY_SKIP_SECONDS` defaults to `10`.
- `SESSION_RECOVERY_MAX_ATTEMPTS` defaults to `6`.

## LAN And Firewall Notes

The installed path is intended for local network access only.

- The installer binds the app to `0.0.0.0`, which makes it listen on the host PC's LAN interfaces instead of only `127.0.0.1`.
- The installer creates an inbound Windows Firewall rule for the chosen port on `Domain` and `Private` profiles.
- If your Windows network is marked `Public`, other devices may still be blocked until you switch that network to `Private` or change the firewall rule manually.
- This project is not set up for internet exposure. Keep it behind your home or office router.

If another machine cannot connect, check these first:

1. Confirm the host PC and the client device are on the same LAN.
2. Confirm the host PC's network profile is `Private`.
3. Confirm the firewall rule exists for the chosen port.
4. Confirm the scheduled task is running and `.runtime\logs\background-host.log` is being updated.

## Where The Installed Logs Live

The Windows install path writes runtime files here:

- `.runtime\manual-server.json`
- `.runtime\installed-settings.json`
- `.runtime\disc-state.txt`
- `.runtime\logs\manual-server.stdout.log`
- `.runtime\logs\manual-server.stderr.log`
- `.runtime\logs\background-host.log`
- `.runtime\logs\server.stdout.log`
- `.runtime\logs\server.stderr.log`

If you change the DVD drive letter, the port, or the VLC install path, rerun the installer with the new values.

## Development And Testing

Use the fake VLC shim when you want the full browser flow without a physical drive:

```powershell
$env:VLC_PATH = (Get-Command node).Source
$env:VLC_SHIM_SCRIPT = 'test/fixtures/fake-vlc.ts'
npm run dev
```

The main validation commands are:

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Important Limits

- One DVD drive.
- One active playback session at a time.
- Local network use only.
- DVD menus are not part of v1.
- DVD subtitles are image-based, so v1 supports subtitles off or burn-in, not live browser-selectable subtitle tracks.
- Users are responsible for using the software only where they have the right to play and stream the disc content.

## Project Docs

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

## License

MIT. See [LICENSE](LICENSE).
