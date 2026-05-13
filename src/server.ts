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
const serverLog = new ServerLog(eventHub)

const resolvedVlc = await findVlc(config.vlcCandidates)
const worker = new VlcWorker({
  executable: resolvedVlc.path ?? config.vlcCandidates[0] ?? process.execPath,
  drive: config.drive ?? 'D:',
  timeoutMs: config.vlcTimeoutMs ?? 30000,
  shimScript: config.vlcShimScript,
  logger: serverLog,
})
const catalogService = new CatalogService({
  cacheDir: config.cacheDir,
  drive: config.drive ?? 'D:',
  minVisibleTitleDurationSeconds: config.minVisibleTitleDurationSeconds ?? 300,
  worker,
  logger: serverLog,
})
const sessionManager = new SessionManager({
  cacheDir: config.cacheDir,
  inactivityMs: config.inactiveSessionMs ?? 900000,
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