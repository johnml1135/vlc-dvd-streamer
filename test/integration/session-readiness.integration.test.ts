import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import { ManualPlaybackTime } from '../helpers/manual-playback-time.js'

interface ProcessResult {
  ok: boolean
  timedOut: boolean
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function successfulProcessResult(): ProcessResult {
  return {
    ok: true,
    timedOut: false,
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
  }
}

describe('SessionManager readiness window', () => {
  it('allows real-world startup time before failing the session', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-ready-'))
    const time = new ManualPlaybackTime()
    let workerStarted!: () => void
    const started = new Promise<void>(resolve => { workerStarted = resolve })
    let resolveCompletion: ((value: ProcessResult) => void) | undefined
    let publishInitialOutput!: () => Promise<void>

    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      time,
      worker: {
        async startHlsSession({ outputDir }: { outputDir: string }) {
          workerStarted()
          let stopped = false
          const completion = new Promise<ProcessResult>((resolve) => {
            resolveCompletion = resolve
          })

          publishInitialOutput = async () => {
            if (stopped) {
              return
            }

            await mkdir(outputDir, { recursive: true })
            await writeFile(join(outputDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000001.ts\n', 'utf8')
            await writeFile(join(outputDir, 'segment-000001.ts'), Buffer.from([0x47, 0x40, 0x00, 0x10]))
          }

          return {
            manifestPath: join(outputDir, 'index.m3u8'),
            handle: {
              pid: 1234,
              completion,
              getStdout: () => '',
              getStderr: () => '',
              async stop() {
                stopped = true
                const result = successfulProcessResult()
                resolveCompletion?.(result)
                return result
              },
            },
          }
        },
      } as never,
    })

    const pending = manager.start({
      discId: 'disc-test',
      drive: 'F:',
      titleNumber: 1,
      audioTrack: 1,
    })

    await started
    await time.waitForScheduledTask()
    await time.advanceBy(15_999)
    await time.waitForScheduledTask()
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await publishInitialOutput()
    await time.advanceBy(1)
    await time.advanceBy(100)
    const session = await pending

    expect(session.state).toBe('ready')
    await manager.stopAll()
  })

  it('fails readiness at the exact elapsed deadline', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-deadline-'))
    const time = new ManualPlaybackTime()
    let workerStarted!: () => void
    const started = new Promise<void>(resolve => { workerStarted = resolve })
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      readinessTimeoutMs: 150,
      time,
      worker: {
        async startHlsSession({ outputDir }: { outputDir: string }) {
          workerStarted()
          await mkdir(outputDir, { recursive: true })
          return {
            manifestPath: join(outputDir, 'index.m3u8'),
            handle: {
              pid: 1234,
              completion: new Promise<ProcessResult>(() => {}),
              getStdout: () => '',
              getStderr: () => '',
              async stop() { return successfulProcessResult() },
            },
          }
        },
      } as never,
    })

    const pending = manager.start({ discId: 'disc-test', drive: 'F:', titleNumber: 1 })
    await started
    await time.waitForScheduledTask()
    await time.advanceBy(149)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await time.advanceBy(1)
    const session = await pending
    expect(session.state).toBe('failed')
    expect(session.error?.detail).toContain('Timed out waiting')
    await manager.stopAll()
  })

  it('does not mark malformed HLS files as ready', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-malformed-'))
    const time = new ManualPlaybackTime()
    let stopCalls = 0

    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      readinessTimeoutMs: 150,
      time,
      worker: {
        async startHlsSession({ outputDir }: { outputDir: string }) {
          await mkdir(outputDir, { recursive: true })
          await writeFile(join(outputDir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\nsegment-000001.ts\n', 'utf8')
          await writeFile(join(outputDir, 'segment-000001.ts'), 'not-a-transport-stream', 'utf8')

          return {
            manifestPath: join(outputDir, 'index.m3u8'),
            handle: {
              pid: 1234,
              completion: new Promise<ProcessResult>(() => {}),
              getStdout: () => '',
              getStderr: () => '',
              async stop() {
                stopCalls += 1
                return successfulProcessResult()
              },
            },
          }
        },
      } as never,
    })

    const pending = manager.start({
      discId: 'disc-test',
      drive: 'F:',
      titleNumber: 1,
    })
    await time.waitForScheduledTask()
    await time.advanceBy(150)
    const session = await pending

    expect(session.state).toBe('failed')
    expect(session.error?.detail).toMatch(/Timed out waiting/)
    expect(stopCalls).toBe(1)
  })

  it('stops the VLC handle and removes session files when VLC exits before readiness', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-exit-'))
    let stopCalls = 0

    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      readinessTimeoutMs: 500,
      worker: {
        async startHlsSession({ outputDir }: { outputDir: string }) {
          await mkdir(outputDir, { recursive: true })
          await writeFile(join(outputDir, 'partial.tmp'), 'partial', 'utf8')
          const completion = Promise.resolve({
            ok: false,
            timedOut: false,
            code: 1,
            signal: null,
            stdout: '',
            stderr: 'VLC could not open the DVD MRL.',
          } satisfies ProcessResult)

          return {
            manifestPath: join(outputDir, 'index.m3u8'),
            handle: {
              pid: 1234,
              completion,
              getStdout: () => '',
              getStderr: () => 'VLC could not open the DVD MRL.',
              async stop() {
                stopCalls += 1
                return successfulProcessResult()
              },
            },
          }
        },
      } as never,
    })

    const session = await manager.start({
      discId: 'disc-test',
      drive: 'F:',
      titleNumber: 1,
    })

    expect(session.state).toBe('failed')
    expect(session.error?.detail).toContain('VLC could not open the DVD MRL.')
    expect(stopCalls).toBe(1)
    await expect(access(session.outputDir)).rejects.toThrow()
  })
})
