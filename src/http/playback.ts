import type { DiscTitle } from '../disc/types.js'
import type { EventHubLike, CatalogServiceLike, SessionManagerLike } from './app-types.js'

export interface PlaybackRequest {
  discId: string
  titleNumber: number
  audioTrack: number | null
  subtitleTrack: number | null
}

export type PlaybackRequestResult = {
  ok: true
  request: PlaybackRequest
} | {
  ok: false
  message: string
}

export type PlaybackStartResult = {
  ok: true
  session: Awaited<ReturnType<SessionManagerLike['start']>>
} | {
  ok: false
  statusCode: number
  message: string
  detail?: string
}

export interface PlaybackStartDeps {
  catalogService: Pick<CatalogServiceLike, 'getSnapshot' | 'findTitle'>
  sessionManager: Pick<SessionManagerLike, 'start'>
  eventHub: Pick<EventHubLike, 'publish'>
}

export interface PlaybackStartOptions {
  catalogUnavailableStatusCode?: number
  catalogUnavailableMessage?: string
  startupFailureMessage?: string
}

export function parsePlaybackRequest(body: unknown): PlaybackRequestResult {
  const record = asRecord(body)
  if (!record) {
    return { ok: false, message: 'Playback request body is invalid.' }
  }

  const discId = typeof record.discId === 'string' ? record.discId : ''
  if (!discId) {
    return { ok: false, message: 'Disc id is required.' }
  }

  const titleNumber = parsePositiveInteger(record.titleNumber)
  if (titleNumber === null) {
    return { ok: false, message: 'Title number must be a positive integer.' }
  }

  const audioTrack = parseOptionalNonNegativeInteger(record.audioTrack)
  if (audioTrack === undefined) {
    return { ok: false, message: 'Audio track must be a non-negative integer.' }
  }

  const subtitleTrack = parseOptionalNonNegativeInteger(record.subtitleTrack)
  if (subtitleTrack === undefined) {
    return { ok: false, message: 'Subtitle track must be a non-negative integer.' }
  }

  return {
    ok: true,
    request: {
      discId,
      titleNumber,
      audioTrack,
      subtitleTrack,
    },
  }
}

export async function startPlaybackSession(
  deps: PlaybackStartDeps,
  request: PlaybackRequest,
  options: PlaybackStartOptions = {},
): Promise<PlaybackStartResult> {
  const snapshot = deps.catalogService.getSnapshot()
  if (snapshot.state !== 'catalog_ready' || !snapshot.disc) {
    return {
      ok: false,
      statusCode: options.catalogUnavailableStatusCode ?? 409,
      message: options.catalogUnavailableMessage ?? 'No DVD catalog is ready yet.',
    }
  }

  if (request.discId !== snapshot.disc.discId) {
    return {
      ok: false,
      statusCode: 400,
      message: 'The selected disc is no longer current.',
    }
  }

  const title = deps.catalogService.findTitle(request.titleNumber)
  if (!title) {
    return {
      ok: false,
      statusCode: 400,
      message: 'The selected title is not available.',
    }
  }

  const trackValidation = validatePlaybackTracks(title, request.audioTrack, request.subtitleTrack)
  if (!trackValidation.ok) {
    return {
      ok: false,
      statusCode: 400,
      message: trackValidation.message,
    }
  }

  const session = await deps.sessionManager.start({
    discId: snapshot.disc.discId,
    drive: snapshot.disc.drive,
    titleNumber: request.titleNumber,
    audioTrack: request.audioTrack ?? undefined,
    subtitleTrack: request.subtitleTrack ?? undefined,
  })

  if (session.state !== 'ready') {
    return {
      ok: false,
      statusCode: 502,
      message: session.error?.message ?? options.startupFailureMessage ?? 'Playback failed to start.',
      detail: session.error?.detail,
    }
  }

  deps.eventHub.publish({ type: 'session.updated', payload: session })
  return { ok: true, session }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null
  }

  if (typeof value === 'string' && value.trim() === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseOptionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined
  }

  if (typeof value === 'string' && value.trim() === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function validatePlaybackTracks(title: DiscTitle, audioTrack: number | null, subtitleTrack: number | null): { ok: true } | { ok: false; message: string } {
  if (audioTrack !== null && !title.audioTracks.some((track) => track.id === audioTrack)) {
    return { ok: false, message: 'The selected audio track is not available for this title.' }
  }

  if (subtitleTrack !== null && !title.subtitleTracks.some((track) => track.id === subtitleTrack)) {
    return { ok: false, message: 'The selected subtitle track is not available for this title.' }
  }

  return { ok: true }
}