# VLC DVD Streamer 📀➡️📺

Turn the Windows PC with the DVD drive into a little living-room streaming box. Drop in a disc, open a browser from another machine on your LAN, pick the title you want, and watch through a normal HTML5 player.

No ripping workflow. No library management. No mystery VLC window on the client. Just the disc that is in the drive right now, streamed across your local network.

## Quick Start ⚡

Paste into PowerShell from the repo folder on the PC with the DVD drive.

First run (installs, builds, starts on the LAN, and opens the browser):

```powershell
$env:HOST='0.0.0.0'; $env:PORT='3000'; $env:VLC_PATH='C:\Program Files\VideoLAN\VLC\vlc.exe'; npm install; npm run build; npm start; Start-Process "http://$((Get-NetIPAddress -AddressFamily IPv4 | ? { $_.PrefixOrigin -eq 'Dhcp' } | Select -First 1).IPAddress):3000"
```

Later runs (already built):

```powershell
$env:HOST='0.0.0.0'; npm start
```

Stop the server:

```powershell
npm stop
```

The drive is auto-detected. If other devices can't connect, allow Node.js through Windows Firewall, or use the installer below.

## What It Does ✨

- Auto-detects the optical drive (the one with a disc loaded) so you usually don't need to configure a drive letter.
- Scans the inserted DVD almost instantly by reading its IFO files directly, and shows a title grid with thumbnails.
- Recognises a disc it has seen before (by fingerprinting its IFO files, not by drive letter) and shows its catalog and thumbnails immediately.
- Tells you plainly when another program is holding the drive, instead of hanging.
- Highlights the likely main feature while keeping shorter extras available.
- Lets you choose audio and subtitle burn-in options before playback starts.
- Starts a server-owned VLC session and serves browser-safe HLS from the app.
- Shows the full DVD title length right away, even before every segment exists.
- Lets you jump around the title timeline.
- Keeps normal seeks local when the target is already buffered.
- Restarts VLC at the requested DVD time when you jump to an unloaded area.
- Keeps generated segments for the active session and stitches watched/jumped ranges into a cache manifest.
- Detects stalled DVD reads, fills unreadable sectors with a brief placeholder so the timeline stays accurate, and resumes instead of hanging forever.
- Lets one device watch at a time, with a one-click takeover when you move to another screen.
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

`-Drive` is optional — if you omit it (or don't set `DVD_DRIVE`), the app auto-detects the optical drive with a disc loaded. `DVD_DRIVE` accepts a drive letter such as `F:`, an absolute DVD folder path containing `VIDEO_TS`, or an absolute `.iso` path. The installer will:

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
- `Refresh Disc` always does a full rescan. A disc the app has seen before is recognised on insert and its saved catalog and thumbnails appear straight away.
- `Start Stream` starts the selected title.
- `Open player` returns to the current active stream.
- Starting another title replaces the current stream, because v1 intentionally supports one active playback session. This works even while the previous title is still starting, so you never wait behind a stuck start.
- If another program is using the drive, `Start Stream` and `Refresh Disc` fail straight away with "The DVD drive is in use by another program" and a `Retry` button.
- If several optical drives contain discs, the first one is used and the server log names the others. Set `DVD_DRIVE` to choose.

### Player

The player page has the browser video element plus a full-title timeline.

- The duration shows the full DVD title length, not just the current HLS window.
- If you seek inside the buffered range, playback jumps immediately without restarting VLC.
- If you jump to an unloaded part, the server moves VLC to that DVD time and buffers a new stream window.
- The old generated pieces are kept for the active session.
- `Stitched cache` points at a generated manifest that joins the retained ranges with HLS discontinuity markers where gaps still exist.
- `Back to titles` leaves the stream running while you browse titles.
- `Stop Stream` ends VLC and cleans up the session.
- If a stream fails or ends, the player says so and offers a way back rather than showing a frozen video. An old player link for a stream that has ended shows an "ended" page; links older than the last ten stopped streams return to the title list.

### One Viewer At A Time

A stream plays on one device at a time. If you open the player on a second device while the first is still playing, the second one shows "Playing on another device — Take over?" and plays nothing until you confirm. After a takeover, the first device shows "Watching elsewhere" with a `Take back` button. If the first device has gone away (closed, asleep, turned off) and has reported nothing for about 15 seconds, the new device takes over without asking. Reloading the page on the same device keeps ownership.

## Scratched Disc Recovery 💪

DVDs can hit bad sectors and cause VLC to stop producing new HLS data. The app watches for that and recovers **without distorting the timeline** — playback time always stays accurate to the DVD.

The title is modelled as a fixed grid of 2-second slots, where slot *N* always represents DVD time *[(N-1)×2, N×2)*. When a read stalls, the server:

1. treats the stall as a possible unreadable DVD area
2. **focuses on what plays next.** Because VLC transcodes faster than real time, a stall usually leaves a healthy buffer of already-produced content sitting ahead of the viewer. The server measures that *runway* — the gap between VLC's produced edge and the segment the browser has most recently fetched — and uses it to decide how hard to try before giving up. While the buffer is healthy it keeps retrying the **same** spot (the drive often reads through a rough patch on a later pass); if the still-running VLC simply went quiet, it is even left alone briefly to clear the hiccup itself with no disruptive restart.
3. only when the spot stays unreadable **and** the viewer is about to catch up to it (or the retry cap is reached) does it fill exactly that one 2-second slot with a short "bad sector" placeholder, mark an HLS discontinuity, and restart playback at the very next slot
4. repeats one slot at a time for as long as the disc is unreadable, then resumes normal playback the instant a readable sector returns

This also applies to the very first slot: a title that starts on a bad sector gets a placeholder and carries on instead of failing to start.

Because each unreadable slot is filled at its true position, a bad sector costs *exactly* its real length — a 6-second scratch fills 6 seconds, never a large jump. The browser plays a single server-composed manifest that stays anchored to the playback position and grows in place, so the displayed time always matches the disc. A manual seek opens a fresh region and re-reads from the target.

Recovery knobs are available if you need to experiment with a difficult disc:

- `SESSION_RECOVERY_STALL_MS` defaults to `10000` — how long a read must be silent before it counts as stalled.
- `SESSION_RECOVERY_RESTART_READINESS_MS` defaults to `30000` — how long a seek/start waits for fresh output.
- `SESSION_RECOVERY_READ_RETRIES` defaults to `12` — max re-read attempts at a stalled spot before filling one slot. Most transient hiccups clear in one or two; the higher cap mainly helps when there is buffer to spend.
- `SESSION_RECOVERY_SKIP_GUARD_SLOTS` defaults to `3` — buffer floor, in 2-second slots, kept ahead of the viewer. Once the runway drains to this, the server stops retrying and fills the slot just in time so playback never stalls.
- `SESSION_RECOVERY_MAX_STALL_PATIENCE_MS` defaults to `20000` — how long a stalled-but-still-running VLC may be left to self-recover (while buffered) before the server intervenes with a restart.
- `SESSION_RECOVERY_MAX_ATTEMPTS` defaults to `6` — consecutive failed VLC restarts before giving up.
- `SESSION_RECOVERY_SKIP_SECONDS` is retired (bad sectors are filled one slot at a time); the value is still accepted for compatibility but ignored.

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

The same log is also appended to a file on disk so failures survive after the in-memory buffer rolls over and after the process exits. By default it is written to `.cache\logs\server.log` (override with the `LOG_FILE` environment variable). When VLC exits or crashes — for example while starting a session with subtitles — its captured stderr and exit code are recorded in this file under the `session` scope, which is the first place to look when a stream fails to start.

On Windows, VLC can show modal error popups even with its dummy interface. The app disables VLC interaction and Qt error dialogs for playback, scanning, and thumbnail commands. During startup the log reports periodic progress with the VLC PID; a timeout includes the final stderr tail and whether VLC was still running. If a popup appears, check that the app is using the configured VLC executable and review the latest `session` and `catalog` log entries.

The app cleans up after itself even after a crash. Each VLC run works in its own scratch folder under the cache, so VLC's console output (which Windows VLC writes to a `vlc-help.txt` in its working folder) never lands in the app directory. On startup the server removes session folders left behind by a previous run, and stops any VLC process that it started itself and that is still running (matched by process id and start time). It never touches a VLC you opened yourself.

If the page will not load at all, check that nothing else is listening on the same port. Other home-media tools often default to `3000` too; set `PORT` (or reinstall with `-Port`) to move this app.

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

- Playback ownership, recovery flow, browser feedback, and HLS guarantees: [docs/architecture.md](docs/architecture.md)
- Developer setup, fake VLC profiles, the synthetic test DVD, `npm run test:vlc`, and planning links: [docs/development.md](docs/development.md)
- Domain glossary (Playback session, Active viewer, Disc identity, and so on): [CONTEXT.md](CONTEXT.md)
- License: [LICENSE](LICENSE)
