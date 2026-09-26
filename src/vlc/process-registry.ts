import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { CommandSpec } from './command-spec.js'
import { setManagedProcessObserver } from './process-supervisor.js'
import { readWindowsProcessIdentity } from '../runtime/process-identity.js'

export interface VlcProcessRecord {
  pid: number
  processStartTime: string
}

export interface VlcProcessRegistryOptions {
  readStartTime?: (pid: number) => Promise<string | null> | string | null
  killProcess?: (pid: number) => Promise<void> | void
  isRunning?: (pid: number) => boolean
}

export class VlcProcessRegistry {
  private readonly filePath: string
  private readonly readStartTime: (pid: number) => Promise<string | null>
  private readonly killProcess: (pid: number) => Promise<void>
  private readonly isRunning: (pid: number) => boolean
  private pendingOperation: Promise<void> = Promise.resolve()

  constructor(cacheDir: string, options: VlcProcessRegistryOptions = {}) {
    this.filePath = join(cacheDir, 'vlc-processes.json')
    this.readStartTime = async (pid) => options.readStartTime
      ? options.readStartTime(pid)
      : readProcessStartTime(pid)
    this.killProcess = async (pid) => options.killProcess
      ? options.killProcess(pid)
      : killProcess(pid)
    this.isRunning = options.isRunning ?? isProcessRunning
  }

  record(pid: number): Promise<void> {
    return this.serialize(async () => {
      if (!Number.isInteger(pid) || pid < 1) return
      const processStartTime = await this.readStartTimeForSpawn(pid)
      if (!processStartTime) return

      const records = await this.readRecords()
      const next = records.filter((record) => record.pid !== pid)
      next.push({ pid, processStartTime })
      await this.writeRecords(next)
    })
  }

  remove(pid: number): Promise<void> {
    return this.serialize(async () => {
      const records = await this.readRecords()
      const next = records.filter((record) => record.pid !== pid)
      if (next.length !== records.length) await this.writeRecords(next)
    })
  }

  sweep(): Promise<number> {
    return this.serialize(async () => {
      const records = await this.readRecords()
      const remaining: VlcProcessRecord[] = []
      let killed = 0

      for (const record of records) {
        const liveStartTime = await this.readStartTime(record.pid)
        if (liveStartTime === record.processStartTime) {
          try {
            await this.killProcess(record.pid)
            killed += 1
          } catch {
            remaining.push(record)
          }
          continue
        }

        if (liveStartTime === null && this.isRunning(record.pid)) {
          // Preserve records we cannot verify so a later startup can retry safely.
          remaining.push(record)
        }
      }

      await this.writeRecords(remaining)
      return killed
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation)
    this.pendingOperation = result.then(() => undefined, () => undefined)
    return result
  }

  private async readStartTimeForSpawn(pid: number): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const processStartTime = await this.readStartTime(pid)
      if (processStartTime) return processStartTime
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return null
  }

  private async readRecords(): Promise<VlcProcessRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!Array.isArray(value)) return []
      return value.filter(isVlcProcessRecord)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return []
    }
  }

  private async writeRecords(records: VlcProcessRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(records), 'utf8')
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

export function attachVlcProcessRegistry(
  registry: VlcProcessRegistry,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  return setManagedProcessObserver({
    onSpawn(spec, pid) {
      if (isVlcExecutable(spec)) void registry.record(pid).catch(onError)
    },
    onClose(spec, pid) {
      if (isVlcExecutable(spec)) void registry.remove(pid).catch(onError)
    },
  })
}

function isVlcExecutable(spec: CommandSpec): boolean {
  return basename(spec.executable).toLowerCase().replace(/\.exe$/, '') === 'vlc'
}

function isVlcProcessRecord(value: unknown): value is VlcProcessRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<VlcProcessRecord>
  return Number.isInteger(record.pid) && (record.pid ?? 0) > 0 && typeof record.processStartTime === 'string'
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return readWindowsProcessIdentity(pid)?.processStartTime ?? null
  if (process.platform !== 'linux') return null

  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const closingParen = stat.lastIndexOf(')')
    const startTime = stat.slice(closingParen + 2).trim().split(/\s+/)[19]
    return startTime ?? null
  } catch {
    return null
  }
}

async function killProcess(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM')
}
