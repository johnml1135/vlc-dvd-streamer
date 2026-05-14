export interface AppConfig {
  host: string
  port: number
  cacheDir: string
  vlcCandidates: string[]
  drive?: string
  minVisibleTitleDurationSeconds?: number
  inactiveSessionMs?: number
  vlcTimeoutMs?: number
  sessionReadinessTimeoutMs?: number
  sessionRecoveryStallMs?: number
  sessionRecoveryRestartReadinessMs?: number
  sessionRecoverySkipSeconds?: number
  sessionRecoveryMaxAttempts?: number
  vlcShimScript?: string
  vlcTrackMetadataScript?: string
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const configuredVlcPath = env.VLC_PATH ?? (env.VLC_SHIM_SCRIPT ? process.execPath : undefined)

  return {
    host: env.HOST ?? '127.0.0.1',
    port: parsePositiveIntegerEnv(env.PORT, 'PORT', 3000, 65535),
    cacheDir: env.CACHE_DIR ?? '.cache',
    vlcCandidates: [
      configuredVlcPath,
      'C:/Program Files/VideoLAN/VLC/vlc.exe',
      'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe',
    ].filter((value): value is string => Boolean(value)),
    drive: env.DVD_DRIVE ?? 'D:',
    minVisibleTitleDurationSeconds: parsePositiveIntegerEnv(env.MIN_VISIBLE_TITLE_SECONDS, 'MIN_VISIBLE_TITLE_SECONDS', 300),
    inactiveSessionMs: parsePositiveIntegerEnv(env.INACTIVE_SESSION_MS, 'INACTIVE_SESSION_MS', 900000),
    vlcTimeoutMs: parsePositiveIntegerEnv(env.VLC_TIMEOUT_MS, 'VLC_TIMEOUT_MS', 30000),
    sessionReadinessTimeoutMs: parsePositiveIntegerEnv(env.SESSION_READINESS_TIMEOUT_MS, 'SESSION_READINESS_TIMEOUT_MS', 120000),
    sessionRecoveryStallMs: parsePositiveIntegerEnv(env.SESSION_RECOVERY_STALL_MS, 'SESSION_RECOVERY_STALL_MS', 12000),
    sessionRecoveryRestartReadinessMs: parsePositiveIntegerEnv(env.SESSION_RECOVERY_RESTART_READINESS_MS, 'SESSION_RECOVERY_RESTART_READINESS_MS', 30000),
    sessionRecoverySkipSeconds: parsePositiveIntegerEnv(env.SESSION_RECOVERY_SKIP_SECONDS, 'SESSION_RECOVERY_SKIP_SECONDS', 10),
    sessionRecoveryMaxAttempts: parsePositiveIntegerEnv(env.SESSION_RECOVERY_MAX_ATTEMPTS, 'SESSION_RECOVERY_MAX_ATTEMPTS', 6),
    vlcShimScript: env.VLC_SHIM_SCRIPT,
    vlcTrackMetadataScript: env.VLC_TRACK_METADATA_SCRIPT,
  }
}

function parsePositiveIntegerEnv(value: string | undefined, name: string, defaultValue: number, maxValue = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value === '') {
    return defaultValue
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxValue) {
    throw new Error(`${name} must be an integer between 1 and ${maxValue}; got "${value}".`)
  }

  return parsed
}