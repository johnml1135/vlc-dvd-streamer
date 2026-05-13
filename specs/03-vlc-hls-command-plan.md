# VLC And HLS Command Plan

## Purpose

This file captures the planned command-line contract between the Node server and VLC.

The implementation should validate every command on Windows with VLC 3.x before treating it as stable.

## VLC Role

VLC is responsible for:

- Opening the DVD drive.
- Selecting a title without using DVD menus.
- Decoding DVD video and audio.
- Optionally overlaying selected DVD subtitles.
- Producing browser-compatible HLS files.
- Producing title thumbnails.

The browser never talks directly to VLC in v1.

## DVD Title MRL

VLC command-line help documents stream MRL syntax as:

```text
[[access][/demux]://]URL[#[title][:chapter][-[title][:chapter]]]
```

For DVDs, the relevant shape is:

```text
dvd://D:#3
```

Meaning:

- `D:` is the Windows DVD drive.
- `#3` selects title 3.

The implementation should keep title selection isolated behind a function so alternate MRL forms can be tested if needed.

## Thumbnail Command

Representative thumbnail command:

```powershell
& "C:\Program Files\VideoLAN\VLC\vlc.exe" `
  -I dummy `
  --no-video-title-show `
  --no-dvdnav-menu `
  "dvd://D:#3" `
  --start-time=600 `
  --run-time=1 `
  --video-filter=scene `
  --scene-path="C:\vlc-dvd-streamer\cache\discs\disc-abc\thumbs" `
  --scene-prefix="title-3" `
  --scene-format=jpg `
  --scene-replace `
  vlc://quit
```

Implementation notes:

- Compute `--start-time` from title duration.
- Prefer a point after the opening credits but before the middle of the title.
- If the output is black or missing, retry with another timestamp.
- Store only one thumbnail per title by default.

## HLS Command

Representative VLC HLS command:

```powershell
& "C:\Program Files\VideoLAN\VLC\vlc.exe" `
  -I dummy `
  --no-video-title-show `
  --no-dvdnav-menu `
  --no-sout-all `
  --audio-track=1 `
  "dvd://D:#3" `
  vlc://quit `
  --sout="#transcode{vcodec=h264,venc=x264{aud,profile=main,level=31,keyint=120,ref=1},vb=2500,acodec=mp4a,ab=160,channels=2,samplerate=48000}:std{access=livehttp{seglen=4,delsegs=false,numsegs=0,index=C:\vlc-dvd-streamer\cache\sessions\session-abc\index.m3u8,index-url=http://HOST:PORT/streams/session-abc/segment-########.ts},mux=ts{use-key-frames},dst=C:\vlc-dvd-streamer\cache\sessions\session-abc\segment-########.ts}" `
  --sout-transcode-deinterlace `
  --deinterlace-mode=yadif
```

## Encoding Choices

Baseline choices for v1:

- Container: HLS playlist plus MPEG-TS segments.
- Video codec: H.264.
- Audio codec: AAC/MP4A.
- Segment length: 4 seconds.
- Video bitrate: start around 2500 kbps for DVD quality.
- Audio bitrate: 160 kbps stereo.
- Audio sample rate: 48000 Hz.
- Deinterlace: enabled for DVD playback.
- Keyframe interval: align to segment length where possible.

Why this shape:

- HLS is the browser-friendly delivery layer.
- TS segments are the mature HLS path and match VLC `livehttp` examples.
- H.264 plus AAC is the safest cross-device codec pair.
- DVD source resolution does not need high bitrate HD output.

## Subtitle Strategy

DVD subtitles are image/subpicture streams, not simple text.

V1 should support:

- `off`: no subtitles.
- `burn-in`: select one subtitle track and overlay it into the video transcode.

Changing subtitle track requires starting a new HLS session.

Browser-selectable WebVTT captions are out of scope for v1 unless a reliable extraction path is later added.

## Audio Strategy

V1 should select one audio track before starting the session.

Mid-stream audio switching is out of scope for v1 because it would require either:

- multiple audio renditions in HLS, or
- restarting the VLC transcode.

The UI can still expose the choice before playback.

## VLC HTTP Control Commands

VLC's local Lua HTTP API includes useful status and control endpoints. They are not the primary v1 playback path, but they are useful for diagnostics and possible later live control.

Examples:

```text
/requests/status.json
/requests/status.json?command=pl_stop
/requests/status.json?command=pl_forcepause
/requests/status.json?command=pl_forceresume
/requests/status.json?command=seek&val=120s
/requests/status.json?command=volume&val=128
/requests/status.json?command=title&val=3
/requests/status.json?command=audio_track&val=1
/requests/status.json?command=subtitle_track&val=2
```

V1 should not require exposing VLC HTTP to the LAN. If enabled for diagnostics, bind it to localhost and proxy only explicit safe actions through the app.

## Fallback Packaging Plan

If VLC `livehttp` is unreliable on Windows, keep the browser/API contract unchanged and replace only the session worker.

Fallback option:

1. VLC reads and decodes the DVD title.
2. VLC emits a local MPEG-TS stream or file output.
3. FFmpeg segments that stream into HLS.

This adds complexity, so it is a fallback, not the initial implementation path.

## Validation Checklist

Before committing to VLC `livehttp` as the default worker, validate:

- Title selection works with `dvd://D:#N`.
- A representative commercial DVD title starts without menu interaction.
- `index.m3u8` is written on Windows.
- TS segments are written and served while VLC is running.
- Chrome or Edge can play the manifest through hls.js.
- Safari or iOS can play the manifest natively if available.
- Stopping VLC releases the DVD drive.
- Disc removal fails cleanly.
