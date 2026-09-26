import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { CatalogService } from './disc/catalog-service.js'
import { detectOpticalDrive, resolveDvdSource } from './disc/optical-drive.js'
import { EventHub } from './events/event-hub.js'
import { createFileLogSink } from './logging/file-log-sink.js'
import { ServerLog } from './logging/server-log.js'
import { SessionManager } from './session/session-manager.js'
import { findVlc } from './vlc/find-vlc.js'
import { attachVlcProcessRegistry, VlcProcessRegistry } from './vlc/process-registry.js'
import { VlcWorker } from './vlc/worker.js'

const config = loadConfig(process.env)
await mkdir(config.cacheDir, { recursive: true })

const eventHub = new EventHub()
const fileLogSink = createFileLogSink(config.logFile ?? `${config.cacheDir}/logs/server.log`)
const serverLog = new ServerLog(eventHub, 200, (line, entry) => {
  fileLogSink.sink(line, entry)

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
serverLog.info('server', `Writing server log to ${fileLogSink.path}.`)

const vlcProcessRegistry = new VlcProcessRegistry(config.cacheDir)
const orphanedVlcProcesses = await vlcProcessRegistry.sweep()
if (orphanedVlcProcesses > 0) {
  serverLog.warn('server', `Stopped ${orphanedVlcProcesses} abandoned VLC process(es) from the previous server run.`)
}
const detachVlcProcessRegistry = attachVlcProcessRegistry(vlcProcessRegistry, (error) => {
  serverLog.warn('server', `Could not update the VLC process registry: ${error instanceof Error ? error.message : String(error)}`)
})

// Resolve the optical drive: an explicit DVD_DRIVE always wins; otherwise
// auto-detect the Windows optical drive (preferring one with a disc loaded) so
// the app does not silently probe the wrong letter.
const sourceResolution = await resolveDvdSource(process.env.DVD_DRIVE, () => detectOpticalDrive({
  onMultipleLoadedDrives: (drives) => {
    serverLog.warn('server', `Multiple optical drives contain discs (${drives.join(', ')}); using ${drives[0]}. Set DVD_DRIVE to choose another drive.`)
  },
}))
const resolvedDrive = sourceResolution.source
if (sourceResolution.detected) serverLog.info('server', `Auto-detected optical drive ${resolvedDrive}.`)
if (!sourceResolution.explicit && !sourceResolution.detected) {
  serverLog.warn('server', `Could not auto-detect an optical drive; using ${resolvedDrive}. Set DVD_DRIVE to override.`)
}

serverLog.info('server', `Bootstrapping DVD Streamer with host=${config.host}, port=${config.port}, drive=${resolvedDrive}, cacheDir=${config.cacheDir}.`)

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
  drive: resolvedDrive,
  timeoutMs: config.vlcTimeoutMs ?? 30000,
  cacheDir: config.cacheDir,
  shimScript: config.vlcShimScript,
  trackMetadataScript: defaultTrackMetadataScript,
  logger: serverLog,
})
const catalogService = new CatalogService({
  cacheDir: config.cacheDir,
  drive: resolvedDrive,
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
    readRetryAttempts: config.sessionRecoveryReadRetries ?? 12,
    skipGuardSlots: config.sessionRecoverySkipGuardSlots ?? 3,
    maxStallPatienceMs: config.sessionRecoveryMaxStallPatienceMs ?? 20000,
    maxAttempts: config.sessionRecoveryMaxAttempts ?? 6,
  },
  onSessionEvent: (event) => eventHub.publish(event),
  worker,
  logger: serverLog,
})

const cleanupTimer = setInterval(() => {
  void sessionManager.cleanupInactive()
}, 30000)

serverLog.info('server', `Starting DVD Streamer on ${config.host}:${config.port} using drive ${resolvedDrive}.`)

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
  detachVlcProcessRegistry()
  await fileLogSink.close()
})

await app.listen({ host: config.host, port: config.port })
serverLog.info('server', `HTTP server listening on ${config.host}:${config.port}.`)
