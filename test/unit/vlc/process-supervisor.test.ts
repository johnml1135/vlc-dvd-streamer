import { describe, expect, it } from 'vitest'
import { normalizeExit } from '../../../src/vlc/process-events.js'
import { runManagedProcess } from '../../../src/vlc/process-supervisor.js'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'

describe('normalizeExit', () => {
  it('keeps exit handling on close-style results', () => {
    expect(normalizeExit({ code: 0, signal: null }).ok).toBe(true)
    expect(normalizeExit({ code: null, signal: 'SIGTERM' }).ok).toBe(false)
  })
})

describe('runManagedProcess', () => {
  it('captures stdout from a successful child process', async () => {
    const spec = createCommandSpec({
      executable: process.execPath,
      args: ['-e', "console.log('hello-from-child')"],
      timeoutMs: 5000,
      label: 'node-smoke',
    })

    const result = await runManagedProcess(spec)

    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('hello-from-child')
    expect(result.stderr).toBe('')
  })
})