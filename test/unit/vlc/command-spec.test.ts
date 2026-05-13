import { describe, expect, it } from 'vitest'
import { createCommandSpec } from '../../../src/vlc/command-spec.js'

describe('createCommandSpec', () => {
  it('creates a shell-free executable spec', () => {
    const spec = createCommandSpec({
      executable: 'C:/Program Files/VideoLAN/VLC/vlc.exe',
      args: ['--version'],
      timeoutMs: 5000,
      label: 'vlc-version',
    })

    expect(spec.executable).toContain('vlc.exe')
    expect(spec.args).toEqual(['--version'])
    expect(spec.timeoutMs).toBe(5000)
    expect(spec.shell).toBe(false)
    expect(spec.windowsHide).toBe(true)
  })
})