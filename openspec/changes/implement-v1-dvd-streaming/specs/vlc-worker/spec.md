## ADDED Requirements

### Requirement: VLC preflight
The system SHALL detect and validate the configured VLC executable before media operations depend on it.

#### Scenario: Default VLC path exists
- **WHEN** VLC is installed at the default Windows path
- **THEN** the health check SHALL report VLC as found
- **AND** the detected path SHALL be included in dependency status.

#### Scenario: Configured VLC path is invalid
- **WHEN** the configured VLC executable path does not exist or is not executable
- **THEN** the health check SHALL report VLC as missing
- **AND** the UI SHALL show an actionable setup error.

#### Scenario: VLC command hangs
- **WHEN** a VLC preflight command exceeds its timeout
- **THEN** the system SHALL terminate that process
- **AND** report a timeout error instead of hanging indefinitely.

### Requirement: VLC-only DVD access boundary
The system SHALL route all DVD media access through a VLC worker abstraction.

#### Scenario: Component needs title metadata
- **WHEN** the catalog service needs title metadata
- **THEN** it SHALL request metadata through the VLC worker boundary.
- **AND** the worker MAY combine CLI probe results with playback-time libVLC enrichment before returning normalized metadata.

#### Scenario: Component needs video output
- **WHEN** the thumbnail service or session manager needs decoded DVD video
- **THEN** it SHALL invoke VLC through the VLC worker boundary.

#### Scenario: Alternate DVD tool is proposed
- **WHEN** implementation work needs more metadata or a different media pipeline
- **THEN** v1 SHALL use an alternate VLC command shape or expose an unsupported limitation
- **AND** it SHALL NOT add FFmpeg, MakeMKV, direct VOB parsing, or another sidecar DVD reader.

### Requirement: VLC control surface selection
The system SHALL use the stable public VLC control surface that matches the current operation, while keeping that choice hidden behind the VLC worker boundary.

#### Scenario: Deterministic process-owned work is started
- **WHEN** the worker performs preflight, title-number probing, duration probing, thumbnail capture, or HLS transcoding
- **THEN** it SHALL spawn the VLC executable directly with an argv array
- **AND** it SHALL own process timeouts, logs, and shutdown without shell wrappers.

#### Scenario: Language-bearing track labels are needed
- **WHEN** the catalog service needs audio or subtitle language labels that are not present in CLI probe output
- **THEN** the worker SHALL use playback-time libVLC media-player APIs for that title
- **AND** it SHALL wait for `MediaPlayerESAdded` or `MediaPlayerESSelected` before reading track descriptions or media tracks
- **AND** it SHALL NOT rely on `libvlc_media_parse_with_options()` alone for `dvd:///` metadata on VLC 3.x.

#### Scenario: Manual diagnostics need live player control
- **WHEN** an operator needs status, seek, pause, or similar live inspection for debugging
- **THEN** the system MAY expose VLC's Lua HTTP interface only on localhost
- **AND** it SHALL NOT make that HTTP surface the normal app control plane.

### Requirement: DVD title MRL construction
The system SHALL construct DVD title inputs through a tested MRL builder.

#### Scenario: Title input is built
- **WHEN** drive `D:` and title number `3` are requested
- **THEN** the MRL builder SHALL produce the configured VLC DVD title input for title 3
- **AND** the command builder SHALL keep the title-selection syntax isolated behind one module.

#### Scenario: Invalid title number is requested
- **WHEN** a title number is not a positive integer from the current catalog
- **THEN** the worker SHALL reject the request before spawning VLC.

### Requirement: Thumbnail command execution
The system SHALL use VLC's dummy interface and scene filter for title thumbnails.

#### Scenario: Thumbnail command is built
- **WHEN** a thumbnail is requested for a known title
- **THEN** the command SHALL include dummy interface mode, no video title overlay, DVD menu bypass, title input, start time, run time, scene filter path, prefix, format, replacement, and `vlc://quit`.

#### Scenario: Thumbnail command completes
- **WHEN** VLC exits after writing the expected image
- **THEN** the worker SHALL report success and the output path.

### Requirement: HLS command execution
The system SHALL use VLC to transcode a selected DVD title into HLS playlist and MPEG-TS segment files.

#### Scenario: HLS command is built
- **WHEN** a session starts for a selected title and options
- **THEN** the command SHALL include dummy interface mode, DVD menu bypass, selected audio track when provided, the title MRL, H.264 video, AAC audio, MPEG-TS segments, livehttp access output, index path, index URL, segment destination pattern, and deinterlace settings.

#### Scenario: Manifest and first segment are written
- **WHEN** VLC writes `index.m3u8` and at least one `.ts` segment
- **THEN** the worker SHALL report the session as ready.

#### Scenario: VLC exits before readiness
- **WHEN** VLC exits before writing the manifest and first segment
- **THEN** the worker SHALL report a failed session with captured log details.

### Requirement: Audio and subtitle option selection
The system SHALL apply audio and subtitle choices before starting VLC playback.

#### Scenario: Audio track is selected
- **WHEN** a playback request includes an audio track id
- **THEN** the VLC command SHALL include the selected audio track option if VLC supports that track.

#### Scenario: Subtitles are off
- **WHEN** a playback request has subtitle mode `off`
- **THEN** the VLC command SHALL avoid enabling subtitle burn-in.

#### Scenario: Subtitle burn-in is selected
- **WHEN** a playback request has subtitle mode `burn-in` with a supported subtitle track
- **THEN** the VLC command SHALL select that subtitle track for overlay into the video transcode.

### Requirement: VLC process lifecycle
The system SHALL own spawned VLC processes from start through cleanup.

#### Scenario: Session is stopped
- **WHEN** a session stop is requested
- **THEN** the worker SHALL terminate the associated VLC process
- **AND** confirm the process has exited or escalate termination after a timeout.

#### Scenario: Process emits logs
- **WHEN** VLC writes stdout or stderr
- **THEN** the worker SHALL capture the output for structured logs and diagnostics.

#### Scenario: Server exits
- **WHEN** the app server shuts down
- **THEN** all active VLC child processes SHALL be stopped.