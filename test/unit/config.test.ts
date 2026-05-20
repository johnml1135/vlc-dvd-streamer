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
    expect(config.sessionRecoveryStallMs).toBe(10000)
    expect(config.sessionRecoveryRestartReadinessMs).toBe(30000)
    expect(config.sessionRecoverySkipSeconds).toBe(10)
    expect(config.sessionRecoveryReadRetries).toBe(3)
    expect(config.sessionRecoveryMaxAttempts).toBe(6)
  })

  it('allows overriding the session readiness timeout', () => {
    const config = loadConfig({
      SESSION_READINESS_TIMEOUT_MS: '150000',
      SESSION_RECOVERY_STALL_MS: '9000',
      SESSION_RECOVERY_RESTART_READINESS_MS: '45000',
      SESSION_RECOVERY_SKIP_SECONDS: '15',
      SESSION_RECOVERY_READ_RETRIES: '5',
      SESSION_RECOVERY_MAX_ATTEMPTS: '4',
    })

    expect(config.sessionReadinessTimeoutMs).toBe(150000)
    expect(config.sessionRecoveryStallMs).toBe(9000)
    expect(config.sessionRecoveryRestartReadinessMs).toBe(45000)
    expect(config.sessionRecoverySkipSeconds).toBe(15)
    expect(config.sessionRecoveryReadRetries).toBe(5)
    expect(config.sessionRecoveryMaxAttempts).toBe(4)
  })

  it('rejects invalid numeric environment values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/i)
    expect(() => loadConfig({ VLC_TIMEOUT_MS: '-1000' })).toThrow(/VLC_TIMEOUT_MS/i)
    expect(() => loadConfig({ SESSION_READINESS_TIMEOUT_MS: '12.5' })).toThrow(/SESSION_READINESS_TIMEOUT_MS/i)
    expect(() => loadConfig({ SESSION_RECOVERY_SKIP_SECONDS: '0' })).toThrow(/SESSION_RECOVERY_SKIP_SECONDS/i)
    expect(() => loadConfig({ SESSION_RECOVERY_READ_RETRIES: '0' })).toThrow(/SESSION_RECOVERY_READ_RETRIES/i)
  })
})