# Product Scope

## Goal

Build a local-network web app that lets a user insert a DVD into a Windows desktop and watch titles from that disc on another device through a browser.

The experience should feel like selecting a video from a media library, not like remote-controlling a DVD player.

## Core User Story

As a user with a DVD inserted in a desktop PC, I want to open a LAN URL from a phone, tablet, laptop, or TV browser, see the videos on the DVD, click one, and watch it with normal video controls.

## First-Version Experience

The home screen shows the current disc and a list of title cards. Each title card includes:

- Screenshot thumbnail.
- Title label, such as `Title 1`, `Title 2`, or an inferred main-feature label.
- Duration.
- Audio option if multiple practical audio tracks are detected.
- Subtitle option with explicit limitations.
- Play button.

When the user clicks Play, the app starts or reuses an HLS session for that title. The playback screen uses a normal HTML5 video element with play, pause, seek, volume, fullscreen, buffering, and error states.

## Non-Goals For Version 1

- Preserve DVD menus.
- Support interactive menu navigation.
- Serve multiple different titles from one physical drive at the same time.
- Rip or permanently archive discs.
- Expose the app safely over the public internet.
- Provide perfect browser-selectable DVD subtitle tracks.
- Build a full media-library product like Jellyfin.

## Success Criteria

A first implementation is successful when:

1. A Windows host with VLC installed can detect an inserted DVD.
2. The browser UI displays multiple DVD titles with durations and thumbnails.
3. Selecting a title starts HLS output without manual VLC interaction.
4. Playback works in at least one Chromium-based desktop browser using hls.js.
5. Playback works on at least one native-HLS browser/device if available.
6. The app reports clear errors when VLC is missing, no disc is inserted, a title cannot be read, or HLS generation fails.
7. Temporary stream files are cleaned up when the session ends or the disc changes.

## Key Product Decisions

- Treat the disc as a list of titles, not a menu tree.
- Generate temporary HLS streams rather than trying to pipe VLC's old web UI to the browser.
- Use VLC for disc access and decoding because VLC already handles the hard DVD playback surface.
- Keep the first version LAN-only and unauthenticated by default only if bound to trusted interfaces; add optional password protection early.
- Prefer reliable playback over low latency. A few seconds of startup delay is acceptable.

## Risks

- VLC HLS `livehttp` support on Windows may be uneven and must be validated early.
- DVD title numbering and durations can be strange on commercial discs.
- Some discs may contain fake titles or intentional structural oddities.
- Optical-drive read speed may limit seeking and concurrent users.
- DVD subtitles are bitmap/subpicture streams, not native browser text captions.

## Open Questions

- Should v1 include optional password protection, or require it by default?
- Should title metadata come from VLC probing, a MakeMKV-style scanner, or both?
- Should the first playback path be VLC `livehttp`, or should FFmpeg be reserved as an immediate sidecar fallback after VLC decoding?
- How aggressive should automatic title filtering be for bonus features and short clips?
