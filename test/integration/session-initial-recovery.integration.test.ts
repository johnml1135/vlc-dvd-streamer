import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../../src/session/session-manager.js'
import type { CompletedProcess, ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput } from '../../src/vlc/worker.js'

const stopped: CompletedProcess = { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: '' }

class Handle implements ManagedProcessHandle {
  readonly pid = 42
  readonly completion: Promise<CompletedProcess>
  constructor(private readonly stderr: string, exited = false) {
    this.completion = exited
      ? Promise.resolve({ ...stopped, ok: false, code: 1, stderr })
      : new Promise<CompletedProcess>(() => {})
  }
  async stop() { return stopped }
  getStdout() { return '' }
  getStderr() { return this.stderr }
  hasExited() { return false }
}

async function writeSegment(input: StartHlsSessionInput): Promise<string> {
  await mkdir(input.outputDir, { recursive: true })
  const number = input.initialSegmentNumber ?? 1
  const name = `segment-${String(number).padStart(6, '0')}.ts`
  await writeFile(join(input.outputDir, name), Buffer.from([0x47, 0x40, 0, 0x10]))
  const manifestPath = join(input.outputDir, 'index.m3u8')
  await writeFile(manifestPath, `#EXTM3U\n#EXTINF:2,\n${name}\n`)
  return manifestPath
}

describe('initial HLS recovery', () => {
  it('fills an unreadable first slot and becomes ready from slot two', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'session-initial-recovery-'))
    const starts: StartHlsSessionInput[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60000,
      readinessTimeoutMs: 1500,
      playbackRecovery: { enabled: true, stallTimeoutMs: 5, readRetryAttempts: 2, stopTimeoutMs: 5 },
      worker: { async startHlsSession(input) {
        starts.push(input)
        const handle = new Handle('DVD input/output error: could not read sector')
        const manifestPath = starts.length <= 3
          ? join(input.outputDir, 'index.m3u8')
          : await writeSegment(input)
        return { manifestPath, handle }
      } },
    })

    try {
      const session = await manager.start({ discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 20 })
      expect(session.state).toBe('ready')
      expect(starts.map((input) => input.initialSegmentNumber)).toEqual([1, 1, 1, 2])
      expect(session.recovery?.skippedSeconds).toBe(2)
      expect(session.recovery?.badRanges).toEqual([{ startSeconds: 0, endSeconds: 2, reason: 'dvd-read-stall' }])
      await expect(manager.readStreamAsset(session.id, 'segment-000001.ts', { generation: 'placeholder' })).resolves.not.toBeNull()
    } finally { await manager.stopAll() }
  })

  it('recovers when VLC exits after reporting an unreadable first slot', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'session-initial-exit-recovery-'))
    const starts: StartHlsSessionInput[] = []
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60000,
      readinessTimeoutMs: 1500,
      playbackRecovery: { enabled: true, stallTimeoutMs: 5, readRetryAttempts: 0, stopTimeoutMs: 5 },
      worker: { async startHlsSession(input) {
        starts.push(input)
        const handle = new Handle('VLC input/output error: could not read sector', starts.length === 1)
        const manifestPath = starts.length === 1
          ? join(input.outputDir, 'index.m3u8')
          : await writeSegment(input)
        return { manifestPath, handle }
      } },
    })

    try {
      const session = await manager.start({ discId: 'disc', drive: 'D:', titleNumber: 1, durationSeconds: 20 })
      expect(session.state).toBe('ready')
      expect(starts.map((input) => input.initialSegmentNumber)).toEqual([1, 2])
      expect(session.recovery?.skippedSeconds).toBe(2)
    } finally { await manager.stopAll() }
  })
})
