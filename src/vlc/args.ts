import { join } from 'node:path'
import { buildDvdTitleMrl } from './mrl.js'

export interface ThumbnailArgsInput {
  drive: string
  titleNumber: number
  snapshotDir: string
  snapshotPrefix: string
  startTimeSeconds: number
  runTimeSeconds: number
}

export interface HlsArgsInput {
  drive: string
  titleNumber: number
  outputDir: string
  baseUrl: string
  audioTrack?: number
  subtitleTrack?: number
  startTimeSeconds?: number
  initialSegmentNumber?: number
}

export function buildThumbnailArgs(input: ThumbnailArgsInput): string[] {
  return [
    '--intf',
    'dummy',
    '--no-video-title-show',
    '--start-time',
    String(input.startTimeSeconds),
    '--run-time',
    String(input.runTimeSeconds),
    '--video-filter=scene',
    `--scene-path=${input.snapshotDir}`,
    `--scene-prefix=${input.snapshotPrefix}`,
    '--scene-format=jpg',
    '--scene-replace',
    buildDvdTitleMrl({ drive: input.drive, titleNumber: input.titleNumber }),
    'vlc://quit',
  ]
}

export function buildHlsArgs(input: HlsArgsInput): string[] {
  const args = [
    '--intf',
    'dummy',
    '--no-video-title-show',
    '--no-dvdnav-menu',
    '--deinterlace',
    '--no-sout-all',
    '--sout-x264-preset=veryfast',
  ]

  if (typeof input.startTimeSeconds === 'number' && input.startTimeSeconds > 0) {
    args.push('--start-time', String(input.startTimeSeconds), '--input-fast-seek')
  }

  if (typeof input.initialSegmentNumber === 'number' && input.initialSegmentNumber > 0) {
    args.push(`--sout-livehttp-initial-segment-number=${input.initialSegmentNumber}`)
  }

  if (typeof input.audioTrack === 'number') {
    args.push(`--audio-track=${input.audioTrack}`)
  } else {
    args.push('--audio-language=en')
  }

  if (typeof input.subtitleTrack === 'number') {
    args.push(`--sub-track=${input.subtitleTrack}`)
  }

  const transcodeOptions = [
    'vcodec=h264',
    'aenc=avcodec',
    'acodec=mp4a',
    'ab=128',
    'channels=2',
    'samplerate=48000',
  ]

  if (typeof input.subtitleTrack === 'number') {
    transcodeOptions.push('soverlay')
  }

  args.push(
    buildDvdTitleMrl({ drive: input.drive, titleNumber: input.titleNumber }),
    `--sout=#transcode{${transcodeOptions.join(',')}}:std{access=livehttp{seglen=2,delsegs=true,numsegs=4,index=${join(input.outputDir, 'index.m3u8')},index-url=${input.baseUrl}segment-######.ts},mux=ts{use-key-frames},dst=${join(input.outputDir, 'segment-######.ts')}}`,
    'vlc://quit',
  )

  return args
}