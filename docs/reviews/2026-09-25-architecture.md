# Architecture Review — 2026-09-25

## Scope and call

This is the Markdown replacement for the HTML report and selection question in the review process. The brief asks me to make the calls and disallows user interaction, so I rank the candidates below and recommend the first one. I read `CONTEXT.md`, `docs/architecture.md`, the sole file under `docs/superpowers/specs/`, the playback depth plan, source pointers, and recent history. There are no ADR files under `docs/adr/` to reconcile.

The review is read-only except for this report. I did not inspect `.worktrees/test-framework`, run tests, or invoke VLC. The main checkout already had a modified `.gitignore` and untracked `.worktrees/` and `coverage/`; I left them untouched.

## Hot spots from history

- Playback owns most recent change activity. `107606b refactor: own playback recovery and publication` moved lifecycle and recovery into `src/session/playback-session.ts` (then 1,179 added lines), added `hls-publication.ts` and `runway-evidence.ts`, and reduced `session-manager.ts` by over 1,100 lines. `ac3bf87` then documented the ownership and recovery guarantees.
- Session and damaged-disc behavior recurs through `0dc7bf0`, `a76dafc`, `713e812`, `aa1a07f`, `33b8926`, and earlier commits. The current controller is 1,059 lines; the surrounding design now has explicit ownership, manual elapsed time, region identity, and final-output collection.
- `src/vlc/disc-scanner.ts`, `src/vlc/worker.ts`, and optical-drive handling changed around `0dc7bf0`. Earlier work separated command construction (`args.ts`) and process supervision (`process-supervisor.ts`). These areas already have injected scanner runners and worker seams.
- The churn is now organized into named modules: `HlsPublication` protects immutable slot publication; `RunwayEvidence` owns untrusted viewer/download evidence; `PlaybackSessionController` owns mutations and worker lifecycle. The recovery, publication, seek, readiness, and lifecycle tests exercise those guarantees through `SessionManager`.

## Ranked candidates

### 1. Deterministic process runtime for `ProcessSupervisor` — **Strong**

**Problem and evidence.** `spawnManagedProcess` owns event collection, completion settlement, timeout handling, and TERM-to-KILL escalation in `src/vlc/process-supervisor.ts:41-139`. It hardcodes both `child_process.spawn` (`:42`) and timers (`:56-61`, `:119-123`). The test surface currently covers a successful child and liveness only (`test/unit/vlc/process-supervisor.test.ts:13-44`); it does not cover a timed-out process, escalation, timeout cancellation, or a spawn error through this module.

**Deepened module and interface.** Keep callers on the existing small `ManagedProcessHandle` interface (`completion`, `stop`, captured output, and optional `hasExited`). Add a private runtime seam to the module:

```ts
interface ProcessEvents {
  stdout(chunk: string): void
  stderr(chunk: string): void
  error(error: Error): void
  close(code: number | null, signal: NodeJS.Signals | null): void
}

interface ProcessRuntime {
  start(spec: CommandSpec, events: ProcessEvents): {
    pid: number | undefined
    kill(signal: NodeJS.Signals): void
  }
  schedule(delayMs: number, task: () => void): () => void
}

function spawnManagedProcess(
  spec: CommandSpec,
  runtime?: ProcessRuntime,
): ManagedProcessHandle
```

The production adapter wraps Node spawning and timers; a deterministic test adapter controls output, close/error events, and scheduled deadlines. This is **one adapter = hypothetical seam, two = real**. The seam stays inside process supervision; the interface callers learn remains unchanged. The module gains depth because callers and tests can exercise process ownership without coordinating a real OS process or waiting on wall time. That gives leverage across VLC and scan commands, with locality for timeout and shutdown fixes.

**What moves behind it.** OS process creation, event forwarding, timeout scheduling, graceful stop, forced stop, and final result settlement remain in one implementation; only their runtime is substituted. No VLC arguments or worker protocol need to change.

**Tests enabled or simplified.** Through `spawnManagedProcess(spec, fakeRuntime)`, assert that timeout marks the result `timedOut`, completion waits for close, SIGTERM precedes SIGKILL, a close cancels escalation, spawn errors retain captured output, and repeated stop calls follow a defined contract. Keep the real Node child smoke tests as adapter checks. The interface is the test surface: these assertions should observe the returned handle/result and the fake runtime's received signals, not private supervisor state.

**Deletion test.** Deleting this module would push process event handling and timer ownership into `VlcWorker` and scanner callers, or force them to duplicate it. Complexity reappears across callers, so the module earns its keep.

**Risk / effort / ordering.** Risk is medium: the fake runtime must preserve Node close/error ordering closely enough to be useful, so retain real-child checks. Effort: **M**. This work is disjoint from the listed test-framework edits to `worker.ts`, `args.ts`, drive parsing, and startup logging, and can proceed in parallel. Run the worker and full-suite checks after that work is integrated, since both paths use the same process module.

### 2. Scripted HLS worker test adapter — **Worth exploring**

**Problem and evidence.** Playback already accepts a worker adapter at `src/session/playback-session.ts:141-164`, which is a real seam between session ownership and VLC. Recovery tests build one-off handles and file writers: `test/integration/session-recovery-ordering.integration.test.ts:16-68` defines two custom handles plus manifest/segment writing, and `:84-166` wires different worker behaviors per test. `test/integration/session-lifecycle.integration.test.ts:16-57` has another handle and output writer. These tests are strong, but each new race scenario must know about segment filenames, HLS manifest text, process completion, and deferred stopping.

**Deepened module and interface.** Add a test-only `ScriptedHlsWorker` adapter under `test/helpers/`. A narrow scenario shape could be:

```ts
interface RunPlan {
  initialSlots: readonly number[]
  onStop?: (run: RunControl) => Promise<void> | void
  stopFailure?: Error
}

interface RunControl {
  publish(slots: readonly number[]): Promise<void>
  releaseStop(): void
}

class ScriptedHlsWorker {
  constructor(plans: readonly RunPlan[])
  startHlsSession(input: StartHlsSessionInput): Promise<StartHlsSessionResult>
  run(index: number): RunControl
}
```

The adapter would own fake handles, deterministic TS bytes, manifest updates, and controlled stop completion while presenting the existing worker interface. Production `VlcWorker` and this fake are the two adapters at the existing worker seam; this adds no production seam. It gives test scenarios more depth and leverage while keeping each race local to its observable event script.

**Tests enabled or simplified.** Express final output during stop, a deferred stop overlapped by seek/stop, failed stop, empty startup output, and a missing slot followed by a placeholder without hand-writing process handles and manifests in every test. Keep `fake-vlc.integration.test.ts` for real command invocation and argv checks.

**Deletion test.** Without the adapter, each scenario recreates some combination of output writing, manifest formatting, process completion, and stop gates in its test file. That complexity reappears across tests, so the test module would earn its keep if the script stays small.

**Risk / effort / ordering.** Risk is medium: an overly general script language could become another interface nearly as complex as the fixture. Start with only initial slots, output-on-stop, and deferred/failed stop. Effort: **M**. Keep it in `test/helpers/`, separate from the parallel worker/argv changes, and migrate one recovery-ordering test first. Integrate after the test-framework work so command-level and session-level checks are reviewed together.

## STRONG findings

Only the `ProcessSupervisor` runtime seam is a confident implementation recommendation now. It targets an untested timeout/escalation path in an existing, well-placed module and preserves the caller interface.

### Execution plan another agent can follow

1. In `test/unit/vlc/process-supervisor.test.ts`, add cases against a small fake `ProcessRuntime` for successful completion, spawn error, timeout, TERM/KILL order, close-before-escalation, and repeated stop behavior. Keep the existing real-child tests unchanged.
2. Add `ProcessEvents`/`ProcessRuntime` and the Node runtime adapter in `src/vlc/process-supervisor.ts`. Give the runtime a default so existing `spawnManagedProcess(spec)` and `runManagedProcess(spec)` call sites remain unchanged.
3. Route process start and both timers through the runtime without changing result semantics or `ManagedProcessHandle`. Make the fake-runtime tests pass before changing consumers.
4. Run the focused process-supervisor tests and typecheck; then run the existing VLC worker, scanner, and integration tests. Check the final diff for unchanged `args.ts` and `worker.ts` protocols. Repeat repository-wide validation after the parallel test-framework work lands.

At each step, the existing real-child tests remain in place. No test needs the physical drive.

## Rejected candidates

- Split `PlaybackSessionController` into a separate recovery owner: the architecture rule deliberately keeps the decision and all cancellable state transitions together; a second owner risks breaking seek/stop intent fencing.
- Deepen `HlsPublication`: already a deep module with real filesystem behavior and integration tests for immutable bytes, cancellation, missing output, and manifests (`test/integration/hls-publication.integration.test.ts:17-255`).
- Deepen `RunwayEvidence`: already has a compact evidence interface, injected elapsed clock, bounded state, and direct behavior tests (`src/session/runway-evidence.ts:30-165`, `test/unit/runway-evidence.test.ts`).
- Split `VlcDiscScanner`: its `scanDisc` interface already hides IFO/VLC fallback and accepts injected process/IFO adapters; tests cover both routes (`src/vlc/disc-scanner.ts:30-80`, `test/unit/vlc/disc-scanner.test.ts:6-127`).
- Redesign `worker.ts`/`args.ts` around command arguments: the parallel test-framework work owns those exact changes; the process runtime seam above sits below them and preserves the worker interface.

## Top recommendation

Implement the deterministic `ProcessRuntime` seam first. It is the clearest depth gain with direct leverage on VLC hangs and timeouts, a stable caller interface, and a focused test plan. The HLS worker adapter is the next candidate if new recovery scenarios continue to require custom handle and manifest machinery.
