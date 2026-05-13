# Architecture

## Summary

The app is a local web server plus a small set of VLC worker processes.

The server owns discovery, catalog state, browser APIs, session lifecycle, WebSocket updates, and cleanup. VLC is used as a media engine, not as the user interface.

## High-Level Components

### Web Server

Responsibilities:

- Serve the HTML/CSS/JS app.
- Expose REST endpoints for disc catalog and stream sessions.
- Serve generated HLS playlists and TS segments from a temporary stream directory.
- Broadcast disc, catalog, and session state over WebSocket.
- Enforce LAN binding and optional authentication.

Likely stack:

- Node.js.
- Express or Fastify.
- ws or a small WebSocket abstraction.
- Static file serving for `public/` and stream output directories.

### Disc Detector

Responsibilities:

- Find optical drives.
- Detect disc insertion and removal.
- Assign a stable `discId` for the current inserted disc.
- Notify the catalog service when a disc changes.

Initial implementation can poll at a short interval. Native Windows events can be added later if polling is not sufficient.

### Catalog Service

Responsibilities:

- Ask VLC or a companion scanner for title metadata.
- Normalize title data into a browser-friendly catalog.
- Filter likely junk titles by duration while preserving a `show extras` path.
- Cache catalog data for the current disc.

Catalog item shape:

```json
{
  "id": "title-3",
  "titleNumber": 3,
  "label": "Title 3",
  "durationSeconds": 6420,
  "isLikelyMainFeature": true,
  "thumbnailUrl": "/api/discs/current/titles/3/thumbnail.jpg",
  "audioTracks": [
    { "id": 1, "label": "Audio 1", "language": "unknown", "default": true }
  ],
  "subtitleTracks": [
    { "id": 0, "label": "Off", "mode": "off" },
    { "id": 1, "label": "Subtitle 1", "mode": "burn-in" }
  ]
}
```

### Thumbnail Service

Responsibilities:

- Generate one representative screenshot per title.
- Avoid black frames by seeking into the title, usually around 10 percent of duration or a capped value such as 10 minutes.
- Cache thumbnails under the current disc cache directory.
- Return a placeholder thumbnail only when generation fails.

### Stream Session Manager

Responsibilities:

- Create, reuse, monitor, and stop HLS sessions.
- Map a playback request to a session key: drive, disc, title, audio track, subtitle mode.
- Start VLC with a deterministic output directory.
- Wait until `index.m3u8` and the first segment exist before reporting ready.
- Kill the VLC worker on stop, inactivity, disc removal, or fatal process error.
- Clean old session directories.

Session shape:

```json
{
  "id": "session-abc123",
  "discId": "disc-xyz",
  "titleNumber": 3,
  "state": "starting",
  "manifestUrl": "/streams/session-abc123/index.m3u8",
  "startedAt": "2026-05-13T00:00:00.000Z",
  "lastAccessedAt": "2026-05-13T00:00:00.000Z"
}
```

### Browser Player

Responsibilities:

- Load native HLS where available.
- Load hls.js when native HLS is unavailable.
- Use HTMLMediaElement controls and events for playback state.
- Render friendly loading, buffering, and error states.
- Offer title return, stop stream, and retry actions.

## Data Flow

1. Server starts and checks configured VLC path.
2. Disc detector finds an inserted DVD.
3. Catalog service scans title metadata.
4. Thumbnail service creates missing screenshots.
5. Browser requests current catalog.
6. User picks title and playback options.
7. Server starts or reuses an HLS session.
8. VLC writes `index.m3u8` and `.ts` segments to a temporary directory.
9. Browser loads the manifest through native HLS or hls.js.
10. Server monitors session health and cleans up after use.

## State Model

Disc state:

- `no_drive`
- `empty`
- `disc_detected`
- `catalog_loading`
- `catalog_ready`
- `catalog_error`
- `disc_removed`

Session state:

- `starting`
- `buffering`
- `ready`
- `stopping`
- `stopped`
- `failed`

## Concurrency Model

Version 1 should allow one active VLC transcode per physical drive.

Multiple clients may watch the same active session if they request the same title and options. A different title or different subtitle burn-in option requires a different VLC process and should be blocked or should stop the existing session in v1.

## Caching And File Layout

Suggested runtime layout:

```text
.cache/
  discs/
    <disc-id>/
      catalog.json
      thumbs/
        title-1.jpg
        title-2.jpg
  sessions/
    <session-id>/
      index.m3u8
      segment-00000001.ts
      segment-00000002.ts
```

The server should never store DVD content permanently by default. HLS session files are transient playback artifacts.

## Error Handling

Each user-visible failure should include a concise message and a technical detail field for logs.

Important cases:

- VLC executable not found.
- VLC starts but exits before writing a manifest.
- No optical drive found.
- No disc inserted.
- Disc was removed during catalog scan.
- Disc was removed during streaming.
- Title metadata is unavailable.
- HLS manifest exists but no segments appear.
- Browser cannot play HLS and hls.js initialization fails.

## Security Model

Version 1 should default to local-network use. Public internet exposure is out of scope.

Recommended controls:

- Bind to `0.0.0.0` only when explicitly configured.
- Show the exact LAN URL on startup.
- Optional password for web access.
- No arbitrary file path input from clients.
- Serve only known stream-session directories.
- Sanitize all generated IDs.
