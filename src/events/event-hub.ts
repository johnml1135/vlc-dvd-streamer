export interface AppEvent {
  type: string
  payload: unknown
}

type Listener = (event: AppEvent) => void

export class EventHub {
  private readonly listeners = new Set<Listener>()

  publish(event: AppEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}