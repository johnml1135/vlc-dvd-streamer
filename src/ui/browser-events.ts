export interface BrowserAppEvent {
  type: string
  payload: unknown
}

type BrowserAppEventListener = (event: BrowserAppEvent) => void

const listeners = new Set<BrowserAppEventListener>()
let socket: WebSocket | null = null

export function subscribeAppEvents(listener: BrowserAppEventListener): () => void {
  listeners.add(listener)
  connect()
  let subscribed = true

  return () => {
    if (!subscribed) {
      return
    }

    subscribed = false
    listeners.delete(listener)
    if (listeners.size === 0 && socket) {
      const closingSocket = socket
      socket = null
      closingSocket.close()
    }
  }
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const connectedSocket = new WebSocket(`${protocol}://${window.location.host}/ws`)
  socket = connectedSocket
  connectedSocket.addEventListener('message', (messageEvent) => {
    const event = parseAppEvent(messageEvent.data)
    if (!event) {
      return
    }

    for (const listener of listeners) {
      listener(event)
    }
  })
  connectedSocket.addEventListener('close', () => {
    if (socket === connectedSocket) {
      socket = null
    }
  })
}

function parseAppEvent(value: unknown): BrowserAppEvent | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed) || typeof parsed.type !== 'string') {
      return null
    }

    return {
      type: parsed.type,
      payload: 'payload' in parsed ? parsed.payload : undefined,
    }
  } catch {
    return null
  }
}
