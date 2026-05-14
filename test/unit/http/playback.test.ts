import { describe, expect, it, vi } from 'vitest'
import { parsePlaybackRequest, startPlaybackSession } from '../../../src/http/playback.js'

describe('http playback helpers', () => {
  it('parses playback bodies into a normalized request', () => {
    expect(parsePlaybackRequest({
      discId: 'disc-001',
      titleNumber: '2',
      audioTrack: '',
      subtitleTrack: '0',
    })).toEqual({
      ok: true,
      request: {
        discId: 'disc-001',
        titleNumber: 2,
        audioTrack: null,
        subtitleTrack: 0,
      },
    })
  })

  it('rejects unavailable tracks without starting a session', async () => {
    const start = vi.fn()

    const result = await startPlaybackSession({
      catalogService: {
        getSnapshot() {
          return {
            state: 'catalog_ready',
            disc: {
              discId: 'disc-001',
              drive: 'F:',
              titles: [],
            },
          }
        },
        findTitle() {
          return {
            id: 'disc-001-title-1',
            titleNumber: 1,
            label: 'Title 1',
            durationSeconds: 7200,
            likelyMainFeature: true,
            thumbnailUrl: '/api/discs/current/titles/1/thumbnail.jpg',
            audioTracks: [{ id: 1, label: 'English' }],
            subtitleTracks: [{ id: 2, label: 'English subtitles' }],
          }
        },
      },
      sessionManager: {
        start,
      },
      eventHub: {
        publish: vi.fn(),
      },
    }, {
      discId: 'disc-001',
      titleNumber: 1,
      audioTrack: 99,
      subtitleTrack: null,
    })

    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      message: 'The selected audio track is not available for this title.',
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts playback and publishes a session update when ready', async () => {
    const session = {
      id: 'session-1',
      discId: 'disc-001',
      drive: 'F:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 2,
      state: 'ready',
      outputDir: '.cache/sessions/session-1',
      manifestPath: '.cache/sessions/session-1/index.m3u8',
      manifestUrl: '/streams/session-1/index.m3u8',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    }
    const start = vi.fn().mockResolvedValue(session)
    const publish = vi.fn()

    const result = await startPlaybackSession({
      catalogService: {
        getSnapshot() {
          return {
            state: 'catalog_ready',
            disc: {
              discId: 'disc-001',
              drive: 'F:',
              titles: [],
            },
          }
        },
        findTitle() {
          return {
            id: 'disc-001-title-1',
            titleNumber: 1,
            label: 'Title 1',
            durationSeconds: 7200,
            likelyMainFeature: true,
            thumbnailUrl: '/api/discs/current/titles/1/thumbnail.jpg',
            audioTracks: [{ id: 1, label: 'English' }],
            subtitleTracks: [{ id: 2, label: 'English subtitles' }],
          }
        },
      },
      sessionManager: {
        start,
      },
      eventHub: {
        publish,
      },
    }, {
      discId: 'disc-001',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 2,
    })

    expect(result).toEqual({
      ok: true,
      session,
    })
    expect(start).toHaveBeenCalledWith({
      discId: 'disc-001',
      drive: 'F:',
      titleNumber: 1,
      audioTrack: 1,
      subtitleTrack: 2,
    })
    expect(publish).toHaveBeenCalledWith({
      type: 'session.updated',
      payload: session,
    })
  })

  it('leaves automatic audio and subtitle choices unset for VLC to resolve', async () => {
    const session = {
      id: 'session-1',
      discId: 'disc-001',
      drive: 'F:',
      titleNumber: 1,
      state: 'ready',
      outputDir: '.cache/sessions/session-1',
      manifestPath: '.cache/sessions/session-1/index.m3u8',
      manifestUrl: '/streams/session-1/index.m3u8',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    }
    const start = vi.fn().mockResolvedValue(session)

    const result = await startPlaybackSession({
      catalogService: {
        getSnapshot() {
          return {
            state: 'catalog_ready',
            disc: {
              discId: 'disc-001',
              drive: 'F:',
              titles: [],
            },
          }
        },
        findTitle() {
          return {
            id: 'disc-001-title-1',
            titleNumber: 1,
            label: 'Title 1',
            durationSeconds: 7200,
            likelyMainFeature: true,
            thumbnailUrl: '/api/discs/current/titles/1/thumbnail.jpg',
            audioTracks: [{ id: 1, label: 'English' }],
            subtitleTracks: [{ id: 2, label: 'English subtitles' }],
          }
        },
      },
      sessionManager: {
        start,
      },
      eventHub: {
        publish: vi.fn(),
      },
    }, {
      discId: 'disc-001',
      titleNumber: 1,
      audioTrack: null,
      subtitleTrack: null,
    })

    expect(result).toEqual({
      ok: true,
      session,
    })
    expect(start).toHaveBeenCalledWith({
      discId: 'disc-001',
      drive: 'F:',
      titleNumber: 1,
      audioTrack: undefined,
      subtitleTrack: undefined,
    })
  })
})