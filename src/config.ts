export interface AppConfig {
  host: string
  port: number
  cacheDir: string
  vlcCandidates: string[]
  drive?: string
  minVisibleTitleDurationSeconds?: number
  inactiveSessionMs?: number
  vlcTimeoutMs?: number
  vlcShimScript?: string
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const configuredVlcPath = env.VLC_PATH ?? (env.VLC_SHIM_SCRIPT ? process.execPath : undefined)

  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    cacheDir: env.CACHE_DIR ?? '.cache',
    vlcCandidates: [
      configuredVlcPath,
      'C:/Program Files/VideoLAN/VLC/vlc.exe',
      'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe',
    ].filter((value): value is string => Boolean(value)),
    drive: env.DVD_DRIVE ?? 'D:',
    minVisibleTitleDurationSeconds: Number(env.MIN_VISIBLE_TITLE_SECONDS ?? 300),
    inactiveSessionMs: Number(env.INACTIVE_SESSION_MS ?? 900000),
    vlcTimeoutMs: Number(env.VLC_TIMEOUT_MS ?? 30000),
    vlcShimScript: env.VLC_SHIM_SCRIPT,
  }
}