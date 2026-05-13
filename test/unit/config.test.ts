import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({})

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.cacheDir).toBe('.cache')
    expect(config.vlcCandidates.length).toBeGreaterThan(0)
  })
})