import { runManagedProcess, type CompletedProcess } from '../vlc/process-supervisor.js'
import { createCommandSpec } from '../vlc/command-spec.js'
import { normalizeDvdSource } from './dvd-source.js'

export interface OpticalDrive {
  drive: string
  mediaLoaded: boolean
}

// PowerShell emits one "F:<TAB>True" line per optical drive.
const DETECT_SCRIPT = "Get-CimInstance Win32_CDROMDrive | ForEach-Object { \"$($_.Drive)`t$($_.MediaLoaded)\" }"

export function parseOpticalDrives(output: string): OpticalDrive[] {
  const drives: OpticalDrive[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const [drivePart, mediaPart] = rawLine.split('\t')
    const drive = drivePart?.trim()
    if (!drive || !/^[A-Za-z]:$/.test(drive)) {
      continue
    }

    drives.push({
      drive: drive.toUpperCase(),
      mediaLoaded: (mediaPart ?? '').trim().toLowerCase() === 'true',
    })
  }

  return drives
}

/** Pick the best optical drive: one with media loaded if possible, else the first present drive. */
export function selectOpticalDrive(drives: OpticalDrive[]): string | null {
  const withMedia = drives.find((drive) => drive.mediaLoaded)
  if (withMedia) {
    return withMedia.drive
  }

  return drives[0]?.drive ?? null
}

export interface DetectOpticalDriveOptions {
  platform?: NodeJS.Platform
  runPowerShell?: (script: string) => Promise<string>
  onMultipleLoadedDrives?: (drives: string[]) => void
}

/**
 * Detects the Windows optical drive to use, preferring one with a disc loaded.
 * Returns null when detection is unavailable (non-Windows) or finds nothing.
 */
export async function detectOpticalDrive(options: DetectOpticalDriveOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return null
  }

  const runPowerShell = options.runPowerShell ?? defaultRunPowerShell
  try {
    const output = await runPowerShell(DETECT_SCRIPT)
    const drives = parseOpticalDrives(output)
    const loadedDrives = drives.filter((drive) => drive.mediaLoaded).map((drive) => drive.drive)
    if (loadedDrives.length > 1) options.onMultipleLoadedDrives?.(loadedDrives)
    return selectOpticalDrive(drives)
  } catch {
    return null
  }
}

export async function resolveDvdSource(
  configuredSource: string | undefined,
  detect: () => Promise<string | null> = detectOpticalDrive,
): Promise<{ source: string; explicit: boolean; detected: boolean }> {
  const configured = configuredSource?.trim()
  if (configured) return { source: normalizeDvdSource(configured), explicit: true, detected: false }
  const detectedSource = await detect()
  return {
    source: detectedSource ?? 'D:',
    explicit: false,
    detected: detectedSource !== null,
  }
}

async function defaultRunPowerShell(script: string): Promise<string> {
  const result: CompletedProcess = await runManagedProcess(createCommandSpec({
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    timeoutMs: 10000,
    label: 'detect-optical-drive',
  }))

  return result.stdout
}
