import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireSessionStorage } from '../../../src/session/session-storage.js'

const roots: string[] = []

async function cacheDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-storage-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session storage startup cleanup', () => {
  it('sweeps only directories inside the cache sessions directory', async () => {
    const cacheDir = await cacheDirectory()
    const sessionDir = join(cacheDir, 'sessions', 'old-session')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'index.m3u8'), 'old')
    await mkdir(join(cacheDir, 'other-cache'), { recursive: true })
    await writeFile(join(cacheDir, 'other-cache', 'keep.txt'), 'keep')

    const storage = await acquireSessionStorage(cacheDir)
    try {
      expect(storage.swept).toBe(true)
      await expect(readFile(join(sessionDir, 'index.m3u8'))).rejects.toThrow()
      await expect(readFile(join(cacheDir, 'other-cache', 'keep.txt'), 'utf8')).resolves.toBe('keep')
    } finally { await storage.release() }
  })

  it('preserves session directories while a different instance owns the cache lock', async () => {
    const cacheDir = await cacheDirectory()
    const first = await acquireSessionStorage(cacheDir)
    const sessionDir = join(cacheDir, 'sessions', 'live-session')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'index.m3u8'), 'live')

    const second = await acquireSessionStorage(cacheDir)
    expect(second.swept).toBe(false)
    await expect(readFile(join(sessionDir, 'index.m3u8'), 'utf8')).resolves.toBe('live')
    await first.release()

    const third = await acquireSessionStorage(cacheDir)
    try {
      expect(third.swept).toBe(false)
      await expect(readFile(join(sessionDir, 'index.m3u8'), 'utf8')).resolves.toBe('live')
    } finally {
      await third.release()
      await second.release()
    }

    const next = await acquireSessionStorage(cacheDir)
    try {
      expect(next.swept).toBe(true)
      await expect(readFile(join(sessionDir, 'index.m3u8'))).rejects.toThrow()
    } finally { await next.release() }
  })

  it('reclaims an owner lock whose process is no longer alive', async () => {
    const cacheDir = await cacheDirectory()
    const lockPath = join(cacheDir, '.sessions.lock')
    await writeFile(lockPath, '2147483647')
    const staleDir = join(cacheDir, 'sessions', 'stale-session')
    await mkdir(staleDir, { recursive: true })
    await writeFile(join(staleDir, 'segment.ts'), 'stale')

    const storage = await acquireSessionStorage(cacheDir)
    try {
      expect(storage.swept).toBe(true)
      await expect(readFile(join(staleDir, 'segment.ts'))).rejects.toThrow()
      await expect(readdir(join(cacheDir, '.session-owners')))
        .resolves.toEqual([expect.stringMatching(new RegExp(`^instance-${process.pid}-`))])
    } finally { await storage.release() }
  })
})
