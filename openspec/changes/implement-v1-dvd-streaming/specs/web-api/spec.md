## ADDED Requirements

### Requirement: Health endpoint
The system SHALL expose dependency and server status through `GET /api/health`.

#### Scenario: Server is healthy
- **WHEN** the server is running and VLC preflight succeeds
- **THEN** `GET /api/health` SHALL return `ok: true`
- **AND** include VLC found status and path.

#### Scenario: VLC is missing
- **WHEN** VLC preflight fails
- **THEN** `GET /api/health` SHALL return `ok: false`
- **AND** include a clear VLC dependency error.

### Requirement: Disc API
The system SHALL expose current disc state and catalog refresh operations.

#### Scenario: Current disc is requested
- **WHEN** a client calls `GET /api/discs/current`
- **THEN** the response SHALL include current disc state and a disc summary when available.

#### Scenario: Disc refresh is requested
- **WHEN** a client calls `POST /api/discs/current/refresh`
- **THEN** the server SHALL trigger disc detection and catalog refresh
- **AND** return the resulting loading or current state.

### Requirement: Title catalog API
The system SHALL expose the current DVD title catalog and thumbnails.

#### Scenario: Titles are requested
- **WHEN** a client calls `GET /api/discs/current/titles`
- **THEN** the response SHALL include the current `discId` and title array.

#### Scenario: Short titles are requested
- **WHEN** `includeShort=true` is provided
- **THEN** the title response SHALL include likely extras and short clips.

#### Scenario: Thumbnail is requested
- **WHEN** a client calls `GET /api/discs/current/titles/:titleNumber/thumbnail.jpg`
- **THEN** the server SHALL return a cached thumbnail, generate it through VLC, or return a placeholder.

### Requirement: Session API
The system SHALL expose session start, status, and stop operations.

#### Scenario: Session start is requested
- **WHEN** a client calls `POST /api/sessions` with current `discId`, title number, audio option, and subtitle option
- **THEN** the server SHALL start, reuse, or replace the active session according to session policy
- **AND** return session id, state, and manifest URL.

#### Scenario: Session status is requested
- **WHEN** a client calls `GET /api/sessions/:sessionId`
- **THEN** the server SHALL return session state, manifest URL, title number, and timestamps for a known session.

#### Scenario: Session stop is requested
- **WHEN** a client calls `DELETE /api/sessions/:sessionId`
- **THEN** the server SHALL stop that session if it exists
- **AND** return whether it was stopped.

### Requirement: WebSocket updates
The system SHALL broadcast disc, catalog, thumbnail, session, and error events over one WebSocket endpoint.

#### Scenario: Disc state changes
- **WHEN** the disc detector changes state
- **THEN** connected clients SHALL receive a `disc.updated` event.

#### Scenario: Catalog changes
- **WHEN** catalog data or thumbnails are updated
- **THEN** connected clients SHALL receive `catalog.updated` or `thumbnail.updated` events.

#### Scenario: Session changes
- **WHEN** a session changes state
- **THEN** connected clients SHALL receive a `session.updated` event.

#### Scenario: Worker log is relevant
- **WHEN** VLC emits diagnostic output for the active session
- **THEN** the server MAY emit `session.log` events to authorized local clients or diagnostics views.

### Requirement: Error response shape
The system SHALL return actionable user messages with technical details suitable for logs.

#### Scenario: User-facing failure occurs
- **WHEN** VLC is missing, no disc is inserted, a title cannot be opened, or HLS generation fails
- **THEN** the API SHALL return a concise message explaining what happened and what to try next
- **AND** include a technical detail field for diagnostics.

#### Scenario: Client input is invalid
- **WHEN** an API request references an unknown title, disc, session, or invalid option
- **THEN** the API SHALL reject the request with a validation error.