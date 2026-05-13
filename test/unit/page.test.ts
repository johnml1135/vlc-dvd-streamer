import { describe, expect, it } from 'vitest'
import { renderPlayerPage } from '../../src/ui/page.js'

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
      },
      manifestUrl: '/streams/session-123/index.m3u8?videoOnly=1',
    })

    expect(html).toContain('/Safari\\//.test(userAgent)')
    expect(html).toContain("userAgent.includes('Code/')")
    expect(html).toContain('Using hls.js fallback without audio in the embedded browser.')
    expect(html).toContain('data-manifest-url="/streams/session-123/index.m3u8?videoOnly=1"')
    expect(html).toContain('Server log')
    expect(html).toContain("fetch('/api/logs')")
    expect(html).toContain("event.type === 'server.log'")
    expect(html).toContain("event.type === 'catalog.updated'")
    expect(html).toContain('window.location.reload()')
  })
})