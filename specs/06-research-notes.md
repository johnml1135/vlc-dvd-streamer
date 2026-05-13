# Research Notes

## Sources Used For Planning

This plan is based on the prior architecture research for a title-based HTML5 DVD streaming app, plus specific VLC, HLS, hls.js, and HTMLMediaElement behavior.

## VLC HTTP Control

VLC includes a Lua HTTP API with status and control endpoints such as:

```text
/requests/status.json
/requests/playlist.json
/requests/status.json?command=pl_stop
/requests/status.json?command=pl_forcepause
/requests/status.json?command=pl_forceresume
/requests/status.json?command=seek&val=120s
/requests/status.json?command=volume&val=128
/requests/status.json?command=title&val=3
/requests/status.json?command=audio_track&val=1
/requests/status.json?command=subtitle_track&val=2
```

For this project, the HTTP API is a secondary control and diagnostic surface. The browser should not need to control VLC directly in v1.

## VLC DVD MRLs

VLC command-line help documents stream MRL syntax:

```text
[[access][/demux]://]URL[#[title][:chapter][-[title][:chapter]]]
```

This supports a planned title MRL like:

```text
dvd://D:#3
```

The implementation must validate this syntax against VLC 3.x on Windows with real DVDs.

## VLC HLS Output

VLC's `livehttp` access output can produce HLS-style playlists and TS segments.

Important options:

- `seglen`: segment length.
- `numsegs`: number of segments in index.
- `delsegs`: whether old segments are deleted.
- `index`: path to generated playlist.
- `index-url`: URL used inside the playlist for segment references.
- `dst`: segment output path pattern.

Relevant stream-output shape:

```text
#transcode{vcodec=h264,acodec=mp4a}:std{access=livehttp{seglen=4,delsegs=false,numsegs=0,index=...,index-url=...},mux=ts{use-key-frames},dst=...}
```

## Browser HLS

Browser support is split:

- Safari and iOS can often play HLS natively in a video element.
- Chromium, Edge, and Firefox usually need hls.js.

Basic hls.js flow:

```javascript
const hls = new Hls();
hls.loadSource(manifestUrl);
hls.attachMedia(video);
hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
hls.on(Hls.Events.ERROR, (_event, data) => {});
```

## HTMLMediaElement Controls

The browser player should rely on HTMLMediaElement for normal playback behavior.

Core methods and properties:

- `play()`.
- `pause()`.
- `currentTime`.
- `duration`.
- `volume`.
- `muted`.
- `buffered`.
- `seekable`.

Core events:

- `loadedmetadata`.
- `timeupdate`.
- `seeking`.
- `seeked`.
- `playing`.
- `waiting`.
- `error`.

## DVD Structure Reality

DVD-Video is not a simple linear video file. It is a set of title/program chains, chapters, navigation data, VOB files, audio streams, and subpicture streams.

The product intentionally avoids DVD menu fidelity. The app should expose titles as playable videos and accept that some discs have unusual or deceptive title structures.

## Commercial DVD Constraint

Commercial DVDs may use CSS encryption and other structural complications. This project should not implement decryption itself. It relies on installed media tooling such as VLC to open playable discs and leaves lawful use decisions to the user.

## Early Validation Priority

Before building a polished UI, validate these facts with real hardware:

1. VLC can open the target drive and title non-interactively.
2. VLC can generate an HLS playlist and TS segments on Windows.
3. The app server can serve those files while VLC writes them.
4. hls.js can play the generated manifest in Edge or Chrome.
5. Session cleanup releases the optical drive.
