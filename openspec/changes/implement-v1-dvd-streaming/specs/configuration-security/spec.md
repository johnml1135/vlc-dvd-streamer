## ADDED Requirements

### Requirement: Runtime configuration
The system SHALL load runtime settings from explicit configuration with safe defaults.

#### Scenario: Server starts with no custom config
- **WHEN** no custom configuration is provided
- **THEN** the server SHALL use default host, port, cache directory, VLC path candidates, title filter duration, inactivity timeout, video bitrate, and audio bitrate.

#### Scenario: Config value is invalid
- **WHEN** a configured path, port, duration, or bitrate is invalid
- **THEN** startup or health status SHALL report a clear configuration error.

#### Scenario: Cache directory is missing
- **WHEN** the configured cache directory does not exist
- **THEN** the server SHALL create required cache subdirectories.

### Requirement: LAN binding controls
The system SHALL make network binding explicit and visible.

#### Scenario: Server starts
- **WHEN** the server is listening
- **THEN** it SHALL log and display the exact local or LAN URL the user should open.

#### Scenario: Public bind is configured
- **WHEN** the host is configured as `0.0.0.0` or another non-loopback interface
- **THEN** the server SHALL treat the app as LAN-visible
- **AND** it SHALL show a warning if password protection is disabled.

#### Scenario: Public internet exposure is requested
- **WHEN** configuration or documentation would expose the app directly to the public internet
- **THEN** the system SHALL mark that exposure as unsupported for v1.

### Requirement: Optional password protection
The system SHALL support optional web password protection while leaving it off by default for personal LAN use.

#### Scenario: Password is not configured
- **WHEN** no web password is configured
- **THEN** the app SHALL allow access without authentication
- **AND** it SHALL warn when bound to a LAN-visible interface.

#### Scenario: Password is configured
- **WHEN** a web password is configured
- **THEN** API, WebSocket, page, and stream access SHALL require authentication.

#### Scenario: Authentication fails
- **WHEN** a request lacks valid credentials while password protection is enabled
- **THEN** the server SHALL reject the request without leaking stream files or catalog data.

### Requirement: File and identifier safety
The system SHALL prevent clients from selecting arbitrary local files or paths.

#### Scenario: Client references a stream file
- **WHEN** the client requests stream content
- **THEN** the server SHALL resolve the request only within known session directories.

#### Scenario: Client supplies an id
- **WHEN** the client supplies a disc id, session id, title number, segment name, or thumbnail path component
- **THEN** the server SHALL validate and sanitize the value before using it.

#### Scenario: Path traversal is attempted
- **WHEN** a request contains traversal or absolute path input
- **THEN** the server SHALL reject it before filesystem access.

### Requirement: Transient content storage
The system SHALL store generated playback artifacts as temporary runtime files, not permanent DVD archives.

#### Scenario: HLS segment is generated
- **WHEN** VLC writes HLS output for playback
- **THEN** the files SHALL be placed under the runtime session cache.

#### Scenario: Session ends
- **WHEN** playback stops, expires, or is replaced
- **THEN** the session files SHALL be removed when safe.

#### Scenario: Disc catalog is cached
- **WHEN** catalog metadata or thumbnails are cached
- **THEN** they SHALL be scoped to the current disc id and invalidated when the disc changes.