import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildManualServerCommand,
  createManualServerState,
  formatManualServerUrl,
  getManualServerPaths,
  type ManualServerState,
} from '../src/runtime/manual-server-control.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const paths = getManualServerPaths(repoRoot)

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const processError = error as NodeJS.ErrnoException
    if (processError.code === 'ESRCH') {
      return false
    }

    if (processError.code === 'EPERM') {
      return true
    }

    throw error
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }

  return predicate()
}

async function readManualServerState(): Promise<ManualServerState | null> {
  try {
    const raw = await readFile(paths.stateFilePath, 'utf8')
    return JSON.parse(raw) as ManualServerState
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException
    if (fileError.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function writeManualServerState(pid: number, command: string, args: string[]): Promise<ManualServerState> {
  const state = createManualServerState({
    repoRoot,
    pid,
    host: process.env.HOST,
    port: process.env.PORT,
    dvdDrive: process.env.DVD_DRIVE,
    command,
    args,
    stdoutLogPath: paths.stdoutLogPath,
    stderrLogPath: paths.stderrLogPath,
  })

  await writeFile(paths.stateFilePath, JSON.stringify(state, null, 2))
  return state
}

async function startManualServer(): Promise<void> {
  const existingState = await readManualServerState()
  if (existingState && isProcessRunning(existingState.pid)) {
    console.log('VLC DVD Streamer is already running in the background.')
    console.log(`PID: ${existingState.pid}`)
    console.log(`URL: ${formatManualServerUrl(existingState.host, existingState.port)}`)
    console.log(`State file: ${paths.stateFilePath}`)
    return
  }

  if (existingState) {
    await rm(paths.stateFilePath, { force: true })
  }

  await mkdir(paths.logsDir, { recursive: true })

  const { command, args } = buildManualServerCommand(repoRoot, process.execPath)
  const stdoutFd = openSync(paths.stdoutLogPath, 'a')
  const stderrFd = openSync(paths.stderrLogPath, 'a')

  try {
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: true,
      env: process.env,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    })

    if (!child.pid) {
      throw new Error('The server process did not report a PID.')
    }

    child.unref()

    const state = await writeManualServerState(child.pid, command, args)
    const running = await waitFor(() => isProcessRunning(child.pid ?? 0), 1500, 100)
    if (!running) {
      await rm(paths.stateFilePath, { force: true })
      throw new Error(`The server process exited before it became stable. Check ${paths.stderrLogPath}.`)
    }

    console.log('Started VLC DVD Streamer in the background.')
    console.log(`PID: ${state.pid}`)
    console.log(`URL: ${formatManualServerUrl(state.host, state.port)}`)
    console.log(`State file: ${paths.stateFilePath}`)
    console.log(`Stdout log: ${paths.stdoutLogPath}`)
    console.log(`Stderr log: ${paths.stderrLogPath}`)
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
}

function stopProcess(pid: number): { ok: boolean; output?: string } {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })

    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    if (result.status === 0) {
      return { ok: true, output: combinedOutput }
    }

    if (/not found|no running instance/i.test(combinedOutput)) {
      return { ok: true, output: combinedOutput }
    }

    return { ok: false, output: combinedOutput }
  }

  try {
    process.kill(pid, 'SIGTERM')
    return { ok: true }
  } catch (error) {
    const processError = error as NodeJS.ErrnoException
    if (processError.code === 'ESRCH') {
      return { ok: true }
    }

    return {
      ok: false,
      output: processError.message,
    }
  }
}

async function stopManualServer(): Promise<void> {
  const state = await readManualServerState()
  if (!state) {
    console.log('No manual server state file found.')
    return
  }

  const stopResult = stopProcess(state.pid)
  if (!stopResult.ok) {
    throw new Error(stopResult.output || `Failed to stop PID ${state.pid}.`)
  }

  await waitFor(() => !isProcessRunning(state.pid), 4000, 100)
  await rm(paths.stateFilePath, { force: true })

  console.log(`Stopped PID: ${state.pid}`)
  if (stopResult.output) {
    console.log(stopResult.output)
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command === 'start') {
    await startManualServer()
    return
  }

  if (command === 'stop') {
    await stopManualServer()
    return
  }

  throw new Error('Usage: manual-server.ts <start|stop>')
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}