import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HlsPublication } from '../../src/session/hls-publication.js'

const media = (value = 0) => Buffer.from([0x47, 0x40, value, 0x10])
const name = (slot: number) => `segment-${String(slot).padStart(6, '0')}.ts`
async function setup(options: { writePlaceholderSegment?: (path: string, slot: number) => Promise<void> } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'hls-publication-'))
  return new HlsPublication({ outputDir, baseUrl: '/streams/test/', durationSeconds: 120, segmentDurationSeconds: 2, ...options })
}
async function manifest(outputDir: string, slots: number[]) {
  await writeFile(join(outputDir, 'index.m3u8'), '#EXTM3U\n' + slots.map(slot => `#EXTINF:2,\n${name(slot)}\n`).join(''))
}

describe('HLS publication', () => {
  it('keeps the target duration stable and withholds segments exceeding it', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1])
    await writeFile(join(epoch.outputDir, name(1)), media())
    await output.observe(epoch)
    await writeFile(join(epoch.outputDir, name(2)), media())
    await writeFile(join(epoch.outputDir, 'index.m3u8'), `#EXTM3U\n#EXTINF:2,\n${name(1)}\n#EXTINF:3,\n${name(2)}\n`)
    await output.observe(epoch)
    expect(output.regionManifest()).toContain('#EXT-X-TARGETDURATION:2')
    expect(output.regionManifest()).not.toContain(name(2))
    expect(output.currentRange.endSeconds).toBe(2)
  })

  it('requires a valid duration before every segment URI', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await writeFile(join(epoch.outputDir, name(1)), media())
    for (const duration of ['', '#EXTINF:NaN,\n', '#EXTINF:0,\n', '#EXTINF:-1,\n']) {
      await writeFile(join(epoch.outputDir, 'index.m3u8'), `#EXTM3U\n${duration}${name(1)}\n`)
      expect(await output.observe(epoch)).toBeNull()
    }
    expect(output.regionManifest()).not.toContain(name(1))
  })

  it('does not publish a playlist tail past a missing first segment', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1, 2])
    await writeFile(join(epoch.outputDir, name(2)), media())
    expect(await output.observe(epoch)).toBeNull()
    expect(output.regionManifest()).not.toContain(name(2))
    await writeFile(join(epoch.outputDir, name(1)), media())
    expect(await output.observe(epoch)).not.toBeNull()
    expect(output.snapshot().currentRange.endSeconds).toBe(4)
  })

  it('publishes placeholders only after their bytes are complete', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { entered = resolve })
    const output = await setup({ writePlaceholderSegment: async path => {
      entered()
      await gate
      await writeFile(path, media())
    } })
    const pending = output.publishPlaceholder(1)
    await writing
    expect(output.regionManifest()).not.toContain(name(1))
    release()
    expect(await pending).toBe(true)
    expect(output.regionManifest()).toContain(`${name(1)}?generation=placeholder&region=0`)
    expect((await output.readAsset(name(1), { generation: 'placeholder' }))?.content).toEqual(media())
  })

  it('does not advertise a placeholder when cancellation wins during rendering', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { entered = resolve })
    let current = true
    const output = await setup({ writePlaceholderSegment: async path => {
      entered()
      await gate
      await writeFile(path, media())
    } })
    const pending = output.publishPlaceholder(1, () => current)
    await writing
    current = false
    release()
    expect(await pending).toBe(false)
    expect(output.regionManifest()).not.toContain(name(1))
    expect(await output.readAsset(name(1), { generation: 'placeholder' })).toBeNull()
  })

  it('does not report a committed slot when staging cleanup fails', async () => {
    const output = await setup({ writePlaceholderSegment: async path => {
      await mkdir(path)
    } })
    await expect(output.publishPlaceholder(1)).rejects.toThrow()
    expect(output.regionManifest()).not.toContain(name(1))
    expect(output.stitchedManifest()).not.toContain(name(1))
  })

  it('keeps published bytes immutable across restarts and ignores obsolete observations', async () => {
    const output = await setup()
    const first = await output.beginEpoch()
    await manifest(first.outputDir, [1])
    await writeFile(join(first.outputDir, name(1)), media(1))
    await output.observe(first)
    const oldManifest = output.regionManifest()
    const second = await output.beginEpoch()
    await manifest(second.outputDir, [1])
    await writeFile(join(second.outputDir, name(1)), media(2))
    await output.observe(second)
    expect(await output.observe(first)).toBeNull()
    expect(oldManifest).toContain('generation=0')
    expect(output.regionManifest()).toContain('generation=0')
    expect((await output.readAsset(name(1), { generation: '0' }))?.content).toEqual(media(1))
    await writeFile(join(first.outputDir, name(1)), media(3))
    expect((await output.readAsset(name(1), { generation: '0' }))?.content).toEqual(media(1))
  })

  it('revises the manifest on a seek and retains immutable old assets', async () => {
    const output = await setup()
    const first = await output.beginEpoch()
    await manifest(first.outputDir, [1])
    await writeFile(join(first.outputDir, name(1)), media(1))
    await output.observe(first)
    output.seekTo(20)
    const second = await output.beginEpoch()
    await manifest(second.outputDir, [11])
    await writeFile(join(second.outputDir, name(11)), media(2))
    await output.observe(second)
    expect(output.manifestUrl).toContain('region=1')
    const oldRegion = await output.readAsset('index.m3u8', { region: '0' })
    expect(oldRegion?.content).toContain(`${name(1)}?generation=0`)
    expect(oldRegion?.content).not.toContain(name(11))
    expect(oldRegion?.content).toContain('#EXT-X-ENDLIST')
    expect(output.regionManifest()).toContain(`${name(11)}?generation=1`)
    expect(output.snapshot().generatedRanges).toEqual([{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 20, endSeconds: 22 }])
    expect((await output.readAsset(name(1), { generation: '0' }))?.content).toEqual(media(1))
  })

  it('rejects unregistered files and traversal and preserves video-only query flags', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1])
    await writeFile(join(epoch.outputDir, name(1)), media())
    await output.observe(epoch)
    expect(await output.readAsset('../index.m3u8')).toBeNull()
    expect(await output.readAsset(name(1), { generation: '../0' })).toBeNull()
    expect(await output.readAsset('placeholder.ts')).toBeNull()
    expect((await output.readAsset('index.m3u8', { videoOnly: true }))?.content).toContain('generation=0&videoOnly=1')
  })

  it('becomes ready at the first valid segment but stops progress at a middle gap', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1, 2, 3])
    await writeFile(join(epoch.outputDir, name(1)), media())
    await writeFile(join(epoch.outputDir, name(3)), media())
    expect(await output.observe(epoch)).toMatchObject({ lastSegmentNumber: 1 })
    expect(output.regionManifest()).not.toContain(name(3))
    await writeFile(join(epoch.outputDir, name(2)), media())
    expect(await output.observe(epoch)).toMatchObject({ lastSegmentNumber: 3 })
  })

  it('requires fresh raw bytes even when the restarted slot is already published', async () => {
    const output = await setup()
    const first = await output.beginEpoch()
    await manifest(first.outputDir, [1])
    await writeFile(join(first.outputDir, name(1)), media())
    await output.observe(first)
    const second = await output.beginEpoch()
    await manifest(second.outputDir, [1])
    expect(await output.observe(second)).toBeNull()
    await writeFile(join(second.outputDir, name(1)), media(2))
    expect(await output.observe(second)).toMatchObject({ lastSegmentNumber: 1 })
    expect(output.regionManifest()).toContain('generation=0')
  })

  it('retains a closed stitched revision when a later seek fills an earlier gap', async () => {
    const output = await setup()
    output.seekTo(4)
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [3])
    await writeFile(join(epoch.outputDir, name(3)), media())
    await output.observe(epoch)
    const revision = new URL(output.snapshot().stitchedManifestUrl, 'http://test').searchParams.get('revision')!
    const earlier = await output.readAsset('stitched.m3u8', { revision })
    output.seekTo(0)
    const second = await output.beginEpoch()
    await manifest(second.outputDir, [1, 2])
    await writeFile(join(second.outputDir, name(1)), media())
    await writeFile(join(second.outputDir, name(2)), media())
    await output.observe(second)
    expect(await output.readAsset('stitched.m3u8', { revision })).toEqual(earlier)
    expect(earlier?.content).toContain('#EXT-X-ENDLIST')
    expect(output.stitchedManifest()).toContain(name(1))
  })

  it('appends recovery with a discontinuity and retains EVENT at title completion', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'hls-endlist-'))
    const output = new HlsPublication({ outputDir, baseUrl: '/streams/test/', durationSeconds: 4, segmentDurationSeconds: 2 })
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1])
    await writeFile(join(epoch.outputDir, name(1)), media())
    await output.observe(epoch)
    const url = output.manifestUrl
    const next = await output.beginEpoch()
    await manifest(next.outputDir, [2])
    await writeFile(join(next.outputDir, name(2)), media())
    await output.observe(next)
    expect(output.manifestUrl).toBe(url)
    expect(output.regionManifest()).toContain('#EXT-X-PLAYLIST-TYPE:EVENT')
    expect(output.regionManifest()).toContain('#EXT-X-ENDLIST')
    expect(output.regionManifest().match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1)
    output.retire()
    expect(await output.readAsset(name(1), { generation: '0' })).toBeNull()
  })

  it('keeps a failed placeholder publication out of every manifest', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await writeFile(join(epoch.outputDir, '..', '..', 'published'), 'blocks the destination directory')
    await expect(output.publishPlaceholder(1)).rejects.toThrow()
    expect(output.regionManifest()).not.toContain(name(1))
    expect(output.stitchedManifest()).not.toContain(name(1))
    expect(await output.readAsset(name(1), { generation: 'placeholder' })).toBeNull()
  })

  it('does not expose an incomplete manifest entry and publishes it once complete', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    await manifest(epoch.outputDir, [1])
    await writeFile(join(epoch.outputDir, name(1)), media())
    await output.observe(epoch)
    const before = output.regionManifest()
    await writeFile(join(epoch.outputDir, name(2)), media())
    await writeFile(join(epoch.outputDir, 'index.m3u8'), `#EXTM3U\n#EXTINF:2,\n${name(1)}\n#EXTINF:2,\nsegment-00000`)
    await output.observe(epoch)
    expect(output.regionManifest()).toBe(before)
    await manifest(epoch.outputDir, [1, 2])
    await Promise.all([output.observe(epoch), output.observe(epoch)])
    expect(output.regionManifest().match(/segment-000002.ts/g)).toHaveLength(1)
  })

  it('propagates manifest filesystem errors while treating a missing manifest as pending', async () => {
    const output = await setup()
    const epoch = await output.beginEpoch()
    expect(await output.observe(epoch)).toBeNull()
    await expect(output.observe(epoch, epoch.outputDir)).rejects.toThrow()
  })

  it('qualifies region media URIs and leaves stitched media unqualified', async () => {
    const output = await setup()
    const first = await output.beginEpoch()
    await manifest(first.outputDir, [1])
    await writeFile(join(first.outputDir, name(1)), media())
    await output.observe(first)
    expect(output.currentRegion).toBe('0')
    expect(output.isCurrentRegion('0')).toBe(true)
    expect(output.isCurrentRegion('00')).toBe(false)
    expect(output.isCurrentRegion()).toBe(false)
    expect(output.regionManifest()).toContain(`${name(1)}?generation=0&region=0`)
    expect(output.stitchedManifest()).toContain(`${name(1)}?generation=0`)
    expect(output.stitchedManifest()).not.toContain(`${name(1)}?generation=0&region=`)
    output.seekTo(4)
    const second = await output.beginEpoch()
    await manifest(second.outputDir, [3])
    await writeFile(join(second.outputDir, name(3)), media())
    await output.observe(second)
    expect(output.currentRegion).toBe('1')
    expect(output.regionManifest()).toContain(`${name(3)}?generation=1&region=1`)
    expect((await output.readAsset('index.m3u8', { region: '0' }))?.content).toContain(`${name(1)}?generation=0&region=0`)
  })
})
