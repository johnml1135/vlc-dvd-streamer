# API And UX Plan

## UX Principles

- The first screen is the app, not a marketing page.
- The user should not need to know what VLC, HLS, or titles mean.
- The default path should be: insert disc, choose video, play.
- Errors should say what happened and what to try next.
- Advanced details belong in logs or expandable diagnostics.

## Screens

### Disc Waiting Screen

Shown when no DVD is available.

States:

- No optical drive found.
- Drive found, no disc inserted.
- Disc inserted, waiting for mount.
- Disc detected, reading titles.

Primary visible action:

- Refresh.

### Catalog Screen

Shows the current disc and title cards.

Title card fields:

- Thumbnail.
- Title label.
- Duration.
- Main-feature badge when inferred.
- Audio selector when useful.
- Subtitle selector when useful.
- Play button.

Catalog controls:

- Refresh disc.
- Show extras.
- Stop current stream if active.
- Settings link or button.

### Player Screen

Contains a normal HTML5 video player.

Controls:

- Browser/native play controls or a thin custom shell over the video element.
- Back to titles.
- Stop stream.
- Retry when session fails.

The player should show session startup progress while the first HLS playlist and segment are being generated.

## REST API

### `GET /api/health`

Returns server and dependency status.

```json
{
  "ok": true,
  "vlc": { "found": true, "path": "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" }
}
```

### `GET /api/discs/current`

Returns current disc state and catalog summary.

```json
{
  "state": "catalog_ready",
  "disc": {
    "id": "disc-abc",
    "drive": "D:",
    "label": "DVD_VIDEO",
    "titleCount": 12
  }
}
```

### `POST /api/discs/current/refresh`

Forces disc detection and catalog refresh.

Response:

```json
{
  "state": "catalog_loading"
}
```

### `GET /api/discs/current/titles`

Returns visible title catalog.

Query parameters:

- `includeShort=true` to include likely extras and very short titles.

Response:

```json
{
  "discId": "disc-abc",
  "titles": [
    {
      "id": "title-3",
      "titleNumber": 3,
      "label": "Title 3",
      "durationSeconds": 6420,
      "isLikelyMainFeature": true,
      "thumbnailUrl": "/api/discs/current/titles/3/thumbnail.jpg",
      "audioTracks": [],
      "subtitleTracks": []
    }
  ]
}
```

### `GET /api/discs/current/titles/:titleNumber/thumbnail.jpg`

Returns cached thumbnail, generates it if missing, or returns a placeholder with an error logged.

### `POST /api/sessions`

Starts or reuses a stream session.

Request:

```json
{
  "discId": "disc-abc",
  "titleNumber": 3,
  "audioTrack": 1,
  "subtitle": { "mode": "off" }
}
```

Response:

```json
{
  "sessionId": "session-abc",
  "state": "starting",
  "manifestUrl": "/streams/session-abc/index.m3u8"
}
```

### `GET /api/sessions/:sessionId`

Returns current session state.

```json
{
  "id": "session-abc",
  "state": "ready",
  "manifestUrl": "/streams/session-abc/index.m3u8",
  "titleNumber": 3,
  "startedAt": "2026-05-13T00:00:00.000Z"
}
```

### `DELETE /api/sessions/:sessionId`

Stops the session and removes temporary files when safe.

Response:

```json
{
  "stopped": true
}
```

## Stream File Routes

### `GET /streams/:sessionId/index.m3u8`

Serves the HLS playlist.

### `GET /streams/:sessionId/:segmentName.ts`

Serves MPEG-TS segments for that session.

The route must reject path traversal and unknown session IDs.

## WebSocket Events

Use one WebSocket endpoint, likely `/ws`.

Event envelope:

```json
{
  "type": "session.updated",
  "payload": {}
}
```

Event types:

- `disc.updated`
- `catalog.updated`
- `thumbnail.updated`
- `session.updated`
- `session.log`
- `error`

Session update payload:

```json
{
  "sessionId": "session-abc",
  "state": "ready",
  "manifestUrl": "/streams/session-abc/index.m3u8"
}
```

## Browser Playback Plan

Browser player initialization:

```javascript
const video = document.querySelector("video");

if (video.canPlayType("application/vnd.apple.mpegurl")) {
  video.src = manifestUrl;
} else if (Hls.isSupported()) {
  const hls = new Hls();
  hls.loadSource(manifestUrl);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
  hls.on(Hls.Events.ERROR, (_event, data) => {
    // Surface recoverable vs fatal errors in the UI.
  });
}
```

HTMLMediaElement properties and events to use:

- `play()` and `pause()`.
- `currentTime` and `duration`.
- `volume` and `muted`.
- `buffered` and `seekable`.
- `loadedmetadata`.
- `timeupdate`.
- `seeking` and `seeked`.
- `playing`.
- `waiting`.
- `error`.

## Error Copy Guidelines

Use plain, actionable errors.

Examples:

- `VLC was not found. Install VLC or set the VLC path in settings.`
- `No DVD is inserted. Insert a disc and refresh.`
- `The disc was removed while streaming. Insert it again to continue.`
- `This title could not be opened by VLC. Try another title or check the disc.`
- `The stream did not produce video segments. Check VLC logs for details.`

## Settings For V1

Minimum settings:

- VLC executable path.
- Host and port.
- Optional web password.
- Cache directory.
- Minimum visible title duration.
- Max inactive session age.
- Default video bitrate.
- Default audio bitrate.
