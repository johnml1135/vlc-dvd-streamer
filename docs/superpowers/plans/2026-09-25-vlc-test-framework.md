# Real VLC Test Framework And Startup Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make startup robust against VLC dialogs and silent stalls, exercise production VLC arguments through the fake, accept synthetic DVD folders, and add reproducible real-VLC integration coverage.

**Architecture:** Keep argument construction shared between real and fake execution; only substitute the process executable and shim prefix. Treat a DVD drive letter, DVD folder, and ISO as source strings at the app boundary, with path normalization owned by the MRL and IFO scanner helpers. Generate the real DVD-Video fixture from local command-line tools and keep real-VLC tests in a separate Vitest config.

**Tech Stack:** TypeScript/Node 22, Vitest, VLC 3.0.23, FFmpeg, mplex, spumux, dvdauthor.

---

## Work constraints and baseline

- Work only in the existing `test-framework` worktree. Leave changes uncommitted because the shared `.git` directory is read-only in this sandbox. At each logical milestone append the intended commit message and exact file list to `.cache/briefs/framework-commits.md` for the lead.
- Real VLC may only read the committed synthetic folder under `test/fixtures/dvd/`. Never invoke VLC with `F:` or any physical `dvd://` source.
- Do not alter the existing runway recovery behavior while adding startup diagnostics. The baseline has two runway recovery timeouts and one API loading-text assertion failure; record their final results.
- Use test-first changes. The final verification commands are `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:vlc`, followed by `tasklist | findstr vlc`.

## Task 1a: VLC option contract and dialog suppression

**Files:** `src/vlc/args.ts`, `src/vlc/probe-commands.ts`, `vlc-help.txt` (read-only source of truth), `test/unit/vlc/args.test.ts`, `test/unit/vlc/probe-commands.test.ts`, and a focused option-contract test.

- [ ] First add a test helper that reads `vlc-help.txt`, extracts all `--name` and `--no-name` spellings, maps negations to the base option, and validates generated argv tokens by stripping an optional `=value`. Test HLS default/audio/subtitle/start-time variants, thumbnail, placeholder, disc/title/language probes, and scan args; include a synthetic `--fake-duration=2000` token that must be rejected.
- [ ] Run the focused test and confirm it fails for the old `--fake-duration` option.
- [ ] Add `--no-interact` and `--no-qt-error-dialogs` to HLS, thumbnail, placeholder, and scan/probe args. Replace fake:// and `--fake-*` with committed still-image input and two-second silent WAV slave; retain H.264/AAC output and a real MPEG-TS file destination.
- [ ] Run the focused tests and append intended commit `fix: validate VLC options and suppress dialogs` plus its file list to `.cache/briefs/framework-commits.md`.

## Task 1b: Production argv through fake VLC

**Files:** `src/vlc/worker.ts`, `src/vlc/disc-scanner.ts`, `test/fixtures/fake-vlc.ts`, `test/integration/vlc/fake-vlc.integration.test.ts`, `test/unit/vlc/worker.test.ts`, and affected integration tests.

- [ ] Add tests that assert the shim receives `buildHlsArgs`, `buildThumbnailArgs`, and `buildPlaceholderArgs` unchanged after the `--import tsx <shim>` prefix. Confirm placeholder generation runs with a shim.
- [ ] Change worker command construction so only the executable changes in shim mode: use Node with the shim prefix and production args. Keep scan metadata behavior through environment selection, while the shim receives `buildScanArgs` for the actual source MRL.
- [ ] Rewrite the fake to parse known options from `vlc-help.txt`, separated and inline values, source MRL, HLS `index`/`dst`, initial segment number, scene path/prefix, and placeholder `dst`. Unknown options print the VLC-style message and exit 2. Preserve existing profiles and add `hang-silent`, `drive-busy`, `slow-start`, `dies-midstream`, `stall-then-resume`, and `eject-midstream`; take delay/segment limits from `FAKE_VLC_*` environment variables.
- [ ] Update mode-contract tests to invoke the fake with production arg builders. Run focused fake and worker tests; append intended commit `test: make fake VLC parse production arguments` plus its file list to `.cache/briefs/framework-commits.md`.

## Task 1c: Startup progress and failure details

**Files:** `src/session/playback-session.ts`, its options/tests, and a session/VLC startup integration test.

- [ ] Add a failing test using the fake's `hang-silent` profile with a short injected readiness timeout and progress interval. Assert bounded failure, at least one waiting log with VLC PID and stderr tail, plus failure detail containing stderr tail and exit status (`still running` when no exit occurred).
- [ ] Log a startup progress line every 10 seconds by default. Capture a bounded tail from `handle.getStderr()`. On exit report the actual exit code/signal and stderr tail; on timeout report the live/no-exit state and stderr tail.
- [ ] Run focused tests and append intended commit `fix: log stalled VLC startup progress` plus its file list to `.cache/briefs/framework-commits.md`.

## Task 2: DVD folder and ISO drive sources

**Files:** `src/config.ts`, `src/server.ts`, `src/disc/optical-drive.ts`, `src/disc/ifo-reader.ts`, `src/vlc/mrl.ts`, `src/vlc/disc-scanner.ts`, `src/disc/catalog-service.ts`, and their unit tests.

- [ ] Add failing tests for `DVD_DRIVE` as an absolute path, preserving its bypass of optical-drive detection; for folder MRLs in VLC form (`dvd:///C:/path/to/DISC/`); and for rejecting relative paths while retaining `F:` compatibility.
- [ ] Normalize drive letters to uppercase. Normalize absolute Windows folder paths to slash-separated DVD MRLs with escaped path characters and a terminal slash; normalize an ISO path as a VLC DVD source without treating it as a VIDEO_TS folder. Keep the public `drive: string` contract through catalog/session records.
- [ ] Make scanner IFO lookup use `<source>/VIDEO_TS` for a folder source and `<drive>/VIDEO_TS` for a drive letter. Document that ISO IFO parsing is unsupported; let VLC handle ISO probing when used.
- [ ] Add catalog assertions that returned metadata retains the configured folder source and reads IFOs from its `VIDEO_TS` child. Run focused unit tests and append intended commit `feat: accept DVD folder sources` plus its file list to `.cache/briefs/framework-commits.md`.

## Task 3: Synthetic DVD generator and real-VLC suite

**Files:** `scripts/build-dvd-fixture.ts`, `test/fixtures/dvd/`, `vitest.vlc.config.ts`, `test/integration/vlc/real-vlc.integration.test.ts`, `package.json`, and lockfile if dependencies change.

- [ ] Write a generator test or dry-run test first. The script resolves `FFMPEG_PATH`, `DVDAUTHOR_PATH`, and `SPUMUX_PATH`, defaulting to `C:\Program Files\DVDStyler\bin\ffmpeg.exe`, `dvdauthor.exe`, and `spumux.exe`; it uses adjacent `mplex.exe`. All temporary files go under `.cache/`.
- [ ] Generate two NTSC DVD MPEG program streams, approximately 20 seconds and 6 seconds, with two AC-3 language tracks and one English DVD subtitle stream. Run spumux and dvdauthor to create `VIDEO_TS.IFO`, `VTS_01_0.IFO`, and `VTS_01_1.VOB`; add the generator and outputs to the worktree. Add `npm run build:dvd-fixture` for regeneration.
- [ ] Add a separate Vitest config/script that logs a clear skip reason when `VLC_PATH` and the default VLC executable are absent. Keep the project excluded from `npm test`.
- [ ] Against only `test/fixtures/dvd/`, test IFO catalog titles/tracks, thumbnail output, first HLS segments and 2-second manifest entries, seek numbering, selected audio and burned subtitles, a playable placeholder TS, VLC stop/cleanup, and fast logged failure for a nonexistent folder. Track all child PIDs and assert their handles complete.
- [ ] Run focused fixture and real-VLC tests; append intended commit `test: add synthetic DVD real VLC suite` plus its file list to `.cache/briefs/framework-commits.md`.

## Task 4: Docs, required gates, and report

**Files:** `docs/development.md`, `README.md`, `.cache/briefs/framework-report.md`.

- [ ] Document fake profiles and relevant environment knobs, the isolated `npm run test:vlc` command and its skip behavior, fixture regeneration requirements, and the VLC popup troubleshooting note.
- [ ] Run all five required gates and record each exit code and relevant test counts. Run `tasklist | findstr vlc` and record whether any process remains. Do not repair the known runway failures as part of this task.
- [ ] Write the final report to `.cache/briefs/framework-report.md` and provide the same report to the user, with commit SHAs, deliverables, gate results, skipped checks, and remaining risks.
- [ ] Append intended commit `docs: document VLC integration workflow` plus its file list to `.cache/briefs/framework-commits.md`.
