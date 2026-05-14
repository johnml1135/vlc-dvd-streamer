import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'

describe('SessionManager readiness window', () => {
  it('allows real-world startup time before failing the session', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-session-ready-'))
    let resolveCompletion: ((value: { ok: boolean; timedOut: boolean; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void) | undefined

    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      worker: {
        async startHlsSession({ outputDir }: { outputDir: string }) {
          let stopped = false
          const completion = new Promise<{ ok: boolean; timedOut: boolean; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
            resolveCompletion = resolve
          })

          setTimeout(async () => {
            if (stopped) {
              return
            }

            await mkdir(outputDir, { recursive: true })
            await writeFile(join(outputDir, 'index.m3u8'), '#EXTM3U\nsegment-000001.ts\n', 'utf8')
            await writeFile(join(outputDir, 'segment-000001.ts'), 'segment', 'utf8')
          }, 16000)

          return {
            manifestPath: join(outputDir, 'index.m3u8'),
            handle: {
              pid: 1234,
              completion,
              getStdout: () => '',
              getStderr: () => '',
              async stop() {
                stopped = true
                const result = {
                  ok: true,
                  timedOut: false,
                  code: 0,
                  signal: null,
                  stdout: '',
                  stderr: '',
                }
                resolveCompletion?.(result)
                return result
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
      audioTrack: 1,
    })

    expect(session.state).toBe('ready')
    await manager.stopAll()
  }, 25000)
})