interface QueuedThumbnailJob {
  key: string
  run: () => Promise<unknown>
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class ThumbnailJobs {
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly failed = new Map<string, { error: unknown; retryAt: number }>()
  private readonly waiting: QueuedThumbnailJob[] = []
  private active = 0

  constructor(private readonly maxConcurrent = 2, private readonly failureCooldownMs = 0) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('Thumbnail job concurrency must be a positive integer.')
    }
    if (!Number.isFinite(failureCooldownMs) || failureCooldownMs < 0) {
      throw new RangeError('Thumbnail failure cooldown must be a non-negative duration.')
    }
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T>

    const recentFailure = this.failed.get(key)
    if (recentFailure && recentFailure.retryAt > Date.now()) {
      return Promise.reject(recentFailure.error)
    }
    this.failed.delete(key)

    let resolveJob!: (value: T) => void
    let rejectJob!: (error: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    const job: QueuedThumbnailJob = {
      key,
      run: async () => work(),
      promise,
      resolve: (value) => resolveJob(value as T),
      reject: rejectJob,
    }

    this.inFlight.set(key, promise)
    this.waiting.push(job)
    this.startAvailableJobs()
    return promise
  }

  private startAvailableJobs(): void {
    while (this.active < this.maxConcurrent && this.waiting.length > 0) {
      const job = this.waiting.shift()!
      this.active += 1
      void Promise.resolve().then(job.run).then(
        (value) => {
          this.failed.delete(job.key)
          job.resolve(value)
          this.finish(job)
        },
        (error: unknown) => {
          if (this.failureCooldownMs > 0) {
            this.failed.set(job.key, { error, retryAt: Date.now() + this.failureCooldownMs })
          }
          job.reject(error)
          this.finish(job)
        },
      )
    }
  }

  private finish(job: QueuedThumbnailJob): void {
    if (this.inFlight.get(job.key) === job.promise) {
      this.inFlight.delete(job.key)
    }
    this.active -= 1
    this.startAvailableJobs()
  }
}
