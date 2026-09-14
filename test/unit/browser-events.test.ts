import { afterEach, describe, expect, it, vi } from 'vitest'

class Socket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string) { super(); Socket.instances.push(this) }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })) }
}

async function transport(protocol = 'http:') {
  vi.resetModules()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('window', { location: { protocol, host: 'localhost:3000' } })
  return import('../../src/ui/browser-events.js')
}

afterEach(() => vi.unstubAllGlobals())

describe('browser event transport', () => {
  it('shares one connection and closes only after the last subscriber leaves', async () => {
    const { subscribeAppEvents } = await transport()
    const first = vi.fn(), second = vi.fn()
    const unsubscribeFirst = subscribeAppEvents(first)
    const unsubscribeSecond = subscribeAppEvents(second)
    expect(Socket.instances).toHaveLength(1)
    const socket = Socket.instances[0]
    expect(socket.url).toBe('ws://localhost:3000/ws')
    socket.message(JSON.stringify({ type: 'session.updated', payload: { id: 'one' } }))
    expect(first).toHaveBeenCalledWith({ type: 'session.updated', payload: { id: 'one' } })
    expect(second).toHaveBeenCalledTimes(1)
    unsubscribeFirst()
    unsubscribeFirst()
    expect(socket.close).not.toHaveBeenCalled()
    socket.message('{"type":"log"}')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith({ type: 'log', payload: undefined })
    unsubscribeSecond()
    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed and non-text messages', async () => {
    const { subscribeAppEvents } = await transport('https:')
    const listener = vi.fn()
    const unsubscribe = subscribeAppEvents(listener)
    const socket = Socket.instances[0]
    expect(socket.url).toBe('wss://localhost:3000/ws')
    for (const value of [new ArrayBuffer(1), '', '{', 'null', '1', '{}', '{"type":3}']) socket.message(value)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps a replacement connection when an older close event arrives late', async () => {
    const { subscribeAppEvents } = await transport()
    const first = subscribeAppEvents(vi.fn())
    const oldSocket = Socket.instances[0]
    first()
    const second = subscribeAppEvents(vi.fn())
    oldSocket.dispatchEvent(new Event('close'))
    const third = subscribeAppEvents(vi.fn())
    expect(Socket.instances).toHaveLength(2)
    second(); third()
    expect(Socket.instances[1].close).toHaveBeenCalledTimes(1)
  })

  it('connects a new subscriber after a server-side close', async () => {
    const { subscribeAppEvents } = await transport()
    const first = subscribeAppEvents(vi.fn())
    Socket.instances[0].dispatchEvent(new Event('close'))
    const second = subscribeAppEvents(vi.fn())
    expect(Socket.instances).toHaveLength(2)
    first(); second()
  })
})
