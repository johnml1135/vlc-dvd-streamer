## ADDED Requirements

### Requirement: Disc state detection
The system SHALL detect the current optical drive and DVD availability state on the Windows host.

#### Scenario: No optical drive exists
- **WHEN** the host has no detectable optical drive
- **THEN** the disc state SHALL be `no_drive`
- **AND** the UI SHALL show a no-drive state with a refresh action.

#### Scenario: Drive exists without a disc
- **WHEN** an optical drive is present and no DVD is inserted
- **THEN** the disc state SHALL be `empty`
- **AND** the UI SHALL ask the user to insert a disc.

#### Scenario: DVD is inserted
- **WHEN** a DVD becomes available in the configured or detected drive
- **THEN** the disc state SHALL transition through `disc_detected` and `catalog_loading`
- **AND** catalog generation SHALL begin without restarting the server.

#### Scenario: DVD is removed
- **WHEN** the active DVD is removed
- **THEN** the disc state SHALL become `disc_removed` or `empty`
- **AND** catalog cache entries for the previous current disc SHALL no longer be served as current data.

### Requirement: VLC-only title catalog
The system SHALL build the visible DVD title catalog from VLC-derived information only.

#### Scenario: Catalog scan succeeds
- **WHEN** VLC returns title metadata for an inserted DVD
- **THEN** the system SHALL normalize each playable title into an id, title number, label, duration, likely-main-feature flag, thumbnail URL, audio options, and subtitle options.
- **AND** the catalog SHALL include the current `discId`.

#### Scenario: Runtime label enrichment is available
- **WHEN** the base VLC probe finds track ids or counts but not language-bearing labels
- **THEN** the system SHALL perform a playback-time libVLC enrichment pass for that title through the VLC worker
- **AND** merge any discovered audio or subtitle language or description labels into the normalized catalog.

#### Scenario: VLC metadata is incomplete
- **WHEN** playback-time VLC enrichment still cannot provide language or track labels
- **THEN** the system SHALL use explicit fallback labels such as `Audio 1` or `Subtitle 1`
- **AND** the UI SHALL not imply that unknown metadata is known.

#### Scenario: Non-VLC scanner would be needed for richer metadata
- **WHEN** richer metadata is unavailable through VLC
- **THEN** the system SHALL keep the metadata unknown or generic
- **AND** it SHALL NOT read DVD media through FFmpeg, MakeMKV, direct VOB parsing, or another sidecar path in v1.

### Requirement: Title filtering
The system SHALL hide likely short clips by default while preserving a way to show extras.

#### Scenario: Default catalog request
- **WHEN** a client requests the current title catalog without `includeShort=true`
- **THEN** titles shorter than the configured minimum visible title duration SHALL be hidden unless no longer playable title exists.

#### Scenario: Extras request
- **WHEN** a client requests the current title catalog with `includeShort=true`
- **THEN** the response SHALL include short titles and extras that were hidden by default.

#### Scenario: Main feature inference
- **WHEN** the catalog contains multiple titles with known durations
- **THEN** the longest practical title SHALL be marked as likely main feature.

### Requirement: Thumbnail generation
The system SHALL generate and cache one representative thumbnail per visible title using VLC.

#### Scenario: Thumbnail cache miss
- **WHEN** a thumbnail is requested for a title without a cached image
- **THEN** the thumbnail service SHALL invoke VLC with the scene filter against that title
- **AND** it SHALL save the result under the current disc cache directory.

#### Scenario: Thumbnail output is missing or black
- **WHEN** the first thumbnail attempt does not produce a usable image
- **THEN** the system SHALL retry at another timestamp before falling back to a placeholder.

#### Scenario: Thumbnail generation fails
- **WHEN** VLC cannot generate a thumbnail for a title
- **THEN** the endpoint SHALL return a placeholder image
- **AND** the technical failure SHALL be logged.

### Requirement: Catalog error reporting
The system SHALL expose catalog failures as user-readable state plus technical details for logs.

#### Scenario: VLC cannot scan titles
- **WHEN** VLC exits before title metadata is available
- **THEN** the disc state SHALL become `catalog_error`
- **AND** the API response SHALL include a concise message and technical detail field.

#### Scenario: Disc removed during scan
- **WHEN** the DVD is removed while catalog generation is running
- **THEN** the scan SHALL stop or be ignored
- **AND** the UI SHALL show that the disc was removed.