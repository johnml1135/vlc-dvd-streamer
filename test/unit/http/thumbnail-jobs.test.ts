import { describe, expect, it, vi } from 'vitest'
import { ThumbnailJobs } from '../../../src/http/thumbnail-jobs.js'

describe('ThumbnailJobs', () => {
  it('shares one in-flight job for the same key', async () => {
    const jobs = new ThumbnailJobs(2)
    let finish!: (value: string) => void
    const work = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = jobs.run('disc-1:1', work)
    const second = jobs.run('disc-1:1', work)

    expect(second).toBe(first)
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1))
    finish('thumbnail')
    await expect(Promise.all([first, second])).resolves.toEqual(['thumbnail', 'thumbnail'])
  })

  it('runs no more jobs than the configured global limit', async () => {
    const jobs = new ThumbnailJobs(2)
    const releases: Array<() => void> = []
    const started: number[] = []
    let active = 0
    let maximumActive = 0
    const work = (titleNumber: number) => async () => {
      started.push(titleNumber)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      active -= 1
      return titleNumber
    }
    const requests = Array.from({ length: 50 }, (_, index) => jobs.run(`disc-1:${index + 1}`, work(index + 1)))

    await vi.waitFor(() => expect(started).toHaveLength(2))
    expect(maximumActive).toBe(2)
    expect(started).toEqual([1, 2])

    while (started.length < 50) {
      const nextCount = Math.min(50, started.length + 2)
      releases.splice(0, 2).forEach((release) => release())
      await vi.waitFor(() => expect(started.length).toBe(nextCount))
      if (started.length < 50) expect(active).toBe(2)
    }
    releases.splice(0).forEach((release) => release())
    await expect(Promise.all(requests)).resolves.toHaveLength(50)
    expect(maximumActive).toBe(2)
  })
})

  it('backs off repeated failures for the same title before retrying', async () => {
    vi.useFakeTimers()
    try {
      const jobs = new ThumbnailJobs(1, 1000)
      const failure = new Error('thumbnail failed')
      const work = vi.fn(async () => { throw failure })

      await expect(jobs.run('disc-1:1', work)).rejects.toBe(failure)
      await expect(jobs.run('disc-1:1', work)).rejects.toBe(failure)
      expect(work).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      await expect(jobs.run('disc-1:1', work)).rejects.toBe(failure)
      expect(work).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
