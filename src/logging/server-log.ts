import type { EventHub } from '../events/event-hub.js'

export type ServerLogLevel = 'info' | 'warn' | 'error'

export interface ServerLogEntry {
  id: number
  at: string
  level: ServerLogLevel
  scope: string
  message: string
}

export class ServerLog {
  private readonly entries: ServerLogEntry[] = []
  private nextId = 1

  constructor(
    private readonly eventHub?: EventHub,
    private readonly maxEntries = 200,
  ) {}

  list(): ServerLogEntry[] {
    return [...this.entries]
  }

  info(scope: string, message: string): ServerLogEntry {
    return this.write('info', scope, message)
  }

  warn(scope: string, message: string): ServerLogEntry {
    return this.write('warn', scope, message)
  }

  error(scope: string, message: string): ServerLogEntry {
    return this.write('error', scope, message)
  }

  private write(level: ServerLogLevel, scope: string, message: string): ServerLogEntry {
    const entry: ServerLogEntry = {
      id: this.nextId,
      at: new Date().toISOString(),
      level,
      scope,
      message,
    }

    this.nextId += 1
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }

    this.eventHub?.publish({
      type: 'server.log',
      payload: entry,
    })

    return entry
  }
}