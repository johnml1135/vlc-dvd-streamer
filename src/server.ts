import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { CatalogService } from './disc/catalog-service.js'
import { EventHub } from './events/event-hub.js'
import { ServerLog } from './logging/server-log.js'
import { SessionManager } from './session/session-manager.js'
import { findVlc } from './vlc/find-vlc.js'
import { VlcWorker } from './vlc/worker.js'

const config = loadConfig(process.env)
await mkdir(config.cacheDir, { recursive: true })

const eventHub = new EventHub()
const serverLog = new ServerLog(eventHub, 200, (line, entry) => {
  if (entry.level === 'error') {
    console.error(line)
    return
  }

  if (entry.level === 'warn') {
    console.warn(line)
    return
  }

  console.log(line)
})

serverLog.info('server', `Bootstrapping DVD Streamer with host=${config.host}, port=${config.port}, drive=${config.drive ?? 'D:'}, cacheDir=${config.cacheDir}.`)

const resolvedVlc = await findVlc(config.vlcCandidates)
serverLog.info(
  'server',
  resolvedVlc.found
    ? `Resolved VLC executable: ${resolvedVlc.path}`
    : `VLC executable was not found. Tried: ${config.vlcCandidates.join(', ')}`,
)

const defaultTrackMetadataScript = !config.vlcShimScript
  && process.platform === 'win32'
  && existsSync(config.vlcTrackMetadataScript ?? 'scripts/windows/query-vlc-track-descriptions.ps1')
  ? (config.vlcTrackMetadataScript ?? 'scripts/windows/query-vlc-track-descriptions.ps1')
  : undefined

const worker = new VlcWorker({
  executable: resolvedVlc.path ?? config.vlcCandidates[0] ?? process.execPath,
  drive: config.drive ?? 'D:',
  timeoutMs: config.vlcTimeoutMs ?? 30000,
  shimScript: config.vlcShimScript,
  trackMetadataScript: defaultTrackMetadataScript,
  logger: serverLog,
})
const catalogService = new CatalogService({
  cacheDir: config.cacheDir,
  drive: config.drive ?? 'D:',
  minVisibleTitleDurationSeconds: config.minVisibleTitleDurationSeconds ?? 300,
  worker,
  logger: serverLog,
  onSnapshot: (snapshot) => {
    eventHub.publish({ type: 'disc.updated', payload: snapshot })
    eventHub.publish({ type: 'catalog.updated', payload: snapshot })
  },
})
const sessionManager = new SessionManager({
  cacheDir: config.cacheDir,
  inactivityMs: config.inactiveSessionMs ?? 900000,
  readinessTimeoutMs: config.sessionReadinessTimeoutMs ?? 120000,
  playbackRecovery: {
    stallTimeoutMs: config.sessionRecoveryStallMs ?? 10000,
    restartReadinessTimeoutMs: config.sessionRecoveryRestartReadinessMs ?? 30000,
    skipSeconds: config.sessionRecoverySkipSeconds ?? 10,
    readRetryAttempts: config.sessionRecoveryReadRetries ?? 3,
    maxAttempts: config.sessionRecoveryMaxAttempts ?? 6,
  },
  onSessionEvent: (event) => eventHub.publish(event),
  worker,
  logger: serverLog,
})

const cleanupTimer = setInterval(() => {
  void sessionManager.cleanupInactive()
}, 30000)

serverLog.info('server', `Starting DVD Streamer on ${config.host}:${config.port} using drive ${config.drive ?? 'D:'}.`)

const app = await buildApp({
  config,
  services: {
    catalogService,
    eventHub,
    sessionManager,
    serverLog,
    vlcWorker: worker,
  },
})

app.addHook('onClose', async () => {
  clearInterval(cleanupTimer)
})

await app.listen({ host: config.host, port: config.port })
serverLog.info('server', `HTTP server listening on ${config.host}:${config.port}.`)