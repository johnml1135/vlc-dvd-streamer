import { join } from 'node:path'

export interface ManualServerPaths {
  runtimeDir: string
  logsDir: string
  stateFilePath: string
  stdoutLogPath: string
  stderrLogPath: string
}

export interface ManualServerCommand {
  command: string
  args: string[]
}

export interface ManualServerState {
  pid: number
  startedAt: string
  repoRoot: string
  host?: string
  port?: string
  dvdDrive?: string
  command: string
  args: string[]
  stdoutLogPath: string
  stderrLogPath: string
}

export interface CreateManualServerStateInput {
  repoRoot: string
  pid: number
  host?: string
  port?: string
  dvdDrive?: string
  command: string
  args: string[]
  stdoutLogPath: string
  stderrLogPath: string
  startedAt?: string
}

export function getManualServerPaths(repoRoot: string): ManualServerPaths {
  const runtimeDir = join(repoRoot, '.runtime')
  const logsDir = join(runtimeDir, 'logs')

  return {
    runtimeDir,
    logsDir,
    stateFilePath: join(runtimeDir, 'manual-server.json'),
    stdoutLogPath: join(logsDir, 'manual-server.stdout.log'),
    stderrLogPath: join(logsDir, 'manual-server.stderr.log'),
  }
}

export function buildManualServerCommand(repoRoot: string, nodeExecutable: string): ManualServerCommand {
  return {
    command: nodeExecutable,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'server.ts')],
  }
}

export function createManualServerState(input: CreateManualServerStateInput): ManualServerState {
  return {
    pid: input.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    repoRoot: input.repoRoot,
    host: input.host,
    port: input.port,
    dvdDrive: input.dvdDrive,
    command: input.command,
    args: input.args,
    stdoutLogPath: input.stdoutLogPath,
    stderrLogPath: input.stderrLogPath,
  }
}

export function formatManualServerUrl(host = '127.0.0.1', port = '3000'): string {
  const reachableHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${reachableHost}:${port}`
}