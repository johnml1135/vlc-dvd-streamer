import { mkdir } from 'node:fs/promises'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { CatalogService } from './disc/catalog-service.js'
import { EventHub } from './events/event-hub.js'
import { SessionManager } from './session/session-manager.js'
import { findVlc } from './vlc/find-vlc.js'
import { VlcWorker } from './vlc/worker.js'

const config = loadConfig(process.env)
await mkdir(config.cacheDir, { recursive: true })

const resolvedVlc = await findVlc(config.vlcCandidates)
const worker = new VlcWorker({
  executable: resolvedVlc.path ?? config.vlcCandidates[0] ?? process.execPath,
  drive: config.drive ?? 'D:',
  timeoutMs: config.vlcTimeoutMs ?? 30000,
  shimScript: config.vlcShimScript,
})
const catalogService = new CatalogService({
  cacheDir: config.cacheDir,
  drive: config.drive ?? 'D:',
  minVisibleTitleDurationSeconds: config.minVisibleTitleDurationSeconds ?? 300,
  worker,
})
const sessionManager = new SessionManager({
  cacheDir: config.cacheDir,
  inactivityMs: config.inactiveSessionMs ?? 900000,
  worker,
})
const eventHub = new EventHub()

const cleanupTimer = setInterval(() => {
  void sessionManager.cleanupInactive()
}, 30000)

const app = await buildApp({
  config,
  services: {
    catalogService,
    eventHub,
    sessionManager,
    vlcWorker: worker,
  },
})

app.addHook('onClose', async () => {
  clearInterval(cleanupTimer)
})

await app.listen({ host: config.host, port: config.port })