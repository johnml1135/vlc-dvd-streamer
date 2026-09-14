import type { PlaybackTime } from '../../src/session/playback-time.js'

interface ScheduledTask {
  at: number
  order: number
  cancelled: boolean
  task: () => void | Promise<void>
}

/** Deterministic elapsed clock that drains due work after each advance. */
export class ManualPlaybackTime implements PlaybackTime {
  private elapsedMs = 0
  private nextOrder = 0
  private readonly tasks: ScheduledTask[] = []

  now(): number {
    return this.elapsedMs
  }

  schedule(delayMs: number, task: () => void | Promise<void>): () => void {
    const item: ScheduledTask = {
      at: this.elapsedMs + Math.max(0, delayMs),
      order: this.nextOrder++,
      cancelled: false,
      task,
    }
    this.tasks.push(item)
    return () => { item.cancelled = true }
  }

  async advanceBy(delayMs: number): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Manual time can only advance by a finite non-negative delay.')
    this.elapsedMs += delayMs
    await this.drainDue()
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (!Number.isFinite(targetMs) || targetMs < this.elapsedMs) throw new Error('Manual time cannot move backwards.')
    this.elapsedMs = targetMs
    await this.drainDue()
  }

  async runUntilIdle(): Promise<void> {
    await this.drainDue()
  }

  /** Wait until an async operation has installed at least one cancellable wake. */
  async waitForScheduledTask(): Promise<void> {
    while (!this.tasks.some(task => !task.cancelled)) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  pendingTaskCount(): number {
    return this.tasks.filter(task => !task.cancelled).length
  }

  private async drainDue(): Promise<void> {
    let iterations = 0
    while (true) {
      if (++iterations > 1000) throw new Error(`Manual time did not quiesce at ${this.elapsedMs}`)
      const due = this.tasks
        .filter(task => !task.cancelled && task.at <= this.elapsedMs)
        .sort((left, right) => left.at - right.at || left.order - right.order)
        .shift()
      if (!due) {
        // Promise continuations can enqueue the next readiness/recovery wakeup
        // after the scheduled callback yields back to the microtask queue.
        await new Promise<void>(resolve => setImmediate(resolve))
        if (!this.tasks.some(task => !task.cancelled && task.at <= this.elapsedMs)) return
        continue
      }
      due.cancelled = true
      await due.task()
    }
  }
}
