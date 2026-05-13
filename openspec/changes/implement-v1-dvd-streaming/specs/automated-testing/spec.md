## ADDED Requirements

### Requirement: Unit test coverage
The project SHALL use Vitest for deterministic unit tests of server-side logic.

#### Scenario: Command builders are tested
- **WHEN** VLC command builders are changed
- **THEN** unit tests SHALL verify MRL construction, argument escaping, thumbnail command arguments, HLS command arguments, audio options, subtitle options, and timeout settings.

#### Scenario: Configuration logic is tested
- **WHEN** configuration defaults or validation change
- **THEN** unit tests SHALL verify valid defaults, overrides, invalid values, and cache directory paths.

#### Scenario: State machines are tested
- **WHEN** disc or session state transitions change
- **THEN** unit tests SHALL verify allowed transitions, failure transitions, replacement behavior, and cleanup triggers.

### Requirement: Fake VLC process testing
The project SHALL provide a fake VLC process fixture for automated tests that cannot require real VLC or a physical DVD.

#### Scenario: Fake VLC simulates HLS success
- **WHEN** an integration test starts a session with the fake VLC executable
- **THEN** the fake SHALL write a deterministic `index.m3u8` and `.ts` segment to the requested output directory.

#### Scenario: Fake VLC simulates readiness delay
- **WHEN** a test needs startup timing behavior
- **THEN** the fake SHALL delay manifest or segment creation in a controlled way.

#### Scenario: Fake VLC simulates failure
- **WHEN** a test needs process failure behavior
- **THEN** the fake SHALL exit early, omit files, or emit configured stderr output.

#### Scenario: Fake VLC simulates thumbnail generation
- **WHEN** a thumbnail test invokes the fake VLC scene command
- **THEN** the fake SHALL write or omit a deterministic image according to test configuration.

### Requirement: API and WebSocket integration tests
The project SHALL test Fastify routes and WebSocket events without real DVD hardware.

#### Scenario: Health endpoint is tested
- **WHEN** health tests run
- **THEN** they SHALL cover VLC found and missing cases.

#### Scenario: Session lifecycle is tested
- **WHEN** session integration tests run
- **THEN** they SHALL cover start, readiness, status, replacement, stop, failure, and cleanup using the fake VLC fixture.

#### Scenario: Stream file safety is tested
- **WHEN** stream route tests run
- **THEN** they SHALL cover valid manifest/segment reads, unknown sessions, and path traversal attempts.

#### Scenario: WebSocket events are tested
- **WHEN** disc, catalog, thumbnail, session, or error states change
- **THEN** tests SHALL verify the corresponding event envelopes and payloads.

### Requirement: Browser automation framework
The project SHALL use Playwright Test as the repeatable browser automation framework.

#### Scenario: Catalog flow is tested
- **WHEN** Playwright tests run against the app with fake catalog data
- **THEN** they SHALL verify waiting states, catalog cards, show-extras behavior, and play actions.

#### Scenario: Playback flow is tested
- **WHEN** Playwright tests run with fake HLS session output
- **THEN** they SHALL verify session startup UI, manifest assignment or hls.js path, stop stream, retry, and error states.

#### Scenario: CI runs browser tests
- **WHEN** CI runs browser tests
- **THEN** it SHALL use Playwright Test commands and reports rather than an MCP session.

### Requirement: Playwright MCP usage
The project MAY use Playwright MCP for exploratory, agent-driven browser inspection and debugging, but SHALL NOT rely on it as the CI test framework.

#### Scenario: Agent debugs UI behavior
- **WHEN** an agent needs to inspect the running app interactively
- **THEN** Playwright MCP MAY be used to navigate, inspect accessibility snapshots, and exercise UI flows.

#### Scenario: Automated acceptance is required
- **WHEN** a repeatable test must run locally or in CI
- **THEN** the test SHALL be implemented with Playwright Test, not only through Playwright MCP.

### Requirement: Hardware validation suite
The project SHALL define manual or env-gated hardware tests for real VLC and real DVD behavior.

#### Scenario: Hardware tests are disabled by default
- **WHEN** the normal test suite runs in CI or on a machine without a DVD drive
- **THEN** tests requiring real VLC, an optical drive, or a disc SHALL be skipped.

#### Scenario: Hardware validation is enabled
- **WHEN** an explicit environment flag and drive configuration are provided
- **THEN** the hardware suite SHALL validate VLC preflight, disc detection, title scan, thumbnail generation, HLS output, browser playback, seeking, stopping, and disc removal handling.

#### Scenario: Hardware validation fails
- **WHEN** real VLC or real DVD behavior differs from documented expectations
- **THEN** the failing command, VLC version, drive, title number, and logs SHALL be captured for diagnosis.

### Requirement: Verification commands
The project SHALL provide documented commands for unit, integration, browser, and hardware validation.

#### Scenario: Developer checks core behavior
- **WHEN** a developer runs the standard test command
- **THEN** unit and non-hardware integration tests SHALL execute without requiring VLC or a DVD.

#### Scenario: Developer checks browser behavior
- **WHEN** a developer runs the browser test command
- **THEN** Playwright Test SHALL start or reuse the app with fake VLC fixtures and produce a report.

#### Scenario: Developer checks real hardware
- **WHEN** a developer opts into hardware validation
- **THEN** the command SHALL require explicit environment values and SHALL warn that a real DVD drive and VLC are needed.