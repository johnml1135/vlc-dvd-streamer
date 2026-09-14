/** Monotonic elapsed time and cancellable scheduling used by playback control. */
export interface PlaybackTime {
  now(): number
  schedule(delayMs: number, task: () => void | Promise<void>): () => void
}

export const systemPlaybackTime: PlaybackTime = {
  now: () => performance.now(),
  schedule(delayMs, task) {
    const timer = setTimeout(() => {
      void task()
    }, Math.max(0, delayMs))
    return () => clearTimeout(timer)
  },
}
