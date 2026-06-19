import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileLogSink } from '../../src/logging/file-log-sink.js'
import { ServerLog } from '../../src/logging/server-log.js'

describe('createFileLogSink', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dvd-log-'))
  })

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true })
  })

  it('appends server log lines to the file, creating missing directories', async () => {
    const filePath = join(dir, 'nested', 'server.log')
    const fileSink = createFileLogSink(filePath)
    const log = new ServerLog(undefined, 200, fileSink.sink)

    log.info('server', 'listening')
    log.error('session', 'VLC exited: subtitle decoder crash')
    await fileSink.close()

    const contents = readFileSync(filePath, 'utf8')
    expect(contents).toContain('=== Log opened')
    expect(contents).toMatch(/\[INFO\] \[server\] listening/)
    expect(contents).toMatch(/\[ERROR\] \[session\] VLC exited: subtitle decoder crash/)
  })

  it('appends across reopens rather than truncating', async () => {
    const filePath = join(dir, 'server.log')

    const first = createFileLogSink(filePath)
    new ServerLog(undefined, 200, first.sink).info('server', 'first run')
    await first.close()

    const second = createFileLogSink(filePath)
    new ServerLog(undefined, 200, second.sink).info('server', 'second run')
    await second.close()

    const contents = readFileSync(filePath, 'utf8')
    expect(contents).toContain('first run')
    expect(contents).toContain('second run')
  })
})
