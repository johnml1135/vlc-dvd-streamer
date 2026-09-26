import { spawnSync } from 'node:child_process'

export interface LiveProcessIdentity {
  pid: number
  processStartTime: string
  executablePath: string
  commandLine: string
}

export interface ManualServerProcessRecord {
  pid: number
  processStartTime?: string
  repoRoot: string
  command: string
  args: string[]
}

export function matchesManualServerProcess(state: ManualServerProcessRecord, live: LiveProcessIdentity | null): boolean {
  if (!live || !state.processStartTime) return false
  if (state.pid !== live.pid || state.processStartTime !== live.processStartTime) return false
  if (normalizeWindowsPath(state.command) !== normalizeWindowsPath(live.executablePath)) return false

  const commandLine = normalizeWindowsPath(live.commandLine)
  return [state.command, ...state.args].every((argument) => commandLine.includes(normalizeWindowsPath(argument)))
}

export function readWindowsProcessIdentity(pid: number): LiveProcessIdentity | null {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid < 1) return null

  const script = `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($process) { [pscustomobject]@{ pid = [int]$process.ProcessId; processStartTime = [string]$process.CreationDate; executablePath = [string]$process.ExecutablePath; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress }`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null

  try {
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object') return null
    const identity = value as Partial<LiveProcessIdentity>
    if (identity.pid !== pid || typeof identity.processStartTime !== 'string'
      || typeof identity.executablePath !== 'string' || typeof identity.commandLine !== 'string') return null
    return identity as LiveProcessIdentity
  } catch {
    return null
  }
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').replaceAll('"', '').toLowerCase()
}
