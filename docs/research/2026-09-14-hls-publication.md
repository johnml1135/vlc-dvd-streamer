# HLS publication research

Research completed before implementing the publication module, then reviewed against the integrated code.

## Findings

HLS segments must be available when their manifest references appear. Manifest updates must appear atomic. An EVENT playlist may append entries but cannot rewrite earlier entries or change to VOD. Timestamp changes require discontinuity markers. This supports immutable segment identities, a new region URL for explicit seeks, and retained old region manifests. [RFC 8216, section 6.2.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.1)

VLC's livehttp implementation truncates numbered output files and publishes its index after closing a segment. A fresh raw directory for each VLC run prevents a later run from overwriting bytes advertised by an earlier manifest. This follows the producer's actual behavior rather than adding a speculative storage adapter. [VLC 3.0 livehttp source](https://github.com/videolan/vlc/blob/3.0.x/modules/access_output/livehttp.c)

Node does not guarantee atomicity for copyFile. Prepare each published file at a unique temporary path, rename it, then synchronously register it in the slot and asset maps. [Node filesystem documentation](https://nodejs.org/api/fs.html#fscopyfilesrc-dest-mode-callback)

## Chosen design

- `HlsPublication` owns raw generations, immutable published files, slot state, regions, revisions, manifests, and asset lookup. The playback session owns worker lifecycle and recovery decisions.
- Each VLC run writes under `raw/<generation>`. Public requests resolve a registered basename plus `generation` query; they never resolve an arbitrary filesystem path.
- Validate each referenced segment before publication. Observe raw-epoch progress even when a slot has already been published; cached title content does not prove a newly restarted worker is ready.
- Require a valid EXTINF before each URI. Preserve the configured target duration for the session; withhold segments whose rounded EXTINF exceeds it, leaving the valid prefix available for recovery. This enforces VLC's fixed two-second GOP contract without changing an advertised EVENT target. [RFC 8216, section 4.3.3.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.3.1)
- First publication wins for each slot for the session lifetime. This preserves previous EVENT entries and keeps old manifests useful. A published placeholder remains a placeholder until a new session is started.
- An explicit seek creates `index.m3u8?region=N`. Earlier regions freeze their publication revision and append ENDLIST. Recovery appends to the current region.
- Stitched snapshots use `stitched.m3u8?revision=N` and are closed immutable views. Filtering immutable slots by publication revision avoids retaining a full copy of every manifest.
- Successful asset reads update session activity and requested-slot tracking. Failed lookups do neither.

## Verification and limits

Regression cases cover missing first/middle segments, incomplete observations, delayed publication, immutable bytes after restart, first-publication-wins readiness, old regions and stitched revisions, query composition, and route lookup isolation.

The existing null-packet placeholder fallback is retained. It is not decodable video: MPEG-TS HLS segments require program information including PAT and PMT tables. The existing lightweight sync-byte check likewise does not validate decodability. These are inherited playback limitations, not guarantees provided by publication atomicity. [RFC 8216, section 3.2](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.2)

The timeline retains fixed title-time slots while manifests preserve parsed EXTINF durations. Real DVD timing and native-player behavior still require hardware/browser validation.
