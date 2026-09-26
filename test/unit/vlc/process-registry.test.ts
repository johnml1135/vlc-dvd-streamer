import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'
import { spawnManagedProcess } from '../../../src/vlc/process-supervisor.js'

describe('VLC process registry', () => {
  it('stores PID and process start time for every registered VLC child', async () => {
    const module = await import('../../../src/vlc/process-registry.js').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return

    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-process-registry-'))
    const registry = new module.VlcProcessRegistry(cacheDir, {
      readStartTime: async (pid: number) => `start-${pid}`,
      killProcess: vi.fn(),
    })

    await registry.record(4242)
    const records = JSON.parse(await readFile(join(cacheDir, 'vlc-processes.json'), 'utf8'))
    expect(records).toEqual([{ pid: 4242, processStartTime: 'start-4242' }])
  })

  it('retries briefly when the OS has not published a just-spawned process yet', async () => {
    const module = await import('../../../src/vlc/process-registry.js').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return

    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-process-registry-retry-'))
    const readStartTime = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('start-4242')
    const registry = new module.VlcProcessRegistry(cacheDir, { readStartTime, killProcess: vi.fn() })

    await registry.record(4242)

    const records = JSON.parse(await readFile(join(cacheDir, 'vlc-processes.json'), 'utf8'))
    expect(readStartTime).toHaveBeenCalledTimes(3)
    expect(records).toEqual([{ pid: 4242, processStartTime: 'start-4242' }])
  })

  it('kills only live processes with the recorded PID and matching start time', async () => {
    const module = await import('../../../src/vlc/process-registry.js').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return

    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-process-sweep-'))
    const filePath = join(cacheDir, 'vlc-processes.json')
    await writeFile(filePath, JSON.stringify([
      { pid: 10, processStartTime: 'same' },
      { pid: 11, processStartTime: 'old' },
      { pid: 12, processStartTime: 'unknown' },
    ]))
    const readStartTime = vi.fn(async (pid: number) => ({ 10: 'same', 11: 'new', 12: null }[pid] ?? null))
    const killProcess = vi.fn(async () => undefined)
    const registry = new module.VlcProcessRegistry(cacheDir, { readStartTime, killProcess, isRunning: () => true })

    await expect(registry.sweep()).resolves.toBe(1)
    expect(killProcess).toHaveBeenCalledOnce()
    expect(killProcess).toHaveBeenCalledWith(10)
    const remaining = JSON.parse(await readFile(filePath, 'utf8'))
    expect(remaining).toEqual([{ pid: 12, processStartTime: 'unknown' }])
  })

  it('tracks only managed VLC executable spawns and removes them on close', async () => {
    const module = await import('../../../src/vlc/process-registry.js').catch(() => null)
    expect(module).not.toBeNull()
    if (!module) return

    const cacheDir = await mkdtemp(join(tmpdir(), 'vlc-dvd-streamer-process-hooks-'))
    const readStartTime = vi.fn(async (pid: number) => `start-${pid}`)
    const registry = new module.VlcProcessRegistry(cacheDir, { readStartTime, killProcess: vi.fn() })
    const detach = module.attachVlcProcessRegistry(registry)
    let vlcEvents: { close(code: number | null, signal: NodeJS.Signals | null): void } | undefined
    let nodeEvents: { close(code: number | null, signal: NodeJS.Signals | null): void } | undefined
    const runtime = (pid: number, setEvents: (events: typeof vlcEvents) => void) => ({
      start(_spec: unknown, events: typeof vlcEvents) {
        setEvents(events)
        return { pid, kill: vi.fn() }
      },
      schedule: () => () => undefined,
    })

    try {
      spawnManagedProcess(createCommandSpec({ executable: 'C:/Program Files/VideoLAN/VLC/vlc.exe', args: [], timeoutMs: 0, label: 'test-vlc' }), runtime(99, (events) => { vlcEvents = events }))
      await vi.waitFor(async () => {
        const records = JSON.parse(await readFile(join(cacheDir, 'vlc-processes.json'), 'utf8'))
        expect(records).toEqual([{ pid: 99, processStartTime: 'start-99' }])
      })
      vlcEvents?.close(0, null)
      await vi.waitFor(async () => {
        const records = JSON.parse(await readFile(join(cacheDir, 'vlc-processes.json'), 'utf8'))
        expect(records).toEqual([])
      })

      spawnManagedProcess(createCommandSpec({ executable: 'node.exe', args: [], timeoutMs: 0, label: 'test-node' }), runtime(100, (events) => { nodeEvents = events }))
      nodeEvents?.close(0, null)
      expect(readStartTime).toHaveBeenCalledOnce()
    } finally {
      detach()
    }
  })
})
