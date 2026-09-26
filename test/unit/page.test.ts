import { describe, expect, it } from 'vitest'
import { renderHomePage, renderPlayerPage } from '../../src/ui/page.js'

describe('renderPlayerPage', () => {
  it('renders a browser-safe player script and supports a video-only manifest override', () => {
    const html = renderPlayerPage({
      session: {
        id: 'session-123',
        discId: 'disc-123',
        drive: 'D:',
        titleNumber: 1,
        audioTrack: 1,
        subtitleTrack: 1,
        state: 'ready',
        outputDir: '.cache/session-123',
        manifestPath: '.cache/session-123/index.m3u8',
        manifestUrl: '/streams/session-123/index.m3u8',
        startedAt: '2025-01-01T00:00:00.000Z',
        lastAccessedAt: '2025-01-01T00:00:00.000Z',
        durationSeconds: 7200,
        timeline: {
          durationSeconds: 7200,
          currentRange: { startSeconds: 0, endSeconds: 8 },
          generatedRanges: [{ startSeconds: 0, endSeconds: 8 }],
          stitchedManifestUrl: '/streams/session-123/stitched.m3u8',
          status: 'idle',
        },
      },
      manifestUrl: '/streams/session-123/index.m3u8?videoOnly=1',
      viewerToken: 'page-token-1',
      viewerActive: true,
    })

    expect(html).toContain('<script type="module" src="/assets/browser-playback.js"></script>')
    expect(html).toContain('data-manifest-url="/streams/session-123/index.m3u8?videoOnly=1"')
    expect(html).toContain('data-session-manifest-url="/streams/session-123/index.m3u8"')
    expect(html).toContain('data-viewer-token="page-token-1"')
    expect(html).toContain('data-viewer-active="true"')
    expect(html).toContain('id="viewer-passive"')
    expect(html).toContain('Server log')
    expect(html).toContain("fetch('/api/logs')")
    expect(html).toContain("event.type === 'server.log'")
    expect(html).toContain("event.type === 'catalog.updated'")
    expect(html).toContain("data-recovery-epoch=\"0\"")
    expect(html).toContain('window.location.reload()')
    expect(html).toContain("lines.join('\\n')")
    expect(html).toContain("split('\\n')")
    expect(html).toContain('server-log-open')
    expect(html).toContain("document.querySelector('.log-drawer')")
    expect(html).toContain("localStorage.getItem(logDrawerStorageKey)")
    expect(html).toContain("logDrawer.addEventListener('toggle'")
    expect(html).toContain("window.addEventListener('beforeunload'")
    expect(html).toContain('data-duration-seconds="7200"')
    expect(html).toContain('id="title-seek"')
    expect(html).toContain("import { subscribeAppEvents } from '/assets/browser-events.js'")
    expect(html).not.toContain('new WebSocket(')
    expect(html).not.toContain('vlc-dvd-streamer:session-recovery')
    expect(html).toContain('stitched.m3u8')
  })
})

describe('renderHomePage', () => {
  it('defaults the audio form to automatic English preference instead of forcing the first numeric track', () => {
    const html = renderHomePage({
      health: {
        ok: true,
        dependencies: {
          vlc: {
            found: true,
            path: 'C:/Program Files/VideoLAN/VLC/vlc.exe',
          },
        },
      },
      snapshot: {
        state: 'catalog_ready',
        disc: {
          discId: 'disc-123',
          drive: 'D:',
          titles: [],
        },
      },
      titles: [
        {
          id: 'disc-123-title-1',
          titleNumber: 1,
          label: 'Title 1',
          durationSeconds: 7212,
          likelyMainFeature: true,
          thumbnailUrl: '/thumbnail.jpg',
          audioTracks: [{ id: 0, label: 'English' }],
          subtitleTracks: [{ id: 2, label: 'English SDH' }],
        },
      ],
      includeShort: true,
    })

    expect(html).toContain('Auto (English preferred)')
    expect(html).toContain('<option value="0">English</option>')
    expect(html).toContain('<option value="">Off</option>')
    expect(html).toContain('<option value="2">English SDH</option>')
  })

  it('shows per-title scan progress while the catalog is loading', () => {
    const html = renderHomePage({
      health: {
        ok: true,
        dependencies: {
          vlc: {
            found: true,
            path: 'C:/Program Files/VideoLAN/VLC/vlc.exe',
          },
        },
      },
      snapshot: {
        state: 'catalog_loading',
        disc: null,
        progress: {
          scannedTitles: 1,
          totalTitles: 4,
          currentTitleNumber: 2,
        },
      },
      titles: [],
      includeShort: true,
    })

    expect(html).toContain('1 of 4 titles scanned')
    expect(html).toContain('Reading title 2')
  })
})
