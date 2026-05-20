# VLC DVD Streamer 📀➡️📺

Turn the Windows PC with the DVD drive into a little living-room streaming box. Drop in a disc, open a browser from another machine on your LAN, pick the title you want, and watch through a normal HTML5 player.

No ripping workflow. No library management. No mystery VLC window on the client. Just the disc that is in the drive right now, streamed across your local network.

## What It Does ✨

- Scans the inserted DVD and shows a title grid with thumbnails.
- Highlights the likely main feature while keeping shorter extras available.
- Lets you choose audio and subtitle burn-in options before playback starts.
- Starts a server-owned VLC session and serves browser-safe HLS from the app.
- Shows the full DVD title length right away, even before every segment exists.
- Lets you jump around the title timeline.
- Keeps normal seeks local when the target is already buffered.
- Restarts VLC at the requested DVD time when you jump to an unloaded area.
- Keeps generated segments for the active session and stitches watched/jumped ranges into a cache manifest.
- Detects stalled DVD reads, skips past bad sectors, and resumes instead of hanging forever.
- Includes a live server log drawer so you can see what the box is doing.
- Runs as a local-network appliance with a Windows scheduled task and firewall rule.

## The Normal Flow 🎬

1. Install the app on the Windows PC that has the DVD drive.
2. Leave that PC signed in on your home or office LAN.
3. Insert a DVD.
4. Open the app from another machine on the same network.
5. Pick a title from the thumbnail grid.
6. Press `Start Stream`.
7. Watch, pause, seek, jump around, and go full screen from the browser.

On some commercial discs, `Start Stream` can take around one to two minutes while VLC negotiates disc access and writes the first HLS segments. Once playback is ready, the browser gets app-served stream URLs under `/streams/...`; it never talks to VLC directly.

## Install It For Daily Use 🛠️

Run this from an elevated PowerShell window on the Windows PC with the DVD drive:

```powershell
npm run install:windows -- -Drive F: -Port 3000 -VlcPath 'C:\Program Files\VideoLAN\VLC\vlc.exe'
```

Use the drive letter for your DVD drive. The installer will:

- build the app for production use
- save the selected drive, port, and VLC path
- create a scheduled task named `VLC DVD Streamer`
- open the selected port in Windows Firewall for Domain and Private networks
- start the background host immediately
- print LAN URLs you can open from another device

After install, open one of the printed URLs from another computer, tablet, or phone on the same network, such as:

```text
http://192.168.1.25:3000
```

## Using The App 🍿

### Catalog

When a disc is ready, the home page shows title cards with thumbnails, durations, and playback options.

- `Show extras` reveals short bonus titles that are hidden by default.
- `Refresh Disc` rescans after swapping discs.
- `Start Stream` starts the selected title.
- `Open player` returns to the current active stream.
- Starting another title replaces the current stream, because v1 intentionally supports one active playback session.

### Player

The player page has the browser video element plus a full-title timeline.

- The duration shows the full DVD title length, not just the current HLS window.
- If you seek inside the buffered range, playback jumps immediately without restarting VLC.
- If you jump to an unloaded part, the server moves VLC to that DVD time and buffers a new stream window.
- The old generated pieces are kept for the active session.
- `Stitched cache` points at a generated manifest that joins the retained ranges with HLS discontinuity markers where gaps still exist.
- `Back to titles` leaves the stream running while you browse titles.
- `Stop Stream` ends VLC and cleans up the session.

## Scratched Disc Recovery 💪

DVDs can hit bad sectors and cause VLC to stop producing new HLS data. The app watches for that.

If playback stalls, the server:

1. treats the stall as a possible unreadable DVD area
2. stops the stuck VLC process
3. retries the same title from the last good time a few times
4. restarts the same title about 10 seconds farther ahead if the retries keep stalling
5. marks the HLS discontinuity
6. tells the browser to wait for recovered stream data

The goal is simple: give the disc a few chances to read through a rough spot, avoid an indefinite freeze, and let the browser resume after a skipped range only when retries fail. If you manually seek back before a previously skipped area, the server starts a fresh retry sequence instead of treating the earlier skip as permanent.

Recovery knobs are available if you need to experiment with a difficult disc:

- `SESSION_RECOVERY_STALL_MS` defaults to `10000`.
- `SESSION_RECOVERY_RESTART_READINESS_MS` defaults to `30000`.
- `SESSION_RECOVERY_SKIP_SECONDS` defaults to `10`.
- `SESSION_RECOVERY_READ_RETRIES` defaults to `3`.
- `SESSION_RECOVERY_MAX_ATTEMPTS` defaults to `6`.

## Run It Manually 🚀

For a quick local run instead of installing the scheduled task:

```powershell
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$env:DVD_DRIVE = 'F:'
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

To let other LAN devices reach a manual run:

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
$env:VLC_PATH = 'C:\Program Files\VideoLAN\VLC\vlc.exe'
$env:DVD_DRIVE = 'F:'
npm run build
npm start
```

Use `npm stop` to stop the background server. Use `npm run start:foreground` if you want the server attached to the current terminal.

## Logs And Troubleshooting 🔎

The player includes a `Server log` drawer with live events for disc scans, session startup, stream lifecycle, seek recovery, and scratched-disc handling.

Installed runtime files live under `.runtime`:

- `.runtime\installed-settings.json`
- `.runtime\disc-state.txt`
- `.runtime\logs\background-host.log`
- `.runtime\logs\server.stdout.log`
- `.runtime\logs\server.stderr.log`
- `.runtime\logs\manual-server.stdout.log`
- `.runtime\logs\manual-server.stderr.log`

If another machine cannot connect:

1. Confirm both devices are on the same LAN.
2. Confirm the host PC network profile is `Private`.
3. Confirm the firewall rule exists for the selected port.
4. Confirm the scheduled task is running.
5. Confirm `.runtime\logs\background-host.log` is updating.

## Important Limits 🚧

- One DVD drive.
- One active playback session at a time.
- Local network use only.
- DVD menus are not part of v1.
- DVD subtitles are image-based, so subtitles are off or burned into the video rather than browser-selectable text tracks.
- Generated stream files are temporary session cache, not a permanent rip or library.
- Use the software only where you have the right to play and stream the disc content.

## More Docs 📚

- Developer setup, fake VLC, tests, and planning links: [docs/development.md](docs/development.md)
- License: [LICENSE](LICENSE)
