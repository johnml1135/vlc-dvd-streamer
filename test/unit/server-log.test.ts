import { describe, expect, it, vi } from 'vitest'
import { ServerLog } from '../../src/logging/server-log.js'

describe('ServerLog', () => {
  it('emits formatted log lines to an optional sink', () => {
    const sink = vi.fn()
    const log = new ServerLog(undefined, 200, sink)

    log.info('server', 'HTTP server listening on 0.0.0.0:3000.')

    expect(log.list()).toHaveLength(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]).toMatch(/^\[[^\]]+\] \[INFO\] \[server\] HTTP server listening on 0\.0\.0\.0:3000\.$/)
  })
})