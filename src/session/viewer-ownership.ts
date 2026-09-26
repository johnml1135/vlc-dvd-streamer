export interface ViewerOwnershipChange {
  sessionId: string
}

export interface ActiveViewerRegistryOptions {
  now?: () => number
  staleAfterMs?: number
  onChange?: (event: ViewerOwnershipChange) => void
}

interface ActiveViewerRecord {
  token: string
  lastFeedbackAt: number
}

/** Owns the single page allowed to report Playback feedback for each session. */
export class ActiveViewerRegistry {
  private readonly owners = new Map<string, ActiveViewerRecord>()
  private readonly now: () => number
  private readonly staleAfterMs: number

  constructor(private readonly options: ActiveViewerRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 15_000
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new Error('Active viewer timeout must be a finite positive number.')
    }
  }

  /** Register a page, granting ownership only when no recent owner is active. */
  attach(sessionId: string, viewerToken: string): boolean {
    if (!isValidIdentity(sessionId) || !isValidIdentity(viewerToken)) return false
    const owner = this.owners.get(sessionId)
    if (owner?.token === viewerToken) return true

    const now = this.readNow()
    if (owner && now - owner.lastFeedbackAt < this.staleAfterMs) return false

    this.setOwner(sessionId, viewerToken, now)
    return true
  }

  /** Transfer ownership after the current page confirms its takeover prompt. */
  takeOver(sessionId: string, viewerToken: string): boolean {
    if (!isValidIdentity(sessionId) || !isValidIdentity(viewerToken)) return false
    if (this.owners.get(sessionId)?.token !== viewerToken) {
      this.setOwner(sessionId, viewerToken, this.readNow())
    }
    return true
  }

  /** Release a page claim only if the caller still owns it. */
  release(sessionId: string, viewerToken: string): boolean {
    if (!isValidIdentity(sessionId) || !isValidIdentity(viewerToken)) return false
    if (this.owners.get(sessionId)?.token !== viewerToken) return false
    this.owners.delete(sessionId)
    this.options.onChange?.({ sessionId })
    return true
  }

  getActiveViewerToken(sessionId: string): string | null {
    return this.owners.get(sessionId)?.token ?? null
  }

  isActiveViewer(sessionId: string, viewerToken: string): boolean {
    return this.getActiveViewerToken(sessionId) === viewerToken
  }

  /** Refresh the 15 second lease only for the current page. */
  recordFeedback(sessionId: string, viewerToken: string): boolean {
    const owner = this.owners.get(sessionId)
    if (!owner || owner.token !== viewerToken) return false
    owner.lastFeedbackAt = this.readNow()
    return true
  }

  remove(sessionId: string): void {
    if (!this.owners.delete(sessionId)) return
    this.options.onChange?.({ sessionId })
  }

  private setOwner(sessionId: string, viewerToken: string, now: number): void {
    this.owners.set(sessionId, { token: viewerToken, lastFeedbackAt: now })
    this.options.onChange?.({ sessionId })
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isFinite(value)) throw new Error('Active viewer clock must return a finite number.')
    return value
  }
}

function isValidIdentity(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}
