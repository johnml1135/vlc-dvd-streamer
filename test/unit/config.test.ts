import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({})

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.cacheDir).toBe('.cache')
    expect(config.vlcCandidates.length).toBeGreaterThan(0)
    expect(config.sessionReadinessTimeoutMs).toBe(120000)
  })

  it('allows overriding the session readiness timeout', () => {
    const config = loadConfig({ SESSION_READINESS_TIMEOUT_MS: '150000' })

    expect(config.sessionReadinessTimeoutMs).toBe(150000)
  })

  it('rejects invalid numeric environment values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/i)
    expect(() => loadConfig({ VLC_TIMEOUT_MS: '-1000' })).toThrow(/VLC_TIMEOUT_MS/i)
    expect(() => loadConfig({ SESSION_READINESS_TIMEOUT_MS: '12.5' })).toThrow(/SESSION_READINESS_TIMEOUT_MS/i)
  })
})