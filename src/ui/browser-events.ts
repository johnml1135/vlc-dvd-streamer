export interface BrowserAppEvent {
  type: string
  payload: unknown
}

type BrowserAppEventListener = (event: BrowserAppEvent) => void

const listeners = new Set<BrowserAppEventListener>()
const INITIAL_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5000
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

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
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      if (socket) {
        const closingSocket = socket
        socket = null
        closingSocket.close()
      }
    }
  }
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const connectedSocket = new WebSocket(`${protocol}://${window.location.host}/ws`)
  socket = connectedSocket
  connectedSocket.addEventListener('open', () => {
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  })
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
      scheduleReconnect()
    }
  })
}

function scheduleReconnect(): void {
  if (listeners.size === 0 || reconnectTimer) return

  const delayMs = reconnectDelayMs
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (listeners.size > 0) connect()
  }, delayMs)
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
