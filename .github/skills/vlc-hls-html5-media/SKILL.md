---
name: vlc-hls-html5-media
description: Use when working on VLC DVD streaming, HLS manifests or segments, hls.js/native HTML5 video playback, VLC track selection, or browser media failures in this repository.
---

# VLC HLS HTML5 Media Integration

## When to Use

Use this skill for changes involving VLC command construction, DVD MRLs, HLS output, session readiness, track or subtitle selection, HTML5 media playback, hls.js/native HLS behavior, or browser media diagnostics in this repo.

Start by reading the relevant local boundary before changing behavior:

- `src/vlc/args.ts` for VLC command-line construction.
- `src/vlc/mrl.ts` for Windows DVD MRL formatting.
- `src/vlc/worker.ts` for the VLC worker boundary and runtime metadata enrichment.
- `src/session/session-manager.ts` for HLS session lifecycle and readiness.
- `src/app.ts` for stream asset routes and content types.
- `src/ui/page.ts` for HTML5 video, native HLS, and hls.js attachment.

## Repo Boundaries

- VLC is a server-owned CLI worker. Keep playback and streaming control behind `VlcWorker`, `buildHlsArgs`, and `spawnManagedProcess`; do not make the browser call VLC directly.
- The browser only consumes app-served HLS URLs under `/streams/:sessionId/:asset` plus `/assets/hls.mjs`.
- libVLC is only for optional runtime elementary stream label enrichment. Do not replace the CLI/HLS worker with libVLC playback control unless the architecture is explicitly changed.
- This repo targets a Windows-hosted DVD drive. Build MRLs through `src/vlc/mrl.ts`: disc MRLs look like `dvd:///F:/`, and title MRLs look like `dvd:///F:/#1`.
- Session readiness is file readiness: `index.m3u8` exists and at least one `.ts` segment exists. Process start alone is not ready.

## VLC Command Construction Rules

- Centralize argument changes in `src/vlc/args.ts`; avoid scattered string-built VLC commands.
- Keep VLC headless for server work: `--intf dummy`, no video title overlay, no DVD menu navigation for title playback, and managed process stdout/stderr capture.
- Use the established HLS shape: transcode DVD video to browser-safe H.264 and audio to AAC, then write livehttp MPEG-TS segments and an M3U8 index.
- Keep the livehttp `index`, `index-url`, and `dst` values consistent with the app route and output directory. The manifest must name segment URLs that `src/app.ts` can serve.
- Prefer explicit track IDs only after mapping repo catalog choices to VLC's indexing. `--audio-track` and `--sub-track` are 0-based in local validation notes.
- For default English audio, prefer language selection only when no explicit audio track is selected.
- DVD subtitles are bitmap/subpicture streams, not WebVTT. For this HTML5 HLS path, selected DVD subtitles must be burned into the video with VLC transcode overlay behavior (`soverlay`).
- Treat `vlc://quit` as appropriate for finite probes and thumbnails; HLS playback sessions are long-lived until the session manager stops them.

## Process and Readiness Rules

- A started VLC process is not proof of playback. Wait until the manifest and first segment are present.
- If VLC exits before readiness, surface stderr/stdout and the exact command context. Early exit usually points to a bad drive, bad MRL, missing VLC module/codec, inaccessible output path, or malformed `--sout` chain.
- Use generous readiness windows for real discs. Local validation observed first segments after several seconds, with manifests later than five seconds on some runs.
- Stop stale or replaced sessions through the session manager so the child process is terminated and output directories are cleaned up.
- Keep output-path handling server-side and avoid exposing arbitrary file paths through stream routes.

## HLS and HTML5 Playback Rules

- The HTML client should attach the app-served manifest URL to a `<video>` element, not a VLC URL.
- Use native HLS only when `HTMLMediaElement.canPlayType('application/vnd.apple.mpegurl')` indicates support in a native-HLS browser. Remember MDN defines `canPlayType()` as returning `probably`, `maybe`, or an empty string.
- Use hls.js for MSE-capable browsers: check `Hls.isSupported()`, create `new Hls()`, call `loadSource()`, then `attachMedia(video)`, listen for `Hls.Events.ERROR`, and call `destroy()` on cleanup.
- Keep media diagnostics attached to browser surfaces: `video.error`, `readyState`, `networkState`, `buffered`, `canplay`, `playing`, `waiting`, `stalled`, and hls.js fatal/non-fatal errors.
- Preserve the VS Code embedded browser workaround. When AAC decode fails in the embedded Chromium/Electron surface, the app can use the `videoOnly=1` stream path, which rewrites the manifest and filters audio from TS segments server-side.
- Serve HLS MIME types consistently: M3U8 as `application/vnd.apple.mpegurl` and TS as `video/mp2t`.

## Failure Diagnostics

When debugging playback, separate the failure layer before changing code:

- Disc/input: confirm the Windows drive and MRL format (`dvd:///F:/`, not `dvd://F:`), title number, and that VLC can read the disc.
- VLC command: inspect `--sout`, codec/transcode options, selected tracks, subtitle overlay, output directory, and stderr/stdout.
- HLS files: verify `index.m3u8`, at least one `.ts`, segment names, segment URLs, and whether files keep updating.
- Server routes: verify `/streams/:sessionId/index.m3u8`, segment responses, content type, path traversal protection, and optional `videoOnly=1` rewriting.
- Browser: inspect `canPlayType`, hls.js support, hls.js errors, `video.error`, and whether native HLS or hls.js was chosen.
- Codec/runtime: distinguish VLC encode failure from browser decode failure. VS Code embedded AAC issues can be browser-specific even when VLC and HLS files are valid.

## Common Mistakes

- Treating generic VLC web examples as if the browser should connect to VLC. In this repo, VLC writes files and the app serves them.
- Changing browser code to point at local file paths or VLC endpoints instead of app routes.
- Declaring readiness when the child process starts or when only the manifest exists.
- Using the wrong Windows DVD MRL shape or hand-building MRLs outside `src/vlc/mrl.ts`.
- Assuming VLC track numbers match UI display numbers without checking zero-based CLI IDs.
- Expecting DVD bitmap subtitles to appear as HTML text tracks instead of burning them into video.
- Replacing the CLI worker with libVLC because libVLC can embed playback elsewhere. In this repo, libVLC metadata is enrichment only.
- Dropping stderr/stdout from failures, which removes the most useful VLC diagnostic evidence.
- Applying short web-video timeouts to physical DVDs; startup and segment creation can be slow.

## Sources Considered

- VideoLAN VLC command-line help: `https://wiki.videolan.org/VLC_command-line_help/` and local `vlc-help.txt` / `vlc -H` output.
- VideoLAN Streaming HowTo command-line examples: `https://wiki.videolan.org/Documentation:Streaming_HowTo/Command_Line_Examples/`.
- VideoLAN livehttp/iPhone HLS example: `https://wiki.videolan.org/Documentation:Streaming_HowTo/Streaming_for_the_iPhone/`.
- VideoLAN libVLC 3.0 Doxygen: `https://videolan.videolan.me/vlc-3.0/group__libvlc.html`, `group__libvlc__media.html`, and `group__libvlc__media__player.html`.
- MDN HTMLMediaElement: `https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement`.
- MDN HTMLMediaElement.canPlayType: `https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType`.
- hls.js API docs: `https://github.com/video-dev/hls.js/blob/master/docs/API.md` and `https://hlsjs.video-dev.org/api-docs/hls.js.hls`.