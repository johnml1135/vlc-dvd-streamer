import { describe, expect, it } from 'vitest'
import { appendStreamFlag, isValidAssetName, isValidSessionId, parseBooleanQuery, rewriteManifest } from '../../../src/http/route-utils.js'

describe('http route helpers', () => {
  it('rewrites only media lines in HLS manifests', () => {
    expect(rewriteManifest('#EXTM3U\n#EXTINF:10,\nsegment-000.ts\n', 'videoOnly')).toBe(
      '#EXTM3U\n#EXTINF:10,\nsegment-000.ts?videoOnly=1\n',
    )
  })

  it('validates session ids and asset names used by stream routes', () => {
    expect(isValidSessionId('session-123')).toBe(true)
    expect(isValidSessionId('bad/session')).toBe(false)
    expect(isValidAssetName('index.m3u8')).toBe(true)
    expect(isValidAssetName('../secret.ts')).toBe(false)
    expect(isValidAssetName('nested/segment.ts')).toBe(false)
  })

  it('parses boolean query flags and appends stream flags consistently', () => {
    expect(parseBooleanQuery('1')).toBe(true)
    expect(parseBooleanQuery('true')).toBe(true)
    expect(parseBooleanQuery('0')).toBe(false)
    expect(appendStreamFlag('/streams/session-1/index.m3u8', 'videoOnly', true)).toBe(
      '/streams/session-1/index.m3u8?videoOnly=1',
    )
    expect(appendStreamFlag('/streams/session-1/index.m3u8?foo=1', 'videoOnly', true)).toBe(
      '/streams/session-1/index.m3u8?foo=1&videoOnly=1',
    )
  })
})