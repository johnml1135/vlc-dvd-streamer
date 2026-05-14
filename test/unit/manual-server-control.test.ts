import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  buildManualServerCommand,
  createManualServerState,
  getManualServerPaths,
} from '../../src/runtime/manual-server-control.js'

describe('manual server control', () => {
  it('uses stable runtime paths for PID and logs', () => {
    const repoRoot = 'C:/repo/vlc-dvd-streamer'
    const paths = getManualServerPaths(repoRoot)

    expect(paths.runtimeDir).toBe(join(repoRoot, '.runtime'))
    expect(paths.logsDir).toBe(join(repoRoot, '.runtime', 'logs'))
    expect(paths.stateFilePath).toBe(join(repoRoot, '.runtime', 'manual-server.json'))
    expect(paths.stdoutLogPath).toBe(join(repoRoot, '.runtime', 'logs', 'manual-server.stdout.log'))
    expect(paths.stderrLogPath).toBe(join(repoRoot, '.runtime', 'logs', 'manual-server.stderr.log'))
  })

  it('launches the real server through node plus the tsx loader', () => {
    const repoRoot = 'C:/repo/vlc-dvd-streamer'
    const command = buildManualServerCommand(repoRoot, 'C:/Program Files/nodejs/node.exe')

    expect(command.command).toBe('C:/Program Files/nodejs/node.exe')
    expect(command.args).toEqual([
      '--import',
      'tsx',
      join(repoRoot, 'src', 'server.ts'),
    ])
  })

  it('persists PID metadata with operator-relevant settings', () => {
    const state = createManualServerState({
      repoRoot: 'C:/repo/vlc-dvd-streamer',
      pid: 4242,
      host: '0.0.0.0',
      port: '3000',
      dvdDrive: 'F:',
      command: 'C:/Program Files/nodejs/node.exe',
      args: ['--import', 'tsx', 'C:/repo/vlc-dvd-streamer/src/server.ts'],
      stdoutLogPath: 'C:/repo/vlc-dvd-streamer/.runtime/logs/manual-server.stdout.log',
      stderrLogPath: 'C:/repo/vlc-dvd-streamer/.runtime/logs/manual-server.stderr.log',
      startedAt: '2026-05-13T12:00:00.000Z',
    })

    expect(state).toEqual({
      pid: 4242,
      startedAt: '2026-05-13T12:00:00.000Z',
      repoRoot: 'C:/repo/vlc-dvd-streamer',
      host: '0.0.0.0',
      port: '3000',
      dvdDrive: 'F:',
      command: 'C:/Program Files/nodejs/node.exe',
      args: ['--import', 'tsx', 'C:/repo/vlc-dvd-streamer/src/server.ts'],
      stdoutLogPath: 'C:/repo/vlc-dvd-streamer/.runtime/logs/manual-server.stdout.log',
      stderrLogPath: 'C:/repo/vlc-dvd-streamer/.runtime/logs/manual-server.stderr.log',
    })
  })
})