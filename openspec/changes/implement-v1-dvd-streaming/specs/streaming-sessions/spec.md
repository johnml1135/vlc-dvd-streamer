## ADDED Requirements

### Requirement: Single active playback session
The system SHALL support at most one active playback session for the current DVD drive in v1.

#### Scenario: Same session is requested again
- **WHEN** a client requests the same disc, title, audio option, and subtitle option as the active session
- **THEN** the session manager MAY reuse the active session
- **AND** it SHALL update `lastAccessedAt`.

#### Scenario: Different title is requested
- **WHEN** a client requests a different title or playback option while a VLC session is active
- **THEN** the session manager SHALL stop the active session
- **AND** start a new session for the requested title and options.

#### Scenario: Replacement startup fails
- **WHEN** the old session stops but the replacement session fails to become ready
- **THEN** the new session SHALL be marked `failed`
- **AND** the API SHALL return a clear playback-start failure.

### Requirement: Session state model
The system SHALL expose deterministic session states during playback lifecycle.

#### Scenario: Session is starting
- **WHEN** VLC has been spawned and readiness files are not available yet
- **THEN** the session state SHALL be `starting`.

#### Scenario: Session is ready
- **WHEN** the manifest and first segment are available
- **THEN** the session state SHALL be `ready`
- **AND** the manifest URL SHALL be returned to the client.

#### Scenario: Session fails
- **WHEN** VLC exits, times out, or cannot produce usable HLS files
- **THEN** the session state SHALL be `failed`
- **AND** the failure SHALL include user-visible and technical details.

#### Scenario: Session is stopped
- **WHEN** the user stops playback, the disc is removed, inactivity expires, or a replacement starts
- **THEN** the session SHALL transition through `stopping` to `stopped`.

### Requirement: HLS readiness detection
The system SHALL wait for concrete HLS files before telling the browser to play.

#### Scenario: Manifest appears first
- **WHEN** `index.m3u8` exists but no segment exists yet
- **THEN** the session SHALL remain `starting` or `buffering`.

#### Scenario: First segment appears
- **WHEN** `index.m3u8` and at least one referenced segment exist
- **THEN** the session SHALL become `ready`.

#### Scenario: Readiness timeout expires
- **WHEN** readiness files do not appear before the configured timeout
- **THEN** the session SHALL fail and VLC SHALL be stopped.

### Requirement: Temporary stream file serving
The system SHALL serve only files belonging to known stream sessions.

#### Scenario: Manifest is requested
- **WHEN** a client requests `/streams/:sessionId/index.m3u8` for a known session
- **THEN** the server SHALL return that session's playlist file with an HLS-compatible content type.

#### Scenario: Segment is requested
- **WHEN** a client requests `/streams/:sessionId/:segmentName.ts` for a known session
- **THEN** the server SHALL return the segment file with an MPEG-TS-compatible content type.

#### Scenario: Path traversal is attempted
- **WHEN** a stream route includes `..`, path separators in a segment name, or an unknown session id
- **THEN** the server SHALL reject the request without reading arbitrary files.

### Requirement: Session cleanup
The system SHALL clean temporary HLS session files when they are no longer needed.

#### Scenario: Session is stopped by user action
- **WHEN** the current session is stopped through the API
- **THEN** the VLC process SHALL stop
- **AND** its temporary session directory SHALL be removed when safe.

#### Scenario: Session is inactive
- **WHEN** no client accesses the session beyond the configured inactive age
- **THEN** the session manager SHALL stop the session and clean its files.

#### Scenario: Disc changes
- **WHEN** the active disc is removed or replaced
- **THEN** all sessions for the previous disc SHALL be stopped and cleaned.