## ADDED Requirements

### Requirement: Disc waiting screen
The browser UI SHALL show the current disc availability state without requiring the user to know VLC or HLS concepts.

#### Scenario: No drive or empty drive
- **WHEN** the API reports `no_drive` or `empty`
- **THEN** the UI SHALL show the corresponding waiting state and a refresh action.

#### Scenario: Catalog is loading
- **WHEN** the API reports `disc_detected` or `catalog_loading`
- **THEN** the UI SHALL show that titles are being read.

#### Scenario: Catalog error occurs
- **WHEN** the API reports `catalog_error`
- **THEN** the UI SHALL show the user-facing error message and a retry action.

### Requirement: Catalog screen
The browser UI SHALL present playable DVD titles as title cards.

#### Scenario: Catalog is ready
- **WHEN** title data is available
- **THEN** the UI SHALL show title cards with thumbnail, label, duration, main-feature badge when inferred, playback options, and a play action.

#### Scenario: Extras are hidden
- **WHEN** short titles are hidden by default
- **THEN** the UI SHALL provide a show-extras control.

#### Scenario: Active stream exists
- **WHEN** a playback session is active
- **THEN** the catalog screen SHALL offer a stop-current-stream action.

### Requirement: Player screen
The browser UI SHALL play HLS through a normal HTML video element and expose expected playback controls.

#### Scenario: Native HLS is available
- **WHEN** `video.canPlayType("application/vnd.apple.mpegurl")` returns support
- **THEN** the player SHALL assign the manifest URL directly to the video element.

#### Scenario: hls.js is supported
- **WHEN** native HLS is not available and `Hls.isSupported()` returns true
- **THEN** the player SHALL load the manifest through hls.js and attach it to the video element.

#### Scenario: No HLS path is available
- **WHEN** neither native HLS nor hls.js is supported
- **THEN** the player SHALL show an unsupported-browser error.

#### Scenario: Session is starting
- **WHEN** the session has not produced a ready manifest and first segment
- **THEN** the player SHALL show startup progress rather than a blank player.

### Requirement: Playback controls and state
The browser UI SHALL rely on HTMLMediaElement behavior for ordinary playback controls and SHALL provide a title-level seek control when the server has DVD duration metadata.

#### Scenario: User interacts with playback
- **WHEN** playback is ready
- **THEN** the user SHALL be able to use play, pause, seek, volume, mute, and fullscreen controls supported by the browser.

#### Scenario: Full title duration is known
- **WHEN** a playback session includes DVD title duration metadata
- **THEN** the player SHALL show that full title duration without waiting for every HLS segment to be generated.

#### Scenario: User seeks within the current buffer
- **WHEN** the user selects a title time already present in the HTML media element's buffered ranges
- **THEN** the player SHALL seek locally within the existing media buffer
- **AND** it SHALL NOT ask the server to restart VLC.

#### Scenario: User seeks outside the current buffer
- **WHEN** the user selects a title time that is not present in the HTML media element's buffered ranges
- **THEN** the player SHALL request a server-owned session seek for that title time
- **AND** it SHALL show buffering feedback while the server prepares the new HLS window.

#### Scenario: Buffering occurs
- **WHEN** the video element emits `waiting` or related buffering state
- **THEN** the UI SHALL show buffering feedback.

#### Scenario: Fatal player error occurs
- **WHEN** hls.js or the video element reports a fatal error
- **THEN** the UI SHALL show a retry action and a useful error message.

### Requirement: Playback navigation
The browser UI SHALL let the user leave or stop playback intentionally.

#### Scenario: User returns to titles
- **WHEN** the user chooses back-to-titles
- **THEN** the UI SHALL return to the catalog screen without losing current disc context.

#### Scenario: User stops stream
- **WHEN** the user chooses stop stream
- **THEN** the UI SHALL call the session stop API and return to a stopped playback state.

#### Scenario: User starts another title
- **WHEN** the user starts a different title from the catalog
- **THEN** the UI SHALL allow the server to stop the previous session and start the new one.