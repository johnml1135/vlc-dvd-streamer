import { createCommandSpec } from './command-spec.js'
import { buildDvdDiscMrl, buildDvdTitleMrl } from './mrl.js'

export const PRIMARY_AUDIO_LANGUAGE = 'en'
export const FALLBACK_AUDIO_LANGUAGE = 'fr'

export interface ScanArgOptions {
  audioLanguage?: string
  subLanguage?: string
}

export interface VlcProbeCommandOptions {
  executable: string
  drive: string
  timeoutMs: number
}

export interface VlcTitleProbeCommandOptions extends VlcProbeCommandOptions {
  titleNumber: number
  audioLanguage: string
}

export interface VlcLanguageProbeCommandOptions extends VlcProbeCommandOptions {
  titleNumber: number
  languageCode: string
}

export interface VlcTrackMetadataCommandOptions {
  drive: string
  titleNumber: number
  timeoutMs: number
  trackMetadataScript: string
}

export function buildScanArgs(mrl: string, options: ScanArgOptions = {}): string[] {
  return [
    '--intf',
    'dummy',
    '--no-video',
    '--vout',
    'dummy',
    '--aout',
    'dummy',
    `--audio-language=${options.audioLanguage ?? PRIMARY_AUDIO_LANGUAGE}`,
    `--sub-language=${options.subLanguage ?? 'en'}`,
    '--play-and-exit',
    '--run-time',
    '1',
    '--verbose=2',
    mrl,
  ]
}

export function buildDiscProbeCommand(options: VlcProbeCommandOptions) {
  return createCommandSpec({
    executable: options.executable,
    args: buildScanArgs(buildDvdDiscMrl({ drive: options.drive })),
    timeoutMs: Math.max(options.timeoutMs, 120000),
    label: 'vlc-disc-probe',
  })
}

export function buildTitleProbeCommand(options: VlcTitleProbeCommandOptions) {
  return createCommandSpec({
    executable: options.executable,
    args: buildScanArgs(buildDvdTitleMrl({ drive: options.drive, titleNumber: options.titleNumber }), {
      audioLanguage: options.audioLanguage,
    }),
    timeoutMs: Math.max(options.timeoutMs, 60000),
    label: `vlc-title-probe-${options.titleNumber}-${options.audioLanguage}`,
  })
}

export function buildLanguageProbeCommand(options: VlcLanguageProbeCommandOptions) {
  return createCommandSpec({
    executable: options.executable,
    args: buildScanArgs(buildDvdTitleMrl({ drive: options.drive, titleNumber: options.titleNumber }), {
      audioLanguage: `${options.languageCode},none`,
      subLanguage: `${options.languageCode},none`,
    }),
    timeoutMs: Math.max(options.timeoutMs, 60000),
    label: `vlc-language-probe-${options.titleNumber}-${options.languageCode}`,
  })
}

export function buildTrackMetadataCommand(options: VlcTrackMetadataCommandOptions) {
  const waitSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000))

  return createCommandSpec({
    executable: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.trackMetadataScript,
      '-Mrl',
      buildDvdTitleMrl({ drive: options.drive, titleNumber: options.titleNumber }),
      '-WaitSeconds',
      String(waitSeconds),
    ],
    timeoutMs: waitSeconds * 2000,
    label: `vlc-track-metadata-${options.titleNumber}`,
  })
}