import { describe, expect, it } from 'vitest'
import { buildDvdDiscMrl, buildDvdTitleMrl } from '../../../src/vlc/mrl.js'
import { buildHlsArgs, buildThumbnailArgs } from '../../../src/vlc/args.js'

describe('buildDvdDiscMrl', () => {
  it('builds a Windows DVD disc MRL with an explicit root slash', () => {
    expect(buildDvdDiscMrl({ drive: 'D:' })).toBe('dvd:///D:/')
  })

  it('builds DVD MRLs for absolute folder and ISO sources', () => {
    expect(buildDvdDiscMrl({ drive: 'C:\\dvd media\\DISC' })).toBe('dvd:///C:/dvd%20media/DISC/')
    expect(buildDvdDiscMrl({ drive: 'C:\\images\\disc.iso' })).toBe('dvd:///C:/images/disc.iso')
    expect(buildDvdTitleMrl({ drive: 'C:\\dvd media\\DISC', titleNumber: 2 })).toBe('dvd:///C:/dvd%20media/DISC/#2')
  })

  it('rejects relative DVD source paths', () => {
    expect(() => buildDvdDiscMrl({ drive: 'fixtures/disc' })).toThrow(/absolute|drive letter/i)
  })
})

describe('buildDvdTitleMrl', () => {
  it('builds a DVD title MRL for a drive letter and title number', () => {
    expect(buildDvdTitleMrl({ drive: 'D:', titleNumber: 3 })).toBe('dvd:///D:/#3')
  })

  it('rejects invalid title numbers', () => {
    expect(() => buildDvdTitleMrl({ drive: 'D:', titleNumber: 0 })).toThrow(/title/i)
  })
})

describe('buildThumbnailArgs', () => {
  it('includes dummy interface and scene filter options', () => {
    const args = buildThumbnailArgs({
      drive: 'D:',
      titleNumber: 2,
      snapshotDir: 'C:/cache/discs/disc-1/title-2',
      snapshotPrefix: 'thumbnail',
      startTimeSeconds: 45,
      runTimeSeconds: 2,
    })

    expect(args).toContain('--intf')
    expect(args).toContain('dummy')
    expect(args).toContain('--video-filter=scene')
    expect(args).toContain('--no-video-title-show')
    expect(args).toContain('--scene-prefix=thumbnail')
    expect(args).toContain('--scene-format=jpg')
    expect(args).toContain('dvd:///D:/#2')
    expect(args.at(-1)).toBe('vlc://quit')
  })
})

describe('buildHlsArgs', () => {
  it('includes livehttp output and selected zero-based audio/subtitle options', () => {
    const args = buildHlsArgs({
      drive: 'D:',
      titleNumber: 4,
      audioTrack: 0,
      subtitleTrack: 2,
      outputDir: 'C:/cache/sessions/session-1',
      baseUrl: '/streams/session-1/',
    })

    expect(args).toContain('--intf')
    expect(args).toContain('dummy')
    expect(args).toContain('--no-dvdnav-menu')
    expect(args).toContain('--audio-track=0')
    expect(args).toContain('--sub-track=2')
    expect(args).toContain('dvd:///D:/#4')
    expect(args.some((arg) => arg.includes('livehttp'))).toBe(true)
    expect(args.some((arg) => arg.includes('delsegs=false'))).toBe(true)
    expect(args.some((arg) => arg.includes('soverlay'))).toBe(true)
    expect(args.some((arg) => arg.includes('scodec=dvbs'))).toBe(false)
    expect(args.some((arg) => arg.includes('index.m3u8'))).toBe(true)
    expect(args.some((arg) => arg.includes('segment-######.ts'))).toBe(true)
  })

  it('pins a fixed GOP and frame rate so segments map exactly to DVD time', () => {
    const args = buildHlsArgs({
      drive: 'D:',
      titleNumber: 4,
      outputDir: 'C:/cache/sessions/session-1',
      baseUrl: '/streams/session-1/',
    })

    // 2s segments at 25fps => a keyframe every 50 frames, no scene-cut keyframes.
    expect(args).toContain('--sout-x264-keyint=50')
    expect(args).toContain('--sout-x264-min-keyint=50')
    expect(args).toContain('--sout-x264-scenecut=0')
    expect(args.some((arg) => arg.includes('fps=25'))).toBe(true)
    expect(args.some((arg) => arg.includes('seglen=2'))).toBe(true)
    expect(args.some((arg) => arg.includes('use-key-frames'))).toBe(true)
  })

  it('prefers English audio automatically when no explicit audio track is selected', () => {
    const args = buildHlsArgs({
      drive: 'D:',
      titleNumber: 4,
      outputDir: 'C:/cache/sessions/session-1',
      baseUrl: '/streams/session-1/',
    })

    expect(args).toContain('--audio-language=en')
    expect(args.some((arg) => arg.startsWith('--audio-track='))).toBe(false)
  })

  it('can restart playback from a later title time with non-reused HLS segment numbers', () => {
    const args = buildHlsArgs({
      drive: 'D:',
      titleNumber: 4,
      outputDir: 'C:/cache/sessions/session-1',
      baseUrl: '/streams/session-1/',
      startTimeSeconds: 3720,
      initialSegmentNumber: 101,
    })

    expect(args).toContain('--start-time')
    expect(args).toContain('3720')
    expect(args).toContain('--input-fast-seek')
    expect(args).toContain('--sout-livehttp-initial-segment-number=101')
  })
})
