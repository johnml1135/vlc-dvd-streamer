import type { AppConfig } from '../config.js'
import type { CatalogService } from '../disc/catalog-service.js'
import { EventHub } from '../events/event-hub.js'
import type { ServerLog } from '../logging/server-log.js'
import type { SessionManager } from '../session/session-manager.js'
import type { VlcWorker } from '../vlc/worker.js'

export type CatalogServiceLike = Pick<CatalogService, 'getSnapshot' | 'startRefresh' | 'refresh' | 'listTitles' | 'findTitle'>
export type EventHubLike = Pick<EventHub, 'publish' | 'subscribe'>
export type SessionManagerLike = Pick<SessionManager, 'start' | 'getSession' | 'getActiveSession' | 'touch' | 'stop' | 'stopAll'>
export type VlcWorkerLike = Pick<VlcWorker, 'generateThumbnail'>
export type ServerLogLike = Pick<ServerLog, 'list'>

export interface AppServices {
  catalogService?: CatalogServiceLike
  eventHub?: EventHubLike
  sessionManager?: SessionManagerLike
  vlcWorker?: VlcWorkerLike
  serverLog?: ServerLogLike
}

export interface AppDeps {
  config: AppConfig
  services?: AppServices
}

export interface AppContext {
  config: AppConfig
  services: AppServices
  eventHub: EventHubLike
  serverLog?: ServerLogLike
}

export function createAppContext(deps: AppDeps): AppContext {
  const services: AppServices = { ...deps.services }
  const eventHub = services.eventHub ?? new EventHub()

  return {
    config: deps.config,
    services: {
      ...services,
      eventHub,
    },
    eventHub,
    serverLog: services.serverLog,
  }
}