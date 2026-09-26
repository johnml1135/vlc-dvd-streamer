import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { EventHub } from '../../src/events/event-hub.js'
import { SessionManager } from '../../src/session/session-manager.js'
import type { ManagedProcessHandle } from '../../src/vlc/process-supervisor.js'
import type { StartHlsSessionInput } from '../../src/vlc/worker.js'

const completed = { ok: true, timedOut: false, code: 0, signal: null, stdout: '', stderr: '' }

function makeHandle(): ManagedProcessHandle {
  let close!: () => void
  const completion = new Promise<typeof completed>((resolve) => { close = () => resolve(completed) })
  return {
    pid: 1,
    completion,
    async stop() { close(); return completion },
    getStdout() { return '' },
    getStderr() { return '' },
    hasExited() { return false },
  }
}

async function writeOutput(input: StartHlsSessionInput): Promise<string> {
  await mkdir(input.outputDir, { recursive: true })
  const name = `segment-${String(input.initialSegmentNumber ?? 1).padStart(6, '0')}.ts`
  await writeFile(join(input.outputDir, name), Buffer.from([0x47, 0x40, 0, 0x10]))
  const manifestPath = join(input.outputDir, 'index.m3u8')
  await writeFile(manifestPath, `#EXTM3U\n#EXTINF:2,\n${name}\n`)
  return manifestPath
}

describe('Active viewer API ownership', () => {
  it('notifies pages on ownership changes and rejects non-owner Playback feedback', async () => {
    let now = Date.parse('2026-09-25T12:00:00.000Z')
    const events: Array<{ type: string; payload: unknown }> = []
    const eventHub = new EventHub()
    eventHub.subscribe((event) => events.push(event))
    const cacheDir = await mkdtemp(join(tmpdir(), 'viewer-ownership-'))
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      now: () => now,
      playbackRecovery: { enabled: false },
      onSessionEvent: (event) => eventHub.publish(event),
      worker: { async startHlsSession(input) { return { manifestPath: await writeOutput(input), handle: makeHandle() } } },
    })
    const app = await buildApp({
      config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
      services: { sessionManager: manager, eventHub },
    })

    try {
      const session = await manager.start({ discId: 'disc-1', drive: 'D:', titleNumber: 1, durationSeconds: 60 })
      const attach = (viewerToken: string) => app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/viewer/attach`, payload: { viewerToken },
      })

      const firstAttach = await attach('page-a')
      expect(firstAttach.statusCode).toBe(200)
      expect(firstAttach.json()).toEqual({ active: true })
      const passiveAttach = await attach('page-b')
      expect(passiveAttach.statusCode).toBe(200)
      expect(passiveAttach.json()).toEqual({ active: false })

      const report = {
        viewerToken: 'page-b',
        manifestUrl: session.manifestUrl,
        reporterId: 'page-b-reporter',
        sequence: 1,
        positionSeconds: 0,
        bufferedEndSeconds: 2,
        paused: false,
        playbackRate: 1,
      }
      now += 5_000
      const beforeRejectedFeedback = manager.getSession(session.id)?.lastAccessedAt
      const rejected = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/playback`, payload: report })
      expect(rejected.statusCode).toBe(409)
      expect(manager.getSession(session.id)?.lastAccessedAt).toBe(beforeRejectedFeedback)

      const takeover = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/viewer/takeover`, payload: { viewerToken: 'page-b' },
      })
      expect(takeover.statusCode).toBe(200)
      expect(takeover.json()).toEqual({ active: true })
      const oldPage = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/playback`, payload: { ...report, viewerToken: 'page-a' },
      })
      expect(oldPage.statusCode).toBe(409)

      const currentPage = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/playback`, payload: report,
      })
      expect(currentPage.statusCode).toBe(204)
      expect(manager.getSession(session.id)?.lastAccessedAt).toBe(new Date(now).toISOString())
      expect(events.filter((event) => event.type === 'session.viewer')).toEqual([
        { type: 'session.viewer', payload: { sessionId: session.id } },
        { type: 'session.viewer', payload: { sessionId: session.id } },
      ])
      expect(JSON.stringify(events.filter((event) => event.type === 'session.viewer'))).not.toContain('page-')
    } finally {
      await manager.stopAll()
      await app.close()
    }
  })

  it('silently transfers an abandoned viewer after 15 seconds', async () => {
    let now = 0
    const cacheDir = await mkdtemp(join(tmpdir(), 'viewer-expiry-'))
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      now: () => now,
      playbackRecovery: { enabled: false },
      worker: { async startHlsSession(input) { return { manifestPath: await writeOutput(input), handle: makeHandle() } } },
    })
    try {
      const session = await manager.start({ discId: 'disc-1', drive: 'D:', titleNumber: 1, durationSeconds: 60 })
      expect(manager.attachViewer(session.id, 'page-a')).toEqual({ ok: true, active: true })
      now = 14_999
      expect(manager.attachViewer(session.id, 'page-b')).toEqual({ ok: true, active: false })
      now = 15_000
      expect(manager.attachViewer(session.id, 'page-b')).toEqual({ ok: true, active: true })
    } finally {
      await manager.stopAll()
    }
  })

  it('releases a page claim on navigation so the next page is active immediately', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'viewer-release-'))
    const manager = new SessionManager({
      cacheDir,
      inactivityMs: 60_000,
      playbackRecovery: { enabled: false },
      worker: { async startHlsSession(input) { return { manifestPath: await writeOutput(input), handle: makeHandle() } } },
    })
    const app = await buildApp({
      config: { host: '127.0.0.1', port: 3000, cacheDir, vlcCandidates: [process.execPath] },
      services: { sessionManager: manager },
    })

    try {
      const session = await manager.start({ discId: 'disc-1', drive: 'D:', titleNumber: 1, durationSeconds: 60 })
      const first = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/viewer/attach`, payload: { viewerToken: 'page-before-navigation' },
      })
      expect(first.json()).toEqual({ active: true })

      const release = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/viewer/release`, payload: { viewerToken: 'page-before-navigation' },
      })
      expect(release.statusCode).toBe(200)
      expect(release.json()).toEqual({ released: true })

      const replacement = await app.inject({
        method: 'POST', url: `/api/sessions/${session.id}/viewer/attach`, payload: { viewerToken: 'page-after-navigation' },
      })
      expect(replacement.statusCode).toBe(200)
      expect(replacement.json()).toEqual({ active: true })
    } finally {
      await manager.stopAll()
      await app.close()
    }
  })
})
