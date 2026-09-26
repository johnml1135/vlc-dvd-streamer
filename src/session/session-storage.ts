import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionStorageLease {
  /** Whether this process removed old session directories during startup. */
  swept: boolean
  release(): Promise<void>
}

/**
 * Register this process as a cache owner, then sweep stale HLS output only
 * when no other live process has a registration. The short startup lock
 * serializes owner registration with cleanup; each registration is held until
 * the server closes so a later startup cannot remove a live peer's files.
 */
export async function acquireSessionStorage(cacheDir: string): Promise<SessionStorageLease> {
  await mkdir(cacheDir, { recursive: true })
  const sessionsDir = join(cacheDir, 'sessions')
  const ownersDir = join(cacheDir, '.session-owners')
  const lockPath = join(cacheDir, '.sessions.lock')
  const startupLock = await acquireStartupLock(lockPath)
  const ownerPath = join(ownersDir, `instance-${process.pid}-${randomUUID()}`)
  let swept = false

  try {
    await mkdir(ownersDir, { recursive: true })
    const ownerHandle = await open(ownerPath, 'wx')
    await ownerHandle.close()
    const hasLivePeer = await pruneAndFindLivePeer(ownersDir, ownerPath)
    if (!hasLivePeer) {
      await mkdir(sessionsDir, { recursive: true })
      const entries = await readdir(sessionsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) await rm(join(sessionsDir, entry.name), { recursive: true, force: true })
      }
      swept = true
    }
  } catch (error) {
    await unlink(ownerPath).catch(() => {})
    await startupLock.close()
    await unlink(lockPath).catch(() => {})
    throw error
  }

  await releaseStartupLock(startupLock, lockPath)
  let released = false
  return {
    swept,
    async release() {
      if (released) return
      released = true
      await unlink(ownerPath).catch((error) => {
        if (fileErrorCode(error) !== 'ENOENT') throw error
      })
    },
  }
}

async function acquireStartupLock(lockPath: string) {
  const waitDeadline = Date.now() + 10000
  while (Date.now() < waitDeadline) {
    try {
      const lock = await open(lockPath, 'wx')
      try {
        await lock.writeFile(String(process.pid), 'utf8')
        return lock
      } catch (error) {
        await lock.close()
        await unlink(lockPath).catch(() => {})
        throw error
      }
    } catch (error) {
      if (fileErrorCode(error) !== 'EEXIST') throw error
      const ownerPid = await readOwnerPid(lockPath)
      if (ownerPid !== null && !isProcessAlive(ownerPid)) {
        const confirmedPid = await readOwnerPid(lockPath)
        if (confirmedPid === ownerPid && !isProcessAlive(ownerPid)) {
          await unlink(lockPath).catch((unlinkError) => {
            if (fileErrorCode(unlinkError) !== 'ENOENT') throw unlinkError
          })
          continue
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error('Timed out waiting for the session storage startup lock.')
}

async function releaseStartupLock(lock: Awaited<ReturnType<typeof open>>, lockPath: string): Promise<void> {
  await lock.close()
  await unlink(lockPath).catch((error) => {
    if (fileErrorCode(error) !== 'ENOENT') throw error
  })
}

async function pruneAndFindLivePeer(ownersDir: string, ownPath: string): Promise<boolean> {
  const names = await readdir(ownersDir)
  let hasLivePeer = false
  for (const name of names) {
    const path = join(ownersDir, name)
    if (path === ownPath) continue
    const match = /^instance-(\d+)-[\da-f-]+$/i.exec(name)
    const pid = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    if (isProcessAlive(pid)) {
      hasLivePeer = true
    } else {
      await unlink(path).catch((error) => {
        if (fileErrorCode(error) !== 'ENOENT') throw error
      })
    }
  }
  return hasLivePeer
}

async function readOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const value = (await readFile(lockPath, 'utf8')).trim()
    const pid = Number(value)
    return /^\d+$/.test(value) && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}
