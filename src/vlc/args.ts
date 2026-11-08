import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDvdTitleMrl } from './mrl.js'

export function getPlaceholderAssetPath(name = 'placeholder.ts'): string {
  const moduleDir = fileURLToPath(new URL('.', import.meta.url))
  const compiledRootAsset = resolve(moduleDir, '../../assets', name)
  return existsSync(compiledRootAsset)
    ? compiledRootAsset
    : resolve(moduleDir, '../../../assets', name)
}

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

// The timeline treats HLS segment N as DVD time [(N-1)*SEG, N*SEG). For that to
// stay true over a long title, every segment must be exactly SEG seconds and
// start on a keyframe. We force a constant output frame rate and a fixed GOP so
// `use-key-frames` cuts land precisely on SEG boundaries instead of drifting
// with scene-cut-driven, variable-length GOPs.
const SEGMENT_DURATION_SECONDS = 2
const OUTPUT_FRAME_RATE = 25
const GOP_FRAMES = SEGMENT_DURATION_SECONDS * OUTPUT_FRAME_RATE

export function buildThumbnailArgs(input: ThumbnailArgsInput): string[] {
  return [
    '--intf',
    'dummy',
    '--no-interact',
    '--no-qt-error-dialogs',
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
    '--no-interact',
    '--no-qt-error-dialogs',
    '--no-video-title-show',
    '--no-dvdnav-menu',
    '--deinterlace=1',
    '--no-sout-all',
    '--sout-x264-preset=veryfast',
    // Fixed GOP, no scene-cut keyframes: guarantees a keyframe every SEG seconds
    // so livehttp segments are uniform and keyframe-aligned to the time grid.
    `--sout-x264-keyint=${GOP_FRAMES}`,
    `--sout-x264-min-keyint=${GOP_FRAMES}`,
    '--sout-x264-scenecut=0',
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
    // Constant output frame rate so GOP_FRAMES corresponds to exactly SEG seconds.
    `fps=${OUTPUT_FRAME_RATE}`,
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
    `--sout=#transcode{${transcodeOptions.join(',')}}:std{access=livehttp{seglen=${SEGMENT_DURATION_SECONDS},delsegs=false,numsegs=0,index=${join(input.outputDir, 'index.m3u8')},index-url=${input.baseUrl}segment-######.ts},mux=ts{use-key-frames},dst=${join(input.outputDir, 'segment-######.ts')}}`,
    'vlc://quit',
  )

  return args
}

/**
 * Re-encodes a committed two-second, 720x480 H.264/AAC placeholder transport
 * stream using the live stream's output settings. VLC 3's fake input module
 * does not exist, and its still-image demuxer exits immediately on this build,
 * so a real MPEG-TS source keeps placeholder generation deterministic.
 */
export function buildPlaceholderArgs(input: { outputPath: string; durationSeconds?: number }): string[] {
  const durationSeconds = input.durationSeconds ?? SEGMENT_DURATION_SECONDS
  const sourcePath = getPlaceholderAssetPath()
  return [
    '--intf',
    'dummy',
    '--no-interact',
    '--no-qt-error-dialogs',
    '--no-video-title-show',
    `--run-time=${durationSeconds}`,
    '--sout-x264-preset=veryfast',
    `--sout-x264-keyint=${GOP_FRAMES}`,
    `--sout-x264-min-keyint=${GOP_FRAMES}`,
    '--sout-x264-scenecut=0',
    sourcePath,
    `--sout=#transcode{vcodec=h264,fps=${OUTPUT_FRAME_RATE},aenc=avcodec,acodec=mp4a,ab=128,channels=2,samplerate=48000}:std{access=file,mux=ts,dst=${input.outputPath}}`,
    'vlc://quit',
  ]
}
