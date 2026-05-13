# VLC DVD Streamer

A local-network HTML5 DVD streaming app built around VLC as the disc playback engine.

The goal is simple: put a DVD in a Windows desktop, open a web page from another device on the LAN, see the playable titles on that disc, choose one, and watch it in a normal browser video player.

This project is intentionally separate from MakeMKV-Auto-Rip. It is not a rip automation tool. It is a focused browser playback experience for currently inserted DVDs.

## Status

Planning scaffold only. No application code has been implemented yet.

## Product Shape

The first version is a deterministic title-based player:

1. Detect the inserted DVD.
2. Build a catalog of titles on the disc.
3. Show title cards with screenshot, duration, and playback options.
4. Start a temporary HLS session for the selected title.
5. Play through HTML5 video, using native HLS where available and hls.js elsewhere.

DVD menus are not part of the first version. The app treats the disc as a collection of playable video titles.

## Planned Stack

- Windows host with VLC installed.
- Node.js web server for API routes, static UI, WebSocket status, and serving HLS files.
- VLC command-line workers for DVD title playback, thumbnail capture, and HLS segment generation.
- hls.js for browser HLS playback in Chromium, Edge, and Firefox.
- Native HLS playback for Safari and iOS where supported.

## Documentation

Start with the specs in order:

- [Product scope](specs/01-product-scope.md)
- [Architecture](specs/02-architecture.md)
- [VLC and HLS command plan](specs/03-vlc-hls-command-plan.md)
- [API and UX plan](specs/04-api-ux-plan.md)
- [Implementation plan](specs/05-implementation-plan.md)

## Important Constraints

- The app is for local-network use, not public internet streaming.
- One optical drive can realistically support one active transcode session at a time.
- Commercial DVD behavior varies. The first implementation must validate title selection, seeking, subtitles, and HLS output on real discs.
- DVD subtitles are image-based. The first version should support either subtitles off or server-side burn-in, not live browser-selectable WebVTT captions.
- Users are responsible for using the software only where they have the right to play and stream the disc content.

## License

MIT. See [LICENSE](LICENSE).
